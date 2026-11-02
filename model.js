'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Regional convection-allowing cloud model (ground-fixed, ~1–2 km grid).
//
//  Numerics and physics are TrailingHV's storm-scale cloud model (scm.js):
//  anelastic Ogura–Phillips equations on a MAC grid, semi-Lagrangian +
//  MacCormack advection (long time steps), six-class Lin-type ice
//  microphysics, Smagorinsky SGS, lateral sponges, Rayleigh damping aloft,
//  semi-slip ground with geotriptic balance.  Changes for the regional setup:
//   • exact pressure solve (solver.js) instead of multigrid — flat cells;
//   • f-plane Coriolis on the departure from the large-scale wind;
//   • air masses: every column has a "large-scale" target state = the warm-
//     sector sounding + the anomaly of whichever boundary air mass covers it
//     (cold front, warm front, dryline, …; they move at prescribed speeds).
//     The target's hydrostatic pressure (φt) is part of the pressure, so the
//     air masses push on each other like density currents; the lateral
//     sponges relax toward the target and it is nudged back deep inside
//     each air mass (so fronts stay fronts over hours);
//   • convective initiation: a map of Naylor & Gilmore (2012) updraft-nudging
//     events (random in the warm sector, along boundaries, or placed by hand).
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_FIELDS = [
  ['dims', 'v4'], ['dzv', 'v4'], ['step', 'v4'], ['sponge', 'v4'], ['turb', 'v4'],
  ['micro', 'v4'], ['misc', 'v4'], ['cor', 'v4'], ['ci', 'v4'], ['pad', 'v4'], ['micro2', 'v4'],
  // hurricane mode: hur = (on, Ck at 10 m, land moisture availability, base surface pressure Pa),
  // hur2 = (radiative relaxation time s, its cap K/s, boundary-layer depth m, U10 / lowest-level wind),
  // hur3 = (land drag coefficient at the lowest level, gustiness m/s, boundary-layer thermal forcing K/s, maritime graupel 0/1)
  // hur4 = (storm centre x, y m, thermal-forcing radius m, environment-hold radius m), updated from the tracker
  // hur5 = (sea drag cap at 10 m, dissipative heating 0/1, 2Δx filter strength per step, 0)
  ['hur', 'v4'], ['hur2', 'v4'], ['hur3', 'v4'], ['hur4', 'v4'], ['hur5', 'v4'],
  // initial vortex (used by the init kernel): vtx = (centre x, y m, table spacing m, table nodes), vtx2 = (moist-core radius m, its RH, on, 0)
  ['vtx', 'v4'], ['vtx2', 'v4'],
  // trajectory-averaged pressure force (hurricane mode): cn = (share of the old pressure gradient applied before advection,
  // stored φ → p′/ρ factor during this step, the same factor after it, midpoint trajectories 0/1)
  ['cn', 'v4'],
];
const MAX_BOUNDS = 8, MAX_BPTS = 32, MAX_CI = 256, VX_MAXR = 2048;
const CN_OLD = 0.4;   // hurricane mode: the share of the last step's pressure force applied before advection (WGSL_M_PREP)

const WGSL_M_HEAD = WGSL_NOISE + /* wgsl */`
fn sstep(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
struct MU {
${new UBlock(MODEL_FIELDS).wgsl}
};
@group(0) @binding(0) var<uniform> S: MU;
@group(0) @binding(1) var<storage, read> BS: array<vec4f>;   // per level: (θ0, qv0, ρc, ρw_bottom), (π0, p0, u0, v0)
fn NS() -> vec3i { return vec3i(S.dims.xyz); }
fn DXS() -> f32 { return S.dims.w; }
fn DZS() -> f32 { return S.dzv.x; }
fn DTS() -> f32 { return S.step.x; }
fn bsA(k: i32) -> vec4f { return BS[clamp(k, 0, i32(S.dims.z) - 1) * 2]; }
fn bsB(k: i32) -> vec4f { return BS[clamp(k, 0, i32(S.dims.z) - 1) * 2 + 1]; }
fn rhoW(k: i32) -> f32 { return BS[clamp(k, 0, i32(S.dims.z)) * 2].w; }
fn scidx(c: vec3i) -> i32 { let n = NS(); return c.x + n.x * (c.y + n.y * c.z); }
// index into the pressure solve's grid, which is the model grid padded by S.pad.x cells on each side (see allocate)
fn pidx(c: vec3i) -> i32 { let p = i32(S.pad.x); return (c.x + p) + i32(S.pad.y) * ((c.y + p) + i32(S.pad.z) * c.z); }
const T0K = 273.15; const CPD = 1005.7; const RDC = 287.04; const RVC = 461.5; const LVC = 2.501e6; const LFC = 3.337e5; const LSC = 2.834e6;
fn esl(T: f32) -> f32 { return 611.2 * exp(17.67 * (T - T0K) / (T - 29.65)); }
fn esi(T: f32) -> f32 { return 611.2 * exp(21.8745584 * (T - 273.16) / (T - 7.66)); }
fn fIce(T: f32) -> f32 { return clamp((T0K - T) / 40.0, 0.0, 1.0); }
fn qvsat(T: f32, p: f32, f: f32) -> f32 { let e = mix(esl(T), esi(T), f); return 0.622 * e / max(p - e, 100.0); }
fn vtR(q: f32, rho: f32) -> f32 {
  let f = sqrt(S.step.z / rho);
  return min(36.34 * pow(max(0.001 * rho * q, 0.0), 0.1364) * f, 10.0 * f);
}
fn vtS(q: f32, rho: f32) -> f32 { return clamp(1.1 * pow(max(1000.0 * rho * q, 1e-6), 0.11), 0.3, 2.2) * sqrt(S.step.z / rho); }
fn vtG(q: f32, rho: f32) -> f32 {
  let v = clamp(9.0 * pow(max(1000.0 * rho * q, 1e-6), 0.42), 1.0, 55.0) * sqrt(S.step.z / rho);
  let r = q / 0.009; return min(v * (1.0 + r * r), 65.0);
}
// ── Thompson-style microphysics (S.micro2.z = 1), after Thompson et al. (2008): rain carries a predicted number
// concentration (per kg, in Q2.z) with an exponential size distribution, so drops size-sort as they fall and rain
// from melted graupel is big drops; the graupel intercept is diagnosed from its mixing ratio (more graupel = fewer,
// larger particles). Cloud water, cloud ice and snow keep the Lin-type treatment. ──
fn thompson() -> bool { return S.micro2.z > 0.5; }
// rain slope (1/m) from mass and number, bounded to volume-mean diameters ≈ 0.02–1.8 mm (the upper bound: breakup)
fn lamR(q: f32, n: f32) -> f32 { return clamp(pow(3.14159 * 1000.0 * max(n, 1e-3) / max(q, 1e-12), 0.33333), 1000.0, 1.0e5); }
// mass- and number-weighted rain fall speeds for v(D) = 842 D^0.8
fn vtRT(q: f32, n: f32, rho: f32) -> vec2f { let l = pow(lamR(q, n), -0.8); return vec2f(min(2503.0 * l, 10.0), min(784.0 * l, 10.0)) * sqrt(S.step.z / rho); }
// graupel: intercept 200 / (ρ qg) within 10⁴–3·10⁶ m⁻⁴, density 500 kg/m³, v(D) = 442 D^0.89
fn n0G(q: f32, rho: f32) -> f32 { return clamp(200.0 / max(rho * q, 1e-9), 1e4, 3e6); }
fn lamG(q: f32, rho: f32) -> f32 { return pow(3.14159 * 500.0 * n0G(q, rho) / max(rho * q, 1e-12), 0.25); }
fn vtGT(q: f32, rho: f32) -> f32 { return min(1503.0 * pow(lamG(q, rho), -0.89), 25.0) * sqrt(S.step.z / rho); }
// the fall speeds the advection uses: rain (mass-weighted, number-weighted) and graupel, for either scheme
fn vtRain(qr: f32, nr: f32, rho: f32) -> vec2f { if (thompson()) { return vtRT(qr, nr, rho); } let v = vtR(qr, rho); return vec2f(v, v); }
// maritime graupel (hurricane mode, Lin scheme): soft, low-density graupel (~400 kg/m³, N0 4·10⁶ m⁻⁴) that falls at
// 1–9 m/s, not the Plains scheme's hail-like 10–55 m/s; hail-like graupel melted in the lowest layer and chilled the
// whole inflow (mean θ′ −2 K over 90–300 km, pockets of −6 to −7 K), which no hurricane can grow on
fn maritime() -> bool { return S.hur3.w > 0.5 && !thompson(); }
fn vtGM(q: f32, rho: f32) -> f32 { return clamp(5.0 * pow(max(1000.0 * rho * q, 1e-6), 0.25), 1.0, 9.0) * sqrt(S.step.z / rho); }
fn vtGrau(qg: f32, rho: f32) -> f32 { if (maritime()) { return vtGM(qg, rho); } return select(vtG(qg, rho), vtGT(qg, rho), thompson()); }
// equivalent reflectivity (mm⁶/m³) of rain and graupel for either scheme
fn zRain(qr: f32, nr: f32, rho: f32) -> f32 {
  if (!thompson()) { return 3.63e9 * pow(max(rho * qr, 0.0), 1.75); }
  if (qr < 1e-9) { return 0.0; }
  let l = lamR(qr, nr); let nb = qr * l * l * l / 3141.59;          // the number within the size bounds
  return 720e18 * rho * nb / (l * l * l * l * l * l);
}
fn zGrau(qg: f32, rho: f32, T: f32) -> f32 {
  if (maritime()) { return select(1.0e10, 1.3e9, T < T0K) * pow(max(rho * qg, 0.0), 1.75); }
  if (!thompson()) { return select(4.33e10, 1.2e10, T < T0K) * pow(max(rho * qg, 0.0), 1.75); }
  if (qg < 1e-9) { return 0.0; }
  let l = lamG(qg, rho); let l2 = l * l;
  return 720e18 * n0G(qg, rho) / (l2 * l2 * l2 * l) * select(0.24, 0.0666, T < T0K);   // dry: 0.224 (ρg/ρi)²
}
// ── hurricane mode: a warm ocean under the domain ──
fn hurOn() -> bool { return S.hur.x > 0.5; }
// cloud ice settles (Heymsfield & Donner 1990: 3.29 (ρ qi)^0.16 m/s, as in WRF's Lin and WSM schemes), so anvils and
// the hurricane's cirrus outflow thin out by falling into drier air instead of piling up for days. Hurricane mode only
// (the outbreak setup was tuned without it).
fn vtI(q: f32, rho: f32) -> f32 { return select(0.0, min(3.29 * pow(max(rho * q, 1e-12), 0.16), 1.5), S.hur.x > 0.5 && q > 1e-9); }
// drag coefficient for the lowest-level wind u1: over the sea Cd(U10) rises with the wind and levels off at 2.4e-3 in
// hurricane-force winds (Donelan et al. 2004), with U10 ≈ S.hur2.w × u1; over land the log law for z0 = 0.3 m
fn cdSfc(u1: f32, land: f32) -> f32 {
  let f = S.hur2.w;
  let cs = min((0.75 + 0.067 * f * u1) * 1e-3, S.hur5.x) * f * f;
  return mix(cs, S.hur3.x, clamp(land, 0.0, 1.0));
}
`;

// the large-scale target state; needs lsfA / lsfB (per column) bound by the including kernel
//   lsfA = (ΔT at the ground K, air-mass depth m, fractional qv deficit, moisture depth m)
//   lsfB = (Δu, Δv at the ground m/s, wind-anomaly depth m, nudging weight)
const WGSL_M_TARGET = /* wgsl */`
fn tprof(z: f32, H: f32) -> f32 { return 1.0 - sstep(0.7 * H, 1.15 * H, z); }
fn lA(ij: vec2i) -> vec4f { return textureLoad(lsfA, clamp(ij, vec2i(0), NS().xy - vec2i(1)), 0); }
fn lB(ij: vec2i) -> vec4f { return textureLoad(lsfB, clamp(ij, vec2i(0), NS().xy - vec2i(1)), 0); }
fn tgtTh(A: vec4f, k: i32) -> f32 { let z = (f32(k) + 0.5) * DZS(); return bsA(k).x + A.x / bsB(k).x * tprof(z, A.y); }
fn tgtQv(A: vec4f, k: i32) -> f32 { let z = (f32(k) + 0.5) * DZS(); return bsA(k).y * (1.0 - A.z * tprof(z, A.w)); }
// target wind components at the u- and v-faces of cell c (averaging the anomaly of the two columns)
fn tgtU(c: vec3i) -> f32 { let z = (f32(c.z) + 0.5) * DZS(); let a = lB(c.xy - vec2i(1, 0)); let b = lB(c.xy); return bsB(c.z).z + 0.5 * (a.x * tprof(z, a.z) + b.x * tprof(z, b.z)); }
fn tgtV(c: vec3i) -> f32 { let z = (f32(c.z) + 0.5) * DZS(); let a = lB(c.xy - vec2i(0, 1)); let b = lB(c.xy); return bsB(c.z).w + 0.5 * (a.y * tprof(z, a.z) + b.y * tprof(z, b.z)); }
`;

