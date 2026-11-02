var SoundingGen = SoundingGen || {};

SoundingGen.Outlook = (function () {
  var TOR = [0, 2, 5, 10, 15, 30, 45, 60];
  var SVR = [0, 5, 15, 30, 45, 60];
  var CATS = ['NONE', 'TSTM', 'MRGL', 'SLGT', 'ENH', 'MDT', 'HIGH'];
  var COLORS = {
    NONE: '#8a94a3', TSTM: '#c1e9c1', MRGL: '#66a366', SLGT: '#f6f67f', ENH: '#e6c27f', MDT: '#e67f7f', HIGH: '#ff7fff'
  };
  var LABELS = {
    NONE: 'No thunder', TSTM: 'General thunder', MRGL: 'Marginal (1/5)', SLGT: 'Slight (2/5)',
    ENH: 'Enhanced (3/5)', MDT: 'Moderate (4/5)', HIGH: 'High (5/5)'
  };

  function v(x) { return (x === null || x === undefined || !isFinite(x)) ? 0 : x; }
  function step(ladder, idx, down) { return ladder[Math.max(0, Math.min(ladder.length - 1, idx - down))]; }
  function idxOf(ladder, p) { var i = ladder.indexOf(p); return i < 0 ? 0 : i; }
  function forcingSteps(f) { return f < 0.2 ? 3 : (f < 0.35 ? 2 : (f < 0.6 ? 1 : 0)); }

  function tornado(P, f) {
    var stp = Math.max(v(P.stp_cin), 0.8 * v(P.stp_fixed));
    var i;
    if (stp < 0.5) i = 0; else if (stp < 1) i = 1; else if (stp < 2) i = 2; else if (stp < 3.5) i = 3;
    else if (stp < 6) i = 4; else if (stp < 9) i = 5; else if (stp < 13 || f < 0.95) i = (f >= 0.85 ? 6 : 5); else i = 7;
    if (i > 0 && v(P.esrh) < 75 && v(P.srh1km) < 100) i = Math.min(i, 1);
    if (v(P.mlcin) < -150 && v(P.esrh) < 150) i = Math.min(i, 1);
    var p = step(TOR, i, forcingSteps(f));
    return { p: p, sig: p >= 10 && v(P.stp_cin) >= 4 && v(P.esrh) >= 250 };
  }

  function hail(P, f) {
    var mu = v(P.mucape), ship = v(P.ship), eb = Math.max(v(P.ebwd), 0.8 * v(P.shr6));
    var i = 0;
    if (mu < 250) i = 0;
    else if (ship >= 3.2 && eb >= 45 && f >= 0.8) i = 4;
    else if (ship >= 1.8 && eb >= 30) i = 3;
    else if (ship >= 1 || (mu >= 2000 && eb >= 35)) i = 2;
    else if (mu >= 500 && eb >= 20) i = 1;
    var p = step(SVR, i, forcingSteps(f));
    return { p: p, sig: p >= 15 && ship >= 2 };
  }

  function wind(P, f) {
    var mu = v(P.mucape), dcp = v(P.dcp), mw = v(P.meanwind), sh = v(P.shr6), i = 0;
    if (mu < 100) i = 0;
    else if (dcp >= 14 && mw >= 38 && f >= 0.9) i = 5;
    else if (dcp >= 9 && mw >= 32 && f >= 0.75) i = 4;
    else if ((dcp >= 5 && sh >= 35) || (v(P.mlcape) >= 100 && sh >= 60 && v(P.srh1km) >= 300 && mw >= 45)) i = 3;
    else if (dcp >= 1.5 || (mu >= 1000 && (v(P.dcape) >= 1000 || sh >= 40))) i = 2;
    else if (v(P.mlcape) >= 100 && sh >= 50 && v(P.srh1km) >= 200) i = 2;
    else if (mu >= 300) i = 1;
    var p = step(SVR, i, forcingSteps(f));
    return { p: p, sig: p >= 30 && (dcp >= 10 || mw >= 50) };
  }

  function catTor(t) {
    if (t.p >= 45) return t.sig ? 'HIGH' : 'MDT';
    if (t.p >= 30) return t.sig ? 'HIGH' : 'MDT';
    if (t.p >= 15) return t.sig ? 'MDT' : 'ENH';
    if (t.p >= 10) return 'ENH';
    if (t.p >= 5) return 'SLGT';
    if (t.p >= 2) return 'MRGL';
    return 'NONE';
  }
  function catSvr(h, hailMode) {
    if (h.p >= 60) return h.sig && !hailMode ? 'HIGH' : 'MDT';
    if (h.p >= 45) return h.sig ? 'MDT' : 'ENH';
    if (h.p >= 30) return 'ENH';
    if (h.p >= 15) return 'SLGT';
    if (h.p >= 5) return 'MRGL';
    return 'NONE';
  }

  function assess(P, forcing) {
    var f = v(forcing);
    var t = tornado(P, f), h = hail(P, f), w = wind(P, f);
    var cat = 'NONE';
    [catTor(t), catSvr(h, true), catSvr(w, false)].forEach(function (c) {
      if (CATS.indexOf(c) > CATS.indexOf(cat)) cat = c;
    });
    if (cat === 'NONE' && v(P.mucape) >= 150 && f >= 0.15) cat = 'TSTM';
    return {
      cat: cat, label: LABELS[cat], color: COLORS[cat],
      tor: t.p, torSig: t.sig, hail: h.p, hailSig: h.sig, wind: w.p, windSig: w.sig
    };
  }

  function fromProfile(prof) {
    var S = SHARPTAB;
    var first = function (x) { return Array.isArray(x) ? x[0] : x; };
    var mag = function (x) { return Array.isArray(x) ? Math.sqrt(x[0] * x[0] + x[1] * x[1]) : x; };
    var P = {
      mlcape: prof.mlpcl && prof.mlpcl.bplus, mlcin: prof.mlpcl && prof.mlpcl.bminus,
      mucape: prof.mupcl && prof.mupcl.bplus, stp_cin: prof.stp_cin, stp_fixed: prof.stp_fixed,
      esrh: first(prof.right_esrh), srh1km: first(prof.srh1km), ship: prof.ship, dcape: prof.dcape,
      shr6: mag(prof.sfc_6km_shear), ebwd: prof.ebwspd
    };
    var mw = Array.isArray(prof.mean_6km) ? prof.mean_6km[1] : NaN;
    if (!isFinite(mw) && S && S.winds && S.interp) {
      try {
        var p6 = S.interp.pres(prof, S.interp.to_msl(prof, 6000));
        mw = mag(S.winds.mean_wind(prof, prof.pres[prof.sfc], p6));
      } catch (e) { mw = NaN; }
    }
    P.meanwind = mw;
    P.dcp = prof.dcp !== undefined && isFinite(prof.dcp) ? prof.dcp
      : (v(P.dcape) / 980) * (v(P.mucape) / 2000) * (v(P.shr6) / 20) * (v(mw) / 16);
    return P;
  }

  return { assess: assess, fromProfile: fromProfile, COLORS: COLORS, LABELS: LABELS, CATS: CATS };
})();
