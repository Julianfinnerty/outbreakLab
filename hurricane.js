'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Hurricane mode: a tropical environment over a warm sea (a generated
//  sounding), the land / SST map under the domain, the Saffir–Simpson scale,
//  the infrared colour table and the storm tracker (centre, central pressure,
//  maximum wind, category, landfall).
// ─────────────────────────────────────────────────────────────────────────────

const HUR_DEFAULT = {
  sst: 29.5,          // sea-surface temperature (°C)
  sstGrad: 0,         // SST change per degree of latitude northward (°C)
  rhMid: 70,          // 700–500 hPa relative humidity (%)
  instab: 3.0,        // how cold the free troposphere is: 3 = the Jordan (1958) mean, each K more = 1 K colder aloft
  steerDir: 340, steerKt: 6,   // the storm's steering flow: toward (deg), speed (kt)
  shearFrom: 270, shearKt: 5,  // 850–200 hPa shear: from (deg), magnitude (kt)
  vmaxKt: 40, rmwKm: 60, r0Km: 350, moistCore: true,  // the initial vortex
  lat: 24.3, lon: -88.0,                              // where it starts (landfall in central Louisiana after ~2 days)
  landMoist: 0.15,    // how much moisture land gives, relative to the sea
  envKm: 300,         // beyond this the air is held to the sounding (the storm's calm surroundings)
  // start from: 'vortex' (a balanced warm-core vortex) or 'cluster' (a patch of active convection, genesis)
  start: 'vortex',
  clusterKm: 150,     // the convective cluster's radius
  seedHours: 18,      // how long new storms keep firing in it
  cellRate: 5,        // storm starts per hour in it
  mcvKt: 20,          // its mid-level vortex (max wind at ~5 km; 0 = none, convection alone)
};
// a hurricane setup's own domain, time and radars (kept apart from the outbreak setup's)
const HUR_SETUP = { grid: 'h2', center: { lat: 26.6, lon: -90.3 }, hours: 72, start: '2025-09-01T00:00', radars: ['KLIX', 'KMOB', 'KLCH'], bounds: [], manual: [] };