// ---------- large-scale forcing: air masses of the boundaries → lsfA/lsfB + the target's hydrostatic φt ----------
// boundary b: p0 = (npts, vx, vy, half frontal width), p1 = (ΔT, max depth, slope, min depth),
//             p2 = (qv deficit, moisture depth ratio, Δu, Δv), p3 = (wind depth ratio, nudge 0/1, free zone m, side ±1),
//             p4 = (along-front variation 0–1, noise seed, variation wavelength m, 0),
//             pts = (x, y at t = 0 in model metres, vx, vy m/s) per point: the points where boundaries meet at a surface
//             low move with the low, the others with their boundary, so fronts stay joined at the low
const WGSL_M_LSF = WGSL_M_HEAD + /* wgsl */`
struct Bnd { p0: vec4f, p1: vec4f, p2: vec4f, p3: vec4f, p4: vec4f, pts: array<vec4f, 32> };
@group(0) @binding(2) var<storage, read> BD: array<Bnd>;
@group(0) @binding(3) var outA: texture_storage_2d<rgba32float, write>;
@group(0) @binding(4) var outB: texture_storage_2d<rgba32float, write>;
@group(0) @binding(5) var phOut: texture_storage_3d<r32float, write>;
fn bpt(b: i32, i: i32) -> vec2f { let q = BD[b].pts[i]; return q.xy + q.zw * S.step.y; }
// signed distance to the (moving) polyline, > 0 inside the boundary's air mass; the end segments extend as lines
// (signed distance, how far beyond the polyline's first / last point along its end segments, distance along it)
fn sdist(b: i32, x: vec2f) -> vec3f {
  let np = i32(BD[b].p0.x);
  var best = 1e30; var sg = 1.0; var over = 0.0; var along = 0.0; var s0 = 0.0;
  for (var i = 0; i < np - 1; i++) {
    let a = bpt(b, i); let e = bpt(b, i + 1); let ab = e - a;
    let la = max(length(ab), 1.0);
    let t0 = dot(x - a, ab) / (la * la);
    var t = t0;
    if (i > 0) { t = max(t, 0.0); }
    if (i < np - 2) { t = min(t, 1.0); }
    let d = length(x - (a + t * ab));
    if (d < best) {
      best = d; sg = select(-1.0, 1.0, ab.x * (x - a).y - ab.y * (x - a).x > 0.0);
      over = select(0.0, max(-t0, 0.0) * la, i == 0) + select(0.0, max(t0 - 1.0, 0.0) * la, i == np - 2);
      along = s0 + t * la;
    }
    s0 += la;
  }
  return vec3f(best * sg * BD[b].p3.w, over, along);
}
// Along-front variation (−1…1): smooth random along the boundary (base wavelength p4.z, two octaves), slowly changing
// (~1.5 h), so a front is not one uniform wall of lift: its air mass is deeper and colder in some stretches and weak
// in others, and storms fire from the bulges instead of all along it at once
fn alongVar(b: i32, s: f32) -> f32 {
  let P4 = BD[b].p4;
  if (P4.x <= 0.0) { return 0.0; }
  return clamp(fbm2(vec2f(s / P4.z, P4.y + S.step.y / 5400.0), 2) * 1.6, -1.0, 1.0);
}
// Convergence hot spots along a boundary (0…1): bumps about every p4.z (random spacing ±35 %), ~14 km wide, of random
// strength, re-drawn every ~80 min (cross-faded, so spots fade in and out in new places). A boundary's lift is
// concentrated there — real boundaries fire storms from such spots, not along their whole length at once.
fn hotSpots(b: i32, s: f32) -> f32 {
  let L = BD[b].p4.z; let sd = i32(BD[b].p4.y * 1000.0);
  let ph = S.step.y / 4800.0; let e = i32(floor(ph)); let fe = sstep(0.0, 1.0, fract(ph));
  let k0 = i32(floor(s / L));
  var acc = 0.0;
  for (var k = k0 - 1; k <= k0 + 1; k++) {
    for (var q = 0; q < 2; q++) {
      let h = hash3i(vec3i(k, e + q, sd));
      let r1 = f32(h & 0xffffu) / 65535.0; let r2 = f32((h >> 16u) & 0xffffu) / 65535.0;
      let z = (s - (f32(k) + 0.5 + 0.7 * (r1 - 0.5)) * L) / (0.17 * L);
      acc += select(1.0 - fe, fe, q == 1) * (0.35 + 0.65 * r2) * exp(-z * z);
    }
  }
  return clamp(acc, 0.0, 1.0);
}
fn tprof(z: f32, H: f32) -> f32 { return 1.0 - sstep(0.7 * H, 1.15 * H, z); }
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let n = NS(); let i = i32(gid.x); let j = i32(gid.y);
  if (i >= n.x || j >= n.y) { return; }
  let x = (vec2f(f32(i), f32(j)) + 0.5) * DXS();
  var sT = 0.0; var sH = 0.0; var sQ = 0.0; var sHq = 0.0; var sU = 0.0; var sV = 0.0; var sHw = 0.0; var sw = 0.0; var nud = 0.0;
  let nb = i32(S.cor.z);
  _ = BD[0].p4;
  for (var b = 0; b < nb; b++) {
    let sd = sdist(b, x); let d = sd.x;
    let P0 = BD[b].p0; let P1 = BD[b].p1; let P2 = BD[b].p2; let P3 = BD[b].p3;
    // the air mass ends ~60 km beyond the boundary's end points (fronts meeting at a triple point must not overlap)
    let w = sstep(-P0.w, P0.w, d) * (1.0 - sstep(0.0, 60000.0, sd.y));
    if (w <= 0.0) { continue; }
    // along-front variation: what makes a boundary lift air — the depth of its air mass at the leading edge (fronts)
    // and its wind contrast (the convergence, which is most of a dryline's lift) — is concentrated in hot spots
    // (variation 1: ×2.3 there, ×0.15 between); the temperature contrast and the depth further back vary smoothly
    // and less. Both fade out deep inside the air mass.
    let vr = BD[b].p4.x; let fade = 1.0 - sstep(30000.0, 90000.0, d);
    let av = vr * alongVar(b, sd.z) * fade;
    let lift = select(1.0, mix(1.0, mix(1.0 - 0.85 * vr, 1.0 + 1.3 * vr, hotSpots(b, sd.z)), fade), vr > 0.0);
    let Hmin = P1.w * clamp(lift, 0.15, 3.0);
    let H = clamp(P1.z * max(d + P0.w, 0.0) * (1.0 + 0.4 * av), Hmin, P1.y);
    sT += w * P1.x * exp(0.5 * av); sQ += w * P2.x; sU += w * P2.z * lift; sV += w * P2.w * lift;
    sH += w * H; sHq += w * H * P2.y; sHw += w * H * P3.x; sw += w;
    nud = max(nud, P3.y * sstep(P3.z, P3.z + 40000.0, d) * (1.0 - sstep(0.0, 60000.0, sd.y)));
  }
  let iw = 1.0 / max(sw, 1e-6);
  let A = vec4f(clamp(sT, -20.0, 10.0), max(sH * iw, 100.0), clamp(sQ, 0.0, 0.92), max(sHq * iw, 100.0));
  let B = vec4f(sU, sV, max(sHw * iw, 100.0), nud);
  textureStore(outA, vec2i(i, j), A);
  textureStore(outB, vec2i(i, j), B);
  // hydrostatic pressure of the target (φ = p/ρ, 0 at the lid): ∂φ/∂z = b_t
  let dz = DZS();
  var ph = 0.0; var bprev = 0.0;
  for (var k = n.z - 1; k >= 0; k--) {
    let z = (f32(k) + 0.5) * dz;
    let a = bsA(k); let bb = bsB(k);
    let dth = A.x / bb.x * tprof(z, A.y);
    let dqv = -a.y * A.z * tprof(z, A.w);
    let bt = 9.81 * (dth / a.x + 0.608 * dqv);
    if (k == n.z - 1) { ph = -bt * 0.5 * dz; } else { ph -= 0.5 * (bt + bprev) * dz; }
    bprev = bt;
    textureStore(phOut, vec3i(i, j, k), vec4f(ph, 0.0, 0.0, 0.0));
  }
}
`;

// ---------- convective-initiation map: strongest active updraft-nudging tower per column ----------
// tower: a = (x, y at its start, centre height, horizontal radius), b = (vertical half-depth, target w, start s, end s),
//        c = (drift vx, vy m/s, shape seed, ramp-up s)
const WGSL_M_CI = WGSL_M_HEAD + /* wgsl */`
struct CIE { a: vec4f, b: vec4f, c: vec4f };
@group(0) @binding(2) var<storage, read> CI: array<CIE>;
@group(0) @binding(3) var ciOut: texture_storage_2d<rgba32float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  _ = BS[0];
  let n = NS(); let i = i32(gid.x); let j = i32(gid.y);
  if (i >= n.x || j >= n.y) { return; }
  let x = (vec2f(f32(i), f32(j)) + 0.5) * DXS();
  let t = S.step.y;
  var best = vec4f(0.0, 0.0, 1500.0, 1500.0);
  let ne = i32(S.ci.x);
  for (var e = 0; e < ne; e++) {
    let E = CI[e];
    if (t < E.b.z || t > E.b.w) { continue; }
    let d = x - (E.a.xy + E.c.xy * (t - E.b.z));
    // irregular outline: the radius wobbles by ±~25 % with direction
    let ang = atan2(d.y, d.x);
    let wob = 1.0 + 0.25 * gnoise2(vec2f(cos(ang), sin(ang)) * 1.6 + vec2f(E.c.z, 3.7 * E.c.z));
    // it grows over the ramp-up from a third of its radius and 40 % of its target w, as an updraft organizes, and the
    // target is a dome (strongest in the middle), not NG12's flat disk, which grew one round, sharp-edged storm
    let g = sstep(E.b.z, E.b.z + max(E.c.w, 60.0), t);
    let r = length(d) / (E.a.w * wob * (0.35 + 0.65 * g));
    if (r >= 1.0) { continue; }
    let L = vec2f(n.xy) * DXS(); let edge = min(min(x.x, L.x - x.x), min(x.y, L.y - x.y));
    let h = sstep(E.b.z, E.b.z + 60.0, t) * (1.0 - sstep(E.b.w - 180.0, E.b.w, t)) * sstep(S.sponge.x, S.sponge.x + 10000.0, edge);
    let wt = E.b.y * (0.4 + 0.6 * g) * cos(1.5707963 * r);
    if (h * wt > best.x * best.y) { best = vec4f(h, wt, E.a.z, E.b.x); }
  }
  textureStore(ciOut, vec2i(i, j), best);
}
`;

// ---------- initial state = the target (warm sector + air masses) + small noise in the boundary layer ----------
const WGSL_M_INIT = WGSL_M_HEAD + /* wgsl */`
@group(0) @binding(2) var lsfA: texture_2d<f32>;
@group(0) @binding(3) var lsfB: texture_2d<f32>;
@group(0) @binding(4) var Vout: texture_storage_3d<rgba32float, write>;
@group(0) @binding(5) var Q1out: texture_storage_3d<rgba32float, write>;
@group(0) @binding(6) var Q2out: texture_storage_3d<rgba32float, write>;
@group(0) @binding(7) var<storage, read> VX: array<vec4f>;   // initial vortex: (tangential wind, θ′) per level × radius
` + WGSL_M_TARGET + /* wgsl */`
fn vxAt(r: f32, k: i32) -> vec2f {
  let nr = i32(S.vtx.w); let fr = r / S.vtx.z; let i0 = i32(floor(fr));
  if (i0 >= nr - 1) { return vec2f(0.0); }
  let o = clamp(k, 0, NS().z - 1) * nr + i0;
  return mix(VX[o].xy, VX[o + 1].xy, fr - f32(i0));
}
@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let c = vec3i(id); let n = NS();
  if (any(c > n)) { return; }
  let k = min(c.z, n.z - 1);
  let kc = vec3i(c.xy, k);
  let A = lA(c.xy);
  let z = (f32(k) + 0.5) * DZS();
  // hurricane mode: the noise reaches up through the moist core (6 km), the rest of the domain keeps it in the lowest 1.5 km
  // (the open sea gets none in hurricane mode: with almost no CIN it would set off convection everywhere)
  var nz0 = sstep(800.0, 1500.0, z);
  if (S.vtx2.z > 0.5) { nz0 = select(1.0, sstep(6000.0, 8000.0, z), length((vec2f(c.xy) + 0.5) * DXS() - S.vtx.xy) < S.vtx2.x); }
  let noise = S.misc.z * (rnd3(c + vec3i(17, 3, 5)) - 0.5) * 2.0 * (1.0 - nz0);
  var th = tgtTh(A, k) + noise;
  var u = select(0.0, tgtU(kc), c.y < n.y && c.z < n.z);
  var v = select(0.0, tgtV(kc), c.x < n.x && c.z < n.z);
  let vortex = S.vtx2.z > 0.5;
  var dqv = 0.0;
  if (vortex) {
    // a warm-core vortex in gradient-wind and hydrostatic (thermal-wind) balance, built on the CPU (setVortex)
    let dx = DXS(); let xc = S.vtx.xy;
    let pu = vec2f(f32(c.x), f32(c.y) + 0.5) * dx - xc; let ru = max(length(pu), 1.0);
    let pv = vec2f(f32(c.x) + 0.5, f32(c.y)) * dx - xc; let rv = max(length(pv), 1.0);
    let pc = (vec2f(c.xy) + 0.5) * dx - xc; let rc = length(pc);
    u -= vxAt(ru, k).x * pu.y / ru;
    v += vxAt(rv, k).x * pv.x / rv;
    th += vxAt(rc, k).y;
  }
  let T = th * bsB(k).x;
  var qv = min(tgtQv(A, k), 0.95 * qvsat(T, bsB(k).y, fIce(T)));
  if (vortex) {
    // a nearly saturated core (Nolan 2007): the vortex starts as a moist, convecting disturbance instead of drying out
    let pc = (vec2f(c.xy) + 0.5) * DXS() - S.vtx.xy;
    let f = (1.0 - sstep(0.6, 1.0, length(pc) / S.vtx2.x)) * sstep(500.0, 1500.0, z) * (1.0 - sstep(7000.0, 10000.0, z));
    let q2 = max(qv, f * S.vtx2.y * qvsat(T, bsB(k).y, fIce(T)));
    dqv = q2 - qv; qv = q2;
    th -= 0.608 * dqv * bsA(k).x;          // the same density: the moister air must not start out buoyant
  }
  textureStore(Vout, c, vec4f(u, v, 0.0, th));
  if (all(c < n)) { textureStore(Q1out, c, vec4f(qv, 0.0, 0.0, 0.0)); textureStore(Q2out, c, vec4f(0.0)); }
}
`;

// ---------- eddy viscosity (Smagorinsky–Lilly with Richardson correction) ----------
const WGSL_M_NUT = WGSL_M_HEAD + /* wgsl */`
@group(0) @binding(2) var Vin: texture_3d<f32>;
@group(0) @binding(3) var auxOut: texture_storage_3d<rg32float, write>;
@group(0) @binding(4) var Q1in: texture_3d<f32>;
@group(0) @binding(5) var sfc: texture_2d<f32>;
fn ldV(c: vec3i) -> vec4f { return textureLoad(Vin, clamp(c, vec3i(0), NS()), 0); }
fn uc(c: vec3i) -> f32 { let k = clamp(c.z, 0, NS().z - 1); return 0.5 * (ldV(c).x + ldV(c + vec3i(1, 0, 0)).x) - bsB(k).z; }
fn vc(c: vec3i) -> f32 { let k = clamp(c.z, 0, NS().z - 1); return 0.5 * (ldV(c).y + ldV(c + vec3i(0, 1, 0)).y) - bsB(k).w; }
fn wc(c: vec3i) -> f32 { return 0.5 * (ldV(c).z + ldV(c + vec3i(0, 0, 1)).z); }
@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  _ = BS[0];
  let c = vec3i(id); let n = NS();
  if (any(c >= n)) { return; }
  let dx = DXS(); let dz = DZS();
  let v0 = ldV(c);
  let dudx = (ldV(c + vec3i(1, 0, 0)).x - v0.x) / dx; let dvdy = (ldV(c + vec3i(0, 1, 0)).y - v0.y) / dx; let dwdz = (ldV(c + vec3i(0, 0, 1)).z - v0.z) / dz;
  let dudy = (uc(c + vec3i(0, 1, 0)) - uc(c - vec3i(0, 1, 0))) / (2.0 * dx); let dudz = (uc(c + vec3i(0, 0, 1)) - uc(c - vec3i(0, 0, 1))) / (2.0 * dz);
  let dvdx = (vc(c + vec3i(1, 0, 0)) - vc(c - vec3i(1, 0, 0))) / (2.0 * dx); let dvdz = (vc(c + vec3i(0, 0, 1)) - vc(c - vec3i(0, 0, 1))) / (2.0 * dz);
  let dwdx = (wc(c + vec3i(1, 0, 0)) - wc(c - vec3i(1, 0, 0))) / (2.0 * dx); let dwdy = (wc(c + vec3i(0, 1, 0)) - wc(c - vec3i(0, 1, 0))) / (2.0 * dx);
  let s12 = 0.5 * (dudy + dvdx); let s13 = 0.5 * (dudz + dwdx); let s23 = 0.5 * (dvdz + dwdy);
  let S2 = 2.0 * (dudx * dudx + dvdy * dvdy + dwdz * dwdz) + 4.0 * (s12 * s12 + s13 * s13 + s23 * s23);
  // km-scale cells are flat (dx >> dz): horizontal and vertical mixing get their own length scales, as in WRF's
  // 2-D Smagorinsky + vertical closure (one isotropic length leaves km-scale updrafts almost unmixed)
  let kz0 = max(c.z - 1, 0); let kz1 = min(c.z + 1, n.z - 1);
  var N2 = 9.81 / bsA(c.z).x * (ldV(vec3i(c.xy, kz1)).w - ldV(vec3i(c.xy, kz0)).w) / (f32(kz1 - kz0) * dz);
  // saturated air rising moist-adiabatically is near neutral: the dry N² would switch mixing off in every cloud core
  let q1 = textureLoad(Q1in, c, 0);
  if (S.cor.w > 0.5 && q1.y + q1.z > 1e-5) { N2 = min(N2, 0.0); }
  let Ri = N2 / max(S2, 1e-10);
  let fst = sqrt(max(0.0, 1.0 - Ri / 0.33));
  let sS = sqrt(max(S2, 0.0));
  let lh = S.turb.x * dx; let lv = 0.18 * dz;
  let nuh = min(lh * lh * sS * fst, 0.08 * dx * dx / max(DTS(), 0.1));
  var nuv = min(lv * lv * sS * fst, 0.15 * dz * dz / max(DTS(), 0.1));
  // hurricane mode: a K-profile boundary layer (K = κ u* z (1 − z/h)²) carries the sea's heat, moisture and drag through
  // the lowest kilometre; the grid's own vertical mixing (0.18 Δz) is far too weak for that at km-scale levels
  let z = (f32(c.z) + 0.5) * dz; let h = S.hur2.z;
  if (hurOn() && z < h) {
    let s0 = ldV(vec3i(c.xy, 0));
    let u1 = length(vec2f(0.5 * (s0.x + ldV(vec3i(c.x + 1, c.y, 0)).x), 0.5 * (s0.y + ldV(vec3i(c.x, c.y + 1, 0)).y)));
    let ust = sqrt(cdSfc(u1, textureLoad(sfc, c.xy, 0).x)) * max(u1, S.hur3.y);
    let q = 1.0 - z / h;
    nuv = max(nuv, min(0.4 * ust * z * q * q, 0.15 * dz * dz / max(DTS(), 0.1)));
  }
  textureStore(auxOut, c, vec4f(nuh, nuv, 0.0, 0.0));
}
`;

