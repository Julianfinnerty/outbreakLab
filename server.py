"""OutbreakLab server: serves the app, turns uploaded radar volumes into Level II files and
serves them to GR2Analyst's polling.

  python server.py [port]            (default 8820)

GR2Analyst:  File -> Configure Polling -> polling URL  http://127.0.0.1:8820/poll/
             (move it above other sources), then pick one of the run's radar sites.
             Files are also written to output/<run>/<ICAO>/ for File -> Open.

Polling layout (as on the Iowa State server): <url>/grlevel2.cfg lists the sites ("Site: KTLX" lines),
<url>/<ICAO>/dir.list lists the volumes ("size name" lines, oldest first), <url>/<ICAO>/<name> is a volume.
"""
import json
import os
import re
import struct
import sys
import threading
import time
import traceback
import urllib.parse
import zlib
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

import l2writer

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "output")
PORT = int(os.environ.get("PORT", sys.argv[1] if len(sys.argv) > 1 else 8820))
MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css",
        ".json": "application/json", ".png": "image/png", ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon"}
SAFE = re.compile(r"^[A-Za-z0-9_.\-]+$")

LOCK = threading.Lock()
STATE = {"live": None, "replay": None}   # live run name; replay = {run, t0_wall, t0_sim, factor}
INDEX = {}                               # run -> icao -> list of [epoch_ms, name, size]


def run_dir(run):
    return os.path.join(OUT, run)


def load_index(run):
    """Rebuild a run's file index from disk (so replays of old runs work after a restart)."""
    idx = {}
    d = run_dir(run)
    if os.path.isdir(d):
        for icao in os.listdir(d):
            sd = os.path.join(d, icao)
            if not os.path.isdir(sd):
                continue
            lst = []
            for fn in os.listdir(sd):
                m = re.match(r"^[A-Z0-9]{4}(\d{8})_(\d{6})_V06$", fn)
                if not m:
                    continue
                import datetime as dt
                t = dt.datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S").replace(tzinfo=dt.timezone.utc)
                lst.append([int(t.timestamp() * 1000), fn, os.path.getsize(os.path.join(sd, fn))])
            lst.sort()
            idx[icao.upper()] = lst
    return idx


def all_sites():
    """Every WSR-88D (GR2Analyst's radars.gis via js/mapdata.js; TDWRs left out), for grlevel2.cfg."""
    try:
        with open(os.path.join(ROOT, "js", "mapdata.js"), encoding="utf-8") as f:
            s = f.read()
        i = s.index('"radars":') + len('"radars":')
        arr, _ = json.JSONDecoder().raw_decode(s, i)
        return sorted({str(r[0]).upper() for r in arr if not re.search("TDWR", str(r[5]), re.I)})
    except Exception:
        traceback.print_exc()
        return []


ALL_SITES = all_sites()


def site_cfg(run):
    """grlevel2.cfg. GR2Analyst reads it when the source is added (and at start-up) and caches it, so it lists every
    WSR-88D, not just this run's radars: later runs' radars then work without re-adding the source."""
    sites = set(ALL_SITES)
    if run:
        with LOCK:
            sites |= set((INDEX.get(run) or {}).keys())
    return "".join("Site: %s\n" % x for x in sorted(sites)).encode()


# volumes are listed to GR2Analyst under the Iowa State server's names (KTLX_20240506_200054.bz2; same Archive II
# content) — the files on disk keep the NCEI names (KTLX20240506_200054_V06) for File -> Open
def poll_name(fn):
    m = re.match(r"^([A-Z0-9]{4})(\d{8})_(\d{6})_V06$", fn)
    return "%s_%s_%s.bz2" % m.groups() if m else fn


def disk_name(pn):
    m = re.match(r"^([A-Z0-9]{4})_(\d{8})_(\d{6})\.bz2$", pn)
    return "%s%s_%s_V06" % m.groups() if m else pn


def newest_run():
    """The most recently written run, so polling carries on after a server restart."""
    if not os.path.isdir(OUT):
        return None
    runs = [r for r in os.listdir(OUT) if SAFE.match(r) and os.path.isdir(run_dir(r))]
    return max(runs, key=lambda r: os.path.getmtime(run_dir(r)), default=None)


