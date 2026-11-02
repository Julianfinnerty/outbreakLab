'use strict';
// Hash / gradient-noise helpers shared by the WGSL kernels (from TrailingHV).
const WGSL_NOISE = /* wgsl */`
const PI = 3.14159265359;
fn pcg(v: u32) -> u32 { let s = v * 747796405u + 2891336453u; let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
fn hash2i(p: vec2i) -> u32 { return pcg(bitcast<u32>(p.x) ^ pcg(bitcast<u32>(p.y) + 0x9e3779b9u)); }
fn hash3i(p: vec3i) -> u32 { return pcg(bitcast<u32>(p.x) ^ pcg(bitcast<u32>(p.y) ^ pcg(bitcast<u32>(p.z) + 0x7f4a7c15u))); }
fn rnd2(p: vec2i) -> f32 { return f32(hash2i(p) >> 8u) * (1.0 / 16777216.0); }
fn rnd3(p: vec3i) -> f32 { return f32(hash3i(p) >> 8u) * (1.0 / 16777216.0); }
fn grad2(p: vec2i) -> vec2f { let a = f32(hash2i(p) >> 8u) * (6.2831853 / 16777216.0); return vec2f(cos(a), sin(a)); }
fn grad3(p: vec3i) -> vec3f {
  let h = hash3i(p);
  let u = f32(h & 0xffffu) * (2.0 / 65535.0) - 1.0;
  let a = f32(h >> 16u) * (6.2831853 / 65535.0);
  let r = sqrt(max(0.0, 1.0 - u * u));
  return vec3f(r * cos(a), r * sin(a), u);
}
fn fade(t: f32) -> f32 { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
fn gnoise2(p: vec2f) -> f32 {
  let i = vec2i(floor(p)); let f = fract(p);
  let u = vec2f(fade(f.x), fade(f.y));
  let a = dot(grad2(i), f); let b = dot(grad2(i + vec2i(1, 0)), f - vec2f(1, 0));
  let c = dot(grad2(i + vec2i(0, 1)), f - vec2f(0, 1)); let d = dot(grad2(i + vec2i(1, 1)), f - vec2f(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.4142;
}
fn fbm2(p0: vec2f, oct: i32) -> f32 {
  var p = p0; var a = 0.5; var s = 0.0;
  for (var i = 0; i < oct; i++) { s += a * gnoise2(p); p = mat2x2f(1.6, 1.2, -1.2, 1.6) * p + vec2f(17.1, 3.7); a *= 0.5; }
  return s;
}
fn ridged2(p0: vec2f, oct: i32) -> f32 {
  var p = p0; var a = 0.5; var s = 0.0; var w = 1.0;
  for (var i = 0; i < oct; i++) { var n = 1.0 - abs(gnoise2(p)); n = n * n * w; w = clamp(n * 2.0, 0.0, 1.0); s += a * n; p = mat2x2f(1.6, 1.2, -1.2, 1.6) * p + vec2f(5.3, 11.9); a *= 0.5; }
  return s;
}
// periodic 3-D gradient noise (period in lattice cells) for tileable textures
fn gnoise3p(p: vec3f, per: i32) -> f32 {
  let i = vec3i(floor(p)); let f = fract(p);
  let u = vec3f(fade(f.x), fade(f.y), fade(f.z));
  var r = 0.0;
  let n000 = dot(grad3((i + vec3i(0,0,0)) % per), f - vec3f(0,0,0));
  let n100 = dot(grad3((i + vec3i(1,0,0)) % per), f - vec3f(1,0,0));
  let n010 = dot(grad3((i + vec3i(0,1,0)) % per), f - vec3f(0,1,0));
  let n110 = dot(grad3((i + vec3i(1,1,0)) % per), f - vec3f(1,1,0));
  let n001 = dot(grad3((i + vec3i(0,0,1)) % per), f - vec3f(0,0,1));
  let n101 = dot(grad3((i + vec3i(1,0,1)) % per), f - vec3f(1,0,1));
  let n011 = dot(grad3((i + vec3i(0,1,1)) % per), f - vec3f(0,1,1));
  let n111 = dot(grad3((i + vec3i(1,1,1)) % per), f - vec3f(1,1,1));
  r = mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
  return r * 1.15;
}
fn gnoise3(p: vec3f) -> f32 { return gnoise3p(p, 1 << 20); }
// periodic Worley (F1), returns distance in cell units (0 at feature points)
fn worley3p(p: vec3f, per: i32) -> f32 {
  let i = vec3i(floor(p)); let f = fract(p); var d = 9.0;
  for (var z = -1; z <= 1; z++) { for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let o = vec3i(x, y, z); let c = ((i + o) % per + per) % per;
    let h = hash3i(c); let fp = vec3f(f32(h & 1023u), f32((h >> 10u) & 1023u), f32((h >> 20u) & 1023u)) / 1023.0;
    let v = vec3f(o) + fp - f; d = min(d, dot(v, v));
  } } }
  return sqrt(d);
}
`;