// ---------- advection (semi-Lagrangian + MacCormack with a local limiter), from the storm model ----------
const WGSL_M_ADV_COMMON = /* wgsl */`
fn ldV(c: vec3i) -> vec4f { return textureLoad(Vin, clamp(c, vec3i(0), NS()), 0); }
struct Loc { vu: vec3f, vv: vec3f, vw: vec3f, vc: vec3f };
fn localVel(c: vec3i) -> Loc {
  let p = ldV(c);
  let xm = ldV(c - vec3i(1, 0, 0)); let xp = ldV(c + vec3i(1, 0, 0));
  let ym = ldV(c - vec3i(0, 1, 0)); let yp = ldV(c + vec3i(0, 1, 0));
  let zm = ldV(c - vec3i(0, 0, 1)); let zp = ldV(c + vec3i(0, 0, 1));
  let xmyp = ldV(c + vec3i(-1, 1, 0)); let xmzp = ldV(c + vec3i(-1, 0, 1));
  let xpym = ldV(c + vec3i(1, -1, 0)); let ymzp = ldV(c + vec3i(0, -1, 1));
  let xpzm = ldV(c + vec3i(1, 0, -1)); let ypzm = ldV(c + vec3i(0, 1, -1));
  var L: Loc;
  L.vu = vec3f(p.x, 0.25 * (xm.y + p.y + xmyp.y + yp.y), 0.25 * (xm.z + p.z + xmzp.z + zp.z));
  L.vv = vec3f(0.25 * (ym.x + p.x + xpym.x + xp.x), p.y, 0.25 * (ym.z + p.z + ymzp.z + zp.z));
  L.vw = vec3f(0.25 * (zm.x + p.x + xpzm.x + xp.x), 0.25 * (zm.y + p.y + ypzm.y + yp.y), p.z);
  L.vc = vec3f(0.5 * (p.x + xp.x), 0.5 * (p.y + yp.y), 0.5 * (p.z + zp.z));
  return L;
}
fn kvec() -> vec3f { return vec3f(DTS() / DXS(), DTS() / DXS(), DTS() / DZS()); }
fn texU(x: vec3f) -> vec3f { return (x + vec3f(0.5, 0.0, 0.0)) / vec3f(NS() + vec3i(1)); }
fn texVv(x: vec3f) -> vec3f { return (x + vec3f(0.0, 0.5, 0.0)) / vec3f(NS() + vec3i(1)); }
fn texW(x: vec3f) -> vec3f { return (x + vec3f(0.0, 0.0, 0.5)) / vec3f(NS() + vec3i(1)); }
fn texC(x: vec3f) -> vec3f { return x / vec3f(NS() + vec3i(1)); }
fn clampX(x: vec3f) -> vec3f { return clamp(x, vec3f(0.0), vec3f(NS())); }
// the wind at any point (grid units: cell c spans [c, c + 1])
fn velAt(p: vec3f) -> vec3f {
  return vec3f(textureSampleLevel(Vin, sL, texU(p), 0.0).x, textureSampleLevel(Vin, sL, texVv(p), 0.0).y, textureSampleLevel(Vin, sL, texW(p), 0.0).z);
}
// departure point (s = 1) or forward point (s = −1) of p over one step. Hurricane mode traces with the wind at the
// trajectory's midpoint (second order): the straight line along the arrival point's wind lands outside a curved path by
// v²Δt / 2r, i.e. every step drew air in from slightly larger radius — a spurious inflow of ~0.3 m/s near the eyewall
// that filled a dry, frictionless 65-kt vortex by 1–2 hPa/h (in proportion to Δt). Outbreak runs keep the first-order
// trace they were tuned with.
fn trace(p: vec3f, v0: vec3f, s: f32) -> vec3f {
  let k = kvec();
  if (S.cn.w < 0.5) { return clampX(p - s * k * v0); }
  return clampX(p - s * k * velAt(clampX(p - 0.5 * s * k * v0)));
}
`;
const WGSL_M_ADVV1 = WGSL_M_HEAD + /* wgsl */`
@group(0) @binding(2) var Vin: texture_3d<f32>;
@group(0) @binding(3) var sL: sampler;
@group(0) @binding(4) var Vout: texture_storage_3d<rgba32float, write>;
@group(0) @binding(5) var Vval: texture_3d<f32>;   // the values carried: Vin, or (hurricane mode) Vin − 40 % Δt ∇p (WGSL_M_PREP)
` + WGSL_M_ADV_COMMON + /* wgsl */`
@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  _ = BS[0];
  let c = vec3i(id); let n = NS();
  if (any(c > n)) { return; }
  let L = localVel(c); let k = kvec(); let fc = vec3f(c);
  let u = textureSampleLevel(Vval, sL, texU(trace(fc + vec3f(0.0, 0.5, 0.5), L.vu, 1.0)), 0.0).x;
  let v = textureSampleLevel(Vval, sL, texVv(trace(fc + vec3f(0.5, 0.0, 0.5), L.vv, 1.0)), 0.0).y;
  let w = textureSampleLevel(Vval, sL, texW(trace(fc + vec3f(0.5, 0.5, 0.0), L.vw, 1.0)), 0.0).z;
  let t = textureSampleLevel(Vval, sL, texC(trace(fc + vec3f(0.5), L.vc, 1.0)), 0.0).w;
  _ = k;
  textureStore(Vout, c, vec4f(u, v, w, t));
}
`;
const WGSL_M_ADVV2 = WGSL_M_HEAD + /* wgsl */`
@group(0) @binding(2) var Vin: texture_3d<f32>;
@group(0) @binding(3) var Vtmp: texture_3d<f32>;
@group(0) @binding(4) var sL: sampler;
@group(0) @binding(5) var Vout: texture_storage_3d<rgba32float, write>;
@group(0) @binding(6) var Vval: texture_3d<f32>;
` + WGSL_M_ADV_COMMON + /* wgsl */`
fn ldVal(c: vec3i) -> vec4f { return textureLoad(Vval, clamp(c, vec3i(0), NS()), 0); }
fn mm(x: vec3f, off: vec3f, ch: i32) -> vec2f {
  let i0 = vec3i(floor(x - off)); var lo = 1e30; var hi = -1e30;
  for (var q = 0; q < 8; q++) { let s = ldVal(i0 + vec3i(q & 1, (q >> 1) & 1, q >> 2))[ch]; lo = min(lo, s); hi = max(hi, s); }
  return vec2f(lo, hi);
}
@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  _ = BS[0];
  let c = vec3i(id); let n = NS();
  if (any(c > n)) { return; }
  let L = localVel(c); let k = kvec(); let fc = vec3f(c);
  let pu = fc + vec3f(0.0, 0.5, 0.5); let pv = fc + vec3f(0.5, 0.0, 0.5); let pw = fc + vec3f(0.5, 0.5, 0.0); let pc = fc + vec3f(0.5);
  let hat = textureLoad(Vtmp, c, 0); let old = ldVal(c);
  let b = vec4f(textureSampleLevel(Vtmp, sL, texU(trace(pu, L.vu, -1.0)), 0.0).x, textureSampleLevel(Vtmp, sL, texVv(trace(pv, L.vv, -1.0)), 0.0).y,
                textureSampleLevel(Vtmp, sL, texW(trace(pw, L.vw, -1.0)), 0.0).z, textureSampleLevel(Vtmp, sL, texC(trace(pc, L.vc, -1.0)), 0.0).w);
  let cour = length(L.vc * k);
  var r = hat + 0.5 * S.misc.y * clamp(cour / 0.35, S.dzv.w, 1.0) * (old - b);
  let lu = mm(trace(pu, L.vu, 1.0), vec3f(0.0, 0.5, 0.5), 0); let lv = mm(trace(pv, L.vv, 1.0), vec3f(0.5, 0.0, 0.5), 1);
  let lw = mm(trace(pw, L.vw, 1.0), vec3f(0.5, 0.5, 0.0), 2); let lt = mm(trace(pc, L.vc, 1.0), vec3f(0.5), 3);
  r = vec4f(clamp(r.x, lu.x, lu.y), clamp(r.y, lv.x, lv.y), clamp(r.z, lw.x, lw.y), clamp(r.w, lt.x, lt.y));
  textureStore(Vout, c, r);
}
`;
const WGSL_M_ADVQ_COMMON = /* wgsl */`
fn ldV(c: vec3i) -> vec4f { return textureLoad(Vin, clamp(c, vec3i(0), NS()), 0); }
fn cellVel(c: vec3i) -> vec3f { let p = ldV(c); return vec3f(0.5 * (p.x + ldV(c + vec3i(1, 0, 0)).x), 0.5 * (p.y + ldV(c + vec3i(0, 1, 0)).y), 0.5 * (p.z + ldV(c + vec3i(0, 0, 1)).z)); }
fn texS(x: vec3f) -> vec3f { return x / vec3f(NS()); }
fn clampS(x: vec3f) -> vec3f { return clamp(x, vec3f(0.5), vec3f(NS()) - vec3f(0.5)); }
fn kv() -> vec3f { return vec3f(DTS() / DXS(), DTS() / DXS(), DTS() / DZS()); }
// the air's wind at any point (cell c spans [c, c + 1]); departure (s = 1) / forward (s = −1) point of a cell centre
// for something falling at "fall" m/s — midpoint rule in hurricane mode, as trace() for the winds
fn velQ(p: vec3f) -> vec3f {
  let N1 = vec3f(NS() + vec3i(1));
  return vec3f(textureSampleLevel(Vin, sL, (p + vec3f(0.5, 0.0, 0.0)) / N1, 0.0).x, textureSampleLevel(Vin, sL, (p + vec3f(0.0, 0.5, 0.0)) / N1, 0.0).y,
               textureSampleLevel(Vin, sL, (p + vec3f(0.0, 0.0, 0.5)) / N1, 0.0).z);
}
fn traceQ(p: vec3f, v0: vec3f, fall: f32, s: f32) -> vec3f {
  let k = kv(); let f = vec3f(0.0, 0.0, fall);
  if (S.cn.w < 0.5) { return clampS(p - s * k * (v0 - f)); }
  let vm = velQ(clamp(p - 0.5 * s * k * (v0 - f), vec3f(0.0), vec3f(NS()))) - f;
  return clampS(p - s * k * vm);
}
`;
const WGSL_M_ADVQ1 = WGSL_M_HEAD + /* wgsl */`
@group(0) @binding(2) var Q1in: texture_3d<f32>;
@group(0) @binding(3) var Q2in: texture_3d<f32>;
@group(0) @binding(4) var Vin: texture_3d<f32>;
@group(0) @binding(5) var sL: sampler;
@group(0) @binding(6) var Q1out: texture_storage_3d<rgba32float, write>;
@group(0) @binding(7) var Q2out: texture_storage_3d<rgba32float, write>;
` + WGSL_M_ADVQ_COMMON + /* wgsl */`
@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let c = vec3i(id); let n = NS();
  if (any(c >= n)) { return; }
  let v = cellVel(c); let k = kv(); let p = vec3f(c) + 0.5;
  let q1 = textureLoad(Q1in, c, 0); let q2 = textureLoad(Q2in, c, 0);
  let rho = bsA(c.z).z;
  let fv = vtRain(q1.w, q2.z, rho); let fr = fv.x; let fs = vtS(q2.x, rho); let fg = vtGrau(q2.y, rho); let fi = vtI(q1.z, rho);
  var a = textureSampleLevel(Q1in, sL, texS(traceQ(p, v, 0.0, 1.0)), 0.0);
  if (fi > 0.0) { a.z = textureSampleLevel(Q1in, sL, texS(traceQ(p, v, fi, 1.0)), 0.0).z; }
  let r = textureSampleLevel(Q1in, sL, texS(traceQ(p, v, fr, 1.0)), 0.0).w;
  let b = textureSampleLevel(Q2in, sL, texS(traceQ(p, v, 0.0, 1.0)), 0.0);
  let s = textureSampleLevel(Q2in, sL, texS(traceQ(p, v, fs, 1.0)), 0.0).x;
  let g = textureSampleLevel(Q2in, sL, texS(traceQ(p, v, fg, 1.0)), 0.0).y;
  var nr = b.z;
  if (thompson()) { nr = textureSampleLevel(Q2in, sL, texS(traceQ(p, v, fv.y, 1.0)), 0.0).z; }
  textureStore(Q1out, c, vec4f(a.xyz, r));
  textureStore(Q2out, c, vec4f(s, g, nr, b.w));
}
`;
const WGSL_M_ADVQ2 = WGSL_M_HEAD + /* wgsl */`
@group(0) @binding(2) var Q1in: texture_3d<f32>;
@group(0) @binding(3) var Q2in: texture_3d<f32>;
@group(0) @binding(4) var Q1t: texture_3d<f32>;
@group(0) @binding(5) var Q2t: texture_3d<f32>;
@group(0) @binding(6) var Vin: texture_3d<f32>;
@group(0) @binding(7) var sL: sampler;
@group(0) @binding(8) var Q1out: texture_storage_3d<rgba32float, write>;
@group(0) @binding(9) var Q2out: texture_storage_3d<rgba32float, write>;
` + WGSL_M_ADVQ_COMMON + /* wgsl */`
fn ld1(c: vec3i) -> vec4f { return textureLoad(Q1in, clamp(c, vec3i(0), NS() - vec3i(1)), 0); }
fn ld2(c: vec3i) -> vec4f { return textureLoad(Q2in, clamp(c, vec3i(0), NS() - vec3i(1)), 0); }
fn mm1(x: vec3f) -> array<vec4f, 2> { let i0 = vec3i(floor(x - 0.5)); var lo = vec4f(1e30); var hi = vec4f(-1e30);
  for (var q = 0; q < 8; q++) { let s = ld1(i0 + vec3i(q & 1, (q >> 1) & 1, q >> 2)); lo = min(lo, s); hi = max(hi, s); } return array<vec4f, 2>(lo, hi); }
fn mm2(x: vec3f) -> array<vec4f, 2> { let i0 = vec3i(floor(x - 0.5)); var lo = vec4f(1e30); var hi = vec4f(-1e30);
  for (var q = 0; q < 8; q++) { let s = ld2(i0 + vec3i(q & 1, (q >> 1) & 1, q >> 2)); lo = min(lo, s); hi = max(hi, s); } return array<vec4f, 2>(lo, hi); }
@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let c = vec3i(id); let n = NS();
  if (any(c >= n)) { return; }
  let v = cellVel(c); let k = kv(); let p = vec3f(c) + 0.5;
  let q1 = ld1(c); let q2 = ld2(c);
  let rho = bsA(c.z).z;
  let fv = vtRain(q1.w, q2.z, rho); let fr = fv.x; let fs = vtS(q2.x, rho); let fg = vtGrau(q2.y, rho); let fi = vtI(q1.z, rho);
  let h1 = textureLoad(Q1t, c, 0); let h2 = textureLoad(Q2t, c, 0);
  let cour = length(v * k);
  let sm = 0.5 * S.misc.y * clamp(cour / 0.35, S.dzv.w, 1.0);
  let b1 = textureSampleLevel(Q1t, sL, texS(traceQ(p, v, 0.0, -1.0)), 0.0);
  let br = textureSampleLevel(Q1t, sL, texS(traceQ(p, v, fr, -1.0)), 0.0).w;
  let b2 = textureSampleLevel(Q2t, sL, texS(traceQ(p, v, 0.0, -1.0)), 0.0);
  let bs = textureSampleLevel(Q2t, sL, texS(traceQ(p, v, fs, -1.0)), 0.0).x;
  let bg = textureSampleLevel(Q2t, sL, texS(traceQ(p, v, fg, -1.0)), 0.0).y;
  let fn_ = select(0.0, fv.y, thompson());
  let bn = textureSampleLevel(Q2t, sL, texS(traceQ(p, v, fn_, -1.0)), 0.0).z;
  let bi = select(b1.z, textureSampleLevel(Q1t, sL, texS(traceQ(p, v, fi, -1.0)), 0.0).z, fi > 0.0);
  var r1 = h1 + sm * (q1 - vec4f(b1.xy, bi, br));
  var r2 = h2 + sm * (q2 - vec4f(bs, bg, bn, b2.w));
  let m1 = mm1(traceQ(p, v, 0.0, 1.0)); let mr = mm1(traceQ(p, v, fr, 1.0));
  let m2 = mm2(traceQ(p, v, 0.0, 1.0)); let ms = mm2(traceQ(p, v, fs, 1.0)); let mg = mm2(traceQ(p, v, fg, 1.0));
  let mi = mm1(traceQ(p, v, fi, 1.0));
  r1 = vec4f(clamp(r1.xy, m1[0].xy, m1[1].xy), clamp(r1.z, mi[0].z, mi[1].z), clamp(r1.w, mr[0].w, mr[1].w));
  let mn = mm2(traceQ(p, v, fn_, 1.0));
  r2 = vec4f(clamp(r2.x, ms[0].x, ms[1].x), clamp(r2.y, mg[0].y, mg[1].y), clamp(r2.z, mn[0].z, mn[1].z), clamp(r2.w, m2[0].w, m2[1].w));
  textureStore(Q1out, c, max(r1, vec4f(0.0)));
  textureStore(Q2out, c, max(r2, vec4f(0.0)));
}
`;

