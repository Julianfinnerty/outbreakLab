var SoundingGen = SoundingGen || {};

SoundingGen.Regimes = (function () {
  function A(dir, spd) { return [((dir % 360) + 360) % 360, Math.max(0, spd)]; }

  function base(rng, o) {
    var r = {
      hBL: 1500, moistDepth: 1200, moistDrop: 0.15,
      cap: { dT: 0, dz: 120 }, eml: null, wm: 0.5, t500: -12,
      zTrop: 12500, tropSharp: rng.uni(300, 1200), stratLapse: rng.uni(-3.0, -0.8),
      sheets: rng.int(0, 3), frontInv: null, coolLayer: null,
      rh: { low: 0.5, mid: 0.4, high: 0.3 }, moistLayers: rng.int(0, 2), drySlots: rng.int(0, 2),
      cloudTopBL: 0.2, sfc: A(180, 12), alpha: 25, r: 0.55, ekD: 380,
      anchors: {}, jet: { z: 11000, dir: 250, spd: 70 }, llj: null, veerBack: null,
      bumps: rng.int(1, 4), bumpAmp: 5, flaws: [], kappa: rng.uni(0.3, 0.75)
    };
    for (var k in o) r[k] = o[k];
    return r;
  }

  var list = [
    {
      key: 'postfrontal', tier: 'slop', forcing: [0, 0.05], label: 'Post-frontal continental air', w: 12,
      blurb: 'Dry, cool air behind a cold front under northwest flow. Nothing to see.',
      mult: { np: 1.5, gl: 1.4, mw: 1.2, hp: 1.1, gc: 0.4, se: 0.7 },
      make: function (rng, c) {
        var d6 = rng.uni(275, 320);
        return base(rng, {
          tSfc: rng.uni(12, 23), tdSfc: rng.uni(-6, 7), hBL: rng.uni(1400, 2600),
          moistDepth: rng.uni(600, 1800), moistDrop: rng.uni(0.1, 0.35),
          cap: { dT: rng.uni(1, 4.5), dz: rng.uni(150, 450) },
          wm: rng.uni(0.2, 0.45), t500: rng.uni(-23, -14), zTrop: rng.uni(9800, 11600),
          rh: { low: rng.uni(0.15, 0.55), mid: rng.uni(0.1, 0.45), high: rng.uni(0.1, 0.5) },
          cloudTopBL: 0.35,
          sfc: A(rng.uni(310, 360), rng.uni(8, 20)), alpha: rng.uni(15, 35), r: rng.uni(0.45, 0.7), ekD: rng.uni(350, 600),
          anchors: {
            1: A(rng.uni(315, 355), rng.uni(15, 30)), 3: A(rng.uni(300, 340), rng.uni(22, 40)),
            6: A(d6, rng.uni(35, 65)), 9: A(d6 - rng.uni(0, 15), rng.uni(55, 90))
          },
          jet: { z: rng.uni(9500, 11000), dir: d6 - rng.uni(0, 20), spd: rng.uni(70, 120) }
        });
      }
    },
    {
      key: 'capped', tier: 'slop', forcing: [0.05, 0.3], label: 'Capped warm sector', w: 9,
      blurb: 'Rich moisture and an enormous EML lid. Big numbers on paper, blue sky in reality.',
      mult: { sp: 1.8, hp: 1.3, cp: 1.3, se: 0.5, gc: 0.9, np: 0.6, gl: 0.3 },
      make: function (rng) {
        var d6 = rng.uni(225, 265);
        return base(rng, {
          tSfc: rng.uni(28, 36), tdSfc: rng.uni(15, 21), hBL: rng.uni(1100, 2200),
          moistDepth: rng.uni(800, 1500), moistDrop: rng.uni(0.12, 0.3),
          cap: { dT: rng.uni(3, 7.5), dz: rng.uni(100, 300) },
          eml: { depth: rng.uni(2000, 3300), lapse: rng.uni(8.4, 9.4) },
          wm: rng.uni(0.3, 0.6), t500: rng.uni(-11, -5.5), zTrop: rng.uni(12800, 14800),
          rh: { low: rng.uni(0.08, 0.3), mid: rng.uni(0.1, 0.35), high: rng.uni(0.15, 0.5) },
          cloudTopBL: 0.1,
          sfc: A(rng.uni(165, 200), rng.uni(12, 25)), alpha: rng.uni(15, 35), r: rng.uni(0.5, 0.75), ekD: rng.uni(300, 550),
          anchors: {
            1: A(rng.uni(185, 215), rng.uni(20, 40)), 3: A(rng.uni(215, 250), rng.uni(18, 35)),
            6: A(d6, rng.uni(22, 50)), 9: A(d6 + rng.uni(-5, 15), rng.uni(35, 70))
          },
          jet: { z: rng.uni(11000, 12500), dir: d6 + rng.uni(-5, 15), spd: rng.uni(45, 95) }
        });
      }
    },
    {
      key: 'pulse', tier: 'slop', forcing: [0.5, 0.9], label: 'Weak-shear airmass (pulse)', w: 9,
      blurb: 'Soupy, weakly sheared tropical-ish air. Popcorn storms that rain themselves out.',
      mult: { gc: 2.6, se: 1.9, ov: 1.2, sp: 0.8, hp: 0.4, np: 0.5, gl: 0.8 },
      make: function (rng) {
        var d6 = rng.uni(180, 340);
        return base(rng, {
          tSfc: rng.uni(27, 34), tdSfc: rng.uni(17, 22), hBL: rng.uni(900, 1700),
          moistDepth: rng.uni(1500, 3000), moistDrop: rng.uni(0.15, 0.3),
          cap: { dT: rng.uni(0, 1.2), dz: rng.uni(80, 200) },
          wm: rng.uni(0.75, 0.95), t500: rng.uni(-12, -8), zTrop: rng.uni(14000, 15800),
          rh: { low: rng.uni(0.55, 0.85), mid: rng.uni(0.4, 0.8), high: rng.uni(0.3, 0.7) },
          moistLayers: rng.int(1, 3), cloudTopBL: 0.5,
          sfc: A(rng.uni(90, 250), rng.uni(3, 10)), alpha: rng.uni(10, 40), r: rng.uni(0.5, 0.8), ekD: rng.uni(300, 500),
          anchors: {
            1: A(rng.uni(120, 260), rng.uni(5, 15)), 3: A(rng.uni(150, 330), rng.uni(5, 17)),
            6: A(d6, rng.uni(6, 22)), 9: A(d6 + rng.uni(-40, 40), rng.uni(10, 30))
          },
          jet: { z: rng.uni(11500, 13500), dir: rng.uni(200, 340), spd: rng.uni(20, 45) },
          bumpAmp: 3
        });
      }
    },
    {
      key: 'elevated', tier: 'slop', forcing: [0.45, 0.85], label: 'Cool side of warm front (elevated)', w: 8,
      blurb: 'Stable easterly surface flow under a warm, veering elevated layer. Hail at best; surface parcels are dead.',
      mult: { mw: 1.5, cp: 1.4, np: 1.3, gl: 1.4, ov: 1.1, gc: 0.2, hp: 0.5 },
      make: function (rng) {
        var tS = rng.uni(9, 19), d6 = rng.uni(230, 260);
        return base(rng, {
          tSfc: tS + rng.uni(4, 9), tdSfc: tS + rng.uni(1, 6), hBL: rng.uni(1300, 2000),
          moistDepth: rng.uni(1600, 2600), moistDrop: rng.uni(0.05, 0.2),
          cap: { dT: rng.uni(0.5, 2), dz: rng.uni(100, 250) },
          eml: rng.chance(0.8) ? { depth: rng.uni(2000, 3000), lapse: rng.uni(7.8, 8.8) } : null,
          coolLayer: { depth: rng.uni(500, 1500), dT: rng.uni(5, 11), satur: rng.uni(0.8, 1.0), inv: true },
          wm: rng.uni(0.4, 0.7), t500: rng.uni(-16, -10), zTrop: rng.uni(11500, 13000),
          rh: { low: rng.uni(0.6, 0.95), mid: rng.uni(0.3, 0.7), high: rng.uni(0.3, 0.7) },
          moistLayers: rng.int(1, 3), cloudTopBL: 0.6,
          sfc: A(rng.uni(50, 120), rng.uni(6, 15)), alpha: rng.uni(5, 25), r: rng.uni(0.6, 0.9), ekD: rng.uni(250, 400),
          anchors: {
            1: A(rng.uni(170, 205), rng.uni(25, 45)), 3: A(rng.uni(215, 245), rng.uni(35, 55)),
            6: A(d6, rng.uni(40, 65)), 9: A(d6 + rng.uni(0, 15), rng.uni(55, 90))
          },
          jet: { z: rng.uni(10500, 12000), dir: d6 + rng.uni(0, 15), spd: rng.uni(75, 120) },
          llj: { z: rng.uni(700, 1300), w: rng.uni(350, 600), dir: rng.uni(180, 210), spd: rng.uni(4, 12) }
        });
      }
    },
    {
      key: 'workedover', tier: 'slop', forcing: [0.2, 0.6], label: 'Worked-over / post-MCS', w: 7,
      blurb: 'Rain-cooled outflow air, moist-adiabatic junk aloft and a messy wind profile.',
      mult: { se: 1.4, ov: 1.3, cp: 1.3, mw: 1.2, sp: 1.1, hp: 0.6, gc: 1.1 },
      make: function (rng) {
        var d6 = rng.uni(220, 300);
        return base(rng, {
          tSfc: rng.uni(22, 28), tdSfc: rng.uni(16, 21), hBL: rng.uni(900, 1600),
          moistDepth: rng.uni(2500, 4500), moistDrop: rng.uni(0.1, 0.25),
          coolLayer: { depth: rng.uni(350, 1100), dT: rng.uni(3, 8), satur: rng.uni(0.85, 1.0) },
          wm: rng.uni(0.85, 1.0), t500: rng.uni(-11, -6.5), zTrop: rng.uni(12500, 15000),
          rh: { low: rng.uni(0.7, 0.97), mid: rng.uni(0.55, 0.9), high: rng.uni(0.4, 0.85) },
          moistLayers: rng.int(2, 4), drySlots: rng.int(0, 1), cloudTopBL: 0.8, sheets: rng.int(1, 4),
          sfc: A(rng.uni(330, 420), rng.uni(6, 18)), alpha: rng.uni(5, 30), r: rng.uni(0.5, 0.9), ekD: rng.uni(250, 450),
          anchors: {
            1: A(rng.uni(180, 280), rng.uni(8, 25)), 3: A(rng.uni(220, 300), rng.uni(10, 28)),
            6: A(d6, rng.uni(12, 35)), 9: A(d6 + rng.uni(-30, 30), rng.uni(20, 50))
          },
          jet: { z: rng.uni(11000, 13000), dir: d6 + rng.uni(-20, 20), spd: rng.uni(30, 70) },
          bumps: rng.int(3, 6), bumpAmp: 7
        });
      }
    },
    {
      key: 'coldcore', tier: 'slop', forcing: [0.5, 0.9], label: 'Upper low / cold core', w: 5,
      blurb: 'Very cold air aloft under a closed low. Low tops, small CAPE, occasional funnels.',
      mult: { np: 1.6, mw: 1.3, gl: 1.4, hp: 1.2, cp: 1.1, gc: 0.3, se: 0.5 },
      make: function (rng) {
        var d6 = rng.uni(170, 260);
        return base(rng, {
          tSfc: rng.uni(13, 22), tdSfc: rng.uni(5, 12), hBL: rng.uni(1000, 1900),
          moistDepth: rng.uni(1000, 2200), moistDrop: rng.uni(0.1, 0.3),
          wm: rng.uni(0.45, 0.75), t500: rng.uni(-27, -19), zTrop: rng.uni(8500, 10500),
          rh: { low: rng.uni(0.5, 0.85), mid: rng.uni(0.4, 0.8), high: rng.uni(0.3, 0.7) },
          moistLayers: rng.int(1, 3), cloudTopBL: 0.5,
          sfc: A(rng.uni(120, 200), rng.uni(8, 18)), alpha: rng.uni(20, 40), r: rng.uni(0.45, 0.7), ekD: rng.uni(300, 500),
          anchors: {
            1: A(rng.uni(150, 210), rng.uni(15, 30)), 3: A(rng.uni(170, 230), rng.uni(25, 40)),
            6: A(d6, rng.uni(35, 60)), 9: A(d6 + rng.uni(0, 20), rng.uni(45, 75))
          },
          jet: { z: rng.uni(8500, 10000), dir: d6 + rng.uni(0, 25), spd: rng.uni(50, 90) }
        });
      }
    },
    {
      key: 'dryhighplains', tier: 'slop', forcing: [0.3, 0.7], label: 'Deep dry mixing (inverted-V)', w: 5,
      blurb: 'Hot, deeply mixed High Plains air. High-based virga showers and dry microbursts.',
      mult: { hp: 3.2, sp: 0.8, cp: 0.4, np: 0.9, se: 0.02, gc: 0.02, ov: 0.05, gl: 0.1, mw: 0.2 },
      make: function (rng) {
        var d6 = rng.uni(215, 260);
        return base(rng, {
          tSfc: rng.uni(28, 36), tdSfc: rng.uni(-4, 9), hBL: rng.uni(2600, 4000),
          moistDepth: rng.uni(1500, 3500), moistDrop: rng.uni(0.0, 0.2),
          cap: { dT: rng.uni(0, 1), dz: rng.uni(80, 200) },
          wm: rng.uni(0.3, 0.6), t500: rng.uni(-14, -7), zTrop: rng.uni(12500, 14500),
          rh: { low: rng.uni(0.2, 0.45), mid: rng.uni(0.45, 0.85), high: rng.uni(0.2, 0.5) },
          moistLayers: rng.int(1, 2), cloudTopBL: 0.1,
          sfc: A(rng.uni(180, 240), rng.uni(12, 25)), alpha: rng.uni(5, 20), r: rng.uni(0.6, 0.85), ekD: rng.uni(500, 900),
          anchors: {
            1: A(rng.uni(190, 240), rng.uni(15, 30)), 3: A(rng.uni(205, 250), rng.uni(15, 30)),
            6: A(d6, rng.uni(20, 40)), 9: A(d6 + rng.uni(0, 15), rng.uni(35, 65))
          },
          jet: { z: rng.uni(11000, 12500), dir: d6 + rng.uni(0, 15), spd: rng.uni(45, 85) }
        });
      }
    },
    {
      key: 'ridge', tier: 'slop', forcing: [0, 0.1], label: 'Ridge / subsidence', w: 6,
      blurb: 'Warm, sinking air under an upper ridge. A subsidence inversion shuts everything down.',
      mult: { sp: 1.2, gc: 1.4, se: 1.1, hp: 1.0, np: 0.7, gl: 0.8 },
      make: function (rng) {
        var d6 = rng.uni(260, 360);
        return base(rng, {
          tSfc: rng.uni(27, 35), tdSfc: rng.uni(9, 19), hBL: rng.uni(1200, 2400),
          moistDepth: rng.uni(800, 1800), moistDrop: rng.uni(0.15, 0.4),
          cap: { dT: rng.uni(1.5, 5), dz: rng.uni(150, 450) },
          wm: rng.uni(0.2, 0.5), t500: rng.uni(-8.5, -3.5), zTrop: rng.uni(14000, 16000),
          rh: { low: rng.uni(0.08, 0.3), mid: rng.uni(0.06, 0.3), high: rng.uni(0.1, 0.4) },
          sfc: A(rng.uni(120, 220), rng.uni(4, 12)), alpha: rng.uni(10, 40), r: rng.uni(0.5, 0.8), ekD: rng.uni(300, 500),
          anchors: {
            1: A(rng.uni(150, 250), rng.uni(6, 18)), 3: A(rng.uni(200, 320), rng.uni(5, 18)),
            6: A(d6, rng.uni(5, 25)), 9: A(d6 + rng.uni(-20, 20), rng.uni(15, 40))
          },
          jet: { z: rng.uni(12000, 14000), dir: d6 + rng.uni(-20, 20), spd: rng.uni(25, 60) },
          bumpAmp: 3
        });
      }
    },
    {
      key: 'shallowmoist', tier: 'slop', forcing: [0.05, 0.3], label: 'Early moisture return (shallow)', w: 4,
      blurb: 'Gulf moisture only a few hundred metres deep beneath a strong inversion. The hodograph lies to you.',
      mult: { sp: 1.6, hp: 1.3, cp: 1.3, gc: 1.1, se: 0.9, np: 0.6, gl: 0.3 },
      make: function (rng) {
        var d6 = rng.uni(225, 260);
        return base(rng, {
          tSfc: rng.uni(21, 28), tdSfc: rng.uni(11, 17), hBL: rng.uni(600, 1100),
          moistDepth: rng.uni(300, 750), moistDrop: rng.uni(0.15, 0.4),
          cap: { dT: rng.uni(3, 7), dz: rng.uni(100, 300) },
          eml: rng.chance(0.7) ? { depth: rng.uni(1800, 3000), lapse: rng.uni(7.8, 9.0) } : null,
          wm: rng.uni(0.3, 0.55), t500: rng.uni(-15, -9), zTrop: rng.uni(11500, 13000),
          rh: { low: rng.uni(0.05, 0.2), mid: rng.uni(0.08, 0.3), high: rng.uni(0.15, 0.5) },
          cloudTopBL: 0.5,
          sfc: A(rng.uni(150, 185), rng.uni(14, 26)), alpha: rng.uni(20, 40), r: rng.uni(0.45, 0.65), ekD: rng.uni(300, 450),
          anchors: {
            1: A(rng.uni(175, 205), rng.uni(35, 55)), 3: A(rng.uni(210, 240), rng.uni(30, 50)),
            6: A(d6, rng.uni(40, 60)), 9: A(d6 + rng.uni(0, 15), rng.uni(55, 85))
          },
          jet: { z: rng.uni(10500, 12000), dir: d6 + rng.uni(0, 15), spd: rng.uni(70, 110) },
          llj: { z: rng.uni(500, 900), w: rng.uni(300, 500), dir: rng.uni(170, 200), spd: rng.uni(10, 20) }
        });
      }
    },
    {
      key: 'hailsupercell', tier: 'moderate', forcing: [0.5, 0.9], label: 'Steep-lapse hail supercells', w: 7,
      blurb: 'Steep lapse rates, modest moisture and long straight hodographs. Big hail, few tornadoes.',
      mult: { hp: 2.0, sp: 1.3, cp: 1.1, np: 1.1, se: 0.4, gc: 0.4, ov: 0.6, gl: 0.6 },
      make: function (rng) {
        var d6 = rng.uni(235, 280);
        return base(rng, {
          tSfc: rng.uni(24, 32), tdSfc: rng.uni(11, 17), hBL: rng.uni(1300, 2100),
          moistDepth: rng.uni(1000, 1700), moistDrop: rng.uni(0.1, 0.25),
          cap: { dT: rng.uni(0.5, 2.5), dz: rng.uni(80, 200) },
          eml: { depth: rng.uni(2200, 3500), lapse: rng.uni(8.3, 9.3) },
          wm: rng.uni(0.3, 0.5), t500: rng.uni(-19, -12), zTrop: rng.uni(11500, 13000),
          rh: { low: rng.uni(0.2, 0.45), mid: rng.uni(0.15, 0.45), high: rng.uni(0.2, 0.55) },
          sfc: A(rng.uni(150, 200), rng.uni(8, 18)), alpha: rng.uni(10, 25), r: rng.uni(0.55, 0.8), ekD: rng.uni(350, 600),
          anchors: {
            1: A(rng.uni(190, 225), rng.uni(18, 30)), 3: A(rng.uni(220, 255), rng.uni(28, 42)),
            6: A(d6, rng.uni(45, 65)), 9: A(d6 + rng.uni(0, 10), rng.uni(65, 95))
          },
          jet: { z: rng.uni(10500, 12000), dir: d6 + rng.uni(0, 10), spd: rng.uni(80, 120) }
        });
      }
    },
    {
      key: 'mcs', tier: 'moderate', forcing: [0.7, 1.0], label: 'MCS / damaging wind', w: 6,
      blurb: 'Very moist, very unstable air with a mid-level dry layer and strong low-to-mid flow. Wind day.',
      mult: { cp: 1.5, mw: 1.4, sp: 1.1, np: 1.1, ov: 1.1, hp: 0.6, gc: 0.7, se: 0.9 },
      make: function (rng) {
        var d6 = rng.uni(260, 310);
        return base(rng, {
          tSfc: rng.uni(28, 34), tdSfc: rng.uni(18.5, 22.5), hBL: rng.uni(900, 1500),
          moistDepth: rng.uni(1200, 2000), moistDrop: rng.uni(0.15, 0.3),
          cap: { dT: rng.uni(0.5, 2.5), dz: rng.uni(80, 200) },
          eml: rng.chance(0.7) ? { depth: rng.uni(1500, 2500), lapse: rng.uni(7.5, 8.5) } : null,
          wm: rng.uni(0.45, 0.7), t500: rng.uni(-12, -7.5), zTrop: rng.uni(13500, 15500),
          rh: { low: rng.uni(0.4, 0.7), mid: rng.uni(0.15, 0.4), high: rng.uni(0.3, 0.6) },
          dryMid: true,
          sfc: A(rng.uni(180, 240), rng.uni(8, 18)), alpha: rng.uni(5, 20), r: rng.uni(0.6, 0.85), ekD: rng.uni(300, 500),
          anchors: {
            1: A(rng.uni(215, 250), rng.uni(20, 35)), 3: A(rng.uni(250, 285), rng.uni(28, 42)),
            6: A(d6, rng.uni(30, 50)), 9: A(d6 + rng.uni(-5, 10), rng.uni(40, 70))
          },
          jet: { z: rng.uni(11500, 13000), dir: d6 + rng.uni(-5, 10), spd: rng.uni(50, 90) }
        });
      }
    },
    {
      key: 'marginaltor', tier: 'moderate', forcing: [0.4, 0.85], label: 'Conditional / flawed tornado setup', w: 6,
      blurb: 'Supercells likely, but something is off: crosswise near-ground vorticity, veer-back, a dry layer or lingering CIN.',
      mult: { sp: 1.2, cp: 1.3, mw: 1.2, se: 1.0, hp: 1.0, np: 1.0, gc: 0.6 },
      make: function (rng) {
        var d6 = rng.uni(225, 255);
        var r = base(rng, {
          tSfc: rng.uni(24, 30), tdSfc: rng.uni(15.5, 20.5), hBL: rng.uni(1000, 1700),
          moistDepth: rng.uni(900, 1600), moistDrop: rng.uni(0.1, 0.25),
          cap: { dT: rng.uni(0.5, 3), dz: rng.uni(80, 250) },
          eml: rng.chance(0.6) ? { depth: rng.uni(1500, 2800), lapse: rng.uni(7.4, 8.6) } : null,
          wm: rng.uni(0.4, 0.6), t500: rng.uni(-15, -9.5), zTrop: rng.uni(12000, 13500),
          rh: { low: rng.uni(0.3, 0.65), mid: rng.uni(0.2, 0.55), high: rng.uni(0.25, 0.6) },
          sfc: A(rng.uni(160, 195), rng.uni(10, 20)), alpha: rng.uni(15, 35), r: rng.uni(0.5, 0.7), ekD: rng.uni(300, 480),
          anchors: {
            1: A(rng.uni(185, 210), rng.uni(25, 40)), 3: A(rng.uni(215, 240), rng.uni(30, 45)),
            6: A(d6, rng.uni(40, 58)), 9: A(d6 + rng.uni(0, 15), rng.uni(55, 85))
          },
          jet: { z: rng.uni(10500, 12000), dir: d6 + rng.uni(0, 15), spd: rng.uni(70, 110) },
          llj: rng.chance(0.4) ? { z: rng.uni(600, 1100), w: rng.uni(300, 500), dir: rng.uni(185, 215), spd: rng.uni(5, 15) } : null
        });
        var pool = ['crosswise', 'crosswise', 'veerback', 'veerback', 'dryMid', 'strongCap', 'weakLL', 'highLCL', 'junk', 'backedUpper'];
        var n = rng.chance(0.4) ? 2 : 1;
        for (var i = 0; i < n; i++) { var f = rng.pick(pool); if (r.flaws.indexOf(f) < 0) r.flaws.push(f); }
        return r;
      }
    },
    {
      key: 'hslc', tier: 'moderate', forcing: [0.7, 1.0], label: 'High-shear / low-CAPE', w: 3,
      blurb: 'Screaming low-level jet over marginal instability and weak lapse rates. QLCS spin-ups.',
      mult: { se: 2.2, ov: 1.8, mw: 1.3, gc: 1.0, sp: 0.6, hp: 0.3, np: 0.6, gl: 1.0 },
      make: function (rng) {
        var d6 = rng.uni(215, 240);
        return base(rng, {
          tSfc: rng.uni(18, 24), tdSfc: rng.uni(16, 20), hBL: rng.uni(500, 900),
          moistDepth: rng.uni(1500, 3000), moistDrop: rng.uni(0.05, 0.2),
          cap: { dT: rng.uni(0, 1.2), dz: rng.uni(80, 200) },
          wm: rng.uni(0.6, 0.85), t500: rng.uni(-15.5, -10.5), zTrop: rng.uni(10500, 12500),
          rh: { low: rng.uni(0.75, 0.97), mid: rng.uni(0.4, 0.8), high: rng.uni(0.3, 0.7) },
          moistLayers: rng.int(1, 3), cloudTopBL: 0.8,
          sfc: A(rng.uni(155, 190), rng.uni(14, 25)), alpha: rng.uni(20, 40), r: rng.uni(0.4, 0.6), ekD: rng.uni(250, 400),
          anchors: {
            1: A(rng.uni(185, 210), rng.uni(45, 65)), 3: A(rng.uni(205, 230), rng.uni(50, 70)),
            6: A(d6, rng.uni(60, 85)), 9: A(d6 + rng.uni(0, 15), rng.uni(80, 110))
          },
          jet: { z: rng.uni(9500, 11000), dir: d6 + rng.uni(0, 15), spd: rng.uni(100, 150) },
          llj: { z: rng.uni(600, 1000), w: rng.uni(300, 500), dir: rng.uni(180, 205), spd: rng.uni(10, 20) }
        });
      }
    },
    {
      key: 'plainsoutbreak', tier: 'juicy', forcing: [0.65, 1.0], label: 'Dryline tornado outbreak', w: 3,
      blurb: 'Deep Gulf moisture under a weakening EML, strong veering and a curved, lengthening hodograph.',
      mult: { sp: 1.7, cp: 1.5, hp: 1.1, np: 0.9, mw: 1.0, se: 0.4, gc: 0.25, ov: 0.5, gl: 0.4 },
      make: function (rng) {
        var d6 = rng.uni(225, 250);
        return base(rng, {
          tSfc: rng.uni(25, 31), tdSfc: rng.uni(16.5, 21), hBL: rng.uni(900, 1500),
          moistDepth: rng.uni(1000, 1700), moistDrop: rng.uni(0.12, 0.25),
          cap: { dT: rng.uni(0.3, 2.2), dz: rng.uni(80, 200) },
          eml: { depth: rng.uni(1800, 3000), lapse: rng.uni(7.8, 9.0) },
          wm: rng.uni(0.35, 0.55), t500: rng.uni(-17, -11), zTrop: rng.uni(11500, 13200),
          rh: { low: rng.uni(0.3, 0.6), mid: rng.uni(0.15, 0.5), high: rng.uni(0.25, 0.6) },
          sfc: A(rng.uni(150, 180), rng.uni(14, 24)), alpha: rng.uni(0, 14), r: rng.uni(0.4, 0.6), ekD: rng.uni(280, 420), kappa: rng.uni(0.1, 0.4),
          anchors: {
            1: A(rng.uni(180, 205), rng.uni(28, 42)), 3: A(rng.uni(210, 235), rng.uni(35, 55)),
            6: A(d6, rng.uni(50, 72)), 9: A(d6 + rng.uni(0, 12), rng.uni(70, 100))
          },
          jet: { z: rng.uni(10500, 12000), dir: d6 + rng.uni(0, 12), spd: rng.uni(90, 135) },
          llj: { z: rng.uni(600, 1100), w: rng.uni(300, 550), dir: rng.uni(175, 200), spd: rng.uni(4, 14) }
        });
      }
    },
    {
      key: 'warmfront', tier: 'juicy', forcing: [0.65, 1.0], label: 'Warm front / triple point', w: 1.8,
      blurb: 'Backed, strong surface flow along a warm front with very low LCLs. Tight low-level hodograph curvature.',
      mult: { cp: 1.5, mw: 1.4, np: 1.2, sp: 1.1, hp: 0.9, se: 0.8, ov: 1.0, gc: 0.3, gl: 0.8 },
      make: function (rng) {
        var d6 = rng.uni(220, 250);
        return base(rng, {
          tSfc: rng.uni(22, 27.5), tdSfc: rng.uni(17, 20.5), hBL: rng.uni(600, 1100),
          moistDepth: rng.uni(1100, 2000), moistDrop: rng.uni(0.05, 0.18),
          cap: { dT: rng.uni(0.3, 1.8), dz: rng.uni(80, 200) },
          eml: rng.chance(0.45) ? { depth: rng.uni(1500, 2600), lapse: rng.uni(7.2, 8.3) } : null,
          wm: rng.uni(0.4, 0.6), t500: rng.uni(-17, -11.5), zTrop: rng.uni(11500, 13000),
          rh: { low: rng.uni(0.5, 0.85), mid: rng.uni(0.2, 0.55), high: rng.uni(0.3, 0.6) },
          cloudTopBL: 0.5,
          sfc: A(rng.uni(100, 145), rng.uni(10, 18)), alpha: rng.uni(4, 18), r: rng.uni(0.4, 0.6), ekD: rng.uni(250, 380), kappa: rng.uni(0.15, 0.45),
          anchors: {
            1: A(rng.uni(170, 200), rng.uni(24, 38)), 3: A(rng.uni(205, 235), rng.uni(35, 55)),
            6: A(d6, rng.uni(45, 68)), 9: A(d6 + rng.uni(0, 12), rng.uni(65, 95))
          },
          jet: { z: rng.uni(10500, 12000), dir: d6 + rng.uni(0, 12), spd: rng.uni(85, 125) },
          llj: { z: rng.uni(500, 900), w: rng.uni(250, 450), dir: rng.uni(165, 195), spd: rng.uni(4, 12) }
        });
      }
    },
    {
      key: 'eveningllj', tier: 'juicy', forcing: [0.6, 1.0], label: 'Evening LLJ ramp-up', w: 1.8,
      blurb: 'Rich moisture as the low-level jet strengthens toward sunset. Low-level SRH balloons while CIN is still modest.',
      mult: { sp: 1.5, cp: 1.5, hp: 1.1, mw: 1.1, np: 0.9, se: 0.8, gc: 0.4, gl: 0.5 },
      prefer: { '00': 3, '12': 0.3 },
      make: function (rng) {
        var d6 = rng.uni(225, 250);
        return base(rng, {
          tSfc: rng.uni(24, 29), tdSfc: rng.uni(17, 21), hBL: rng.uni(800, 1300),
          moistDepth: rng.uni(1100, 1800), moistDrop: rng.uni(0.06, 0.18),
          cap: { dT: rng.uni(0.5, 2.5), dz: rng.uni(80, 200) },
          eml: { depth: rng.uni(1800, 2800), lapse: rng.uni(7.6, 8.8) },
          wm: rng.uni(0.35, 0.55), t500: rng.uni(-16, -10.5), zTrop: rng.uni(11500, 13200),
          rh: { low: rng.uni(0.35, 0.65), mid: rng.uni(0.2, 0.5), high: rng.uni(0.25, 0.6) },
          eveningStable: { depth: rng.uni(80, 250), dT: rng.uni(1, 3.5) },
          sfc: A(rng.uni(145, 170), rng.uni(12, 22)), alpha: rng.uni(0, 12), r: rng.uni(0.4, 0.6), ekD: rng.uni(250, 380), kappa: rng.uni(0.1, 0.35),
          anchors: {
            1: A(rng.uni(180, 200), rng.uni(30, 42)), 3: A(rng.uni(210, 235), rng.uni(35, 50)),
            6: A(d6, rng.uni(45, 65)), 9: A(d6 + rng.uni(0, 12), rng.uni(65, 95))
          },
          jet: { z: rng.uni(10500, 12000), dir: d6 + rng.uni(0, 12), spd: rng.uni(80, 120) },
          llj: { z: rng.uni(450, 850), w: rng.uni(250, 450), dir: rng.uni(175, 200), spd: rng.uni(6, 14) }
        });
      }
    },
    {
      key: 'dixie', tier: 'juicy', forcing: [0.7, 1.0], label: 'Southeast high-shear tornado day', w: 1.2,
      blurb: 'Moist, moderately unstable air under an intense wind field. Fast storms, low LCLs, big SRH.',
      mult: { se: 3.0, ov: 1.6, gc: 1.0, sp: 0.6, mw: 0.8, cp: 0.4, hp: 0.05, np: 0.1, gl: 0.3 },
      make: function (rng) {
        var d6 = rng.uni(220, 245);
        return base(rng, {
          tSfc: rng.uni(24, 29), tdSfc: rng.uni(18, 21.5), hBL: rng.uni(600, 1100),
          moistDepth: rng.uni(1300, 2500), moistDrop: rng.uni(0.05, 0.18),
          cap: { dT: rng.uni(0, 1.5), dz: rng.uni(80, 200) },
          wm: rng.uni(0.55, 0.75), t500: rng.uni(-14, -9.5), zTrop: rng.uni(11000, 12800),
          rh: { low: rng.uni(0.5, 0.85), mid: rng.uni(0.3, 0.65), high: rng.uni(0.3, 0.6) },
          sfc: A(rng.uni(150, 185), rng.uni(14, 24)), alpha: rng.uni(0, 14), r: rng.uni(0.4, 0.55), ekD: rng.uni(250, 380), kappa: rng.uni(0.1, 0.4),
          anchors: {
            1: A(rng.uni(185, 205), rng.uni(38, 52)), 3: A(rng.uni(205, 230), rng.uni(50, 65)),
            6: A(d6, rng.uni(60, 85)), 9: A(d6 + rng.uni(0, 12), rng.uni(80, 110))
          },
          jet: { z: rng.uni(10000, 11500), dir: d6 + rng.uni(0, 12), spd: rng.uni(100, 150) },
          llj: { z: rng.uni(500, 900), w: rng.uni(300, 450), dir: rng.uni(180, 200), spd: rng.uni(8, 18) }
        });
      }
    },
    {
      key: 'highrisk', tier: 'juicy', forcing: [0.85, 1.0], label: 'Kitchen-sink high risk', w: 0.5,
      blurb: 'Everything overlaps: extreme instability, deep moisture, huge low-level SRH and a strong, curved hodograph.',
      mult: { sp: 1.8, cp: 1.4, hp: 0.9, mw: 0.9, se: 0.8, np: 0.6, gc: 0.2, ov: 0.6, gl: 0.3 },
      make: function (rng) {
        var d6 = rng.uni(225, 250);
        return base(rng, {
          tSfc: rng.uni(26, 31), tdSfc: rng.uni(19, 22.5), hBL: rng.uni(900, 1400),
          moistDepth: rng.uni(1300, 2000), moistDrop: rng.uni(0.05, 0.14),
          cap: { dT: rng.uni(0.2, 1.4), dz: rng.uni(80, 180) },
          eml: { depth: rng.uni(2200, 3200), lapse: rng.uni(8.3, 9.2) },
          wm: rng.uni(0.3, 0.5), t500: rng.uni(-18, -13), zTrop: rng.uni(12000, 13500),
          rh: { low: rng.uni(0.35, 0.6), mid: rng.uni(0.15, 0.45), high: rng.uni(0.25, 0.55) },
          sfc: A(rng.uni(145, 170), rng.uni(16, 26)), alpha: rng.uni(0, 14), r: rng.uni(0.38, 0.52), ekD: rng.uni(250, 380), kappa: rng.uni(0.1, 0.4),
          anchors: {
            1: A(rng.uni(180, 200), rng.uni(36, 48)), 3: A(rng.uni(210, 230), rng.uni(45, 60)),
            6: A(d6, rng.uni(60, 80)), 9: A(d6 + rng.uni(0, 10), rng.uni(80, 110))
          },
          jet: { z: rng.uni(10500, 12000), dir: d6 + rng.uni(0, 10), spd: rng.uni(110, 150) },
          llj: { z: rng.uni(500, 900), w: rng.uni(300, 450), dir: rng.uni(175, 195), spd: rng.uni(6, 15) }
        });
      }
    }
  ];

  var byKey = {};
  list.forEach(function (g) { byKey[g.key] = g; });

  var TIERS = {
    slop: { label: 'Slop', order: 0, mult: 0.62 },
    moderate: { label: 'Moderate', order: 1, mult: 1.35 },
    juicy: { label: 'Juicy', order: 2, mult: 2.3 }
  };

  var MONTH_MULT = {
    postfrontal: [1.8, 1.7, 1.4, 1.1, 1, 0.7], capped: [0.3, 0.4, 0.7, 1.0, 1, 1.1], pulse: [0.05, 0.1, 0.3, 0.6, 1, 1.6],
    elevated: [1.4, 1.5, 1.4, 1.2, 1, 0.7], workedover: [0.4, 0.5, 0.8, 1.0, 1, 1.2], coldcore: [1.3, 1.3, 1.3, 1.1, 1, 0.6],
    dryhighplains: [0.2, 0.3, 0.6, 0.9, 1, 1.4], ridge: [0.5, 0.5, 0.6, 0.8, 1, 1.5], shallowmoist: [1.5, 1.6, 1.6, 1.2, 1, 0.4],
    hailsupercell: [0.2, 0.4, 0.9, 1.2, 1, 0.9], mcs: [0.1, 0.2, 0.4, 0.8, 1, 1.6], marginaltor: [0.6, 0.8, 1.1, 1.2, 1, 0.7],
    hslc: [2.8, 2.6, 1.8, 1.0, 1, 0.3], plainsoutbreak: [0.2, 0.4, 0.8, 1.2, 1, 0.6], warmfront: [0.8, 1.0, 1.2, 1.2, 1, 0.7],
    eveningllj: [0.3, 0.5, 0.9, 1.2, 1, 0.9], dixie: [2.2, 2.4, 2.2, 1.6, 1, 0.3], highrisk: [0.2, 0.4, 0.9, 1.3, 1, 0.4]
  };

  var SEASON = [
    { t: -14, td: -8, t500: -5, trop: -1200, jet: 1.25 },
    { t: -12, td: -7, t500: -4.5, trop: -1000, jet: 1.22 },
    { t: -7, td: -4, t500: -3, trop: -600, jet: 1.15 },
    { t: -3.5, td: -2, t500: -1.5, trop: -300, jet: 1.07 },
    { t: 0, td: 0, t500: 0, trop: 0, jet: 1 },
    { t: 2.5, td: 1.5, t500: 2, trop: 500, jet: 0.85 }
  ];

  var COLD_REGIMES = { postfrontal: true, elevated: true, workedover: true, coldcore: true, ridge: true };

  var FLAWS = {
    crosswise: 'Veered surface wind: near-ground vorticity largely crosswise',
    veerback: 'Mid-level veer-back (backing winds 4-7 km)',
    dryMid: 'Dry, entraining mid-levels',
    strongCap: 'Stubborn cap',
    weakLL: 'Weak low-level flow',
    highLCL: 'Marginal moisture / high LCL',
    junk: 'Moist-adiabatic junk aloft (poor lapse rates)',
    backedUpper: 'Backed, weak anvil-level flow',
    shallowMoist: 'Shallow moisture',
    outflow: 'Outflow-contaminated surface layer'
  };

  return { list: list, byKey: byKey, TIERS: TIERS, FLAWS: FLAWS, A: A, MONTH_MULT: MONTH_MULT, SEASON: SEASON, COLD_REGIMES: COLD_REGIMES };
})();
