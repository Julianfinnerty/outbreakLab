"""NEXRAD Level II (Archive II, message 31) writer for pre-encoded gates.

Adapted from StormLab/stormlab/level2.py, itself a port of RadarPainter's worker.js exporter
(validated byte-for-byte against real KTWX files; StormLab's output loads in GR2Analyst 3).
Here the browser has already quantised every gate to its 8-bit code on the GPU, so each moment
of a sweep arrives as raw bytes (nrad x ngates, radial-major).
"""
import bz2
import os
import struct

import numpy as np
from concurrent.futures import ThreadPoolExecutor

GATE_FIRST_M = 2125
GATE_SIZE_M = 250

# name in the data block, scale, offset (code = value * scale + offset; 0 = below threshold, 1 = range folded)
MOMENTS = {
    "REF": ("DREF", 2.0, 66.0),
    "VEL": ("DVEL", 2.0, 129.0),
    "SW":  ("DSW ", 2.0, 129.0),
    "ZDR": ("DZDR", 16.0, 128.0),
    # the real 10-bit NEXRAD scale (2.8361) would saturate at 89 deg in an 8-bit word
    "PHI": ("DPHI", 253.0 / 360.0, 2.0),
    "RHO": ("DRHO", 300.0, -60.5),
}
MOMENT_ORDER = ["REF", "VEL", "SW", "ZDR", "PHI", "RHO"]

# bz2 releases the GIL, so LDM records compress in parallel
_POOL = ThreadPoolExecutor(max_workers=max(2, min(16, (os.cpu_count() or 4) - 2)))