// ---------- forces + microphysics ----------
const WGSL_M_PHYS = WGSL_M_HEAD + /* wgsl */`
@group(0) @binding(2) var Vin: texture_3d<f32>;
@group(0) @binding(3) var Q1in: texture_3d<f32>;
@group(0) @binding(4) var Q2in: texture_3d<f32>;
@group(0) @binding(5) var aux: texture_3d<f32>;
@group(0) @binding(6) var Vout: texture_storage_3d<rgba32float, write>;
@group(0) @binding(7) var Q1out: texture_storage_3d<rgba32float, write>;
@group(0) @binding(8) var Q2out: texture_storage_3d<rgba32float, write>;
@group(0) @binding(9) var lsfA: texture_2d<f32>;
@group(0) @binding(10) var lsfB: texture_2d<f32>;
@group(0) @binding(11) var phT: texture_3d<f32>;
@group(0) @binding(12) var ciMap: texture_2d<f32>;
@group(0) @binding(13) var sfc: texture_2d<f32>;                 // hurricane mode: (land fraction, SST K, 0, 0)
@group(0) @binding(14) var<storage, read> phi: array<f32>;       // last step's perturbation pressure / ρ (the solve's φ)
` + WGSL_M_TARGET + /* wgsl */`
fn ldV(c: vec3i) -> vec4f { return textureLoad(Vin, clamp(c, vec3i(0), NS()), 0); }
fn ld1(c: vec3i) -> vec4f { return textureLoad(Q1in, clamp(c, vec3i(0), NS() - vec3i(1)), 0); }
fn ld2(c: vec3i) -> vec4f { return textureLoad(Q2in, clamp(c, vec3i(0), NS() - vec3i(1)), 0); }
fn ldA(c: vec3i) -> vec2f { return textureLoad(aux, clamp(c, vec3i(0), NS() - vec3i(1)), 0).xy; }
fn ldP(c: vec3i) -> f32 { return textureLoad(phT, clamp(c, vec3i(0), NS() - vec3i(1)), 0).x; }
fn lapH(c: vec3i, ch: i32, me: f32) -> f32 { return ldV(c + vec3i(1, 0, 0))[ch] + ldV(c - vec3i(1, 0, 0))[ch] + ldV(c + vec3i(0, 1, 0))[ch] + ldV(c - vec3i(0, 1, 0))[ch] - 4.0 * me; }
fn lapZ(c: vec3i, ch: i32, me: f32, lo: bool, hi: bool) -> f32 {
  let a = select(ldV(c - vec3i(0, 0, 1))[ch], me, lo); let b = select(ldV(c + vec3i(0, 0, 1))[ch], me, hi); return a + b - 2.0 * me;
}
fn bsV(k: i32, ch: i32) -> f32 {
  let kk = clamp(k, 0, NS().z - 1);
  if (ch == 0) { return bsB(kk).z; } if (ch == 1) { return bsB(kk).w; } if (ch == 3) { return bsA(kk).x; } return 0.0;
}
fn lapZp(c: vec3i, ch: i32, me: f32, lo: bool, hi: bool) -> f32 {
  let k = c.z;
  let m0 = me - bsV(k, ch);
  let a = select(ldV(c - vec3i(0, 0, 1))[ch] - bsV(k - 1, ch), m0, lo);
  let b = select(ldV(c + vec3i(0, 0, 1))[ch] - bsV(k + 1, ch), m0, hi);
  return a + b - 2.0 * m0;
}
// lateral sponge rate: rises nearly linearly over its width (not quadratically) so that a storm drifting in dies in
// its inner half — the storm's own low / high must not reach the edge, where the pressure is pinned to the target
fn spongeLat(xm: vec2f) -> f32 {
  let L = vec2f(NS().xy) * DXS(); let e = min(min(xm.x, L.x - xm.x), min(xm.y, L.y - xm.y));
  let d = clamp(1.0 - e / S.sponge.x, 0.0, 1.0); return d * (0.3 + 0.7 * d) / S.sponge.y;
}
fn spongeTop(z: f32) -> f32 {
  let ztop = f32(NS().z) * DZS(); if (z < S.sponge.z) { return 0.0; }
  let s = sin(1.5707963 * (z - S.sponge.z) / (ztop - S.sponge.z)); return s * s / S.sponge.w;
}
fn buoy(c: vec3i) -> f32 {
  let A = bsA(c.z); let v = ldV(c); let q1 = ld1(c); let q2 = ld2(c);
  return 9.81 * ((v.w - A.x) / A.x + 0.608 * (q1.x - A.y) - (q1.y + q1.z + q1.w + q2.x + q2.y));
}
@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let c = vec3i(id); let n = NS();
  if (any(c > n)) { return; }
  let dx = DXS(); let dz = DZS(); let dt = DTS();
  let V = ldV(c); var o = V;
  let ix2 = 1.0 / (dx * dx); let iz2 = 1.0 / (dz * dz);
  let fc = S.cor.x;                      // Coriolis parameter
  let nudR = 1.0 / S.cor.y;              // air-mass nudging rate at full weight
  // ---------------- u ----------------
  if (c.y < n.y && c.z < n.z) {
    let xm = vec2f(f32(c.x), f32(c.y) + 0.5) * dx; let z = (f32(c.z) + 0.5) * dz;
    let nu = 0.5 * (ldA(c - vec3i(1, 0, 0)) + ldA(c)) + S.turb.y;
    var du = nu.x * lapH(c, 0, V.x) * ix2 + nu.y * lapZp(c, 0, V.x, c.z == 0, c.z == n.z - 1) * iz2;
    let ut = tgtU(c); let vt = tgtV(c) ;
    let vbar = 0.25 * (ldV(c - vec3i(1, 0, 0)).y + V.y + ldV(c + vec3i(-1, 1, 0)).y + ldV(c + vec3i(0, 1, 0)).y);
    let vtb = 0.5 * (tgtV(c - vec3i(1, 0, 0)) + tgtV(c + vec3i(0, 1, 0)));
    let nw = 0.5 * (lB(c.xy - vec2i(1, 0)).w + lB(c.xy).w);
    du += (spongeLat(xm) + spongeTop(z) + nw * nudR) * (ut - V.x);
    du += fc * (vbar - vtb);
    if (c.x > 0 && c.x < n.x) { du -= (ldP(c) - ldP(c - vec3i(1, 0, 0))) / dx; }
    if (c.z == 0 && S.turb.w > 0.5) {
      let g = vec2f(V.x, vbar); let g0 = vec2f(ut, vtb);
      let cd = select(S.micro.w, cdSfc(length(g), 0.5 * (textureLoad(sfc, max(c.xy - vec2i(1, 0), vec2i(0)), 0).x + textureLoad(sfc, min(c.xy, n.xy - vec2i(1)), 0).x)), hurOn());
      du += cd * (-length(g) * g.x + length(g0) * g0.x) / dz;   // semi-slip with geotriptic balance
    }
    o.x = V.x + dt * du;
  } else { o.x = 0.0; }
  // ---------------- v ----------------
  if (c.x < n.x && c.z < n.z) {
    let xm = vec2f(f32(c.x) + 0.5, f32(c.y)) * dx; let z = (f32(c.z) + 0.5) * dz;
    let nu = 0.5 * (ldA(c - vec3i(0, 1, 0)) + ldA(c)) + S.turb.y;
    var dv = nu.x * lapH(c, 1, V.y) * ix2 + nu.y * lapZp(c, 1, V.y, c.z == 0, c.z == n.z - 1) * iz2;
    let vt = tgtV(c);
    let ubar = 0.25 * (ldV(c - vec3i(0, 1, 0)).x + V.x + ldV(c + vec3i(1, -1, 0)).x + ldV(c + vec3i(1, 0, 0)).x);
    let utb = 0.5 * (tgtU(c - vec3i(0, 1, 0)) + tgtU(c + vec3i(1, 0, 0)));
    let nw = 0.5 * (lB(c.xy - vec2i(0, 1)).w + lB(c.xy).w);
    dv += (spongeLat(xm) + spongeTop(z) + nw * nudR) * (vt - V.y);
    dv -= fc * (ubar - utb);
    if (c.y > 0 && c.y < n.y) { dv -= (ldP(c) - ldP(c - vec3i(0, 1, 0))) / dx; }
    if (c.z == 0 && S.turb.w > 0.5) {
      let g = vec2f(ubar, V.y); let g0 = vec2f(utb, vt);
      let cd = select(S.micro.w, cdSfc(length(g), 0.5 * (textureLoad(sfc, max(c.xy - vec2i(0, 1), vec2i(0)), 0).x + textureLoad(sfc, min(c.xy, n.xy - vec2i(1)), 0).x)), hurOn());
      dv += cd * (-length(g) * g.y + length(g0) * g0.y) / dz;
    }
    o.y = V.y + dt * dv;
  } else { o.y = 0.0; }
  // ---------------- w ----------------
  if (c.x < n.x && c.y < n.y && c.z > 0 && c.z < n.z) {
    let xm = (vec2f(c.xy) + 0.5) * dx; let z = f32(c.z) * dz;
    let nu = 0.5 * (ldA(c - vec3i(0, 0, 1)) + ldA(c)) + S.turb.y;
    var dw = nu.x * lapH(c, 2, V.z) * ix2 + nu.y * lapZ(c, 2, V.z, false, false) * iz2;
    // buoyancy relative to the target air mass (whose weight is carried by its hydrostatic φt)
    dw += 0.5 * (buoy(c - vec3i(0, 0, 1)) + buoy(c)) - (ldP(c) - ldP(c - vec3i(0, 0, 1))) / dz;
    dw += (spongeLat(xm) + spongeTop(z)) * (0.0 - V.z);
    // convective initiation (Naylor & Gilmore 2012 updraft nudging)
    let ci = textureLoad(ciMap, c.xy, 0);
    // (hurricane mode starts its storms as warm, moist bubbles instead, in the θ section: this every-step push on w
    // and the carried-over pressure force of WGSL_M_PREP fed each other — 930 hPa, 145 kt lows a few km wide in 1 h)
    if (ci.x > 0.0 && !hurOn()) {
      let zz = abs(z - ci.z) / ci.w;
      // one-sided: it lifts slower air to the target but never holds back the storm's own, stronger updraft. The
      // target itself follows the vertical profile (w rises smoothly from the ground to the push's centre height):
      // shaping only the nudging rate drove w to the full target a few hundred metres up, squeezing all the push's
      // convergence into the lowest layer — a ring of 25–38 m/s surface inflow winds around every new storm
      if (zz < 1.0) { let cv = cos(1.5707963 * zz); dw += S.misc.w * ci.x * cv * max(ci.y * cv - V.z, 0.0); }
    }
    o.z = V.z + dt * dw;
  } else { o.z = 0.0; }
  // ---------------- θ + microphysics (cell centres) ----------------
  if (all(c < n)) {
    let xm = (vec2f(c.xy) + 0.5) * dx; let z = (f32(c.z) + 0.5) * dz;
    let A = bsA(c.z); let B = bsB(c.z);
    let LA = lA(c.xy); let nw = lB(c.xy).w;
    let tth = tgtTh(LA, c.z); let tqv = tgtQv(LA, c.z);
    let relax = spongeLat(xm) + nw * nudR;
    let nu = ldA(c) * 3.0 + S.turb.y;
    var th = V.w + dt * (nu.x * lapH(c, 3, V.w) * ix2 + nu.y * lapZp(c, 3, V.w, c.z == 0, c.z == n.z - 1) * iz2 + (relax + spongeTop(z)) * (tth - V.w));
    var q1 = ld1(c); var q2 = ld2(c);
    let l1 = ld1(c + vec3i(1, 0, 0)) + ld1(c - vec3i(1, 0, 0)) + ld1(c + vec3i(0, 1, 0)) + ld1(c - vec3i(0, 1, 0)) - 4.0 * q1;
    var l1z = select(ld1(c - vec3i(0, 0, 1)), q1, c.z == 0) + select(ld1(c + vec3i(0, 0, 1)), q1, c.z == n.z - 1) - 2.0 * q1;
    let qvb = select(bsA(c.z - 1).y, A.y, c.z == 0) + select(bsA(c.z + 1).y, A.y, c.z == n.z - 1) - 2.0 * A.y;
    l1z.x -= qvb;
    q1 = vec4f(q1.xyz + dt * (nu.x * l1.xyz * ix2 + nu.y * l1z.xyz * iz2), q1.w);
    q1.x += dt * relax * (tqv - q1.x);
    if (hurOn()) {
      // radiative cooling as a relaxation to the environment (Rotunno & Emanuel 1987: 12 h, at most 2 K/day), which
      // balances the sea's heating of the open tropics
      th += dt * clamp((tth - V.w) / S.hur2.x, -S.hur2.y, S.hur2.y);
      // storm starts (genesis clusters): a warm, moist bubble through the push's depth instead of a forced updraft —
      // up to 1.2·10⁻³ K/s at the core of an 8 m/s push (~1–2 K over its half hour) and moistening toward saturation
      // (2·10⁻³ set off convection so violent that its cold pools, −3 K over the inner 160 km, smothered genesis)
      let cs = textureLoad(ciMap, c.xy, 0);
      if (cs.x > 0.0) {
        let zz = abs(z - cs.z) / cs.w;
        if (zz < 1.0) {
          let f = cs.x * cos(1.5707963 * zz) * cs.y / 8.0;
          th += dt * 1.2e-3 * f;
          q1.x += dt * f / 600.0 * max(0.97 * qvsat(V.w * B.x, B.y, 0.0) - q1.x, 0.0);
        }
      }
      // far from the storm the air is held to the sounding (6 h), standing in for the large-scale flow that keeps the
      // real tropics near radiative-convective balance: without it the sea's heat and moisture built up over the open
      // domain for a day and it erupted into convection nearly everywhere
      let rS = length(xm - S.hur4.xy);
      // (1 h, from hur4.w = 300 km by default: with the observed, ~3000 J/kg sounding a 6 h hold beyond 400 km let the
      // storm's outflow set off self-sustaining convective systems all around it; the cloud and rain out there decay too,
      // below)
      let wEnv = sstep(S.hur4.w, 1.5 * S.hur4.w, rS) / 3600.0;
      th += dt * wEnv * (tth - V.w);
      q1.x += dt * wEnv * (tqv - q1.x);
      // boundary-layer thermals: the km-scale grid resolves none of the sea's turbulent plumes, and a smooth, well-mixed
      // boundary layer never starts convection even under a saturated, unstable core (tested: no updraft over 0.3 m/s in
      // 9 h). Random warm and cool patches (below) heat or cool the lowest ~1 km. The forcing grows with
      // the square of the wind (the storm's wind-driven turbulence), up to full strength at 15 m/s, and only under the
      // storm (hur4.z): forced everywhere, the open sea around it (nearly no CIN) erupted into huge convective systems,
      // whose own outflow winds then forced more.
      if (z < S.hur2.z) {
        let s0 = ldV(vec3i(c.xy, 0));
        let u1 = length(vec2f(0.5 * (s0.x + ldV(vec3i(c.x + 1, c.y, 0)).x), 0.5 * (s0.y + ldV(vec3i(c.x, c.y + 1, 0)).y)));
        // coherent ~6 km thermals living ~15 min (cross-faded): independent 2-km cells (2Δx noise) are what the advection
        // damps hardest, and they never set off convection in a buoyant, CIN-free core
        let e = S.step.y / 900.0; let e0 = floor(e); let q = xm / 6000.0;
        let r = 0.5 * mix(gnoise2(q + vec2f(37.1, 11.3) * e0), gnoise2(q + vec2f(37.1, 11.3) * (e0 + 1.0)), sstep(0.0, 1.0, fract(e)));
        // (and fading out again under eyewall winds of 20–32 m/s, where the storm's own convection carries on and the
        // pulses only jostle it)
        let fu = min(u1 * u1 / 225.0, 1.0) * (1.0 - sstep(20.0, 32.0, u1)) * (1.0 - sstep(S.hur4.z, 1.5 * S.hur4.z, length(xm - S.hur4.xy)));
        th += dt * S.hur3.z * 2.0 * r * fu * (1.0 - z / S.hur2.z);
      }
      if (c.z == 0) {
        // the sea's sensible and latent heat (bulk formulas, Ck ≈ Cd's 10-m value): the hurricane's fuel. Saturation at
        // the sea surface uses the actual surface pressure, which falls by 50–100 hPa under the eye. Land gives only a
        // little moisture and no heat.
        let sf = textureLoad(sfc, c.xy, 0); let land = clamp(sf.x, 0.0, 1.0);
        let u1 = length(vec2f(0.5 * (V.x + ldV(c + vec3i(1, 0, 0)).x), 0.5 * (V.y + ldV(c + vec3i(0, 1, 0)).y)));
        let ch = S.hur.y * S.hur2.w * max(u1, S.hur3.y) / dz;
        let ps = max(S.hur.w + A.z * S.cn.y * phi[pidx(c)], 50000.0);
        let ths = sf.y * pow(1.0e5 / ps, 0.2854);
        th += dt * ch * (1.0 - land) * (ths - V.w);
        // dissipative heating (Bister & Emanuel 1998): the kinetic energy the surface friction takes out of the wind
        // comes back as heat in the lowest layer, Cd |V|³ / (cp Δz) — worth ~10–20 % on a strong storm's peak wind
        if (S.hur5.y > 0.5) { let cdh = cdSfc(u1, land); th += dt * cdh * u1 * u1 * u1 / (CPD * dz) / B.x; }
        let qsS = qvsat(sf.y, ps, 0.0);
        let qsL = qvsat(V.w * B.x, ps, 0.0);
        q1.x += dt * ch * ((1.0 - land) * (qsS - q1.x) + land * S.hur.z * max(qsL - q1.x, 0.0));
      }
    }
    q1 = max(q1, vec4f(0.0)); q2 = max(q2, vec4f(0.0));
    let pi0 = B.x; let p0 = B.y; let rho = A.z;
    var T = th * pi0;
    var qv = q1.x; var qc = q1.y; var qi = q1.z; var qr = q1.w; var qs = q2.x; var qg = q2.y;
    let thm = thompson(); var nr = max(q2.z, 0.0);
    let rq = 1000.0 * rho;
    let rs = sqrt(S.step.z / rho);
    // warm rain (Kessler 1969); Thompson: collection by the actual drop-size distribution (E = 1, v = 842 D^0.8)
    let pauto = S.micro.x * max(qc - S.micro.y, 0.0);
    var accr = 2.2 * qc * pow(qr, 0.875);
    if (thm && qr > 1e-9) { let l = lamR(qr, nr); accr = 3100.0 * rho * nr * pow(l, -2.8) * qc * rs; }
    let da = min(pauto * dt, qc); let dc = min(accr * dt, qc - da);
    qc -= da + dc; qr += da + dc;
    nr += da / 2.68e-10;                                // new drops from autoconversion are ~80 µm
    // ice-phase conversions (condensed Lin et al. 1983)
    let dTc = T - T0K;
    if (dTc < 0.0) {
      let psaut = 1e-3 * exp(0.025 * dTc) * max(qi - 6e-4, 0.0);
      let psacw = 5.4e-3 * qc * pow(max(rq * qs, 0.0), 0.81) * rs;
      let psaci = 5.4e-3 * qi * pow(max(rq * qs, 0.0), 0.81) * exp(0.025 * dTc) * rs;
      let ewet = 1.0 / (1.0 + qg / 0.008);
      let pgacw = 3.1e-3 * qc * pow(max(rq * qg, 0.0), 0.875) * rs * ewet;
      let pgaci = 3.0e-4 * qi * pow(max(rq * qg, 0.0), 0.875) * rs;
      let pgacr = 3.1e-3 * qr * pow(max(rq * qg, 0.0), 0.875) * rs * ewet;
      let pgfr = min(2e-4 * S.micro.z * (exp(0.66 * min(-dTc, 20.0)) - 1.0), 0.08) * qr;
      // Thompson keeps rimed snow as snow until riming dominates: much less snow → graupel conversion than Lin
      let pgaut = 1e-3 * exp(0.09 * dTc) * max(qs - 6e-4, 0.0) * select(1.0, 0.25, thm);
      var a1 = min((psaut + psaci + pgaci) * dt, qi);
      let fs1 = (psaut + psaci) / max(psaut + psaci + pgaci, 1e-20);
      qi -= a1; qs += a1 * fs1; qg += a1 * (1.0 - fs1);
      var a2 = min((psacw + pgacw) * dt, qc);
      let fs2 = psacw / max(psacw + pgacw, 1e-20);
      let rimeS = select(0.7, 0.95, thm);                  // share of the cloud water rimed onto snow that stays snow
      qc -= a2; qs += a2 * fs2 * rimeS; qg += a2 * (1.0 - fs2 * rimeS);
      var a3 = min((pgacr + pgfr) * dt, qr);
      if (T < 235.0) { a3 = qr; }
      if (qr > 1e-12) { nr *= (qr - a3) / qr; }
      qr -= a3; qg += a3;
      var a4 = min(pgaut * dt, qs); qs -= a4; qg += a4;
      T += LFC / CPD * (a2 + a3);
    } else {
      let m1 = min(0.012 * dTc * qs * dt, qs);
      var m2 = min(0.0022 * dTc * qg * dt, qg);
      if (thm) {
        // graupel melts from its size distribution (Lin et al. 1983 with Thompson's intercept): big particles slowly,
        // and not at all in air dry enough to keep their surface below 0 °C; each melted particle becomes one drop
        if (qg > 1e-9) {
          let l = lamG(qg, rho); let n0 = n0G(qg, rho);
          let vent = 0.78 / (l * l) + 0.31 * 0.843 * 1.89 * 5430.0 * pow(S.step.z / rho, 0.25) * pow(l, -2.945);
          let heat = 2.4e-2 * dTc - LVC * 2.26e-5 * rho * (qvsat(T0K, p0, 0.0) - qv);
          m2 = clamp(6.2832 / (rho * LFC) * heat * n0 * vent * dt, 0.0, qg);
          nr += m2 / qg * n0 / (rho * l);
        }
        if (qs > 1e-9) { let ls = pow(3.14159 * 100.0 * 2e6 / (rho * qs), 0.25); nr += m1 / qs * 2e6 / (rho * ls); }
      }
      qs -= m1; qg -= m2; qr += m1 + m2;
      T -= LFC / CPD * (m1 + m2);
    }
    // evaporation of rain; sublimation of snow/graupel
    let qvsl = qvsat(T, p0, 0.0);
    if (qr > 0.0 && qv < qvsl) {
      let rc = 0.001 * rho * qr;
      let ern = ((1.6 + 124.9 * pow(rc, 0.2046)) * pow(rc, 0.525) / (2.55e8 / (p0 * qvsl) + 5.4e5)) * ((qvsl - qv) / (0.001 * rho * qvsl));
      // size sorting: light rain (the forward-flank edge, anvil fallout) is mostly large drops, not the swarm of small
      // ones a fixed intercept assumes, so it evaporates far more slowly (≈ what double-moment schemes get; with
      // single-moment evaporation the cold pools ran to −8…−11 K and storms went outflow-dominant within minutes)
      let srt = select(1.0, sqrt(rc / (rc + 0.001 * rho * S.micro2.y)), S.micro2.y > 0.0);
      var e = ern * srt * dt * S.turb.z;
      if (thm) {
        // Thompson: evaporation from the actual drop-size distribution (Lin et al. 1983), without the single-moment
        // fudge factors: big drops (melted graupel, size-sorted at the forward-flank edge) evaporate slowly
        let l = lamR(qr, nr); let n0 = rho * nr * l;
        let Ap = LVC * LVC / (2.4e-2 * RVC * T * T); let Bp = 1.0 / (rho * qvsl * 2.26e-5);
        let vent = 0.78 / (l * l) + 0.31 * 0.843 * 1.827 * 7492.0 * pow(S.step.z / rho, 0.25) * pow(l, -2.9);
        e = 6.2832 * (1.0 - qv / qvsl) * n0 * vent / (rho * (Ap + Bp)) * dt * S.micro2.w;
      }
      e = clamp(e, 0.0, min(qr, qvsl - qv));
      if (thm && qr > 1e-12) { nr *= (qr - e) / qr; }
      qr -= e; qv += e; T -= LVC / CPD * e;
    }
    // Thompson: rain self-collection and breakup (Seifert & Beheng 2006), then the drop-size bounds
    if (thm) {
      if (qr > 1e-9) {
        // net self-collection (> 0) or breakup (< 0), balancing at a volume-mean diameter of 1.1 mm (Seifert &
        // Beheng's equilibrium: median ≈ 2.2 mm in heavy rain); light rain changes slowly, so size-sorted big
        // drops at the forward-flank edge survive (the ZDR arc)
        let dm = 1.817 / lamR(qr, nr);
        let fb = clamp(1.0 - exp(2300.0 * (dm - 1.1e-3)), -2.0, 1.0);
        nr *= exp(-7.12 * rho * qr * fb * dt);
        nr = clamp(nr, qr * 3.183e5, qr * 3.183e11);
      } else { nr = 0.0; }
    }
    let qvsi = qvsat(T, p0, 1.0);
    if (dTc < 0.0 && qv < qvsi) {
      let sub = max(1.0 - qv / qvsi, 0.0);
      var e = min((2e-3 * qs + 5e-4 * qg) * sub * dt, (qvsi - qv) * 0.5);
      let fsn = qs / max(qs + qg, 1e-20);
      e = min(e, qs + qg);
      qs -= e * fsn; qg -= e * (1.0 - fsn); qv += e; T -= LSC / CPD * e;
    }
    // saturation adjustment, mixed phase (Hsie et al. 1980)
    let qi0 = qi;
    var qcl = qc + qi;
    var dsum = 0.0;
    for (var it = 0; it < 3; it++) {
      let f = fIce(T);
      let qs_ = qvsat(T, p0, f);
      let L = mix(LVC, LSC, f);
      var d = (qv - qs_) / (1.0 + L * L * qs_ / (CPD * RVC * T * T));
      d = max(d, -qcl);
      qv -= d; qcl += d; T += L / CPD * d; dsum += d;
    }
    let f = fIce(T);
    qi = f * qcl; qc = qcl - qi;
    T += LFC / CPD * (qi - qi0 - f * dsum);
    th = T / pi0;
    // the lateral sponge also removes cloud and precipitation (twice its rate), so a storm drifting into it rains and
    // melts itself out instead of building a cold pool against the edge, where the pressure is pinned to the target
    // and a cold pool's high would drive a runaway outflow (tested: 110 m/s winds and a −11 K pool racing back in)
    var envDecay = 0.0;
    if (hurOn()) { envDecay = sstep(S.hur4.w, 1.5 * S.hur4.w, length(xm - S.hur4.xy)) / 1800.0; }
    let keep = 1.0 / (1.0 + 2.0 * dt * spongeLat(xm) + dt * envDecay);
    qc *= keep; qi *= keep; qr *= keep; qs *= keep; qg *= keep; nr *= keep;
    textureStore(Q1out, c, max(vec4f(qv, qc, qi, qr), vec4f(0.0)));
    textureStore(Q2out, c, vec4f(max(qs, 0.0), max(qg, 0.0), select(q2.z, max(nr, 0.0), thm), q2.w));
    o.w = th;
  }
  let sp = length(o.xyz);
  if (sp > S.misc.x) { o = vec4f(o.xyz * (S.misc.x / sp), o.w); }
  if (!(o.x == o.x) || !(o.y == o.y) || !(o.z == o.z) || !(o.w == o.w)) { o = vec4f(bsB(c.z).zw, 0.0, bsA(c.z).x); }
  textureStore(Vout, c, o);
}
`;

