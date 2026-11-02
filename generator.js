var SoundingGen = SoundingGen || {};

(function (G) {
  var Rng = G.Rng, R = G.Regimes;
  var RD = 287.04, CP = 1005.7, GRAV = 9.80665, LV = 2.501e6, EPS = 0.622, ZK = 273.15;
  var GAMMA_D = GRAV / CP * 1000;
  var DZ = 10;

  function esw(t) { return 6.112 * Math.exp(17.67 * t / (t + 243.5)); }
  function esi(t) { return 6.112 * Math.exp(22.46 * t / (272.62 + t)); }
  function mixr(p, td) { var e = esw(td); if (e > 0.99 * p) e = 0.99 * p; return 621.97 * e / (p - e); }
  function tdFromE(e) { if (e < 1e-10) e = 1e-10; var l = Math.log(e / 6.112); return 243.5 * l / (17.67 - l); }
  function tdFromW(w, p) { return tdFromE(p * w / (621.97 + w)); }
  function moistLapse(t, p) {
    var tk = t + ZK, rs = mixr(p, t) / 1000;
    return GRAV * (1 + LV * rs / (RD * tk)) / (CP + LV * LV * rs * EPS / (RD * tk * tk)) * 1000;
  }
  function smooth(e0, e1, x) { var t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
  function gauss(z, c, w) { var d = (z - c) / w; return Math.exp(-d * d); }
  function box(z, a, b, edge) { return smooth(a - edge, a + edge, z) * (1 - smooth(b - edge, b + edge, z)); }

  function uvOf(a) { var r = a[0] * Math.PI / 180; return [-a[1] * Math.sin(r), -a[1] * Math.cos(r)]; }
  function dirspd(u, v) {
    var s = Math.sqrt(u * u + v * v);
    var d = (270 - Math.atan2(v, u) * 180 / Math.PI) % 360;
    if (d < 0) d += 360;
    return [d, s];
  }
  function crot(c, ang) { var co = Math.cos(ang), si = Math.sin(ang); return [c[0] * co - c[1] * si, c[0] * si + c[1] * co]; }
  function cmul(a, b) { return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]; }
  function cexp(re, im) { var m = Math.exp(re); return [m * Math.cos(im), m * Math.sin(im)]; }

  function pchip(xs, ys) {
    var n = xs.length, h = [], d = [], m = new Array(n), i;
    for (i = 0; i < n - 1; i++) { h[i] = xs[i + 1] - xs[i]; d[i] = (ys[i + 1] - ys[i]) / h[i]; }
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) m[i] = 0;
      else {
        var w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
      }
    }
    return function (x) {
      if (x <= xs[0]) return ys[0];
      if (x >= xs[n - 1]) return ys[n - 1];
      var k = 0;
      while (k < n - 2 && x > xs[k + 1]) k++;
      var t = (x - xs[k]) / h[k], t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h[k] * m[k] +
             (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h[k] * m[k + 1];
    };
  }

  function ar1(rng, n, sd, corrLen) {
    var a = Math.exp(-DZ / corrLen), s = sd * Math.sqrt(1 - a * a), out = new Array(n), x = rng.norm(0, sd);
    for (var i = 0; i < n; i++) { x = a * x + rng.norm(0, s); out[i] = x; }
    return out;
  }

  function pickHour(rng, regime) {
    if (regime.tier !== 'slop' && rng.chance(0.1)) return rng.chance(0.6) ? '18' : '21';
    var w00 = 0.52 * ((regime.prefer && regime.prefer['00']) || 1);
    var w12 = 0.48 * ((regime.prefer && regime.prefer['12']) || 1);
    return rng.u() * (w00 + w12) < w00 ? '00' : '12';
  }

  function pickRegime(rng, st, forced, month) {
    if (forced && R.byKey[forced]) return R.byKey[forced];
    var base = {}, seas = {};
    var items = R.list.map(function (g) {
      var w0 = g.w * R.TIERS[g.tier].mult * ((g.mult && g.mult[st.region] !== undefined) ? g.mult[st.region] : 1);
      var mm = R.MONTH_MULT[g.key] ? R.MONTH_MULT[g.key][(month || 5) - 1] : 1;
      base[g.tier] = (base[g.tier] || 0) + w0;
      seas[g.tier] = (seas[g.tier] || 0) + w0 * mm;
      return { g: g, w: w0 * mm };
    });
    items.forEach(function (it) { if (seas[it.g.tier] > 0) it.w = it.w * base[it.g.tier] / seas[it.g.tier]; });
    return rng.wpick(items, 'w').g;
  }

  function applyFlaw(r, f, rng, s) {
    if (r.flaws.indexOf(f) < 0) r.flaws.push(f);
    var a1 = r.anchors[1];
    if (f === 'crosswise') {
      r.sfc = R.A(a1[0] - rng.uni(-10, 15), Math.max(r.sfc[1], a1[1] * rng.uni(0.35, 0.55)));
      r.alpha = rng.uni(0, 8); r.r = rng.uni(0.65, 0.9); r.ekD = rng.uni(450, 700);
      if (r.llj) r.llj.spd *= 0.4;
      r.crosswise = true;
    } else if (f === 'veerback') {
      r.veerBack = { z: rng.uni(3800, 6500), w: rng.uni(700, 1300), ang: rng.uni(18, 40) * s };
    } else if (f === 'dryMid') {
      r.dryMid = true; r.rh.mid *= 0.5;
    } else if (f === 'strongCap') {
      r.cap.dT += rng.uni(2, 4.5) * s; r.cap.dz = Math.max(r.cap.dz, 150);
    } else if (f === 'weakLL') {
      r.anchors[1] = R.A(a1[0], a1[1] * rng.uni(0.5, 0.75)); r.llj = null; r.sfc[1] *= rng.uni(0.6, 0.85);
    } else if (f === 'highLCL') {
      r.tdSfc -= rng.uni(3, 6.5) * s;
    } else if (f === 'junk') {
      r.wm = rng.uni(0.85, 1.0); r.eml = null; r.rh.mid = Math.max(r.rh.mid, rng.uni(0.6, 0.9));
      r.moistLayers += 2; r.t500 += rng.uni(1, 3);
    } else if (f === 'backedUpper') {
      r.jet.dir -= rng.uni(20, 45); r.jet.spd *= rng.uni(0.5, 0.7);
      var a9 = r.anchors[9]; r.anchors[9] = R.A(a9[0] - rng.uni(15, 35), a9[1] * rng.uni(0.6, 0.8));
    } else if (f === 'shallowMoist') {
      r.moistDepth = rng.uni(350, 700);
    } else if (f === 'outflow') {
      r.coolLayer = { depth: rng.uni(300, 800), dT: rng.uni(4, 8), satur: rng.uni(0.85, 1.0) };
      r.sfc = R.A(rng.uni(330, 420), rng.uni(8, 20)); r.alpha = rng.uni(0, 20);
    }
  }

  function makeRecipe(rng, regime, st, hour, month) {
    var r = regime.make(rng.fork('recipe'), st);
    r.key = regime.key; r.tier = regime.tier; r.label = regime.label; r.blurb = regime.blurb;
    var fr = rng.fork('flaw');
    var chanceMap = { slop: 0.25, moderate: 0.35, juicy: 0.28 };
    if (regime.key !== 'marginaltor' && fr.chance(chanceMap[regime.tier])) {
      var pool = regime.tier === 'juicy' ? ['veerback', 'crosswise', 'dryMid', 'strongCap', 'weakLL', 'outflow']
        : ['veerback', 'crosswise', 'dryMid', 'strongCap', 'weakLL', 'highLCL', 'junk', 'backedUpper', 'outflow', 'shallowMoist'];
      applyFlaw(r, fr.pick(pool), fr, regime.tier === 'juicy' ? 0.6 : 1);
    } else if (regime.key === 'marginaltor') {
      var fl = r.flaws.slice(); r.flaws = [];
      fl.forEach(function (f) { applyFlaw(r, f, fr, 1); });
    }
    var S = R.SEASON[(month || 5) - 1], cold = !!R.COLD_REGIMES[regime.key];
    var sT = cold ? 1 : 0.45, s5 = cold ? 1 : 0.7;
    r.tSfc += S.t * sT;
    r.tdSfc += S.td * sT;
    r.t500 += S.t500 * s5;
    r.zTrop += S.trop;
    r.jet.spd *= S.jet;
    [3, 6, 9].forEach(function (k) {
      if (r.anchors[k]) r.anchors[k] = R.A(r.anchors[k][0], r.anchors[k][1] * (k === 3 ? Math.sqrt(S.jet) : S.jet));
    });
    var ek = st.elev / 1000, dl = st.lat - 35;
    r.tSfc += -0.45 * dl - 2.2 * ek;
    r.tdSfc += -0.25 * dl - 4.2 * ek;
    r.t500 += -0.35 * dl;
    r.zTrop += -120 * dl;
    if (r.tdSfc > r.tSfc - 0.5) r.tdSfc = r.tSfc - 0.5;
    r.hour = hour;
    return r;
  }

  function build(rng, r, st) {
    var hour = r.hour, night = hour === '12', late = hour === '06', morning = hour === '1630';
    var elev = st.elev;
    var zTopMsl = rng.chance(0.04) ? rng.uni(13500, 17000) : rng.uni(19000, 25000);
    var n = Math.floor((zTopMsl - elev) / DZ) + 1;
    var z = new Array(n), i;
    for (i = 0; i < n; i++) z[i] = i * DZ;

    var slp = r.tier === 'juicy' ? rng.uni(994, 1009) : rng.uni(1000, 1020);
    var tMean = r.tSfc + ZK + 0.0065 * elev / 2;
    var psfc = slp * Math.exp(-GRAV * elev / (RD * tMean));

    var t0 = r.tSfc;
    if (hour === '18') t0 -= rng.uni(1.5, 3.5);
    if (hour === '21') t0 -= rng.uni(0, 1.2);
    if (night) t0 -= rng.uni(0.5, 2.0);
    if (late) t0 -= rng.uni(0.3, 1.0);
    if (morning) t0 -= rng.uni(3, 6);
    var hBL = r.hBL * (hour === '18' ? rng.uni(0.7, 0.9) : (morning ? rng.uni(0.4, 0.65) : 1));
    var md = r.moistDepth;

    var w0 = mixr(psfc, r.tdSfc);
    for (var it = 0; it < 12; it++) {
      var wMean = w0 * (1 - r.moistDrop * 0.45 * Math.min(1, hBL / md));
      var tTop = t0 - GAMMA_D * hBL / 1000;
      var pTop = psfc * Math.exp(-GRAV * hBL / (RD * (t0 + ZK - GAMMA_D * hBL / 2000)));
      if (wMean <= mixr(pTop, tTop) * 0.97 || hBL < 300) break;
      hBL *= 0.92;
    }
    if (md < hBL * 0.6 && r.key !== 'shallowmoist' && r.flaws.indexOf('shallowMoist') < 0 && r.key !== 'dryhighplains') md = hBL * rng.uni(0.8, 1.05);

    var capBot = hBL, capTop = hBL + (r.cap.dT > 0 ? r.cap.dz : 0);
    var emlTop = capTop;
    if (r.eml) emlTop = Math.min(capTop + r.eml.depth, 5000 - elev * 0.9);
    var zTropAgl = r.zTrop - elev;

    var sheets = [];
    var ns = r.sheets;
    for (i = 0; i < ns; i++) {
      var zc = rng.uni(Math.max(emlTop, 1500), zTropAgl - 800);
      var th = rng.uni(80, 450);
      sheets.push({ a: zc, b: zc + th, rate: rng.uni(0.5, 2.8) / th * 1000 });
    }
    if (r.frontInv) sheets.push({ a: r.frontInv.z, b: r.frontInv.z + r.frontInv.dz, rate: r.frontInv.dT / r.frontInv.dz * 1000 });
    var lapseNoise = ar1(rng, n, rng.uni(0.6, 1.3), rng.uni(120, 280));
    var mlNoise = ar1(rng, n, 0.25, 60);
    var stratLapse2 = rng.uni(-1.6, -0.3);

    function lapseAt(zz, t, p, gc, idx) {
      var g;
      if (zz < capBot) g = GAMMA_D + (night ? 0 : 0) + mlNoise[idx] * 0.4;
      else if (zz < capTop) g = -r.cap.dT / r.cap.dz * 1000;
      else if (r.eml && zz < emlTop) g = r.eml.lapse + lapseNoise[idx] * 0.5;
      else g = r.wm * moistLapse(t, p) + (1 - r.wm) * gc + lapseNoise[idx];
      var tb = smooth(zTropAgl - r.tropSharp * 0.5, zTropAgl + r.tropSharp * 0.5, zz);
      if (tb > 0) {
        var sl = zz < zTropAgl + 2500 ? r.stratLapse : stratLapse2;
        g = g * (1 - tb) + (sl + lapseNoise[idx] * 0.6) * tb;
      }
      for (var k = 0; k < sheets.length; k++) {
        if (zz >= sheets[k].a && zz < sheets[k].b) g -= sheets[k].rate;
      }
      if (zz < capBot && zz > capBot - 30 && g < GAMMA_D) g = GAMMA_D;
      return g;
    }

    function integrate(gc) {
      var T = new Array(n), P = new Array(n);
      T[0] = t0; P[0] = psfc;
      for (var k = 0; k < n - 1; k++) {
        var g = lapseAt(z[k], T[k], P[k], gc, k);
        T[k + 1] = T[k] - g * DZ / 1000;
        var tv = 0.5 * (T[k] + T[k + 1]) + ZK;
        P[k + 1] = P[k] * Math.exp(-GRAV * DZ / (RD * tv));
      }
      return { T: T, P: P };
    }
    function tAtP(res, pp) {
      for (var k = 1; k < n; k++) {
        if (res.P[k] <= pp) {
          var f = Math.log(pp / res.P[k - 1]) / Math.log(res.P[k] / res.P[k - 1]);
          return res.T[k - 1] + f * (res.T[k] - res.T[k - 1]);
        }
      }
      return res.T[n - 1];
    }

    var gcA = 6.5, resA = integrate(gcA), fA = tAtP(resA, 500) - r.t500;
    var gcB = 7.2, resB = integrate(gcB), fB = tAtP(resB, 500) - r.t500;
    for (it = 0; it < 6 && Math.abs(fB) > 0.05; it++) {
      var gcN = gcB - fB * (gcB - gcA) / (fB - fA);
      if (!isFinite(gcN)) break;
      gcN = Math.max(4, Math.min(9.0, gcN));
      gcA = gcB; fA = fB; gcB = gcN;
      resB = integrate(gcB); fB = tAtP(resB, 500) - r.t500;
    }
    var T = resB.T, P = resB.P;

    var gw1 = { a: rng.uni(0.4, 1.8), l: rng.uni(1500, 3500), ph: rng.uni(0, 6.28) };
    var gw2 = { a: rng.uni(0.2, 0.9), l: rng.uni(700, 1400), ph: rng.uni(0, 6.28) };
    var hs = rng.uni(30, 110);
    var exc = hour === '00' ? rng.uni(0.4, 2.0) : ((hour === '12' || late) ? 0 : (morning ? rng.uni(1.0, 2.5) : rng.uni(1.5, 3.5)));
    var tWhite = 0.06;
    for (i = 0; i < n; i++) {
      var zz = z[i];
      var above = smooth(zTropAgl, zTropAgl + 1200, zz);
      if (above > 0) {
        T[i] += above * (gw1.a * Math.sin(2 * Math.PI * zz / gw1.l + gw1.ph) + gw2.a * Math.sin(2 * Math.PI * zz / gw2.l + gw2.ph));
      }
      if (exc > 0) T[i] += exc * Math.exp(-zz / hs);
      T[i] += rng.norm(0, tWhite);
    }

    var nocturnal = null;
    if (night) {
      var windF = Math.min(1, r.sfc[1] / 25);
      var cloudy = r.cloudTopBL > 0.45 || r.rh.low > 0.7;
      nocturnal = {
        depth: rng.uni(150, 450) * (1 + 0.8 * windF),
        dT: rng.uni(4, 11) * (1 - 0.55 * windF) * (cloudy ? 0.6 : 1),
        k: rng.uni(1.8, 3.2)
      };
      if (r.coolLayer) nocturnal.dT *= 0.25;
    } else if (late) {
      var windF2 = Math.min(1, r.sfc[1] / 25);
      nocturnal = {
        depth: rng.uni(100, 300) * (1 + 0.8 * windF2),
        dT: rng.uni(3, 8) * (1 - 0.55 * windF2) * (r.coolLayer ? 0.25 : 1),
        k: rng.uni(1.8, 3.2)
      };
    } else if (r.eveningStable) {
      nocturnal = { depth: r.eveningStable.depth, dT: r.eveningStable.dT, k: 2.0 };
    } else if (hour === '00' && rng.chance(0.2)) {
      nocturnal = { depth: rng.uni(40, 120), dT: rng.uni(0.4, 1.5), k: 2.0 };
    }
    if (nocturnal) {
      var ek = Math.exp(-nocturnal.k);
      for (i = 0; i < n; i++) {
        var x = z[i] / nocturnal.depth;
        if (x >= 1) break;
        T[i] -= nocturnal.dT * (Math.exp(-nocturnal.k * x) - ek) / (1 - ek);
      }
    }
    var cool = r.coolLayer;
    if (cool) {
      for (i = 0; i < n; i++) {
        var xc = z[i] / cool.depth;
        if (xc > 1.3) break;
        var gfac = cool.inv ? (1 - 0.15 * Math.min(xc, 0.8)) * (1 - smooth(0.82, 1.05, xc)) : (1 - smooth(0.45, 1.15, xc));
        T[i] -= cool.dT * gfac;
      }
    }

    var RH = new Array(n), W = new Array(n);
    var rhNoiseBL = ar1(rng, n, 0.035, rng.uni(60, 150));
    var rhNoiseFT = ar1(rng, n, rng.uni(0.07, 0.14), rng.uni(180, 420));
    var rhNoiseFine = ar1(rng, n, rng.uni(0.02, 0.05), 30);
    var tz = rng.uni(40, 180);
    var moistL = [], dryL = [];
    for (i = 0; i < r.moistLayers; i++) {
      var mc = rng.uni(md + 300, Math.max(md + 400, zTropAgl - 800)), mt = rng.uni(200, 1600);
      moistL.push({ a: mc, b: mc + mt, rh: rng.uni(0.72, 1.0), e: rng.uni(20, 90) });
    }
    for (i = 0; i < r.drySlots; i++) {
      var dc = rng.uni(md + 150, 9000), dt = rng.uni(150, 1200);
      dryL.push({ a: dc, b: dc + dt, rh: rng.uni(0.03, 0.14), e: rng.uni(15, 70) });
    }
    var blCloud = !night && !late && rng.chance(r.cloudTopBL) ? { a: hBL - rng.uni(40, 200), b: hBL + rng.uni(0, 60), rh: rng.uni(0.95, 0.99) } : null;
    var stratus = (night || late) && rng.chance(Math.min(0.8, r.cloudTopBL + (r.tdSfc > 17 ? 0.25 : 0))) && nocturnal
      ? { a: nocturnal.depth * rng.uni(0.8, 1.6), b: 0, rh: rng.uni(0.95, 0.99) } : null;
    if (stratus) stratus.b = stratus.a + rng.uni(150, 500);
    if (cool && cool.satur > 0.9 && rng.chance(0.5)) moistL.push({ a: cool.depth * 0.3, b: cool.depth * 1.1, rh: rng.uni(0.93, 1.0), e: 40 });

    var rhAnch = pchip([md, 5000, 9000, zTropAgl, zTropAgl + 1500, zTropAgl + 20000],
      [r.rh.low, r.rh.mid, r.rh.high, r.rh.high * 0.6, rng.uni(0.03, 0.08), rng.uni(0.015, 0.04)]);

    for (i = 0; i < n; i++) {
      var zi = z[i];
      var wBL = w0 * (1 - r.moistDrop * Math.pow(Math.min(zi, md) / md, 1.3));
      if (cool) wBL = Math.max(wBL, cool.satur * mixr(P[i], T[i]) * (1 - smooth(0.7, 1.2, zi / cool.depth)));
      wBL *= Math.exp(rhNoiseBL[i]);
      var rhFT = rhAnch(Math.max(zi, md));
      if (r.dryMid) rhFT *= 1 - 0.65 * box(zi, 2800, 6200, 300);
      if (r.eml && zi > capTop && zi < emlTop) rhFT = Math.min(rhFT, r.rh.low * 1.2);
      for (var m = 0; m < moistL.length; m++) {
        var b1 = box(zi, moistL[m].a, moistL[m].b, moistL[m].e);
        if (b1 > 0) rhFT = rhFT + (Math.max(rhFT, moistL[m].rh) - rhFT) * b1;
      }
      for (m = 0; m < dryL.length; m++) {
        var b2 = box(zi, dryL[m].a, dryL[m].b, dryL[m].e);
        if (b2 > 0) rhFT = rhFT + (Math.min(rhFT, dryL[m].rh) - rhFT) * b2;
      }
      rhFT *= Math.exp(rhNoiseFT[i] + rhNoiseFine[i]);
      var ws = mixr(P[i], T[i]);
      var wFT = rhFT * ws;
      var bl = 1 - smooth(md - tz * 0.5, md + tz * 0.5, zi);
      var w = Math.exp(bl * Math.log(Math.max(wBL, 1e-4)) + (1 - bl) * Math.log(Math.max(wFT, 1e-4)));
      var rh = w / ws;
      if (blCloud && zi > blCloud.a && zi < blCloud.b) rh = Math.max(rh, blCloud.rh + rhNoiseBL[i] * 0.3);
      if (stratus && zi > stratus.a && zi < stratus.b) rh = Math.max(rh, stratus.rh + rhNoiseBL[i] * 0.3);
      if (T[i] < -5) {
        var iceCap = esi(T[i]) / esw(T[i]) * rng.uni(0.97, 1.04);
        if (rh > iceCap) rh = iceCap;
      }
      if (rh > 1) rh = 1;
      RH[i] = rh;
    }
    if (night || late) {
      var dep = rng.uni(0, 2.8);
      var tdS = Math.min(r.tdSfc - rng.uni(0, 1.5), T[0] - dep);
      var rhS = esw(tdS) / esw(T[0]);
      for (i = 0; i < n && z[i] < 120; i++) {
        var fb = 1 - z[i] / 120;
        RH[i] = RH[i] * (1 - fb) + Math.min(1, rhS * (1 + 0.1 * z[i] / 120)) * fb;
      }
    }

    var inCloud = false, dipLeft = 0, dipAmp = 0, dipLen = 1;
    for (i = 0; i < n; i++) {
      if (RH[i] > 0.95 && T[i] > -12) inCloud = true;
      else if (inCloud && RH[i] < 0.85) {
        inCloud = false;
        if (rng.chance(0.15)) { dipAmp = rng.uni(0.4, 1.6); dipLen = rng.uni(60, 260); dipLeft = dipLen; }
      }
      if (dipLeft > 0) { T[i] -= dipAmp * dipLeft / dipLen; dipLeft -= DZ; }
    }

    var rhF = new Array(n);
    rhF[0] = RH[0];
    for (i = 1; i < n; i++) {
      var tl = T[i];
      var lag = tl > 0 ? 6 : (tl > -20 ? 6 + (-tl) * 0.8 : (tl > -40 ? 22 + (-tl - 20) * 1.5 : 52 + (-tl - 40) * 5));
      var a = Math.min(1, DZ / lag);
      rhF[i] = rhF[i - 1] + (RH[i] - rhF[i - 1]) * a;
    }

    var TD = new Array(n);
    for (i = 0; i < n; i++) {
      var td = tdFromE(Math.max(rhF[i], 0.0005) * esw(T[i]));
      if (td > T[i]) td = T[i];
      if (td < -99) td = -99 + rng.uni(-0.5, 0.5);
      TD[i] = td;
    }
    for (i = 0; i < n; i++) W[i] = mixr(P[i], TD[i]);
    P[0] = psfc;
    for (i = 0; i < n - 1; i++) {
      var tv1 = (T[i] + ZK) * (1 + W[i] / 1000 / EPS) / (1 + W[i] / 1000);
      var tv2 = (T[i + 1] + ZK) * (1 + W[i + 1] / 1000 / EPS) / (1 + W[i + 1] / 1000);
      P[i + 1] = P[i] * Math.exp(-GRAV * DZ / (RD * 0.5 * (tv1 + tv2)));
    }

    var U = new Array(n), V = new Array(n);
    var wsfc = uvOf(r.sfc);
    var alpha = r.alpha * Math.PI / 180;
    var vg0 = crot([wsfc[0] / r.r, wsfc[1] / r.r], -alpha);
    var anchorsZ = [0], anchorsU = [vg0[0]], anchorsV = [vg0[1]];
    var jetAgl = r.jet.z - elev;
    var c1 = uvOf(r.anchors[1]);
    var d0 = dirspd(vg0[0], vg0[1]), d1 = dirspd(c1[0], c1[1]);
    var dd = ((d1[0] - d0[0] + 540) % 360) - 180;
    var c05 = uvOf([d0[0] + dd * rng.uni(0.05, 0.25), d0[1] + (d1[1] - d0[1]) * rng.uni(0.45, 0.7)]);
    anchorsZ.push(500); anchorsU.push(c05[0]); anchorsV.push(c05[1]);
    [1, 3, 6, 9].forEach(function (k) {
      var zk = k * 1000;
      if (k === 9 && zk > jetAgl - 600) return;
      if (k === 6 && zk > jetAgl - 1500) return;
      var c = uvOf(r.anchors[k]);
      anchorsZ.push(zk); anchorsU.push(c[0]); anchorsV.push(c[1]);
    });
    var cj = uvOf([r.jet.dir, r.jet.spd]);
    anchorsZ.push(jetAgl); anchorsU.push(cj[0]); anchorsV.push(cj[1]);
    var zs1 = Math.max(zTropAgl, jetAgl) + 3500;
    var cs1 = uvOf([r.jet.dir + rng.uni(-10, 25), r.jet.spd * rng.uni(0.3, 0.5)]);
    anchorsZ.push(zs1); anchorsU.push(cs1[0]); anchorsV.push(cs1[1]);
    var cs2 = uvOf([r.jet.dir + rng.uni(0, 60), r.jet.spd * rng.uni(0.1, 0.25)]);
    anchorsZ.push(Math.max(zs1 + 3000, z[n - 1])); anchorsU.push(cs2[0]); anchorsV.push(cs2[1]);
    var gu = pchip(anchorsZ, anchorsU), gv = pchip(anchorsZ, anchorsV);

    var Aag = [vg0[0] - wsfc[0], vg0[1] - wsfc[1]];
    var phi = hour === '12' ? rng.uni(2.3, 3.5) : (late ? rng.uni(1.2, 2.0) : (hour === '00' ? rng.uni(0, 0.35) : 0));
    if (r.eveningStable && !late) phi = rng.uni(0.2, 0.6);
    var hsn = hour === '12' ? rng.uni(100, 300) : (late ? rng.uni(60, 200) : (r.eveningStable ? r.eveningStable.depth * 0.7 : 0));
    var wsfcN = hour === '12' ? [wsfc[0] * rng.uni(0.3, 0.7), wsfc[1] * rng.uni(0.3, 0.7)]
      : (late ? [wsfc[0] * rng.uni(0.5, 0.85), wsfc[1] * rng.uni(0.5, 0.85)] : wsfc);
    var lljAmp = hour === '12' ? rng.uni(1.15, 1.6) : (late ? rng.uni(1.1, 1.4) : 1);
    var cl = r.llj ? uvOf([r.llj.dir, r.llj.spd * lljAmp]) : null;
    var bumps = [];
    for (i = 0; i < r.bumps; i++) {
      var ang = rng.uni(0, 6.283), amp = rng.uni(0.3, 1) * r.bumpAmp;
      bumps.push({ z: rng.uni(1200, Math.min(14000, zTropAgl + 1000)), w: rng.uni(250, 1100), u: amp * Math.cos(ang), v: amp * Math.sin(ang) });
    }
    var wN1u = ar1(rng, n, 1, rng.uni(120, 220)), wN1v = ar1(rng, n, 1, rng.uni(120, 220));
    var ekD = r.ekD, kap = r.kappa;
    for (i = 0; i < n; i++) {
      var zi2 = z[i];
      var wg = [gu(zi2), gv(zi2)];
      var e = cexp(-zi2 / ekD, -kap * zi2 / ekD);
      var ag = cmul([-Aag[0], -Aag[1]], e);
      if (phi) ag = crot(ag, -phi);
      var uu = wg[0] + ag[0], vv = wg[1] + ag[1];
      if (cl) { var gj = gauss(zi2, r.llj.z, r.llj.w); uu += cl[0] * gj; vv += cl[1] * gj; }
      for (var bb = 0; bb < bumps.length; bb++) {
        var gb = gauss(zi2, bumps[bb].z, bumps[bb].w); uu += bumps[bb].u * gb; vv += bumps[bb].v * gb;
      }
      if (r.veerBack) {
        var rot = crot([uu, vv], r.veerBack.ang * Math.PI / 180 * gauss(zi2, r.veerBack.z, r.veerBack.w));
        uu = rot[0]; vv = rot[1];
      }
      if (hsn > 0) {
        var sfac = 1 - Math.exp(-3 * zi2 / hsn);
        uu = wsfcN[0] + (uu - wsfcN[0]) * sfac;
        vv = wsfcN[1] + (vv - wsfcN[1]) * sfac;
      }
      var sdw = zi2 < 3000 ? 0.8 : (zi2 < 12000 ? 1.3 : 1.0);
      uu += wN1u[i] * sdw + rng.norm(0, 0.3);
      vv += wN1v[i] * sdw + rng.norm(0, 0.3);
      U[i] = uu; V[i] = vv;
    }
    U[0] += rng.norm(0, 1.5); V[0] += rng.norm(0, 1.5);

    return {
      n: n, z: z, p: P, t: T, td: TD, u: U, v: V, elev: elev, psfc: psfc,
      diag: {
        hBL: hBL, moistDepth: md, capTop: capTop, emlTop: r.eml ? emlTop : null,
        zTropAgl: zTropAgl, nocturnal: nocturnal, phi: phi, gcFT: gcB, slp: slp
      }
    };
  }

  var MANDATORY = [1000, 925, 850, 700, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30, 20, 10];

  function sampleAt(g, k) {
    var ds = dirspd(g.u[k], g.v[k]);
    return { p: g.p[k], z: g.z[k] + g.elev, t: g.t[k], td: g.td[k], dir: ds[0], spd: ds[1] };
  }
  function interpP(g, pp) {
    for (var k = 1; k < g.n; k++) {
      if (g.p[k] <= pp) {
        var f = Math.log(pp / g.p[k - 1]) / Math.log(g.p[k] / g.p[k - 1]);
        var L = function (a) { return a[k - 1] + f * (a[k] - a[k - 1]); };
        var ds = dirspd(L(g.u), L(g.v));
        return { p: pp, z: L(g.z) + g.elev, t: L(g.t), td: L(g.td), dir: ds[0], spd: ds[1] };
      }
    }
    return null;
  }

  function highRes(g, rng) {
    var out = [sampleAt(g, 0)], zc = 0;
    while (true) {
      var step = zc < 1000 ? 30 : (zc < 3000 ? 55 : (zc < 10000 ? 110 : 170));
      zc += step * rng.uni(0.6, 1.4);
      var k = Math.round(zc / DZ);
      if (k >= g.n) break;
      out.push(sampleAt(g, k));
    }
    return out;
  }

  function sigLevels(g, rng) {
    var hr = [];
    for (var k = 0; k < g.n; k += 2) hr.push(sampleAt(g, k));
    var keep = new Array(hr.length).fill(false);
    keep[0] = true; keep[hr.length - 1] = true;
    function tol(p, key) { return key === 't' ? (p > 300 ? 1.0 : 2.0) : (p > 300 ? 2.5 : 5); }
    function rec(a, b) {
      if (b - a < 2) return;
      var la = Math.log(hr[a].p), lb = Math.log(hr[b].p), worst = -1, wi = -1;
      for (var i = a + 1; i < b; i++) {
        var f = (Math.log(hr[i].p) - la) / (lb - la);
        ['t', 'td'].forEach(function (key) {
          var d = Math.abs(hr[i][key] - (hr[a][key] + f * (hr[b][key] - hr[a][key]))) / tol(hr[i].p, key);
          if (d > worst) { worst = d; wi = i; }
        });
      }
      if (worst > 1) { keep[wi] = true; rec(a, wi); rec(wi, b); }
    }
    rec(0, hr.length - 1);
    var out = hr.filter(function (_, i) { return keep[i]; });
    MANDATORY.forEach(function (pm) {
      if (pm < g.p[0] && pm > g.p[g.n - 1]) { var s = interpP(g, pm); if (s) out.push(s); }
    });
    var zw = 300;
    while (zw < 3000) { var kk = Math.round(zw / DZ); if (kk < g.n) out.push(sampleAt(g, kk)); zw += 300; }
    out.sort(function (a, b) { return b.p - a.p; });
    var ded = [out[0]];
    for (var i = 1; i < out.length; i++) if (ded[ded.length - 1].p - out[i].p > 0.4) ded.push(out[i]);
    ded.forEach(function (l) { l.dir = Math.round(l.dir / 5) * 5 % 360; });
    return ded;
  }

  function roundLevels(levels) {
    return levels.map(function (l) {
      var spd = Math.round(l.spd);
      return {
        p: Math.round(l.p * 10) / 10, z: Math.round(l.z), t: Math.round(l.t * 10) / 10,
        td: Math.round(l.td * 10) / 10, dir: spd === 0 ? 0 : Math.round(l.dir) % 360, spd: spd
      };
    }).filter(function (l, i, arr) { return i === 0 || l.p < arr[i - 1].p && l.z > arr[i - 1].z; });
  }

  function pad2(x) { return (x < 10 ? '0' : '') + x; }

  function randomSeed() {
    var s = '';
    var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (var i = 0; i < 8; i++) s += abc[Math.floor(Math.random() * abc.length)];
    return s;
  }

  function generate(opts) {
    opts = opts || {};
    var seed = opts.seed || randomSeed();
    var rng = new Rng(seed);
    var st = opts.station ? G.STATIONS.filter(function (s) { return s.id === opts.station; })[0] : null;
    var stRng = rng.fork('station');
    if (!st) st = stRng.wpick(G.STATIONS, 'w');
    var dr = rng.fork('date');
    var year = dr.int(1998, 2025), month = dr.int(1, 6);
    var dim = [31, (year % 4 === 0 ? 29 : 28), 31, 30, 31, 30][month - 1];
    var day = dr.int(1, dim);
    var regime = pickRegime(rng.fork('regime'), st, opts.regime, month);
    var hour = opts.hour || pickHour(rng.fork('hour'), regime);
    var recipe = makeRecipe(rng, regime, st, hour, month);
    var forcing = rng.fork('forcing').range(regime.forcing || [0.3, 0.7]);
    var grid = build(rng.fork('build'), recipe, st);
    var mode = opts.resolution && opts.resolution !== 'auto' ? opts.resolution : (year >= 2014 ? 'high' : 'sig');
    var levels = roundLevels(mode === 'sig' ? sigLevels(grid, rng.fork('sig')) : highRes(grid, rng.fork('hr')));
    var hh = +hour.slice(0, 2), mi = hour.length > 2 ? +hour.slice(2) : 0;
    var date = new Date(Date.UTC(year, month - 1, day + (opts.utcDayOffset || 0), hh, mi, 0));
    var stamp = String(date.getUTCFullYear()).slice(2) + pad2(date.getUTCMonth() + 1) + pad2(date.getUTCDate()) + '/' + pad2(hh) + pad2(mi);
    return {
      seed: seed,
      levels: levels,
      grid: opts.keepGrid ? grid : undefined,
      meta: {
        station: st.id, wmo: st.wmo, name: st.name, lat: st.lat, lon: st.lon, elev: st.elev,
        region: st.region, regionName: G.REGION_NAMES[st.region],
        hour: hour, date: date,
        time: stamp, year: year, month: month, day: day,
        regime: regime.key, regimeLabel: regime.label, tier: regime.tier, blurb: regime.blurb,
        flaws: recipe.flaws.slice(), flawLabels: recipe.flaws.map(function (f) { return R.FLAWS[f]; }),
        resolution: mode, forcing: forcing, diag: grid.diag
      }
    };
  }

  function toSPC(res) {
    var m = res.meta, L = res.levels;
    function pad(v, w) { var s = v.toFixed(2); while (s.length < w) s = ' ' + s; return s; }
    var lines = ['%TITLE%', ' ' + m.station + '   ' + m.time, '',
      '   LEVEL       HGHT       TEMP       DWPT       WDIR       WSPD',
      '-------------------------------------------------------------------', '%RAW%'];
    L.forEach(function (l) {
      lines.push([pad(l.p, 8), pad(l.z, 10), pad(l.t, 10), pad(l.td === null ? -9999 : l.td, 10), pad(l.dir, 10), pad(l.spd, 10)].join(','));
    });
    lines.push('%END%');
    return lines.join('\n');
  }

  function toJSON(res, extra) {
    var m = res.meta;
    var o = {
      format: 'SoundingGen/1', seed: res.seed,
      station: { id: m.station, wmo: m.wmo, name: m.name, lat: m.lat, lon: m.lon, elev: m.elev },
      valid: m.date.toISOString(), regime: { key: m.regime, label: m.regimeLabel, tier: m.tier, flaws: m.flaws },
      columns: ['pres_hPa', 'hght_mMSL', 'tmpc', 'dwpc', 'wdir', 'wspd_kt'],
      levels: res.levels.map(function (l) { return [l.p, l.z, l.t, l.td, l.dir, l.spd]; })
    };
    if (extra) o.params = extra;
    return JSON.stringify(o);
  }

  G.generate = generate;
  G.toSPC = toSPC;
  G.toJSON = toJSON;
  G._internal = { build: build, makeRecipe: makeRecipe, esw: esw, mixr: mixr, dirspd: dirspd };
})(SoundingGen);