const Hurricane = (function () {
  const RD = 287.04, CP = 1005.7, LV = 2.501e6, EPS = 0.622, G = 9.80665, KAP = RD / CP, KT = 0.514444;
  const es = t => 6.112 * Math.exp(17.67 * t / (t + 243.5));        // hPa, t °C
  const ws = (p, t) => EPS * es(t) / Math.max(p - es(t), 1e-3);
  const tdFromRh = (t, rh) => { const g = Math.log(Math.max(rh, 1e-4) * es(t) / 6.112); return 243.5 * g / (17.67 - g); };
  // pseudo-adiabatic lapse dT/dp (K / hPa)
  const dTdp = (p, T) => { const r = ws(p, T - 273.15); return (RD * T + LV * r) / (p * (CP + LV * LV * r * EPS / (RD * T * T))); };
  function moistT(p0, T0, p1) {
    let p = p0, T = T0;
    while (p > p1 + 1e-6) {
      const h = -Math.min(2, p - p1);
      const k1 = dTdp(p, T), k2 = dTdp(p + h / 2, T + h / 2 * k1), k3 = dTdp(p + h / 2, T + h / 2 * k2), k4 = dTdp(p + h, T + h * k3);
      T += h / 6 * (k1 + 2 * k2 + 2 * k3 + k4); p += h;
    }
    return T;
  }

  // A hurricane-season tropical sounding (after Jordan 1958 / Dunion 2011): sea-level pressure 1012 hPa, surface air
  // 1 K cooler than the sea at 80 % humidity, a well-mixed boundary layer to ~960 hPa, then a moist adiabat cooled by
  // `instab` K through the free troposphere (CAPE ~1000–2000 J/kg), a −76 °C tropopause near 100 hPa and a warming
  // stratosphere. Above 6 km θ must rise at least 2 K/km, growing to 3.5 K/km by 12 km, as in observed tropical
  // soundings: a pure moist adiabat turns almost dry-adiabatic when it gets that cold (0.4 K/km at 12–14 km), and the
  // hurricane's warm core, which weakens upward above ~9 km, then made the upper troposphere overturn and mixed it away.
  // Winds: the steering flow through the deep layer plus the 850–200 hPa shear, centred on 5 km.
  // Jordan (1958) mean West Indies hurricane-season temperature (°C) by pressure (hPa)
  const JORDAN = [[1000, 26.0], [950, 22.6], [900, 19.8], [850, 17.4], [800, 14.7], [750, 12.2], [700, 9.6], [600, 2.4], [500, -6.9], [400, -17.3],
    [300, -32.4], [250, -41.6], [200, -53.6], [175, -59.8], [150, -65.6], [125, -71.0], [100, -73.5], [70, -69.0], [50, -62.5]];
  function jordanT(p) {
    if (p >= JORDAN[0][0]) return JORDAN[0][1];
    for (let i = 0; i < JORDAN.length - 1; i++) {
      const a = JORDAN[i], b = JORDAN[i + 1];
      if (p <= a[0] && p >= b[0]) return a[1] + (b[1] - a[1]) * Math.log(a[0] / p) / Math.log(a[0] / b[0]);
    }
    return JORDAN[JORDAN.length - 1][1];
  }
  function sounding(H) {
    const psfc = 1012, T0 = H.sst - 1.0, pB = 960, Ttp = -76;
    const ps = [psfc];
    for (let p = 1000; p >= 50; p -= p > 850 ? 10 : p > 200 ? 25 : 10) if (p < psfc - 2) ps.push(p);
    const th0 = (T0 + 273.15) * Math.pow(1000 / psfc, KAP);
    const TB = th0 * Math.pow(pB / 1000, KAP);
    const rhMid = clamp(H.rhMid / 100, 0.1, 0.95);
    const rhAt = p => {
      if (p >= 950) return lerp(0.80, 0.85, (psfc - p) / (psfc - 950));
      if (p >= 850) return 0.85;
      if (p >= 700) return lerp(0.85, rhMid, (850 - p) / 150);
      if (p >= 500) return rhMid;
      if (p >= 300) return lerp(rhMid, Math.max(0.3, rhMid - 0.15), (500 - p) / 200);
      if (p >= 150) return lerp(Math.max(0.3, rhMid - 0.15), 0.3, (300 - p) / 150);
      return 0.1;
    };
    const su = H.steerKt * KT * Math.sin(H.steerDir * DEG), sv = H.steerKt * KT * Math.cos(H.steerDir * DEG);
    // the shear vector (upper minus lower) points away from where the shear comes from
    const hu = -H.shearKt * KT * Math.sin(H.shearFrom * DEG), hv = -H.shearKt * KT * Math.cos(H.shearFrom * DEG);
    const windAt = z => {
      let f = clamp((z - 1500) / 10500, 0, 1) - 0.5;
      if (z > 12000) f = 0.5 * (1 - smooth(12000, 17000, z));
      const lo = z < 1500 ? 0.85 + 0.15 * smooth(0, 1500, z) : 1;
      return [(su + hu * f) * lo, (sv + hv * f) * lo];
    };
    const rows = [];
    let z = 0, pPrev = psfc, tvPrev = 0, tropo = false, z100 = NaN, thPrev = 0, zPrev = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      let T;
      if (p >= pB) T = th0 * Math.pow(p / 1000, KAP) - 273.15;
      else {
        // the free troposphere follows the observed hurricane-season mean (Jordan 1958), shifted by half the SST's departure
        // from 28.5 °C and by the instability setting (3 K = Jordan's own): a moist adiabat from this warm boundary layer
        // was 5–7 K too warm aloft (−2 °C at 500 hPa, −47 °C at 200 hPa), so storms stopped near 12 km under a warm
        // "CDO" and their outflow was too warm for a strong hurricane
        const Tj = jordanT(p) + 0.5 * (H.sst - 28.5) + (3 - H.instab);
        T = lerp(moistT(pB, TB, p) - 273.15, Tj, smooth(pB, 880, p));
        // the minimum stability: estimate this level's height from the layer below at its temperature
        const zEst = z + RD / G * tvPrev * Math.log(pPrev / p);
        const need = zEst > 6000 ? lerp(2e-3, 3.5e-3, smooth(6000, 12000, zEst)) : 0;
        if (need > 0) T = Math.max(T, (thPrev + need * (zEst - zPrev)) * Math.pow(p / 1000, KAP) - 273.15);
      }
      if (T <= Ttp || tropo) { tropo = true; T = Ttp; }
      if (p <= 100) { if (!isFinite(z100)) z100 = z; T = Ttp + 0.0022 * Math.max(0, z - z100); }
      let td = tdFromRh(T, rhAt(p));
      if (p < 120) td = Math.min(td, T - 25, -88);
      const tv = (T + 273.15) * (1 + 0.61 * ws(p, td));
      if (i > 0) z += RD / G * 0.5 * (tv + tvPrev) * Math.log(pPrev / p);
      pPrev = p; tvPrev = tv; thPrev = (T + 273.15) * Math.pow(1000 / p, KAP); zPrev = z;
      const w = windAt(z), spd = Math.hypot(w[0], w[1]) / KT;
      const dir = spd < 0.05 ? 0 : (Math.atan2(-w[0], -w[1]) / DEG + 360) % 360;
      rows.push([p, z, T, td, dir, spd]);
    }
    const f = (v, d) => v.toFixed(d).padStart(10);
    return `%TITLE%\n TROP   ${new Date().toISOString().slice(2, 10).replace(/-/g, '')}/0000  SST ${H.sst.toFixed(1)}C\n\n   LEVEL       HGHT       TEMP       DWPT       WDIR       WSPD\n` +
      '-------------------------------------------------------------------\n%RAW%\n' +
      rows.map(r => [f(r[0], 2), f(r[1], 0), f(r[2], 2), f(r[3], 2), f(r[4], 0), f(r[5], 1)].join(',')).join('\n') + '\n%END%';
  }

  // land fraction (US states from the map data; Mexico, Cuba and the rest are sea) and SST (K) under every column
  function surface(model, geo, H, rings) {
    const nx = model.nx, ny = model.ny, dx = model.dx;
    const cv = document.createElement('canvas'); cv.width = nx; cv.height = ny;
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff';
    for (const r of rings || []) {
      ctx.beginPath();
      for (let i = 0; i < r.lat.length; i++) {
        const [x, y] = geo.toModel(r.lat[i], r.lon[i]);
        const px = x / dx, py = ny - y / dx;
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.closePath(); ctx.fill();
    }
    const img = ctx.getImageData(0, 0, nx, ny).data, out = new Float32Array(nx * ny * 4);
    let land = 0;
    for (let j = 0; j < ny; j++) {
      const lat = geo.fromModel(model.Lx / 2, (j + 0.5) * dx)[0];
      const sst = H.sst + (H.sstGrad || 0) * (lat - H.lat) + 273.15;
      for (let i = 0; i < nx; i++) {
        const a = img[4 * (i + nx * (ny - 1 - j)) + 3] / 255, o = 4 * (i + nx * j);
        out[o] = a; out[o + 1] = sst; land += a;
      }
    }
    return { data: out, landFrac: land / (nx * ny) };
  }

  // Saffir–Simpson by 1-minute 10-m wind (kt)
  const CATS = [
    { min: 0, short: 'TD', name: 'Tropical depression', color: '#5ebaff' },
    { min: 34, short: 'TS', name: 'Tropical storm', color: '#00faf4' },
    { min: 64, short: 'C1', name: 'Category 1 hurricane', color: '#ffffcc' },
    { min: 83, short: 'C2', name: 'Category 2 hurricane', color: '#ffe775' },
    { min: 96, short: 'C3', name: 'Category 3 major hurricane', color: '#ffc140' },
    { min: 113, short: 'C4', name: 'Category 4 major hurricane', color: '#ff8f20' },
    { min: 137, short: 'C5', name: 'Category 5 major hurricane', color: '#ff6060' },
  ];
  const catIndex = kt => { let k = 0; while (k + 1 < CATS.length && kt >= CATS[k + 1].min) k++; return k; };

  // infrared colours: SatPainter's table (the Tropical Tidbits GOES-16/18 Ch13 colorbar, −90…+40 °C at 0.5 °C;
  // js/palettes_ir.js), looked up exactly as SatPainter does: purple below −90 °C, black above +40 °C
  const IR_ROWS = (window.IR_TT || []).map(h => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]);
  function irColor(tc) {
    if (!IR_ROWS.length) return [128, 128, 128];
    if (tc < -90) return [126, 1, 128];
    if (tc > 40) return [0, 0, 0];
    return IR_ROWS[Math.round((tc + 90) * 2)];
  }
  // sea-level pressure shades (hPa)
  const P_STOPS = [[1016, [30, 34, 44, 0]], [1008, [70, 90, 120, 110]], [1000, [60, 130, 190, 150]], [990, [60, 190, 170, 170]], [980, [140, 220, 90, 180]],
    [965, [250, 230, 70, 190]], [950, [255, 150, 40, 200]], [935, [240, 60, 50, 210]], [920, [200, 30, 140, 220]], [890, [255, 190, 255, 230]]];
  function pColor(p) {
    if (p >= P_STOPS[0][0]) return P_STOPS[0][1];
    for (let i = 0; i < P_STOPS.length - 1; i++) {
      const a = P_STOPS[i], b = P_STOPS[i + 1];
      if (p <= a[0] && p >= b[0]) { const f = (a[0] - p) / (a[0] - b[0]); return [0, 1, 2, 3].map(c => a[1][c] + (b[1][c] - a[1][c]) * f); }
    }
    return P_STOPS[P_STOPS.length - 1][1];
  }
  // 10-m wind (kt) shades by the Saffir–Simpson thresholds
  function windColor(kt) {
    if (kt < 20) return null;
    if (kt < 34) return [70, 110, 160, 90 + 90 * (kt - 20) / 14];
    const k = catIndex(kt), h = CATS[k].color;
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 215];
  }

  // ── the storm tracker ──
  // The centre is the lowest surface pressure (refined to the pressure-weighted centroid of the cells within 2 hPa of
  // it), the intensity the strongest ~10-m wind within 200 km of it (1-min sustained, from the lowest model level).
  const T = { track: [], cur: null, landfalls: 0, overLand: false, lastCat: -1, peak: null };
  function reset() { T.track = []; T.cur = null; T.landfalls = 0; T.overLand = false; T.lastCat = -1; T.peak = null; T.pendCat = undefined; T.edgeWarned = false; T.formed = false; T.formT = -1; }
  // near = {x, y, r} (model m): look for the centre only there (the last centre, or a developing cluster), so a
  // convective meso-low elsewhere can't steal the track
  function analyze(maps, model, sfcP, surf, near) {
    const m3 = maps.m3; if (!m3) return null;
    const nx = model.nx, ny = model.ny, dx = model.dx, edge = Math.ceil((model.params.spongeW + 20000) / dx);
    let i0b = edge, i1b = nx - edge, j0b = edge, j1b = ny - edge;
    if (near) {
      const R = Math.ceil(near.r / dx), ic = Math.floor(near.x / dx), jc = Math.floor(near.y / dx);
      i0b = Math.max(i0b, ic - R); i1b = Math.min(i1b, ic + R); j0b = Math.max(j0b, jc - R); j1b = Math.min(j1b, jc + R);
    }
    let pmin = 1e9, im = -1;
    for (let j = j0b; j < j1b; j++) for (let i = i0b; i < i1b; i++) { const q = m3[4 * (i + nx * j)]; if (q < pmin) { pmin = q; im = i + nx * j; } }
    if (im < 0) return null;
    const i0 = im % nx, j0 = Math.floor(im / nx), r = Math.ceil(30000 / dx);
    let sw = 0, sx = 0, sy = 0;
    for (let j = Math.max(0, j0 - r); j <= Math.min(ny - 1, j0 + r); j++) for (let i = Math.max(0, i0 - r); i <= Math.min(nx - 1, i0 + r); i++) {
      const w = Math.max(0, pmin + 2 - m3[4 * (i + nx * j)]); sw += w; sx += w * (i + 0.5); sy += w * (j + 0.5);
    }
    const cx = (sw > 0 ? sx / sw : i0 + 0.5) * dx, cy = (sw > 0 ? sy / sw : j0 + 0.5) * dx;
    const R = Math.ceil(200000 / dx);
    let vmax = 0, rmw = 0;
    const ci = Math.floor(cx / dx), cj = Math.floor(cy / dx);
    for (let j = Math.max(0, cj - R); j <= Math.min(ny - 1, cj + R); j++) for (let i = Math.max(0, ci - R); i <= Math.min(nx - 1, ci + R); i++) {
      const d2 = (i - ci) ** 2 + (j - cj) ** 2; if (d2 > R * R) continue;
      const w = m3[4 * (i + nx * j) + 2]; if (w > vmax) { vmax = w; rmw = Math.sqrt(d2) * dx; }
    }
    const land = surf ? surf[4 * (ci + nx * cj)] : 0;
    // the closed circulation: mean tangential wind at the lowest level, 25–100 km from the centre (a uniform drift
    // averages out around the ring)
    let vtr = 0, nr = 0;
    const m2 = maps.m2, R2 = Math.ceil(100000 / dx);
    if (m2) for (let j = Math.max(0, cj - R2); j <= Math.min(ny - 1, cj + R2); j += 2) for (let i = Math.max(0, ci - R2); i <= Math.min(nx - 1, ci + R2); i += 2) {
      const x = (i + 0.5) * dx - cx, y = (j + 0.5) * dx - cy, r = Math.hypot(x, y);
      if (r < 25000 || r > 100000) continue;
      const o = 4 * (i + nx * j); vtr += (-m2[o] * y + m2[o + 1] * x) / r; nr++;
    }
    const sg = (model.params.lat || 0) < 0 ? -1 : 1;
    return { t: maps.t, x: cx, y: cy, p: sfcP + pmin, kt: vmax / KT, rmw, land, ring: nr ? sg * vtr / nr : 0 };
  }
  return { sounding, surface, CATS, catIndex, irColor, pColor, windColor, analyze, reset, T, KT };
})();
