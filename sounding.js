'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Soundings: SHARPpy-format parser + parcel/kinematic analysis (adapted from
//  RadarSynth/sounding.js), a hydrostatically balanced base-state builder for
//  the cloud model.
// ─────────────────────────────────────────────────────────────────────────────
const Sounding = (function () {
  const KT = 0.514444, RD = 287.04, CP = 1005.7, LV = 2.501e6, EPS = 0.622, G = 9.80665, RV = 461.5;

  function parseSharppy(text) {
    const out = { title: '', station: '', time: null, levels: [] };
    const lines = text.replace(/\r/g, '').split('\n');
    let mode = '';
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i].trim();
      if (!L) continue;
      if (/^%TITLE%/i.test(L)) { mode = 'title'; continue; }
      if (/^%RAW%/i.test(L)) { mode = 'raw'; continue; }
      if (/^%END%/i.test(L)) { mode = ''; continue; }
      if (mode === 'title') { if (!out.title) { out.title = L; out.station = L.split(/\s+/)[0]; } continue; }
      if (mode === 'raw' || (!mode && /^-?\d/.test(L))) {
        const f = L.split(/[,\s]+/).filter(Boolean).map(Number);
        if (f.length < 6 || f.some(v => !isFinite(v))) continue;
        const [p, h, t, td, wd, ws] = f;
        if (p <= 0 || h < -1000 || h > 40000 || p === -9999) continue;
        out.levels.push({ p, h, t: t > -9990 ? t : NaN, td: td > -9990 ? td : NaN, wd: wd > -9990 ? wd : NaN, ws: ws > -9990 ? ws : NaN });
      }
    }
    out.levels.sort((a, b) => b.p - a.p);
    if (out.levels.length < 4) throw new Error('Could not read at least 4 levels. Expected SHARPpy format: %RAW% rows of  PRES, HGHT, TEMP, DWPT, WDIR, WSPD(kt)  ... %END%');
    return out;
  }
  function es(t) { return 6.112 * Math.exp(17.67 * t / (t + 243.5)); }
  function mixr(p, t) { const e = es(t); return EPS * e / Math.max(p - e, 1e-3); }
  function tvK(tK, w) { return tK * (1 + 0.61 * w); }
  function interpLogP(levels, key, p) {
    for (let i = 0; i < levels.length - 1; i++) {
      const a = levels[i], b = levels[i + 1];
      if (p <= a.p && p >= b.p) {
        const va = a[key], vb = b[key];
        if (!isFinite(va) || !isFinite(vb)) return isFinite(va) ? va : vb;
        const f = Math.log(a.p / p) / Math.log(a.p / b.p);
        return va + (vb - va) * f;
      }
    }
    return NaN;
  }
  function moistStep(p, tK, dp) {
    const f = (pp, T) => { const rs = mixr(pp, T - 273.15); return (1 / pp) * (RD * T + LV * rs) / (CP + LV * LV * rs * EPS / (RD * T * T)); };
    const k1 = f(p, tK), k2 = f(p + dp / 2, tK + dp / 2 * k1), k3 = f(p + dp / 2, tK + dp / 2 * k2), k4 = f(p + dp, tK + dp * k3);
    return tK + dp / 6 * (k1 + 2 * k2 + 2 * k3 + k4);
  }
  function liftParcel(snd, grid, p0, t0, td0) {
    const T0 = t0 + 273.15, TD0 = td0 + 273.15;
    const tl = 1 / (1 / (TD0 - 56) + Math.log(T0 / TD0) / 800) + 56;
    const pl = p0 * Math.pow(tl / T0, 1 / 0.2857);
    const w0 = mixr(p0, td0);
    const theta = T0 * Math.pow(1000 / p0, 0.2857);
    let cin = 0, lfcH = NaN, elH = NaN, above = false, capeTot = 0;
    let moistP = pl, moistT = tl;
    const pts = [];
    for (let k = 0; k < grid.p.length; k++) {
      const p = grid.p[k];
      if (p > p0) continue;
      let tp, wp;
      if (p >= pl) { tp = theta * Math.pow(p / 1000, 0.2857); wp = w0; }
      else {
        while (moistP > p + 1e-6) { const dp = Math.max(-5, p - moistP); moistT = moistStep(moistP, moistT, dp); moistP += dp; }
        tp = moistT; wp = mixr(p, tp - 273.15);
      }
      pts.push({ p, h: grid.h[k], tvp: tvK(tp, wp), tve: grid.tv[k] });
    }
    const lclH = grid.hAt(pl);
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      const buoy = ((a.tvp - a.tve) / a.tve + (b.tvp - b.tve) / b.tve) / 2;
      const e = G * buoy * (b.h - a.h);
      if (buoy > 0) {
        if (!above && b.p < pl + 1) { above = true; if (!isFinite(lfcH)) lfcH = a.h; }
        if (above) { capeTot += e; elH = b.h; }
      } else if (!above) cin += e;
    }
    return { cape: Math.max(0, capeTot), cin: Math.min(0, cin), lclH, lfcH, elH, pLcl: pl };
  }

  function analyze(snd) {
    const lv = snd.levels.filter(l => isFinite(l.h));
    const sfc = lv[0], sfcH = sfc.h;
    const grid = { p: [], h: [], tv: [] };
    for (let p = sfc.p; p >= Math.max(100, lv[lv.length - 1].p); p -= 2) {
      const t = interpLogP(lv, 't', p), td = interpLogP(lv, 'td', p), h = interpLogP(lv, 'h', p);
      if (!isFinite(t) || !isFinite(h)) continue;
      grid.p.push(p); grid.h.push(h - sfcH); grid.tv.push(tvK(t + 273.15, isFinite(td) ? mixr(p, td) : 0));
    }
    grid.hAt = p => { for (let k = 0; k < grid.p.length - 1; k++) if (p <= grid.p[k] && p >= grid.p[k + 1]) { const f = Math.log(grid.p[k] / p) / Math.log(grid.p[k] / grid.p[k + 1]); return grid.h[k] + (grid.h[k + 1] - grid.h[k]) * f; } return p > grid.p[0] ? 0 : grid.h[grid.h.length - 1]; };
    const sb = liftParcel(snd, grid, sfc.p, sfc.t, sfc.td);
    let thS = 0, wS = 0, n = 0;
    for (let p = sfc.p; p >= sfc.p - 100; p -= 1) {
      const t = interpLogP(lv, 't', p), td = interpLogP(lv, 'td', p);
      if (!isFinite(t) || !isFinite(td)) continue;
      thS += (t + 273.15) * Math.pow(1000 / p, 0.2857); wS += mixr(p, td); n++;
    }
    thS /= n; wS /= n;
    const mlT = thS * Math.pow(sfc.p / 1000, 0.2857) - 273.15;
    const eML = wS * sfc.p / (EPS + wS), lnE = Math.log(eML / 6.112), mlTd = 243.5 * lnE / (17.67 - lnE);
    const ml = liftParcel(snd, grid, sfc.p, mlT, Math.min(mlTd, mlT));
    let best = null, bestTe = -1;
    for (const l of lv) {
      if (l.p < sfc.p - 300 || !isFinite(l.t) || !isFinite(l.td)) continue;
      const w = mixr(l.p, l.td), te = (l.t + 273.15) * Math.pow(1000 / l.p, 0.2857) * Math.exp(LV * w / (CP * (l.t + 273.15)));
      if (te > bestTe) { bestTe = te; best = l; }
    }
    const mu = best ? liftParcel(snd, grid, best.p, best.t, best.td) : sb;
    const wl = lv.filter(l => isFinite(l.wd) && isFinite(l.ws)).map(l => { const d = l.wd * Math.PI / 180, s = l.ws * KT; return { z: (l.h - sfcH) / 1000, u: -s * Math.sin(d), v: -s * Math.cos(d) }; });
    function windAt(z) {
      if (z <= wl[0].z) return [wl[0].u, wl[0].v];
      for (let i = 0; i < wl.length - 1; i++) if (z >= wl[i].z && z <= wl[i + 1].z) { const f = (z - wl[i].z) / Math.max(1e-6, wl[i + 1].z - wl[i].z); return [wl[i].u + (wl[i + 1].u - wl[i].u) * f, wl[i].v + (wl[i + 1].v - wl[i].v) * f]; }
      const l = wl[wl.length - 1]; return [l.u, l.v];
    }
    function meanWind(z0, z1) { let u = 0, v = 0, k = 0; for (let z = z0; z <= z1 + 1e-9; z += 0.05) { const w = windAt(z); u += w[0]; v += w[1]; k++; } return [u / k, v / k]; }
    const mean6 = meanWind(0, 6), lo = meanWind(0, 0.5), hi = meanWind(5.5, 6);
    const sh = [hi[0] - lo[0], hi[1] - lo[1]], shm = Math.hypot(sh[0], sh[1]) || 1;
    const rm = [mean6[0] + 7.5 * sh[1] / shm, mean6[1] - 7.5 * sh[0] / shm];
    const lm = [mean6[0] - 7.5 * sh[1] / shm, mean6[1] + 7.5 * sh[0] / shm];
    function srh(z1, cm) { let s = 0, prev = windAt(0); for (let z = 0.02; z <= z1 + 1e-9; z += 0.02) { const w = windAt(z); s += (w[0] - cm[0]) * (prev[1] - cm[1]) - (prev[0] - cm[0]) * (w[1] - cm[1]); prev = w; } return s; }
    function shear(z0, z1) { const a = windAt(z0), b = windAt(z1); return Math.hypot(b[0] - a[0], b[1] - a[1]); }
    const P = {
      sbcape: sb.cape, sbcin: sb.cin, sblcl: sb.lclH, mlcape: ml.cape, mlcin: ml.cin, mllcl: ml.lclH, mllfc: ml.lfcH,
      mucape: mu.cape, el: (isFinite(mu.elH) ? mu.elH : 11000),
      srh05: srh(0.5, rm), srh1: srh(1, rm), srh3: srh(3, rm), shr1: shear(0, 1), shr6: shear(0, 6),
    };
    const lclTerm = P.mllcl < 1000 ? 1 : P.mllcl > 2000 ? 0 : (2000 - P.mllcl) / 1000;
    const shrTerm = P.shr6 < 12.5 ? 0 : Math.min(1.5, P.shr6 / 20);
    const cinTerm = P.mlcin > -50 ? 1 : P.mlcin < -200 ? 0 : (200 + P.mlcin) / 150;
    P.stp = Math.max(0, (P.mlcape / 1500) * lclTerm * (P.srh1 / 150) * shrTerm * cinTerm);
    return { snd, sfcH, windAt, meanWind, P, rm, lm, mean6 };
  }

  // Hydrostatically balanced base state on the cloud model's vertical grid.
  // Returns Float32Array with 8 floats per level k (cell centres):
  //   θ0, qv0, ρ0(centre), ρ0(bottom face), π0, p0 (Pa), u0, v0  (winds minus `motion`)
  // plus level nz holding the top face density in slot 3.
  function baseState(snd, nz, dz, motion) {
    const lv = snd.levels.filter(l => isFinite(l.h) && isFinite(l.t)).slice().sort((a, b) => a.h - b.h);
    const sfcH = lv[0].h, sfcP = lv[0].p;
    const byH = (key, zAgl) => {
      const h = zAgl + sfcH;
      if (h <= lv[0].h) return lv[0][key];
      for (let i = 0; i < lv.length - 1; i++) if (h <= lv[i + 1].h) {
        const a = lv[i], b = lv[i + 1], f = (h - a.h) / Math.max(b.h - a.h, 1e-3);
        const va = a[key], vb = b[key];
        if (!isFinite(va) || !isFinite(vb)) return isFinite(va) ? va : vb;
        if (key === 'p') return Math.exp(Math.log(va) + (Math.log(vb) - Math.log(va)) * f);
        return va + (vb - va) * f;
      }
      return NaN;
    };
    const top = lv[lv.length - 1];
    const wind = z => {
      const a = analyze(snd); return a.windAt(z / 1000);
    };
    const A = analyze(snd);
    const B = new Float32Array((nz + 1) * 8);
    // θ, qv at centres from the sounding (above its top: isothermal, very dry)
    const th = [], qv = [];
    for (let k = 0; k < nz; k++) {
      const z = (k + 0.5) * dz;
      let T = byH('t', z), Td = byH('td', z), p = byH('p', z);
      if (!isFinite(T) || !isFinite(p)) { const dzt = z + sfcH - top.h; T = top.t; p = top.p * Math.exp(-G * dzt / (RD * (top.t + 273.15))); Td = Math.min(top.td, -80); }
      if (!isFinite(Td)) Td = T - 30;
      Td = Math.min(Td, T - 0.3);
      th.push((T + 273.15) * Math.pow(1000 / p, RD / CP));
      qv.push(Math.max(1e-7, mixr(p, Td)));
    }
    // integrate π upward on faces
    const piF = new Float64Array(nz + 1); piF[0] = Math.pow(sfcP / 1000, RD / CP);
    for (let k = 0; k < nz; k++) piF[k + 1] = piF[k] - G * dz / (CP * th[k] * (1 + 0.61 * qv[k]));
    for (let k = 0; k < nz; k++) {
      const pi = 0.5 * (piF[k] + piF[k + 1]);
      const p = 100000 * Math.pow(pi, CP / RD), T = th[k] * pi;
      // cap relative humidity at 97 % to avoid spontaneous condensation of the base state
      const esx = 611.2 * Math.exp(17.67 * (T - 273.15) / (T - 29.65)), qvs = EPS * esx / (p - esx);
      qv[k] = Math.min(qv[k], 0.97 * qvs);
      const rho = p / (RD * T * (1 + 0.61 * qv[k]));
      const w = A.windAt((k + 0.5) * dz / 1000);
      B.set([th[k], qv[k], rho, 0, pi, p, w[0] - motion[0], w[1] - motion[1]], k * 8);
    }
    // face densities
    for (let k = 0; k <= nz; k++) {
      let r;
      if (k === 0) r = B[2] + (B[2] - B[10]) * 0.5;
      else if (k === nz) r = B[(nz - 1) * 8 + 2] * 0.94;
      else r = 0.5 * (B[(k - 1) * 8 + 2] + B[k * 8 + 2]);
      B[k * 8 + 3] = r;
    }
    return { B, sfcP, sfcH, analysis: A };
  }

  return { parseSharppy, analyze, baseState, mixr, KT };
})();
