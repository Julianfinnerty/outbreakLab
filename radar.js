'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Virtual WSR-88D: samples the regional model along real beam geometry
//  (4/3-earth refraction, great-circle azimuths from the site) into Level II
//  cuts, quantised to Archive II codes on the GPU.
//   • VCPs with the real split cuts (surveillance + Doppler at 0.5/0.9/1.3°):
//     GR2Analyst binds products to cuts by number (StormLab lesson).
//   • Each cut is sampled when the model reaches that cut's scan time, so a
//     volume shows the storm evolving through it like the real radar.
//   • Only what the model holds: Z from rain/snow/graupel-hail (Smith 1975)
//     with beam filling over three heights, above a fixed echo floor; Vr from
//     the model wind minus the echo's fall speed, aliased at the cut's
//     Nyquist; SW from SGS turbulence and beam shear; ZDR / ρhv by hydrometeor
//     mix; ΦDP = system offset + 2∫KDP (rain). No clear-air returns, fine
//     lines, texture or noise. The optional sub-grid tornado scheme adds its
//     beam-smeared vortex and debris.
// ─────────────────────────────────────────────────────────────────────────────

const RE_M = 6371000, KE = 4 / 3;
const GATE0 = 2125, GATEDR = 250, MAX_REF_GATES = 1832, MAX_DOP_GATES = 1192;
const L2_SCALE = { REF: [2, 66], VEL: [2, 129], SW: [2, 129], ZDR: [16, 128], PHI: [253 / 360, 2], RHO: [300, -60.5] };
const CUT_MOMENTS = { surv: ['REF', 'ZDR', 'PHI', 'RHO'], dop: ['REF', 'VEL', 'SW'], both: ['REF', 'VEL', 'SW', 'ZDR', 'PHI', 'RHO'] };

function splitVcp(split, rest, nyqSplit, nyqRest) {
  const cuts = [];
  for (const a of split) { cuts.push({ angle: a, kind: 'surv', superRes: true, nyquist: 8.9 }); cuts.push({ angle: a, kind: 'dop', superRes: true, nyquist: nyqSplit }); }
  for (const a of rest) cuts.push({ angle: a, kind: 'both', superRes: false, nyquist: a < 7 ? nyqRest : 32.3 });
  return cuts;
}
const VCPS = {
  212: { label: 'VCP 212 · 14 tilts · 4.5 min (severe, SZ-2)', dur: 270, cuts: splitVcp([0.5, 0.9, 1.3], [1.8, 2.4, 3.1, 4.0, 5.1, 6.4, 8.0, 10.0, 12.5, 15.6, 19.5], 28.4, 29.4) },
  12: { label: 'VCP 12 · 14 tilts · 4.2 min (severe)', dur: 250, cuts: splitVcp([0.5, 0.9, 1.3], [1.8, 2.4, 3.1, 4.0, 5.1, 6.4, 8.0, 10.0, 12.5, 15.6, 19.5], 28.4, 29.4) },
  215: { label: 'VCP 215 · 15 tilts · 6 min (general precipitation)', dur: 360, cuts: splitVcp([0.5, 0.9, 1.3], [1.8, 2.4, 3.1, 4.0, 5.1, 6.4, 8.0, 10.0, 12.0, 14.0, 16.7, 19.5], 28.4, 29.4) },
  35: { label: 'VCP 35 · 9 tilts · 7 min (clear air)', dur: 420, cuts: splitVcp([0.5, 0.9, 1.3], [1.8, 2.4, 3.1, 4.0, 5.1, 6.4], 26.0, 27.0) },
};

const RADAR_FIELDS = [
  ['site', 'v4'], ['geo', 'v4'], ['cut', 'v4'], ['gates', 'v4'], ['nyq', 'v4'], ['offA', 'v4'], ['offB', 'v4'], ['mdl', 'v4'], ['mdl2', 'v4'], ['phys', 'v4'], ['phys2', 'v4'],
];