def visible(run, icao):
    """Files GR2Analyst may see for a site: all of them, or during a replay only those up to the replay clock."""
    with LOCK:
        if run not in INDEX:
            INDEX[run] = load_index(run)
        lst = list(INDEX[run].get(icao.upper(), []))
        rp = STATE["replay"]
    if rp and rp["run"] == run:
        t_sim = rp["t0_sim"] + (time.time() - rp["t0_wall"]) * 1000.0 * rp["factor"]
        lst = [e for e in lst if e[0] <= t_sim]
    return lst


def write_dirlist(run, icao):
    lst = INDEX[run].get(icao, [])
    with open(os.path.join(run_dir(run), icao, "dir.list"), "w", newline="\n") as f:
        for _, name, size in lst:
            f.write("%d %s\n" % (size, name))


class Handler(BaseHTTPRequestHandler):
    server_version = "OutbreakLab/1.0"

    def log_message(self, fmt, *args):
        if "/poll/" in self.path or "/api/volume" in self.path:
            sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def send_bytes(self, code, data, ctype="application/octet-stream", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_json(self, obj, code=200):
        self.send_bytes(code, json.dumps(obj).encode(), "application/json")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    # ---------------------------------------------------------------- GET
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        parts = [p for p in u.path.split("/") if p]
        try:
            if parts[:2] == ["api", "status"]:
                with LOCK:
                    idx = INDEX.get(STATE["live"] or "", {})
                    sites = {k: len(v) for k, v in idx.items()}
                return self.send_json({"ok": True, "live": STATE["live"], "replay": STATE["replay"], "sites": sites, "port": PORT})
            if parts[:2] == ["api", "runs"]:
                runs = []
                if os.path.isdir(OUT):
                    for r in sorted(os.listdir(OUT)):
                        if os.path.isdir(run_dir(r)):
                            idx = load_index(r)
                            runs.append({"run": r, "sites": {k: len(v) for k, v in idx.items()}})
                return self.send_json({"runs": runs})
            # polling: /poll/<ICAO>/(dir.list|file) serves the live (or replaying) run,
            # /runs/<run>/<ICAO>/... a specific run; a bare /<ICAO>/... also works
            # grlevel2.cfg (GR2Analyst also tries .grlevel2.cfg) at any of those roots
            if parts and parts[-1] in ("grlevel2.cfg", ".grlevel2.cfg"):
                if parts[0] == "runs" and len(parts) == 3:
                    run = parts[1] if SAFE.match(parts[1]) else None
                else:
                    with LOCK:
                        run = (STATE["replay"] or {}).get("run") or STATE["live"]
                return self.send_bytes(200, site_cfg(run), "text/plain")
            run, rest = None, None
            if parts and parts[0] == "poll":
                with LOCK:
                    run = (STATE["replay"] or {}).get("run") or STATE["live"]
                rest = parts[1:]
            elif parts and parts[0] == "runs" and len(parts) >= 2:
                run, rest = parts[1], parts[2:]
            elif len(parts) == 2 and re.match(r"^[A-Za-z]{4}$", parts[0]) and (parts[1] == "dir.list" or parts[1].upper().startswith(parts[0].upper())):
                with LOCK:
                    run = (STATE["replay"] or {}).get("run") or STATE["live"]
                rest = parts
            if rest is not None:
                if not run or len(rest) != 2 or not SAFE.match(run):
                    return self.send_bytes(404, b"no such run or site")
                icao, fn = rest[0].upper(), rest[1]
                lst = visible(run, icao)
                if fn in ("dir.list", ".dir.list"):
                    body = "".join("%d %s\n" % (size, poll_name(name)) for _, name, size in lst).encode()
                    return self.send_bytes(200, body, "text/plain")
                fn = disk_name(fn)
                if not SAFE.match(fn) or fn not in {e[1] for e in lst}:
                    return self.send_bytes(404, b"not found")
                with open(os.path.join(run_dir(run), icao, fn), "rb") as f:
                    return self.send_bytes(200, f.read())
            # static files
            rel = u.path.lstrip("/") or "index.html"
            p = os.path.normpath(os.path.join(ROOT, rel))
            if not p.startswith(ROOT) or not os.path.isfile(p) or os.path.basename(p) in ("server.py", "l2writer.py"):
                return self.send_bytes(404, b"not found")
            with open(p, "rb") as f:
                data = f.read()
            return self.send_bytes(200, data, MIME.get(os.path.splitext(p)[1].lower(), "application/octet-stream"))
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            traceback.print_exc()
            try:
                self.send_json({"ok": False, "error": str(e)}, 500)
            except Exception:
                pass

    # ---------------------------------------------------------------- POST
    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        try:
            if u.path == "/api/run":
                cfg = json.loads(body or b"{}")
                name = re.sub(r"[^A-Za-z0-9_\-]", "_", cfg.get("name") or time.strftime("run_%Y%m%d_%H%M%S"))[:80]
                os.makedirs(run_dir(name), exist_ok=True)
                with open(os.path.join(run_dir(name), "run.json"), "w") as f:
                    json.dump(cfg, f, indent=1)
                with LOCK:
                    STATE["live"] = name
                    STATE["replay"] = None
                    INDEX[name] = load_index(name)
                return self.send_json({"ok": True, "run": name, "dir": run_dir(name)})
            if u.path == "/api/volume":
                t0 = time.time()
                if self.headers.get("X-OB-Gzip") == "1":
                    body = zlib.decompress(body, 16 + zlib.MAX_WBITS)
                hl = struct.unpack("<I", body[:4])[0]
                H = json.loads(body[4:4 + hl])
                payload = memoryview(body)[4 + hl:]
                run, icao = H["run"], H["icao"].upper()
                if not SAFE.match(run) or not re.match(r"^[A-Z0-9]{4}$", icao):
                    return self.send_json({"ok": False, "error": "bad run/site"}, 400)
                sweeps = []
                for s in H["sweeps"]:
                    mom = {}
                    for m in s["moments"]:
                        ln = int(s["nrad"]) * int(m["ngates"])
                        mom[m["name"]] = (payload[m["off"]:m["off"] + ln], int(m["ngates"]))
                    sw = dict(s)
                    sw["moments"] = mom
                    sweeps.append(sw)
                data = l2writer.encode_volume(icao, float(H["lat"]), float(H["lon"]), float(H["elev"]),
                                              int(H["epoch_ms"]), sweeps, int(H.get("vcp", 212)))
                name = l2writer.archive_name(icao, int(H["epoch_ms"]))
                d = os.path.join(run_dir(run), icao)
                os.makedirs(d, exist_ok=True)
                with open(os.path.join(d, name + ".part"), "wb") as f:
                    f.write(data)
                os.replace(os.path.join(d, name + ".part"), os.path.join(d, name))
                with LOCK:
                    STATE["live"] = run                  # the run that is sending volumes is the live one
                    idx = INDEX.setdefault(run, {})
                    lst = [e for e in idx.setdefault(icao, []) if e[1] != name]
                    lst.append([int(H["epoch_ms"]), name, len(data)])
                    lst.sort()
                    idx[icao] = lst
                    write_dirlist(run, icao)
                return self.send_json({"ok": True, "name": name, "size": len(data), "ms": round((time.time() - t0) * 1000)})
            if u.path == "/api/replay":
                cfg = json.loads(body or b"{}")
                run = cfg.get("run")
                if not run:
                    with LOCK:
                        STATE["replay"] = None
                    return self.send_json({"ok": True, "replay": None})
                if not SAFE.match(run) or not os.path.isdir(run_dir(run)):
                    return self.send_json({"ok": False, "error": "no such run"}, 404)
                idx = load_index(run)
                first = min((v[0][0] for v in idx.values() if v), default=0)
                rp = {"run": run, "t0_wall": time.time(), "t0_sim": first + float(cfg.get("lead_min", 20)) * 60000.0,
                      "factor": float(cfg.get("factor", 10))}
                with LOCK:
                    INDEX[run] = idx
                    STATE["replay"] = rp
                return self.send_json({"ok": True, "replay": rp})
            return self.send_json({"ok": False, "error": "unknown endpoint"}, 404)
        except Exception as e:
            traceback.print_exc()
            return self.send_json({"ok": False, "error": str(e)}, 500)


def main():
    os.makedirs(OUT, exist_ok=True)
    STATE["live"] = newest_run()
    ThreadingHTTPServer.request_queue_size = 128
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    print("OutbreakLab listening on 0.0.0.0:%d/   (local URL: http://127.0.0.1:%d/)" % (PORT, PORT), flush=True)
    print("  %d sites in grlevel2.cfg; live run: %s" % (len(ALL_SITES), STATE["live"]), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