// ---------- density-weighted divergence (Poisson right-hand side) ----------
const WGSL_M_DIV = WGSL_M_HEAD + /* wgsl */`
@group(0) @binding(2) var Vin: texture_3d<f32>;
@group(0) @binding(3) var<storage, read_write> rhs: array<f32>;
fn ldV(c: vec3i) -> vec4f { return textureLoad(Vin, clamp(c, vec3i(0), NS()), 0); }
@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let c = vec3i(id); let n = NS();
  if (any(c >= n)) { return; }
  let p = ldV(c);
  let rc = bsA(c.z).z;
  let wt = select(ldV(c + vec3i(0, 0, 1)).z, 0.0, c.z == n.z - 1);
  let wb = select(p.z, 0.0, c.z == 0);
  let d = rc * (ldV(c + vec3i(1, 0, 0)).x - p.x + ldV(c + vec3i(0, 1, 0)).y - p.y) / DXS() + (rhoW(c.z + 1) * wt - rhoW(c.z) * wb) / DZS();
  rhs[pidx(c)] = d / DTS();
}
`;

// ---------- projection: φ comes from the padded solve, so the edge faces use the solved φ just outside the domain ----------
const WGSL_M_PROJ = WGSL_M_HEAD + /* wgsl */`
@group(0) @binding(2) var Vin: texture_3d<f32>;
@group(0) @binding(3) var<storage, read> phi: array<f32>;
@group(0) @binding(4) var Vout: texture_storage_3d<rgba32float, write>;
fn ldV(c: vec3i) -> vec4f { return textureLoad(Vin, clamp(c, vec3i(0), NS()), 0); }
fn P(c: vec3i) -> f32 { let p = i32(S.pad.x); return phi[pidx(clamp(c, vec3i(-p, -p, 0), NS() + vec3i(p - 1, p - 1, -1)))]; }
@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let c = vec3i(id); let n = NS();
  if (any(c > n)) { return; }
  _ = BS[0];
  let V = ldV(c); var o = V;
  let kx = DTS() / DXS(); let kz = DTS() / DZS();
  if (c.y < n.y && c.z < n.z) { o.x = V.x - kx * (P(c) - P(c - vec3i(1, 0, 0))); }
  if (c.x < n.x && c.z < n.z) { o.y = V.y - kx * (P(c) - P(c - vec3i(0, 1, 0))); }
  if (c.x < n.x && c.y < n.y && c.z > 0 && c.z < n.z) { o.z = V.z - kz * (P(c) - P(c - vec3i(0, 0, 1))); } else { o.z = 0.0; }
  textureStore(Vout, c, o);
}
`;