const WGSL_R_HEAD = WGSL_NOISE + /* wgsl */`
fn sstep(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
struct RU {
${new UBlock(RADAR_FIELDS).wgsl}
};
// site = (model x, model y, antenna height MSL, ke·R); geo = (lat0, lon0, site lat, site lon) radians
// cut = (elevation rad, az0 deg, Δaz deg, nrad); gates = (REF gates, Doppler gates, first gate m, gate m)
// nyq = (Nyquist m/s, time s, noise seed, system ΦDP deg); offA = word offsets (REF, VEL, SW, ZDR); offB = (PHI, RHO, -, moment mask)
// mdl = (nx, ny, nz, dx); mdl2 = (dz, ground MSL, domain x0, domain y0) — AEQD metres of the model's (0,0) corner
// phys = (ρ at the ground, echo floor dBZ, microphysics 0 Lin / 1 Thompson, number of sub-grid tornadoes)
@group(0) @binding(0) var<uniform> R: RU;
@group(0) @binding(1) var<storage, read> BS: array<vec4f>;
fn bsA(k: i32) -> vec4f { return BS[clamp(k, 0, i32(R.mdl.z) - 1) * 2]; }
fn bsB(k: i32) -> vec4f { return BS[clamp(k, 0, i32(R.mdl.z) - 1) * 2 + 1]; }
const RE = 6371000.0;
// great-circle destination (bearing a rad, ground distance s m) → azimuthal-equidistant model metres
fn gatePos(a: f32, s: f32) -> vec2f {
  let p1 = R.geo.z; let l1 = R.geo.w; let d = s / RE;
  let sp2 = sin(p1) * cos(d) + cos(p1) * sin(d) * cos(a);
  let p2 = asin(clamp(sp2, -1.0, 1.0));
  let l2 = l1 + atan2(sin(a) * sin(d) * cos(p1), cos(d) - sin(p1) * sp2);
  let p0 = R.geo.x; let dl = l2 - R.geo.y;
  let cc = clamp(sin(p0) * sin(p2) + cos(p0) * cos(p2) * cos(dl), -1.0, 1.0);
  let c = acos(cc);
  let k = select(c / sin(c), 1.0, c < 1e-6);
  let x = RE * k * cos(p2) * sin(dl);
  let y = RE * k * (cos(p0) * sin(p2) - sin(p0) * cos(p2) * cos(dl));
  return vec2f(x, y) - R.mdl2.zw;
}
// 4/3-earth beam: height above the antenna and ground distance at slant range r
fn beam(r: f32, el: f32) -> vec2f {
  let a = R.site.w;
  let q = r * r + 2.0 * r * a * sin(el);
  let h = q / (sqrt(q + a * a) + a);
  let s = a * asin(clamp(r * cos(el) / (a + h), -1.0, 1.0));
  return vec2f(h, s);
}
`;

