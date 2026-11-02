'use strict';
// Azimuthal-equidistant projection about the domain centre (metres), shared by the map display,
// the model grid (corner-origin metres) and the virtual radars' beam geometry.
const EARTH_R = 6371000;

class Geo {
  constructor(lat0, lon0, Lx = 0, Ly = 0, groundMSL = 0) {
    this.lat0 = lat0; this.lon0 = lon0; this.Lx = Lx; this.Ly = Ly; this.groundMSL = groundMSL;
    this.p0 = lat0 * DEG; this.l0 = lon0 * DEG; this.sp0 = Math.sin(this.p0); this.cp0 = Math.cos(this.p0);
  }
  // lat/lon (deg) → projected metres (x east, y north) about the centre
  fwd(lat, lon) {
    const p = lat * DEG, dl = lon * DEG - this.l0, sp = Math.sin(p), cp = Math.cos(p), cdl = Math.cos(dl);
    const cc = Math.max(-1, Math.min(1, this.sp0 * sp + this.cp0 * cp * cdl));
    const c = Math.acos(cc), k = c < 1e-9 ? 1 : c / Math.sin(c);
    return [EARTH_R * k * cp * Math.sin(dl), EARTH_R * k * (this.cp0 * sp - this.sp0 * cp * cdl)];
  }
  inv(x, y) {
    const rho = Math.hypot(x, y);
    if (rho < 1e-6) return [this.lat0, this.lon0];
    const c = rho / EARTH_R, sc = Math.sin(c), ccs = Math.cos(c);
    const p = Math.asin(ccs * this.sp0 + y * sc * this.cp0 / rho);
    const l = this.l0 + Math.atan2(x * sc, rho * this.cp0 * ccs - y * this.sp0 * sc);
    return [p / DEG, ((l / DEG + 540) % 360) - 180];
  }
  // model metres from the domain's south-west corner
  toModel(lat, lon) { const [x, y] = this.fwd(lat, lon); return [x + this.Lx / 2, y + this.Ly / 2]; }
  fromModel(mx, my) { return this.inv(mx - this.Lx / 2, my - this.Ly / 2); }
}

function gcDist(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG, p2 = lat2 * DEG, dl = (lon2 - lon1) * DEG;
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

// WSR-88D sites from GR2Analyst's radars.gis (via RadarPainter's mapdata.js); TDWRs are left out
const SITES = (window.MAPDATA && MAPDATA.radars || [])
  .filter(r => !/TDWR/i.test(r[5]))
  .map(r => ({ id: r[0], lat: r[1], lon: r[2], h: r[3], st: r[4], name: r[5] }));

function decodeRings(enc) {
  const out = [];
  for (const flat of enc) {
    const n = flat.length / 2, lon = new Float32Array(n), lat = new Float32Array(n);
    let x = flat[0], y = flat[1]; lon[0] = x / 1000; lat[0] = y / 1000;
    for (let i = 1; i < n; i++) { x += flat[2 * i]; y += flat[2 * i + 1]; lon[i] = x / 1000; lat[i] = y / 1000; }
    out.push({ lon, lat });
  }
  return out;
}