// ---------- hurricane mode: the 2Δx filter ----------
// Full-strength MacCormack advection (needed for hurricanes, see app.js) leaves grid-scale stripes in rain and cloud.
// A weak 4th-order horizontal hyperdiffusion removes them (as WRF / CM1 filter): with S.hur5.z per pass, a 2Δx wave
// loses 16× that, a 4Δx wave 4×, a 10Δx one 0.3×. It is its own kernel, dispatched every 4th step at 4× strength
// (inside the physics kernel it slowed every step to ~60 %), reading the state and writing the scratch fields, which
// are then copied back. Hydrometeors stay non-negative.
const WGSL_M_FILT = WGSL_M_HEAD + /* wgsl */`
@group(0) @binding(2) var Vin: texture_3d<f32>;
@group(0) @binding(3) var Q1in: texture_3d<f32>;
@group(0) @binding(4) var Q2in: texture_3d<f32>;
@group(0) @binding(5) var Vout: texture_storage_3d<rgba32float, write>;
@group(0) @binding(6) var Q1out: texture_storage_3d<rgba32float, write>;
@group(0) @binding(7) var Q2out: texture_storage_3d<rgba32float, write>;
fn ldV(c: vec3i) -> vec4f { return textureLoad(Vin, clamp(c, vec3i(0), NS()), 0); }
fn ld1(c: vec3i) -> vec4f { return textureLoad(Q1in, clamp(c, vec3i(0), NS() - vec3i(1)), 0); }
fn ld2(c: vec3i) -> vec4f { return textureLoad(Q2in, clamp(c, vec3i(0), NS() - vec3i(1)), 0); }
fn bihV(c: vec3i) -> vec4f {
  let x = vec3i(1, 0, 0); let y = vec3i(0, 1, 0);
  return 20.0 * ldV(c) - 8.0 * (ldV(c + x) + ldV(c - x) + ldV(c + y) + ldV(c - y))
    + 2.0 * (ldV(c + x + y) + ldV(c + x - y) + ldV(c - x + y) + ldV(c - x - y)) + ldV(c + 2 * x) + ldV(c - 2 * x) + ldV(c + 2 * y) + ldV(c - 2 * y);
}
fn bih1(c: vec3i) -> vec4f {
  let x = vec3i(1, 0, 0); let y = vec3i(0, 1, 0);
  return 20.0 * ld1(c) - 8.0 * (ld1(c + x) + ld1(c - x) + ld1(c + y) + ld1(c - y))
    + 2.0 * (ld1(c + x + y) + ld1(c + x - y) + ld1(c - x + y) + ld1(c - x - y)) + ld1(c + 2 * x) + ld1(c - 2 * x) + ld1(c + 2 * y) + ld1(c - 2 * y);
}
fn bih2(c: vec3i) -> vec4f {
  let x = vec3i(1, 0, 0); let y = vec3i(0, 1, 0);
  return 20.0 * ld2(c) - 8.0 * (ld2(c + x) + ld2(c - x) + ld2(c + y) + ld2(c - y))
    + 2.0 * (ld2(c + x + y) + ld2(c + x - y) + ld2(c - x + y) + ld2(c - x - y)) + ld2(c + 2 * x) + ld2(c - 2 * x) + ld2(c + 2 * y) + ld2(c - 2 * y);
}
@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  _ = BS[0];
  let c = vec3i(id); let n = NS();
  if (any(c > n)) { return; }
  let a = S.hur5.z;
  var o = ldV(c) - a * bihV(c);
  // the lid / ground faces of w stay zero
  if (c.z == 0 || c.z >= n.z) { o.z = 0.0; }
  textureStore(Vout, c, o);
  if (all(c < n)) {
    textureStore(Q1out, c, max(ld1(c) - a * bih1(c), vec4f(0.0)));
    textureStore(Q2out, c, max(ld2(c) - a * bih2(c), vec4f(0.0)));
  }
}
`;

// ---------- hurricane mode: half the old pressure force, applied before advection ----------
// The projection applies the whole pressure force at the end of the step, at the arrival point, after the wind has been
// advected without it. For rotating flow that is backward Euler: every step the wind is advected along its curved path
// as if no centripetal force acted, the projection only removes the resulting outward component, and the speed shrinks
// by (ΩΔt)²/2 — a dry, frictionless 65-kt vortex filled 1.3 hPa/h at Δt = 12 s (0.7 at 6 s, 2.2 at 18 s), and the
// damping grows with Ω², so it held small intense eyewalls down most of all. Here 40 % of the last step's pressure force
// is applied before advection, so it is carried (and turned) along the trajectory, and the projection supplies the
// rest at the arrival point: the force is averaged along the trajectory (Crank–Nicolson-like, off-centred 40/60, see
// writeUniforms). The stored φ is then 60 % of the pressure (cn.y / cn.z = 1 / 0.6). The shifted winds go into their own
// field (Vp), whose values the wind advection carries; the trajectories and θ / moisture advection keep the true winds:
// applied in place, the vertical part (40 % Δt ∂p/∂z ≈ 0.4 m/s in a warm core) moved θ with the wrong w.
const WGSL_M_PREP = WGSL_M_HEAD + /* wgsl */`
@group(0) @binding(2) var Vin: texture_3d<f32>;
@group(0) @binding(3) var<storage, read> phi: array<f32>;
@group(0) @binding(4) var Vout: texture_storage_3d<rgba32float, write>;
fn ldV(c: vec3i) -> vec4f { return textureLoad(Vin, clamp(c, vec3i(0), NS()), 0); }
fn P(c: vec3i) -> f32 { let p = i32(S.pad.x); return phi[pidx(clamp(c, vec3i(-p, -p, 0), NS() + vec3i(p - 1, p - 1, -1)))]; }
@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let c = vec3i(id); let n = NS();
  if (any(c > n)) { return; }
  _ = BS[0];
  let V = ldV(c); var o = V;
  let f = S.cn.x * S.cn.y;
  let kx = f * DTS() / DXS(); let kz = f * DTS() / DZS();
  if (c.y < n.y && c.z < n.z) { o.x = V.x - kx * (P(c) - P(c - vec3i(1, 0, 0))); }
  if (c.x < n.x && c.z < n.z) { o.y = V.y - kx * (P(c) - P(c - vec3i(0, 1, 0))); }
  if (c.x < n.x && c.y < n.y && c.z > 0 && c.z < n.z) { o.z = V.z - kz * (P(c) - P(c - vec3i(0, 0, 1))); }
  textureStore(Vout, c, o);
}
`;