// pass 1: one thread per (radial, 4 gates) → REF / VEL / SW / ZDR / RHO codes; KDP to the scratch radial.
// Only what the model holds: hydrometeor reflectivity, the model wind (+ fall speed), SGS turbulence; no clear-air
// returns, no texture or noise. The optional sub-grid tornado scheme is the one addition (its vortex and debris).
const WGSL_R_CUT = WGSL_R_HEAD + /* wgsl */`
@group(0) @binding(2) var Vt: texture_3d<f32>;
@group(0) @binding(3) var Q1t: texture_3d<f32>;
@group(0) @binding(4) var Q2t: texture_3d<f32>;
@group(0) @binding(5) var auxT: texture_3d<f32>;
@group(0) @binding(6) var sL: sampler;
@group(0) @binding(7) var<storage, read_write> OUT: array<u32>;
@group(0) @binding(8) var<storage, read_write> KDP: array<f32>;
// sub-grid tornadoes: per tornado (x, y, core radius m, current Vmax m/s), (debris top m, debris dBZ, debris on 0–1, 0)
@group(0) @binding(9) var<storage, read> TOR: array<vec4f>;
struct Smp { zr: f32, zs: f32, zg: f32, vt: f32, u: vec3f, T: f32, qr: f32, rho: f32, nu: f32, inside: f32, lr: f32 };
fn nn() -> vec3f { return R.mdl.xyz; }
fn sample(xy: vec2f, z: f32) -> Smp {
  var o: Smp;
  let n = nn(); let dx = R.mdl.w; let dz = R.mdl2.x;
  let g = vec3f(xy / dx, z / dz);
  o.inside = select(0.0, 1.0, all(g >= vec3f(0.0)) && all(g <= n) && z >= 0.0);
  let gc = clamp(g, vec3f(0.0), n);
  let uc = gc / n;
  let q1 = textureSampleLevel(Q1t, sL, uc, 0.0); let q2 = textureSampleLevel(Q2t, sL, uc, 0.0);
  let N1 = n + 1.0;
  let u = textureSampleLevel(Vt, sL, (gc + vec3f(0.5, 0.0, 0.0)) / N1, 0.0).x;
  let v = textureSampleLevel(Vt, sL, (gc + vec3f(0.0, 0.5, 0.0)) / N1, 0.0).y;
  let w = textureSampleLevel(Vt, sL, (gc + vec3f(0.0, 0.0, 0.5)) / N1, 0.0).z;
  let th = textureSampleLevel(Vt, sL, gc / N1, 0.0).w;
  let k = i32(clamp(floor(gc.z), 0.0, n.z - 1.0));
  let A = bsA(k); let B = bsB(k);
  let rho = A.z; let T = th * B.x;
  let qr = max(q1.w, 0.0); let qs = max(q2.x, 0.0); let qg = max(q2.y, 0.0);
  o.zr = 3.63e9 * pow(rho * qr, 1.75);
  o.zs = 9.80e8 * pow(rho * qs, 1.75) * 0.224 * 4.0;
  o.zg = select(4.33e10, 1.2e10, T < 273.15) * pow(rho * qg, 1.75);
  let sq = sqrt(R.phys.x / rho);
  var vr = min(36.34 * pow(max(0.001 * rho * qr, 0.0), 0.1364) * sq, 10.0 * sq);
  let vs = clamp(1.1 * pow(max(1000.0 * rho * qs, 1e-6), 0.11), 0.3, 2.2) * sq;
  var vg = clamp(9.0 * pow(max(1000.0 * rho * qg, 1e-6), 0.42), 1.0, 55.0) * sq; let rr = qg / 0.009; vg = min(vg * (1.0 + rr * rr), 65.0);
  // hurricane mode's maritime (soft) graupel, as in the model
  if (R.phys2.x > 0.5 && R.phys.z < 0.5) { o.zg = select(1.0e10, 1.3e9, T < 273.15) * pow(rho * qg, 1.75); vg = clamp(5.0 * pow(max(1000.0 * rho * qg, 1e-6), 0.25), 1.0, 9.0) * sq; }
  // Marshall–Palmer slope for the dual-pol drop size; Thompson: the predicted drop sizes and graupel distribution
  o.lr = pow(3.14159 * 1000.0 * 8e6 / max(rho * qr, 1e-9), 0.25);
  if (R.phys.z > 0.5) {
    let nr = max(q2.z, 0.0);
    if (qr > 1e-9) {
      let l = clamp(pow(3.14159 * 1000.0 * max(nr, 1e-3) / qr, 0.33333), 1000.0, 1.0e5); let nb = qr * l * l * l / 3141.59;
      o.zr = 720e18 * rho * nb / pow(l, 6.0); o.lr = l; vr = min(3949.0 * pow(l, -0.8), 10.0) * sq;
    } else { o.zr = 0.0; }
    if (qg > 1e-9) {
      let n0 = clamp(200.0 / (rho * qg), 1e4, 3e6); let l = pow(3.14159 * 500.0 * n0 / (rho * qg), 0.25);
      o.zg = 720e18 * n0 / pow(l, 7.0) * select(0.24, 0.0666, T < 273.15); vg = min(2483.0 * pow(l, -0.89), 30.0) * sq;
    } else { o.zg = 0.0; }
  }
  let zt = o.zr + o.zs + o.zg;
  o.vt = select(0.0, (o.zr * vr + o.zs * vs + o.zg * vg) / zt, zt > 1e-6);
  o.u = vec3f(u, v, w); o.T = T; o.qr = qr; o.rho = rho;
  o.nu = textureSampleLevel(auxT, sL, uc, 0.0).x;
  return o;
}
fn code(v: f32, sc: f32, ofs: f32) -> u32 { return u32(clamp(round(v * sc + ofs), 2.0, 255.0)); }
fn db2lin(d: f32) -> f32 { return pow(10.0, 0.1 * d); }
fn sq(x: f32) -> f32 { return x * x; }
struct Gate { zref: u32, vel: u32, sw: u32, zdr: u32, rho: u32, kdp: f32 };
fn gate(ri: i32, gi: i32) -> Gate {
  var G: Gate; G.zref = 0u; G.vel = 0u; G.sw = 0u; G.zdr = 0u; G.rho = 0u; G.kdp = -1.0;
  let r = R.gates.z + R.gates.w * f32(gi);
  let el = R.cut.x;
  let az = (R.cut.y + R.cut.z * f32(ri)) * 0.017453293;
  let bw = 0.0165;                                   // ≈ 0.95° half-power beam width
  let hc = beam(r, el);
  let p = gatePos(az, hc.y);
  let e = normalize(gatePos(az, hc.y + 200.0) - p);
  let zAnt = R.site.z - R.mdl2.y;                    // antenna above the model's ground
  let zc = zAnt + hc.x;
  if (zc > f32(R.mdl.z) * R.mdl2.x - 200.0) { return G; }
  // beam filling: three heights across the beam, Gaussian weights
  let hl = beam(r, el - 0.4 * bw).x + zAnt; let hu = beam(r, el + 0.4 * bw).x + zAnt;
  let s0 = sample(p, max(zc, 5.0)); let s1 = sample(p, max(hl, 5.0)); let s2 = sample(p, max(hu, 5.0));
  if (s0.inside < 0.5) { return G; }
  let zr = 0.5 * s0.zr + 0.25 * (s1.zr + s2.zr); let zs = 0.5 * s0.zs + 0.25 * (s1.zs + s2.zs); let zg = 0.5 * s0.zg + 0.25 * (s1.zg + s2.zg);
  let zmet = zr + zs + zg;
  // optional sub-grid tornadoes: Rankine vortex smeared over the beam (circulation kept: Vmax·R/Re), lofted debris
  var zdeb = 0.0; var dvt = vec2f(0.0); var swt = 0.0;
  let bwm = 0.5 * r * bw;
  for (var q = 0; q < i32(R.phys.w); q++) {
    let A = TOR[2 * q]; let B = TOR[2 * q + 1];
    let d = p - A.xy; let rt = length(d);
    let Re = sqrt(A.z * A.z + bwm * bwm + 125.0 * 125.0);
    if (rt > 8.0 * Re) { continue; }
    let vmx = A.w * A.z / Re;
    let vt = vmx * select(Re / max(rt, 1.0), rt / Re, rt < Re);
    let et = vec2f(-d.y, d.x) / max(rt, 1.0); let er = d / max(rt, 1.0);
    let fz = 1.0 - sstep(1200.0, 3500.0, zc);
    dvt += (vt * et - 0.25 * vt * er) * fz;
    swt = max(swt, vmx * 0.4 * exp(-rt * rt / (4.0 * Re * Re)) * fz);
    if (B.z > 0.0 && zc < B.x) {
      let rd = max(1.4 * A.z, 150.0);
      zdeb += db2lin(B.y) * min(1.0, rd * rd / (Re * Re)) * exp(-rt * rt / (Re * Re)) * (1.0 - sstep(0.55 * B.x, B.x, zc)) * B.z;
    }
  }
  let ztot = zmet + zdeb;
  if (ztot <= 1e-6) { return G; }
  let dbz = 10.0 * log(ztot) / 2.302585;
  if (dbz < R.phys.y) { return G; }                  // echo floor (dBZ): below it the gate is empty
  G.zref = code(dbz, 2.0, 66.0);
  if (gi >= i32(R.gates.y)) { return G; }
  // radial velocity: model wind (beam direction in model axes) + tornado, minus the echo's fall speed; aliasing
  let ce = cos(el); let se = sin(el);
  let vtf = s0.vt * zmet / ztot;
  var vr = ((s0.u.x + dvt.x) * e.x + (s0.u.y + dvt.y) * e.y) * ce + (s0.u.z - vtf) * se;
  let nyq = R.nyq.x;
  vr = vr - 2.0 * nyq * floor((vr + nyq) / (2.0 * nyq));
  G.vel = code(vr, 2.0, 129.0);
  // spectrum width: SGS turbulence, shear across the beam, fall-speed spread, tornado
  let vru = (s2.u.x * e.x + s2.u.y * e.y) * ce; let vrl = (s1.u.x * e.x + s1.u.y * e.y) * ce;
  let swv = sqrt(1.0 + sq(clamp(2.5 * sqrt(max(s0.nu, 0.0) / 1000.0), 0.0, 8.0)) + sq((vru - vrl) / 2.5) + sq(0.15 * s0.vt * se) + sq(swt));
  G.sw = code(min(swv, 19.5), 2.0, 129.0);
  // dual polarisation from the hydrometeor mix (deterministic)
  let d0 = 3.67 / s0.lr * 1000.0;                    // rain median volume diameter (mm): Marshall–Palmer, or predicted
  let melt = s0.T > 273.15;
  let zdrR = clamp(0.2 + 1.15 * (d0 - 0.5), 0.1, 4.8);
  let zdrS = select(0.3, 1.3, melt);
  let zdrG = select(0.15, select(0.7, 0.0, zg > 3.2e5), melt);
  let zv = zr / db2lin(zdrR) + zs / db2lin(zdrS) + zg / db2lin(zdrG) + zdeb / db2lin(0.2);
  let zdr = 10.0 * log(max(ztot, 1e-9) / max(zv, 1e-9)) / 2.302585;
  G.zdr = code(clamp(zdr, -7.9, 7.9), 16.0, 128.0);
  let fr = zr / ztot; let fs = zs / ztot; let fg = zg / ztot; let fd = zdeb / ztot;
  var cc = fr * select(0.995, 0.986, d0 > 2.5) + fs * select(0.985, 0.93, melt) + fg * select(0.985, select(0.94, 0.90, zg > 3.2e5), melt) + fd * 0.55;
  cc -= 0.24 * fr * fg;                              // hail mixed with rain decorrelates the channels
  G.rho = code(clamp(cc, 0.2, 1.05), 300.0, -60.5);
  // KDP from rain (S band): R = 0.017 Z^0.714, KDP = (R / 44)^(1 / 0.822)
  G.kdp = pow(0.017 * pow(max(zr, 0.0), 0.714) / 44.0, 1.2165);
  return G;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let nq = i32(R.gates.x) / 4;
  let t = i32(gid.x) + i32(gid.y) * 65535 * 64;
  let nrad = i32(R.cut.w);
  if (t >= nrad * nq) { return; }
  let ri = t / nq; let q = t % nq;
  let mask = u32(R.offB.w);
  var pr = 0u; var pv = 0u; var ps = 0u; var pz = 0u; var ph = 0u;
  let ndq = i32(R.gates.y) / 4;
  for (var k = 0; k < 4; k++) {
    let gi = q * 4 + k;
    let G = gate(ri, gi);
    pr |= G.zref << (8u * u32(k)); pv |= G.vel << (8u * u32(k)); ps |= G.sw << (8u * u32(k));
    pz |= G.zdr << (8u * u32(k)); ph |= G.rho << (8u * u32(k));
    if (gi < i32(R.gates.y)) { KDP[ri * i32(R.gates.y) + gi] = G.kdp; }
  }
  OUT[u32(R.offA.x) + u32(ri * nq + q)] = pr;
  if (q < ndq) {
    let o = u32(ri * ndq + q);
    if ((mask & 2u) != 0u) { OUT[u32(R.offA.y) + o] = pv; }
    if ((mask & 4u) != 0u) { OUT[u32(R.offA.z) + o] = ps; }
    if ((mask & 8u) != 0u) { OUT[u32(R.offA.w) + o] = pz; }
    if ((mask & 32u) != 0u) { OUT[u32(R.offB.y) + o] = ph; }
  }
}
`;