def _julian(epoch_ms):
    days = int(epoch_ms // 86400000)
    return days + 1, int(epoch_ms - days * 86400000)


def _msg_header(buf, msize_halfwords, mtype, seq, epoch_ms, nseg=1, seg=1):
    jd, jms = _julian(epoch_ms)
    struct.pack_into(">HBBHHIHH", buf, 12, msize_halfwords, 8, mtype, seq & 0xFFFF, jd, jms, nseg, seg)


def _pad_str(s, n):
    return s.encode("ascii")[:n].ljust(n, b" ")


def build_msg5(tilts, epoch_ms, seq, vcp):
    buf = bytearray(2432)
    n = len(tilts)
    data_len = 22 + 46 * n
    _msg_header(buf, (16 + data_len) // 2, 5, seq, epoch_ms)
    o = 28
    struct.pack_into(">HHHHHBB", buf, o, data_len // 2, 2, vcp, n, 1, 2, 2)
    o += 22
    for t in tilts:
        sr = bool(t.get("superRes"))
        kind = t.get("kind", "both")
        # waveform 1 = contiguous surveillance, 2 = contiguous Doppler, 4 = batch; the super-res control byte
        # flags 0.5 deg azimuth (1), 1/4 km reflectivity (2), 300 km Doppler (4) and dual polarisation (8)
        chan, wave, sres = {"surv": (2, 1, 0x0B), "dop": (2, 2, 0x07)}.get(kind, (0, 4, 0x0E))
        struct.pack_into(">HBBBBHh", buf, o, int(round(t["angle"] * 65536 / 360)) & 0xFFFF, chan,
                         wave, sres, 1, 15 if sr else 3, 15400 if sr else 17944)
        for k in range(6):
            struct.pack_into(">h", buf, o + 10 + 2 * k, 28)
        for k, edge in enumerate((0x1558, 0x9558, 0xEE38)):
            struct.pack_into(">HHH", buf, o + 22 + 8 * k, edge, 6, 0x1F)
        o += 46
    return bytes(buf)


def build_msg2(epoch_ms, seq, vcp):
    buf = bytearray(2432)
    _msg_header(buf, 48, 2, seq, epoch_ms)
    jd, _ = _julian(epoch_ms)
    hw = [16, 2, 4, 2, 1402, 8, 28, vcp, 0, 1910, 4, 2, 63, 2, 0, 0, 0, 0, jd, 22, jd, 1308, 65512, 3]
    struct.pack_into(">" + "H" * len(hw), buf, 28, *hw)
    return bytes(buf)


def build_metadata(tilts, epoch_ms, vcp):
    segs = [bytes(2432)] * 131
    m3 = bytearray(2432)
    _msg_header(m3, 488, 3, 1, epoch_ms)
    segs.append(bytes(m3))
    segs.append(build_msg5(tilts, epoch_ms, 2, vcp))
    segs.append(build_msg2(epoch_ms, 3, vcp))
    return b"".join(segs)


def _sweep_block(s, ei, nsw, seq0, icao, lat, lon, height_m, vcp, epoch_ms):
    """All message-31 radials of one sweep as a (nrad, msg_len) uint8 array (numpy-vectorised)."""
    ang = float(s["angle"])
    sr = bool(s.get("superRes"))
    mom = s["moments"]
    nrad = int(s["nrad"])
    d_az = 360.0 / nrad
    az0 = float(s.get("az0", 0.0))
    present = [m for m in MOMENT_ORDER if m in mom]
    ngates = {m: int(mom[m][1]) for m in present}
    t0 = int(s.get("start_ms", epoch_ms))
    dur = float(s.get("dur_ms", 15000))
    nyq = int(round(float(s.get("nyquist", 63.5)) * 100))
    unamb = int(round(float(s.get("unamb_km", 466.0)) * 10))
    data_len = 68 + 44 + 12 + 28 + sum(28 + ngates[m] for m in present)
    rad_len = data_len + (data_len & 1)
    L = 28 + rad_len
    # template radial (radial 0), then broadcast and patch the per-radial fields
    buf = bytearray(L)
    _msg_header(buf, (16 + rad_len) // 2, 31, 0, t0)
    d = 28
    buf[d:d + 4] = _pad_str(icao, 4)
    struct.pack_into(">IHHfBBHBBBBfBB", buf, d + 4, 0, 0, 1, 0.0, 0, 0, rad_len, 1 if sr else 2, 1, ei + 1, 1, ang, 0, 25 if sr else 50)
    p = 68
    ptrs = [p]
    buf[d + p:d + p + 4] = b"RVOL"
    struct.pack_into(">HBBffhHfffffHH", buf, d + p + 4, 44, 2, 0, lat, lon, int(round(height_m)), 20, -43.1, 267.0, 258.0, 0.44, 60.0, vcp, 1)
    p += 44
    ptrs.append(p)
    buf[d + p:d + p + 4] = b"RELV"
    struct.pack_into(">Hhf", buf, d + p + 4, 12, -12, -42.5)
    p += 12
    ptrs.append(p)
    buf[d + p:d + p + 4] = b"RRAD"
    struct.pack_into(">HhffhHff", buf, d + p + 4, 28, unamb, -80.4, -80.8, nyq, 0, -42.6, -42.3)
    p += 28
    data_at = {}
    for m in present:
        name, scale, offset = MOMENTS[m]
        ptrs.append(p)
        buf[d + p:d + p + 4] = name.encode("ascii")
        struct.pack_into(">IHHHHhBBff", buf, d + p + 4, 0, ngates[m], GATE_FIRST_M, GATE_SIZE_M, 50, 16, 0, 8, scale, offset)
        data_at[m] = d + p + 28
        p += 28 + ngates[m]
    struct.pack_into(">H", buf, d + 30, len(ptrs))
    for k, pp in enumerate(ptrs):
        struct.pack_into(">I", buf, d + 32 + 4 * k, pp)
    arr = np.tile(np.frombuffer(bytes(buf), dtype=np.uint8), (nrad, 1))
    ri = np.arange(nrad)
    tms = t0 + np.rint(dur * ri / nrad).astype(np.int64)
    days = tms // 86400000
    jd = (days + 1).astype(">u2")
    jms = (tms - days * 86400000).astype(">u4")
    seq = ((seq0 + ri) & 0xFFFF).astype(">u2")
    az = ((az0 + ri * d_az) % 360.0).astype(">f4")
    status = np.ones(nrad, dtype=np.uint8)
    status[0] = 3 if ei == 0 else 0
    status[-1] = 4 if ei == nsw - 1 else 2
    def put(off, vals):
        v = np.ascontiguousarray(vals)
        arr[:, off:off + v.itemsize] = v.view(np.uint8).reshape(nrad, v.itemsize)
    put(12 + 4, seq); put(12 + 6, jd); put(12 + 8, jms)
    put(d + 4, jms); put(d + 8, jd); put(d + 10, (ri + 1).astype(">u2")); put(d + 12, az)
    arr[:, d + 21] = status
    for m in present:
        ng = ngates[m]
        arr[:, data_at[m]:data_at[m] + ng] = np.frombuffer(mom[m][0], dtype=np.uint8, count=nrad * ng).reshape(nrad, ng)
    return arr


def encode_volume(icao, lat, lon, height_m, epoch_ms, sweeps, vcp=212):
    """sweeps: list of dicts
         angle, superRes, kind ('surv' | 'dop' | 'both'), az0 (deg of radial 0), nrad,
         nyquist (m/s), unamb_km, start_ms, dur_ms,
         moments: {name: (codes bytes of nrad*ngates, ngates)}
       Radials increase clockwise from az0. Returns the Archive II bytes."""
    tilts = [{"angle": s["angle"], "superRes": bool(s.get("superRes")), "kind": s.get("kind", "both")} for s in sweeps]
    meta = build_metadata(tilts, epoch_ms, vcp)
    records = [meta]
    seq = 10
    for ei, s in enumerate(sweeps):
        arr = _sweep_block(s, ei, len(sweeps), seq, icao, lat, lon, height_m, vcp, epoch_ms)
        seq += arr.shape[0]
        for i in range(0, arr.shape[0], 120):
            records.append(arr[i:i + 120].tobytes())
    jd, jms = _julian(epoch_ms)
    parts = [b"AR2V0006.001" + struct.pack(">ii", jd, jms) + _pad_str(icao, 4)]
    comp = list(_POOL.map(lambda r: bz2.compress(r, 5), records))
    for i, c in enumerate(comp):
        parts.append(struct.pack(">i", -len(c) if i == len(comp) - 1 else len(c)))
        parts.append(c)
    return b"".join(parts)


def archive_name(icao, epoch_ms):
    import datetime as dt
    t = dt.datetime.fromtimestamp(epoch_ms / 1000.0, dt.timezone.utc)
    return "%s%s_V06" % (icao.upper(), t.strftime("%Y%m%d_%H%M%S"))