// ---------- 2-D maps for the display, storm finding and the scheduler ----------
//   map0 = (composite dBZ, dBZ at ~1 km, θ′ at the lowest level vs the warm sector, ζ at ~1 km (1/s))
//   map1 = (max w below 12 km, 2–5 km updraft helicity m²/s², lowest-level convergence 1e-3/s, lowest-level wind speed)
//   map2 = (u, v at the lowest level, u, v at ~1 km) for the velocity layers
//   map3 = (surface pressure perturbation hPa, infrared brightness temperature K, ~10-m wind m/s, ζ at ~5 km) for hurricanes
const WGSL_M_MAP = WGSL_M_HEAD + /* wgsl */`
@group(0) @binding(2) var Vin: texture_3d<f32>;
@group(0) @binding(3) var Q1in: texture_3d<f32>;
@group(0) @binding(4) var Q2in: texture_3d<f32>;
@group(0) @binding(5) var<storage, read_write> outM: array<vec4f>;
@group(0) @binding(6) var<storage, read> phi: array<f32>;
@group(0) @binding(7) var sfc: texture_2d<f32>;
fn ldV(c: vec3i) -> vec4f { return textureLoad(Vin, clamp(c, vec3i(0), NS()), 0); }
fn cvel(c: vec3i) -> vec3f { let p = ldV(c); return vec3f(0.5 * (p.x + ldV(c + vec3i(1, 0, 0)).x), 0.5 * (p.y + ldV(c + vec3i(0, 1, 0)).y), 0.5 * (p.z + ldV(c + vec3i(0, 0, 1)).z)); }
fn dbz(c: vec3i) -> f32 {
  let q1 = textureLoad(Q1in, c, 0); let q2 = textureLoad(Q2in, c, 0); let rho = bsA(c.z).z;
  let T = ldV(c).w * bsB(c.z).x;
  let Zr = zRain(q1.w, q2.z, rho);
  let Zs = 9.80e8 * pow(max(rho * q2.x, 0.0), 1.75) * 0.224 * 4.0;
  let Zg = zGrau(q2.y, rho, T);
  let Z = Zr + Zs + Zg;
  return select(-30.0, 10.0 * log(Z) / 2.302585, Z > 1e-3);
}
fn zeta(i: i32, j: i32, k: i32) -> f32 {
  return (cvel(vec3i(i + 1, j, k)).y - cvel(vec3i(i - 1, j, k)).y - cvel(vec3i(i, j + 1, k)).x + cvel(vec3i(i, j - 1, k)).x) / (2.0 * DXS());
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let n = NS(); let i = i32(gid.x); let j = i32(gid.y);
  if (i >= n.x || j >= n.y) { return; }
  let dz = DZS();
  var comp = -30.0; var wmx = 0.0; var uh = 0.0;
  let k12 = min(i32(12000.0 / dz), n.z - 1);
  for (var k = 0; k < k12; k++) {
    let c = vec3i(i, j, k);
    let w = cvel(c).z;
    wmx = max(wmx, w);
    comp = max(comp, dbz(c));
    let z = (f32(k) + 0.5) * dz;
    if (z > 2000.0 && z < 5000.0 && w > 0.0) { uh += w * max(zeta(i, j, k), 0.0) * dz; }
  }
  let k1 = clamp(i32(1000.0 / dz), 1, n.z - 2);
  let v0 = cvel(vec3i(i, j, 0));
  let conv = -((ldV(vec3i(i + 1, j, 0)).x - ldV(vec3i(i, j, 0)).x + ldV(vec3i(i, j + 1, 0)).y - ldV(vec3i(i, j, 0)).y) / DXS()) * 1000.0;
  let idx = i + n.x * j;
  outM[idx] = vec4f(comp, dbz(vec3i(i, j, k1)), ldV(vec3i(i, j, 0)).w - bsA(0).x, zeta(i, j, k1));
  outM[idx + n.x * n.y] = vec4f(wmx, uh, conv, length(v0.xy));
  // winds for the velocity layers: the lowest level and ~1 km
  let v1 = cvel(vec3i(i, j, k1));
  outM[idx + 2 * n.x * n.y] = vec4f(v0.x, v0.y, v1.x, v1.y);
  // infrared (10.7 µm window) brightness temperature: each level emits at its temperature in proportion to the
  // condensate's infrared absorption (cloud droplets 80, ice 60, snow 25, graupel 4 m²/kg: thin cirrus is still
  // translucent, but an anvil's or a hurricane's dense overcast emits from near its top — at 27 / 8 for ice / snow the
  // CDO read 10–20 K warmer than its top and looked nothing like GOES),
  // seen through the cloud above it; the rest comes from the sea surface (or the lowest level)
  var tr = 1.0; var bt = 0.0;
  for (var k = n.z - 1; k >= 0; k--) {
    let c = vec3i(i, j, k);
    let q1 = textureLoad(Q1in, c, 0); let q2 = textureLoad(Q2in, c, 0);
    let dtau = (80.0 * q1.y + 60.0 * q1.z + 25.0 * q2.x + 4.0 * q2.y + 1.0 * q1.w) * bsA(k).z * dz;
    let a = 1.0 - exp(-dtau);
    bt += tr * a * ldV(c).w * bsB(k).x; tr *= 1.0 - a;
    if (tr < 1e-3) { break; }
  }
  let sst = textureLoad(sfc, vec2i(i, j), 0).y;
  bt += tr * select(ldV(vec3i(i, j, 0)).w * bsB(0).x, sst, sst > 200.0);
  let p = i32(S.pad.x);
  let ps = bsA(0).z * S.cn.z * phi[(i + p) + i32(S.pad.y) * (j + p)] / 100.0;
  // ζ at ~5 km (1/s): where a genesis cluster's mid-level vortex is
  let k5 = clamp(i32(5000.0 / dz), 1, n.z - 2);
  outM[idx + 3 * n.x * n.y] = vec4f(ps, bt, S.hur2.w * length(v0.xy), zeta(i, j, k5));
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// levels by grid spacing (20 km deep): 56 at 2 km … 80 at 500 m (250 m deep cells) … 160 at 100 m
const LEVELS_BY_DX = [[100, 160], [250, 100], [500, 80], [1000, 64], [1500, 60], [2000, 56], [3000, 52], [4000, 48]];
function levelsFor(dx) {
  const T = LEVELS_BY_DX, l = Math.log(clamp(dx, T[0][0], T[T.length - 1][0]));
  for (let i = 0; i < T.length - 1; i++) {
    const a = Math.log(T[i][0]), b = Math.log(T[i + 1][0]);
    if (l <= b) return Math.round(lerp(T[i][1], T[i + 1][1], (l - a) / (b - a)) / 4) * 4;
  }
  return T[T.length - 1][1];
}
// a custom grid: spacing (m) and domain size (km); cells per side a multiple of 8, at most 2040 (3-D texture limit)
function customGrid(c) {
  const dx = clamp(+c.dx || 500, 100, 4000);
  const side = km => clamp(Math.round((+km || 256) * 1000 / dx / 8) * 8, 64, 2040);
  const nx = side(c.w), ny = side(c.h), nz = levelsFor(dx);
  const km = v => (v * dx / 1000).toFixed(v * dx % 1000 ? 1 : 0);
  return { key: `custom:${dx}:${nx}x${ny}x${nz}`, dx, n: [nx, ny, nz], label: `Custom · ${dx} m · ${km(nx)} × ${km(ny)} km · ${nz} levels` };
}
// the pressure solve's padding (cells per side): ~10 km, a multiple of 8, 8–64 cells
function gridPad(dx) { return clamp(Math.round(10000 / dx / 8) * 8, 8, 64); }
// GPU memory of a grid (bytes): ~176 B per cell (state, advection fields; solver fields on the padded grid) + 2-D maps
// + solver matrices, + 5 % (measured: 15.8 GB for 1024 × 1024 × 80 before the padding)
function gridBytes(g) {
  const [nx, ny, nz] = g.n, p = gridPad(g.dx), nxp = nx + 2 * p, nyp = ny + 2 * p;
  return 1.05 * ((nx + 1) * (ny + 1) * (nz + 1) * 48 + nx * ny * nz * 108 + nxp * nyp * nz * 20 + nx * ny * 192 + 8 * (nxp * nxp + nyp * nyp));
}
// The largest single field (the wind/θ 3-D texture) in bytes as the browser sets it up: WebGPU zero-fills every new
// texture before its first use from ONE staging buffer, which cannot exceed maxBufferSize (2 GiB in Chrome / Edge),
// so a field over 2 GiB fails at the first step ("Buffer size … exceeds the max buffer size limit") however much GPU
// memory is free. Rows are padded to 256 bytes (16 texels).
function gridFieldBytes(g) { const [nx, ny, nz] = g.n; return 16 * Math.ceil((nx + 1) / 16) * 16 * (ny + 1) * (nz + 1); }
function gridFieldLimit() { return (GPU.device && GPU.device.limits.maxBufferSize) || 2 ** 31; }
// the largest square domain (cells per side, a multiple of 8) whose fields fit at this spacing
function gridMaxSide(dx) {
  const nz = levelsFor(dx);
  let n = 2040;
  while (n > 64 && gridFieldBytes({ n: [n, n, nz] }) > gridFieldLimit()) n -= 8;
  return n;
}
const GRID_PRESETS = {
  quick: { dx: 2000, n: [320, 320, 56], label: '2 km · 640 × 640 km · 56 levels (fastest)' },
  standard: { dx: 1500, n: [448, 448, 60], label: '1.5 km · 672 × 672 km · 60 levels' },
  large: { dx: 1500, n: [640, 640, 60], label: '1.5 km · 960 × 960 km · 60 levels' },
  fine: { dx: 1000, n: [640, 640, 64], label: '1 km · 640 × 640 km · 64 levels' },
  m500: { dx: 500, n: [512, 512, 80], label: '500 m · 256 × 256 km · 80 levels' },
  m250: { dx: 250, n: [512, 512, 100], label: '250 m · 128 × 128 km · 100 levels' },
  m100: { dx: 100, n: [512, 512, 160], label: '100 m · 51 × 51 km · 160 levels (slow)' },
  // hurricanes need room: a storm and its rainbands span 500–1000 km, and it moves 200–400 km a day
  h2: { dx: 2000, n: [640, 640, 56], label: 'Hurricane · 2 km · 1280 × 1280 km · 56 levels' },
  h3: { dx: 3000, n: [640, 640, 52], label: 'Hurricane · 3 km · 1920 × 1920 km · 52 levels (fast, coarse eyewall)' },
  h15: { dx: 1500, n: [960, 960, 60], label: 'Hurricane · 1.5 km · 1440 × 1440 km · 60 levels (slow)' },
};

class RegionalModel {
  constructor() {
    this.U = new UBlock(MODEL_FIELDS);
    this.ubo = GPU.ubuf(this.U.size, 'mU');
    const P = (c, l) => GPU.compute(c, l);
    this.pipes = {
      lsf: P(WGSL_M_LSF, 'm.lsf'), ci: P(WGSL_M_CI, 'm.ci'), init: P(WGSL_M_INIT, 'm.init'), nut: P(WGSL_M_NUT, 'm.nut'),
      advV1: P(WGSL_M_ADVV1, 'm.advV1'), advV2: P(WGSL_M_ADVV2, 'm.advV2'), advQ1: P(WGSL_M_ADVQ1, 'm.advQ1'), advQ2: P(WGSL_M_ADVQ2, 'm.advQ2'),
      phys: P(WGSL_M_PHYS, 'm.phys'), div: P(WGSL_M_DIV, 'm.div'), proj: P(WGSL_M_PROJ, 'm.proj'), map: P(WGSL_M_MAP, 'm.map'),
      prep: P(WGSL_M_PREP, 'm.prep'), filt: P(WGSL_M_FILT, 'm.filt'),
    };
    this.sampL = GPU.device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
    // The storm model's (TrailingHV) mixing and advection settings on every grid: Smagorinsky cs 0.18 with the dry N²
    // in cloud (moistMix 0), MacCormack floor 0.25. Tested 2 km – 500 m: km-grid alternatives (full MacCormack, moist
    // N² in cloud) left grid-scale noise and outflow-dominated storms that died sooner.
    // Rain evaporation 22 % of Kessler's (plus size sorting, sortQ): single-moment rain evaporates far too readily —
    // at 35 % a Dixie-type sounding at 300 m gave −8…−11 K cold pools over 700 km² within 50 min (outflow-dominant
    // storms); at 22 %, −2…−4 K over ~300 km² (a −6 K core) and a strong cyclonic low-level meso. 15 % left moist
    // soundings (3 May 1999) with no cold pool at all, i.e. no forward-flank baroclinity for a low-level meso.
    // qc0 = 2 g/kg: continental (Plains) warm rain is slow, so a new storm's first echo forms aloft and descends.
    this.params = {
      cs: 0.18, nu0: 1.0, drag: 1, z0: 0.1, spongeW: 36000, spongeTau: 100, dampZ: 15000, dampTau: 150,
      auto: 1e-3, qc0: 2e-3, freeze: 1.0, noise: 0.25, mc: 1.0, vcap: 110, evap: 0.22, sortQ: 5e-4, ciRate: 0.5, nudgeTau: 5400, lat: 35,
      moistMix: 0, mcFloor: 0.25,
    };
    this.parity = 0; this.time = 0; this.steps = 0;
    this.bounds = []; this.ciEvents = [];
  }

  // key: a preset name, or spec = {key, dx, n} for a custom grid. Throws if the GPU is out of memory.
  async allocate(key, spec) {
    this.destroy();
    const pr = spec || GRID_PRESETS[key], [nx, ny, nz] = pr.n;
    if (gridFieldBytes(pr) > gridFieldLimit()) {
      const side = gridMaxSide(pr.dx) * pr.dx / 1000;
      throw new Error(`this grid is too big for the browser: one model field would be ${(gridFieldBytes(pr) / 2 ** 30).toFixed(2)} GiB, and WebGPU can only set up fields of up to ${(gridFieldLimit() / 2 ** 30).toFixed(0)} GiB. At ${pr.dx} m the largest domain is about ${side.toFixed(0)} × ${side.toFixed(0)} km (or the same area in another shape).`);
    }
    const d = GPU.device;
    d.pushErrorScope('out-of-memory'); d.pushErrorScope('validation');
    try { this.allocTextures(key, pr, nx, ny, nz); } catch (e) { this.destroy(); this.key = null; throw e; }
    const ve = await d.popErrorScope(), oe = await d.popErrorScope();
    if (oe || ve) {
      this.destroy(); this.key = null;
      throw new Error(oe ? `not enough GPU memory for this grid (it needs about ${(gridBytes(pr) / 1e9).toFixed(1)} GB): close other GPU-heavy programs, or reload the page to free an earlier grid's memory` : ve.message);
    }
  }
  allocTextures(key, pr, nx, ny, nz) {
    Object.assign(this, { key, nx, ny, nz, dx: pr.dx, dz: 20000 / nz });
    this.Lx = nx * this.dx; this.Ly = ny * this.dx; this.Lz = nz * this.dz;
    // lateral sponge: ~8 % of the domain (40 km at 500+ km, 20 km at 256 km, 5 km on the 100 m grid), relaxing to the
    // target at up to 1/100 s at the edge: storms that reach it are erased before they reach the edge itself
    this.params.spongeW = clamp(0.08 * Math.min(this.Lx, this.Ly), 5000, 40000);
    const T3 = (w, h, d, f, l) => GPU.tex3d(w, h, d, f, l);
    this.V = [T3(nx + 1, ny + 1, nz + 1, 'rgba32float', 'mV0'), T3(nx + 1, ny + 1, nz + 1, 'rgba32float', 'mV1')];
    this.Vt = T3(nx + 1, ny + 1, nz + 1, 'rgba32float', 'mVt');
    this.Q1 = [T3(nx, ny, nz, 'rgba32float', 'mQ1a'), T3(nx, ny, nz, 'rgba32float', 'mQ1b')];
    this.Q2 = [T3(nx, ny, nz, 'rgba32float', 'mQ2a'), T3(nx, ny, nz, 'rgba32float', 'mQ2b')];
    this.Q1t = T3(nx, ny, nz, 'rgba32float', 'mQ1t'); this.Q2t = T3(nx, ny, nz, 'rgba32float', 'mQ2t');
    this.aux = T3(nx, ny, nz, 'rg32float', 'mAux');
    this.phT = T3(nx, ny, nz, 'r32float', 'mPhT');
    this.lsfA = GPU.tex2d(nx, ny, 'rgba32float', 'mLsfA'); this.lsfB = GPU.tex2d(nx, ny, 'rgba32float', 'mLsfB');
    this.ciMap = GPU.tex2d(nx, ny, 'rgba32float', 'mCI');
    this.bs = GPU.sbuf((nz + 1) * 8 * 4, 'mBase');
    this.bndBuf = GPU.sbuf(MAX_BOUNDS * 592, 'mBounds');
    this.ciBuf = GPU.sbuf(MAX_CI * 48, 'mCIev');
    // The pressure solve runs on the grid padded by ~10 km of cells on each side with φ = 0 at the padded edge, so φ
    // at the domain edge is solved (it decays smoothly outside) instead of pinned to 0 just outside the last cell:
    // pinned, any low or high reaching the edge fell across half a cell and drove 50–110 m/s winds through it.
    this.pad = gridPad(this.dx);
    const nxp = nx + 2 * this.pad, nyp = ny + 2 * this.pad, pcells = nxp * nyp * nz;
    this.phi = GPU.sbuf(pcells * 4, 'mPhi'); this.rhs = GPU.sbuf(pcells * 4, 'mRhs');
    this.solver = new PoissonDirect(nxp, nyp, nz, this.dx, this.dz);
    this.U.set('pad', this.pad, nxp, nyp, 0);
    this.mapBuf = GPU.sbuf(nx * ny * 64, 'mMaps');
    this.mapRead = [0, 1].map(() => GPU.device.createBuffer({ size: nx * ny * 64, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
    // hurricane mode: the sea / land surface (land fraction, SST K) and the initial vortex's table
    this.sfc = GPU.tex2d(nx, ny, 'rgba32float', 'mSfc');
    this.vxBuf = GPU.sbuf(nz * VX_MAXR * 16, 'mVortex');
    this.mapBusy = [false, false];
    this.U.set('dims', nx, ny, nz, this.dx);
    this.U.set('dzv', this.dz, 1 / this.dx, 1 / this.dz, 0);
    this.makeBindGroups();
  }
  destroy() {
    if (!this.V) return;
    const k = t => t && t.destroy && t.destroy();
    [...this.V, this.Vt, ...(this.Q1 || []), ...(this.Q2 || []), this.Q1t, this.Q2t, this.aux, this.phT, this.lsfA, this.lsfB, this.ciMap, this.bs, this.bndBuf, this.ciBuf,
      this.phi, this.rhs, this.mapBuf, ...(this.mapRead || []), this.sfc, this.vxBuf, this.Vp].forEach(k);
    this.Vp = null;
    if (this.solver) this.solver.destroy();
    this.V = null; this.solver = null;
  }
  makeBindGroups() {
    const p = this.pipes, B = (pp, r) => GPU.bind(pp, 0, r), u = this.ubo, bs = this.bs, s = this.sampL;
    const v = t => t.createView();
    this.bg = {
      lsf: B(p.lsf, [u, bs, this.bndBuf, v(this.lsfA), v(this.lsfB), v(this.phT)]),
      ci: B(p.ci, [u, bs, this.ciBuf, v(this.ciMap)]),
      init: B(p.init, [u, bs, v(this.lsfA), v(this.lsfB), v(this.V[0]), v(this.Q1[0]), v(this.Q2[0]), this.vxBuf]),
      solve: this.solver.bind(this.rhs, this.phi),
    };
    this.bg.par = [0, 1].map(pv => {
      const Vc = this.V[pv], Vn = this.V[1 - pv];
      return {
        nut: B(p.nut, [u, bs, v(Vc), v(this.aux), v(this.Q1[0]), v(this.sfc)]),
        advV1: B(p.advV1, [u, bs, v(Vc), s, v(this.Vt), v(this.Vp || Vc)]),
        advV2: B(p.advV2, [u, bs, v(Vc), v(this.Vt), s, v(Vn), v(this.Vp || Vc)]),
        advQ1: B(p.advQ1, [u, bs, v(this.Q1[0]), v(this.Q2[0]), v(Vc), s, v(this.Q1t), v(this.Q2t)]),
        advQ2: B(p.advQ2, [u, bs, v(this.Q1[0]), v(this.Q2[0]), v(this.Q1t), v(this.Q2t), v(Vc), s, v(this.Q1[1]), v(this.Q2[1])]),
        phys: B(p.phys, [u, bs, v(Vn), v(this.Q1[1]), v(this.Q2[1]), v(this.aux), v(Vc), v(this.Q1[0]), v(this.Q2[0]),
          v(this.lsfA), v(this.lsfB), v(this.phT), v(this.ciMap), v(this.sfc), this.phi]),
        div: B(p.div, [u, bs, v(Vc), this.rhs]),
        proj: B(p.proj, [u, bs, v(Vc), this.phi, v(Vn)]),
        prep: this.Vp ? B(p.prep, [u, bs, v(Vc), this.phi, v(this.Vp)]) : null,
        filt: B(p.filt, [u, bs, v(Vc), v(this.Q1[0]), v(this.Q2[0]), v(Vn), v(this.Q1[1]), v(this.Q2[1])]),
        map: B(p.map, [u, bs, v(Vn), v(this.Q1[0]), v(this.Q2[0]), this.mapBuf, this.phi, v(this.sfc)]),
      };
    });
  }

  setSounding(text) {
    const snd = Sounding.parseSharppy(text);
    const A = Sounding.analyze(snd);
    this.analysis = A; this.snd = snd;
    const bsx = Sounding.baseState(snd, this.nz, this.dz, [0, 0]);
    this.base = bsx; this.rhoSfc = bsx.B[2];
    GPU.write(this.bs, bsx.B);
    const rc = [], rw = [];
    for (let k = 0; k < this.nz; k++) rc.push(bsx.B[k * 8 + 2]);
    for (let k = 0; k <= this.nz; k++) rw.push(bsx.B[k * 8 + 3]);
    this.solver.setDensity(rc, rw);
    return A;
  }
  // the extra wind field the trajectory-averaged pressure force needs (hurricane runs only: ~16 B per cell)
  setPrepField(on) {
    if (!!this.Vp === !!on) return;
    if (this.Vp) { this.Vp.destroy(); this.Vp = null; }
    if (on) this.Vp = GPU.tex3d(this.nx + 1, this.ny + 1, this.nz + 1, 'rgba32float', 'mVp');
    this.makeBindGroups();
  }
  // hurricane mode. surf: Float32Array(nx·ny·4) = (land fraction, SST K, 0, 0) per column (null = no sea: outbreak mode);
  // hur: {ck, landMoist, sfcP Pa, tauRad s, radCap K/s, blDepth m, u10f, gust m/s} or null
  setSurface(surf, hur) {
    const n = this.nx * this.ny, a = surf || new Float32Array(n * 4);
    GPU.device.queue.writeTexture({ texture: this.sfc }, a, { bytesPerRow: this.nx * 16, rowsPerImage: this.ny }, [this.nx, this.ny]);
    this.hur = hur || null;
    this.setPrepField(!!hur);
  }
  // The initial vortex (hurricane mode): tangential wind v(r, z) = Vs(r) F(z). Vs is a smooth Rankine-type profile,
  // vmax (1+a) x / (a + x^(1+a)) with x = r / rmw (solid-body inside, v ∝ r^(−a) outside, a = 0.6), tapered towards the
  // outer radius r0, and then made inertially stable: marching outward, the absolute angular momentum M = r v + f r²/2
  // never decreases (where the taper would make it, M is held, the steepest decline physics allows, until v reaches 0).
  // An earlier vmax x e^(1−x) profile fell off faster than 1/r beyond 2 rmw; that unstable ring overturned and tore the
  // vortex apart within hours (and Rotunno & Emanuel's 1987 profile does the same near r0 at hurricane strength).
  // F(z) = 1 − (z/H − sin(2πz/H)/(2π)), H = ztop: the winds barely weaken through the lowest ~4 km (as observed) and
  // the decay — so the warm core — is spread over the middle and upper troposphere instead of piled up in one layer.
  // (F = ½ (1 + cos πz/H) put a +11 K warm core over dry air at 4–5 km, which shut down the eyewall; F = 1 to 4.5 km,
  // then a cosine, gave +18 K at 9 km that weakened upward faster than the sounding's stability, so the upper
  // troposphere overturned and mixed the warm core away within hours.) Its pressure (φ = p′/ρ) is in
  // gradient-wind balance, ∂φ/∂r = v²/r + f v, and its warm core in hydrostatic balance with that, b = ∂φ/∂z
  // (θ′ = θ0 b / g): with both, the vortex starts steady instead of first throwing off a gravity-wave adjustment.
  // v: {x, y model m, vmax m/s, rmw m, r0 m, ztop m, moistR m (0 = no moist core), moistRH}; null = none
  setVortex(v) {
    if (!v) { this.vortex = null; return; }
    const nz = this.nz, dz = this.dz, f = 2 * 7.292e-5 * Math.sin(this.params.lat * DEG), B = this.base.B;
    const dr = Math.max(500, this.dx / 2), nr = Math.min(VX_MAXR, Math.ceil(v.r0 * 2 / dr) + 3);
    // cyclonic: anticlockwise in the northern hemisphere, clockwise in the southern
    const sg = f < 0 ? -1 : 1;
    const fa = Math.abs(f), al = 0.6, vs = new Float64Array(nr);
    let Mp = 0;
    for (let i = 0; i < nr; i++) {
      const r = i * dr, x = r / v.rmw;
      let s = v.vmax * (1 + al) * x / (al + Math.pow(x, 1 + al)) * (1 - smooth(0.5 * v.r0, v.r0, r));
      if (r > 0) s = Math.max(s, (Mp - 0.5 * fa * r * r) / r, 0);
      vs[i] = s; Mp = r * s + 0.5 * fa * r * r;
    }
    const Vs = r => sg * vs[Math.min(nr - 1, Math.round(r / dr))];
    // genesis starts (v.shape 'mid'): a mid-level vortex, strongest at ~5 km and almost calm at the surface (a
    // mesoscale convective vortex / tropical-wave vortex; balanced: cool below its core, warm above)
    const Fz = v.shape === 'mid' ? z => Math.exp(-Math.pow((z - 5000) / 2500, 2))
      : z => z >= v.ztop ? 0 : 1 - (z / v.ztop - Math.sin(2 * Math.PI * z / v.ztop) / (2 * Math.PI));
    const vt = [], ph = [];
    for (let k = 0; k < nz; k++) {
      const F = Fz((k + 0.5) * dz), vk = new Float64Array(nr), pk = new Float64Array(nr);
      for (let i = 0; i < nr; i++) vk[i] = Vs(i * dr) * F;
      // φ(r) = −∫_r^∞ (v²/r' + f v) dr', integrated inward from the outer edge of the table (where v = 0)
      const g = i => i === 0 ? 0 : vk[i] * vk[i] / (i * dr) + f * vk[i];
      for (let i = nr - 2; i >= 0; i--) pk[i] = pk[i + 1] - 0.5 * (g(i) + g(i + 1)) * dr;
      vt.push(vk); ph.push(pk);
    }
    const tab = new Float32Array(nz * nr * 4);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nr; i++) {
      const k0 = Math.max(k - 1, 0), k1 = Math.min(k + 1, nz - 1);
      const b = (ph[k1][i] - ph[k0][i]) / ((k1 - k0) * dz);
      tab.set([vt[k][i], B[k * 8] * b / 9.81, 0, 0], (k * nr + i) * 4);
    }
    GPU.write(this.vxBuf, tab);
    // the least dθ/dz (K/km) in the vortex core between 2 km and the top of the vortex, and the warm core's peak
    let minStab = 1e9, warm = 0;
    for (let k = 1; k < nz; k++) {
      const z = k * dz; if (z < 2000 || z > v.ztop) continue;
      for (let i = 0; i < Math.min(nr, Math.ceil(2 * v.rmw / dr)); i++) {
        const a = B[(k - 1) * 8] + tab[((k - 1) * nr + i) * 4 + 1], b = B[k * 8] + tab[(k * nr + i) * 4 + 1];
        minStab = Math.min(minStab, (b - a) / dz * 1000);
      }
      warm = Math.max(warm, tab[(k * nr) * 4 + 1]);
    }
    this.vortex = { x: v.x, y: v.y, dr, nr, moistR: v.moistR || 1, moistRH: v.moistR ? v.moistRH : 0, pc: ph[0][0] * B[2] / 100, minStab, warm };
    return this.vortex;
  }
  // warm-sector wind at height z (m AGL), from the base state
  baseWind(z) { const k = clamp(Math.floor(z / this.dz), 0, this.nz - 1), B = this.base.B; return [B[k * 8 + 6], B[k * 8 + 7]]; }

  // bnds: [{pts: [[x,y],...] model metres, motion: [vx, vy], halfW, dT, Hmax, slope, Hmin, dq, qRatio, du, dv, wRatio, nudge, dFree, side}]
  // bnds: [{pts: [[x, y]], vel: [[vx, vy]] per point (default: motion), motion, halfW, dT, …, vary, seed}] (model m, m/s)
  setBoundaries(bnds) {
    this.bounds = bnds.slice(0, MAX_BOUNDS);
    const f = new Float32Array(MAX_BOUNDS * 148);
    this.bounds.forEach((b, i) => {
      const o = i * 148, pts = b.pts.slice(0, MAX_BPTS);
      f.set([pts.length, b.motion[0], b.motion[1], b.halfW, b.dT, b.Hmax, b.slope, b.Hmin, b.dq, b.qRatio, b.du, b.dv, b.wRatio, b.nudge ? 1 : 0, b.dFree, b.side,
        b.vary || 0, b.seed || 0, b.varyL || 60000, 0], o);
      pts.forEach((p, k) => { const v = (b.vel && b.vel[k]) || b.motion; f.set([p[0], p[1], v[0], v[1]], o + 20 + 4 * k); });
    });
    GPU.write(this.bndBuf, f);
  }
  // towers: [{x, y, zc, rh, rz, wt, t0, t1, vx, vy, seed}] (model metres, seconds, m/s)
  setCI(events) {
    const act = events.filter(e => e.t1 > this.time).slice(-MAX_CI);
    this.ciActive = act.length;
    const f = new Float32Array(Math.max(1, act.length) * 12);
    act.forEach((e, i) => f.set([e.x, e.y, e.zc, e.rh, e.rz, e.wt, e.t0, e.t1, e.vx || 0, e.vy || 0, e.seed || i * 1.37, e.ramp || 150], i * 12));
    GPU.write(this.ciBuf, f);
  }

  writeUniforms(dt) {
    const U = this.U, P = this.params;
    U.set('step', dt, this.time, this.rhoSfc || 1.15, 9.81);
    U.set('sponge', P.spongeW, P.spongeTau, P.dampZ, P.dampTau);
    U.set('turb', P.cs, P.nu0, P.evap, P.drag ? 1 : 0);
    const cd = Math.pow(0.41 / Math.log(0.5 * this.dz / P.z0 + 1), 2);
    U.set('micro', P.auto, P.qc0, P.freeze, cd);
    U.set('misc', P.vcap, P.mc, P.noise, P.ciRate);
    U.set('cor', 2 * 7.292e-5 * Math.sin(P.lat * DEG), P.nudgeTau, this.bounds.length, P.moistMix ?? 0);
    U.set('ci', this.ciActive || 0, 0, 0, 0);
    U.set('micro2', 0, P.sortQ ?? 5e-4, P.scheme === 'thompson' ? 1 : 0, P.evapT ?? 0.3);
    const H = this.hur;
    if (H) {
      U.set('hur', 1, H.ck, H.landMoist, H.sfcP);
      U.set('hur2', H.tauRad, H.radCap, H.blDepth, H.u10f);
      U.set('hur3', Math.pow(0.41 / Math.log(0.5 * this.dz / 0.3 + 1), 2), H.gust, (H.thermals ?? 0) * (H.thermalScale ?? 1), H.maritime ? 1 : 0);
      // the 2Δx filter runs every 4th step at 4× strength (64 · 0.012 stays well under its stability limit of 2)
      this.filtNow = this.steps % 4 === 3 && (H.filter4 ?? 0.003) > 0;
      U.set('hur5', H.cdCap ?? 2.4e-3, H.dissHeat ? 1 : 0, 4 * (H.filter4 ?? 0.003), 0);
      const C = H.centre || [this.Lx / 2, this.Ly / 2];
      U.set('hur4', C[0], C[1], H.thermalR || 200000, H.envR || 400000);
    } else { U.set('hur', 0, 0, 0, 0); U.set('hur2', 1, 0, 1, 0.8); U.set('hur3', 0, 1, 0, 0); U.set('hur4', 0, 0, 1, 1e9); U.set('hur5', 2.4e-3, 0, 0, 0); }
    // the trajectory-averaged pressure force needs a pressure from the step before: not on the first step after a reset
    // off-centred (40 % old, 60 % new): exactly centred, p(n+1) = 2·balance − p(n) is a neutral 2Δt mode, and it blew up
    // within an hour; off-centred it decays by a third per step, and the rotation damping is still 5× smaller (ε (ΩΔt)²/2)
    const cnOld = this.cnOld ?? CN_OLD, cn = !!H && !!this.Vp && this.steps > 0 && cnOld > 0, ca = cnOld, cb = 1 - cnOld;
    this.cnNow = cn;
    U.set('cn', cn ? ca : 0, this.phiScale || 1, cn ? 1 / cb : 1, H && (this.traj2 ?? true) ? 1 : 0);
    const X = this.vortex;
    if (X) { U.set('vtx', X.x, X.y, X.dr, X.nr); U.set('vtx2', X.moistR, X.moistRH, 1, 0); }
    else { U.set('vtx', 0, 0, 1, 0); U.set('vtx2', 1, 0, 0, 0); }
    // MacCormack correction floor: the correction is weakened at small Courant numbers (full strength is noisy)
    U.set('dzv', this.dz, 1 / this.dx, 1 / this.dz, P.mcFloor ?? 0.25);
    GPU.write(this.ubo, U.f);
  }
  encLSF(pass) { GPU.dispatch(pass, this.pipes.lsf, [this.bg.lsf], this.nx / 8, this.ny / 8); }
  reset() {
    this.time = 0; this.steps = 0; this.parity = 0; this.phiScale = 1;
    this.writeUniforms(1);
    const enc = GPU.device.createCommandEncoder(), pass = enc.beginComputePass();
    this.encLSF(pass);
    pass.end();
    const p2 = enc.beginComputePass();
    GPU.dispatch(p2, this.pipes.init, [this.bg.init], (this.nx + 1) / 8, (this.ny + 1) / 8, (this.nz + 1) / 4);
    p2.end();
    enc.clearBuffer(this.phi); enc.clearBuffer(this.rhs);
    enc.copyTextureToTexture({ texture: this.V[0] }, { texture: this.V[1] }, [this.nx + 1, this.ny + 1, this.nz + 1]);
    GPU.device.queue.submit([enc.finish()]);
    this.lsfT = 0;
  }
  // one time step (the state ends in V[parity], Q1[0], Q2[0])
  encStep(enc, dt) {
    this.writeUniforms(dt);
    const p = this.pipes, g = this.bg.par[this.parity];
    const nx = this.nx, ny = this.ny, nz = this.nz;
    const wx = (nx + 1) / 8, wy = (ny + 1) / 8, wz = (nz + 1) / 4, cx = nx / 8, cy = ny / 8, cz = nz / 4;
    // hurricane mode, every 4th step: the 2Δx filter (state → scratch fields → back), see WGSL_M_FILT
    if (this.hur && this.filtNow) {
      const fp = enc.beginComputePass();
      GPU.dispatch(fp, p.filt, [g.filt], wx, wy, wz);
      fp.end();
      const Vc = this.V[this.parity], Vn = this.V[1 - this.parity];
      enc.copyTextureToTexture({ texture: Vn }, { texture: Vc }, [nx + 1, ny + 1, nz + 1]);
      enc.copyTextureToTexture({ texture: this.Q1[1] }, { texture: this.Q1[0] }, [nx, ny, nz]);
      enc.copyTextureToTexture({ texture: this.Q2[1] }, { texture: this.Q2[0] }, [nx, ny, nz]);
    }
    const pass = enc.beginComputePass();
    // hurricane mode: the winds the advection carries, with 40 % of the last pressure force (WGSL_M_PREP; on the first
    // step after a reset, with none)
    if (this.Vp) GPU.dispatch(pass, p.prep, [g.prep], wx, wy, wz);
    if (this.time - this.lsfT >= 60 || this.time === 0) { this.encLSF(pass); this.lsfT = this.time; }
    GPU.dispatch(pass, p.ci, [this.bg.ci], nx / 8, ny / 8);
    GPU.dispatch(pass, p.nut, [g.nut], cx, cy, cz);
    GPU.dispatch(pass, p.advV1, [g.advV1], wx, wy, wz);
    GPU.dispatch(pass, p.advV2, [g.advV2], wx, wy, wz);
    GPU.dispatch(pass, p.advQ1, [g.advQ1], cx, cy, cz);
    GPU.dispatch(pass, p.advQ2, [g.advQ2], cx, cy, cz);
    GPU.dispatch(pass, p.phys, [g.phys], wx, wy, wz);
    GPU.dispatch(pass, p.div, [g.div], cx, cy, cz);
    this.solver.enc(pass, this.bg.solve);
    GPU.dispatch(pass, p.proj, [g.proj], wx, wy, wz);
    pass.end();
    this.parity = 1 - this.parity;
    this.time += dt; this.steps++;
    this.phiScale = this.cnNow ? 1 / (1 - (this.cnOld ?? CN_OLD)) : 1;
  }
  // maps of the current state → readback; resolves {m0, m1: Float32Array(nx*ny*4), t}
  requestMaps(enc) {
    const slot = this.mapBusy[0] ? (this.mapBusy[1] ? -1 : 1) : 0;
    if (slot < 0) return null;
    const g = this.bg.par[1 - this.parity];     // map kernel reads V[1 − parity of the next step] = current state
    const pass = enc.beginComputePass();
    GPU.dispatch(pass, this.pipes.map, [this.bg.par[this.parity === 0 ? 1 : 0].map], this.nx / 8, this.ny / 8);
    pass.end();
    enc.copyBufferToBuffer(this.mapBuf, 0, this.mapRead[slot], 0, this.nx * this.ny * 64);
    this.mapBusy[slot] = true;
    const t = this.time, buf = this.mapRead[slot], n = this.nx * this.ny;
    void g;
    return () => buf.mapAsync(GPUMapMode.READ).then(() => {
      const a = new Float32Array(buf.getMappedRange().slice(0));
      buf.unmap(); this.mapBusy[slot] = false;
      return { m0: a.subarray(0, n * 4), m1: a.subarray(n * 4, n * 8), m2: a.subarray(n * 8, n * 12), m3: a.subarray(n * 12, n * 16), t };
    }).catch(e => { this.mapBusy[slot] = false; throw e; });
  }
  get Vcur() { return this.V[this.parity]; }
}