// pass 2: ΦDP accumulated along each radial from KDP (two-way), from the system offset
const WGSL_R_PHI = WGSL_R_HEAD + /* wgsl */`
@group(0) @binding(2) var<storage, read_write> OUT: array<u32>;
@group(0) @binding(3) var<storage, read> KDP: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  _ = BS[0];
  let ri = i32(gid.x);
  if (ri >= i32(R.cut.w)) { return; }
  let ng = i32(R.gates.y);
  var acc = R.nyq.w;
  for (var q = 0; q < ng / 4; q++) {
    var w = 0u;
    for (var k = 0; k < 4; k++) {
      let gi = q * 4 + k;
      let kd = KDP[ri * ng + gi];
      if (kd >= 0.0) {
        acc += 2.0 * kd * R.gates.w * 0.001;
        let phi = acc - 360.0 * floor(acc / 360.0);
        w |= u32(clamp(round(phi * 253.0 / 360.0 + 2.0), 2.0, 255.0)) << (8u * u32(k));
      }
    }
    OUT[u32(R.offB.x) + u32(ri * (ng / 4) + q)] = w;
  }
}
`;

// ─────────────────────────────────────────────────────────────────────────────
class RadarSim {
  constructor(model, geo) {
    this.m = model; this.geo = geo;
    this.pCut = GPU.compute(WGSL_R_CUT, 'radar.cut');
    this.pPhi = GPU.compute(WGSL_R_PHI, 'radar.phi');
    this.sampL = model.sampL;
    this.radars = [];
    this.torBuf = GPU.sbuf(64 * 32, 'radarTornadoes');
    this.nTor = 0;
  }
  // tornadoes: [{x, y, R, v, debrisTop, debrisDbz, debris}] model metres
  setTornadoes(list) {
    const act = list.slice(0, 64), f = new Float32Array(Math.max(1, act.length) * 8);
    act.forEach((t, i) => f.set([t.x, t.y, t.R, t.v, t.debrisTop, t.debrisDbz, t.debris, 0], i * 8));
    GPU.write(this.torBuf, f);
    this.nTor = act.length;
  }
  // site: {id, lat, lon, h (ground m MSL)}; opts: {vcp, start (epoch ms of sim t = 0), insects, texture, aliasing}
  addRadar(site, opts) {
    const m = this.m, g = this.geo;
    const vcp = VCPS[opts.vcp] || VCPS[212];
    const [sx, sy] = g.toModel(site.lat, site.lon);
    // how far the model reaches from this site
    let far = 0;
    for (const [cx, cy] of [[0, 0], [m.Lx, 0], [0, m.Ly], [m.Lx, m.Ly]]) far = Math.max(far, Math.hypot(cx - sx, cy - sy));
    const rng = Math.min(460000, far + 10000);
    let ngRef = Math.min(MAX_REF_GATES, Math.ceil((rng - GATE0) / GATEDR));
    ngRef = Math.max(64, Math.ceil(ngRef / 4) * 4);
    const ngDop = Math.min(MAX_DOP_GATES, ngRef);
    // layout of the volume buffer (bytes): each cut's moments, radial-major
    let off = 0;
    const cuts = vcp.cuts.map((c, ci) => {
      const nrad = c.superRes ? 720 : 360;
      const mom = CUT_MOMENTS[c.kind].map(name => {
        const ng = name === 'REF' ? ngRef : ngDop;
        const o = { name, ngates: ng, off };
        off += nrad * ng;
        return o;
      });
      return { ...c, index: ci, nrad, mom };
    });
    // scan timing: split / super-res cuts take about twice as long as the 1° cuts
    const wsum = cuts.reduce((s, c) => s + (c.superRes ? 2 : 1), 0);
    let acc = 0;
    for (const c of cuts) { c.t0 = acc / wsum * vcp.dur; acc += c.superRes ? 2 : 1; c.dur = (c.superRes ? 2 : 1) / wsum * vcp.dur; }
    const bytes = off;
    const d = GPU.device;
    const R = {
      site, opts, vcp, vcpId: +opts.vcp || 212, cuts, bytes, ngRef, ngDop, sx, sy,
      out: GPU.sbuf(bytes, 'radarOut_' + site.id),
      kdp: GPU.sbuf(720 * ngDop * 4, 'radarKdp_' + site.id),
      read: [0, 1].map(() => d.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })),
      readBusy: [false, false],
      ubo: cuts.map(() => GPU.ubuf(new UBlock(RADAR_FIELDS).size, 'radarU')),
      U: new UBlock(RADAR_FIELDS),
      // real radars are not synchronised: a random phase for this site's volume starts
      phase: Math.random() * vcp.dur, vol: -1, next: 0, volStart: 0, cutsDone: 0, az0: 0, done: 0, failed: 0,
    };
    this.makeBind(R);
    this.radars.push(R);
    return R;
  }
  makeBind(R) {
    const m = this.m, v = t => t.createView();
    R.bgCut = [0, 1].map(par => R.ubo.map(u => GPU.bind(this.pCut, 0, [u, m.bs, v(m.V[par]), v(m.Q1[0]), v(m.Q2[0]), v(m.aux), this.sampL, R.out, R.kdp, this.torBuf])));
    R.bgPhi = R.ubo.map(u => GPU.bind(this.pPhi, 0, [u, m.bs, R.out, R.kdp]));
  }
  destroy() {
    for (const R of this.radars) { R.out.destroy(); R.kdp.destroy(); R.read.forEach(b => b.destroy()); R.ubo.forEach(b => b.destroy()); }
    this.radars = [];
    this.torBuf.destroy();
  }
  // encode every cut whose scan time has been reached; returns volumes that completed
  encDue(enc, simT) {
    const done = [];
    for (const R of this.radars) {
      for (;;) {
        if (R.vol < 0 || R.next >= R.cuts.length) {
          // start the next volume once its time comes
          const vstart = R.vol < 0 ? R.phase : R.volStart + R.vcp.dur;
          if (simT < vstart) break;
          if (R.readBusy[0] && R.readBusy[1]) break;     // both readback buffers still in flight: wait
          R.vol++; R.volStart = vstart; R.next = 0; R.az0 = Math.random();
        }
        const c = R.cuts[R.next];
        if (simT < R.volStart + c.t0) break;
        this.encCut(enc, R, c, simT);
        R.next++;
        if (R.next >= R.cuts.length) {
          const slot = R.readBusy[0] ? 1 : 0;
          R.readBusy[slot] = true;
          enc.copyBufferToBuffer(R.out, 0, R.read[slot], 0, R.bytes);
          done.push({ R, slot, vol: R.vol, volStart: R.volStart, az0: R.az0 });
        }
      }
    }
    return done;
  }
  encCut(enc, R, c, simT) {
    const m = this.m, g = this.geo, U = R.U;
    const off = {}; c.mom.forEach(o => { off[o.name] = o.off / 4; });
    let mask = 0; ['REF', 'VEL', 'SW', 'ZDR', 'PHI', 'RHO'].forEach((n, i) => { if (off[n] !== undefined) mask |= 1 << i; });
    const zAnt = R.site.h + 20;
    U.set('site', R.sx, R.sy, zAnt, KE * RE_M);
    U.set('geo', g.lat0 * DEG, g.lon0 * DEG, R.site.lat * DEG, R.site.lon * DEG);
    U.set('cut', c.angle * DEG, R.az0, 360 / c.nrad, c.nrad);
    U.set('gates', R.ngRef, R.ngDop, GATE0, GATEDR);
    U.set('nyq', R.opts.aliasing === false ? 63.5 : c.nyquist, simT, (R.vol * 97 + c.index * 13) % 100000, 25);
    U.set('offA', off.REF ?? 0, off.VEL ?? 0, off.SW ?? 0, off.ZDR ?? 0);
    U.set('offB', off.PHI ?? 0, off.RHO ?? 0, 0, mask);
    U.set('mdl', m.nx, m.ny, m.nz, m.dx);
    U.set('mdl2', m.dz, g.groundMSL, -m.Lx / 2, -m.Ly / 2);
    U.set('phys', m.rhoSfc || 1.15, R.opts.minDbz ?? 0, m.params.scheme === 'thompson' ? 1 : 0, this.nTor);
    U.set('phys2', m.hur && m.hur.maritime ? 1 : 0, 0, 0, 0);
    GPU.write(R.ubo[c.index], U.f);
    const pass = enc.beginComputePass();
    const nthreads = c.nrad * (R.ngRef / 4), nwg = Math.ceil(nthreads / 64);
    GPU.dispatch(pass, this.pCut, [R.bgCut[m.parity][c.index]], Math.min(nwg, 65535), Math.ceil(nwg / 65535));
    if (off.PHI !== undefined) GPU.dispatch(pass, this.pPhi, [R.bgPhi[c.index]], Math.ceil(c.nrad / 64));
    pass.end();
    c.simT = simT;
  }
  // map a finished volume's buffer and build the upload for the server
  async collect(d, run, epoch0) {
    const R = d.R, buf = R.read[d.slot];
    try {
      await buf.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(buf.getMappedRange().slice(0));
      buf.unmap();
      R.readBusy[d.slot] = false;
      const t0 = epoch0 + d.volStart * 1000;
      const header = {
        run, icao: R.site.id, lat: R.site.lat, lon: R.site.lon, elev: R.site.h + 20, vcp: R.vcpId, epoch_ms: Math.round(t0),
        sweeps: R.cuts.map(c => ({
          angle: c.angle, superRes: c.superRes, kind: c.kind, az0: d.az0, nrad: c.nrad, nyquist: R.opts.aliasing === false ? 63.5 : c.nyquist,
          unamb_km: c.kind === 'surv' ? 466 : 300, start_ms: Math.round(t0 + c.t0 * 1000), dur_ms: Math.round(c.dur * 1000),
          moments: c.mom.map(o => ({ name: o.name, ngates: o.ngates, off: o.off })),
        })),
      };
      return { R, header, bytes };
    } catch (e) { R.readBusy[d.slot] = false; throw e; }
  }
}
