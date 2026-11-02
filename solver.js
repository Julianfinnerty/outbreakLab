'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Exact anelastic pressure solver:  ρc(z) ∇h²φ + ∂z(ρw(z) ∂zφ) = rhs
//  φ = 0 on the lateral boundaries (open boundaries, as in the storm model),
//  ∂zφ = 0 at the ground and the lid.  Separable, so it is solved exactly:
//  orthonormal sine transforms (DST-II) in x and y as batched GEMMs, then one
//  tridiagonal (Thomas) solve in z per horizontal mode.  Unlike point-smoothed
//  multigrid it does not care how flat the cells are (1.5 km × 300 m here).
//  GEMM / Thomas kernels from TrailingHV's vortex core (vortex.js).
// ─────────────────────────────────────────────────────────────────────────────

const WGSL_PS_GEMM = /* wgsl */`
struct TP { n: vec4i, aux: vec4i };
@group(0) @binding(0) var<uniform> T: TP;
@group(0) @binding(1) var<storage, read> mats: array<f32>;
@group(0) @binding(2) var<storage, read> src: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;
var<workgroup> As: array<array<f32, 17>, 64>;
var<workgroup> Bs: array<array<f32, 65>, 16>;
// mode 0 (x): C(l, col) = Σ_i M(l, i) F(i, col), col = j + ny k;  mode 1 (y): C(i, m, k) = Σ_j F(i, j, k) M(m, j)
@compute @workgroup_size(16, 16, 1)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let nx = T.n.x; let ny = T.n.y; let mode = T.n.w; let mofs = T.aux.x;
  let rows = nx;
  let cols = select(ny, ny * T.n.z, mode == 0);
  let depth = select(ny, nx, mode == 0);
  let plane = select(i32(wg.z) * nx * ny, 0, mode == 0);
  let r0 = i32(wg.x) * 64; let c0 = i32(wg.y) * 64;
  let tx = i32(lid.x); let ty = i32(lid.y); let tid = tx + 16 * ty;
  var acc: array<array<f32, 4>, 4>;
  for (var a = 0; a < 4; a++) { for (var b = 0; b < 4; b++) { acc[a][b] = 0.0; } }
  for (var q0 = 0; q0 < depth; q0 += 16) {
    for (var s = 0; s < 4; s++) {
      let t = tid + 256 * s;
      var ar: i32; var aq: i32;
      if (mode == 0) { ar = t / 16; aq = t % 16; } else { ar = t % 64; aq = t / 64; }
      let gr = r0 + ar; let gq = q0 + aq;
      var av = 0.0;
      if (gr < rows && gq < depth) {
        if (mode == 0) { av = mats[mofs + gr * nx + gq]; } else { av = src[plane + gr + nx * gq]; }
      }
      As[ar][aq] = av;
      let bq = t % 16; let bc = t / 16;
      let gc = c0 + bc; let gq2 = q0 + bq;
      var bv = 0.0;
      if (gc < cols && gq2 < depth) {
        if (mode == 0) { bv = src[gq2 + nx * gc]; } else { bv = mats[mofs + gc * ny + gq2]; }
      }
      Bs[bq][bc] = bv;
    }
    workgroupBarrier();
    for (var kk = 0; kk < 16; kk++) {
      var av4: array<f32, 4>; var bv4: array<f32, 4>;
      for (var a = 0; a < 4; a++) { av4[a] = As[tx + 16 * a][kk]; bv4[a] = Bs[kk][ty + 16 * a]; }
      for (var a = 0; a < 4; a++) { for (var b = 0; b < 4; b++) { acc[a][b] += av4[a] * bv4[b]; } }
    }
    workgroupBarrier();
  }
  for (var a = 0; a < 4; a++) {
    let r = r0 + tx + 16 * a;
    if (r >= rows) { continue; }
    for (var b = 0; b < 4; b++) {
      let cc = c0 + ty + 16 * b;
      if (cc < cols) { dst[plane + r + nx * cc] = acc[a][b]; }
    }
  }
}
`;

// (lower, upper, diag, ρc) per level; the horizontal eigenvalue enters multiplied by ρc(k)
const WGSL_PS_TRI = /* wgsl */`
struct TP { n: vec4i, aux: vec4i };
@group(0) @binding(0) var<uniform> T: TP;
@group(0) @binding(1) var<storage, read> lambda: array<f32>;
@group(0) @binding(2) var<storage, read> zop: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> hat: array<f32>;
@group(0) @binding(4) var<storage, read_write> cp: array<f32>;
@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let n = T.n.xyz;
  let l = i32(gid.x); let m = i32(gid.y);
  if (l >= n.x || m >= n.y) { return; }
  let shift = lambda[l] + lambda[n.x + m];
  let sxy = n.x * n.y;
  let base = l + n.x * m;
  var cprev = 0.0; var dprev = 0.0;
  for (var k = 0; k < n.z; k++) {
    let o = zop[k];
    let idx = base + sxy * k;
    let den = o.z + shift * o.w - o.x * cprev;
    cprev = o.y / den;
    dprev = (hat[idx] - o.x * dprev) / den;
    cp[idx] = cprev;
    hat[idx] = dprev;
  }
  var above = hat[base + sxy * (n.z - 1)];
  for (var k = n.z - 2; k >= 0; k--) {
    let idx = base + sxy * k;
    above = hat[idx] - cp[idx] * above;
    hat[idx] = above;
  }
}
`;

class PoissonDirect {
  constructor(nx, ny, nz, dx, dz) {
    Object.assign(this, { nx, ny, nz, dx, dz });
    const P = (c, l) => GPU.compute(c, l);
    this.pGemm = P(WGSL_PS_GEMM, 'ps.gemm');
    this.pTri = P(WGSL_PS_TRI, 'ps.tri');
    const cells = nx * ny * nz;
    this.tmp = GPU.sbuf(cells * 4, 'psTmp'); this.hat = GPU.sbuf(cells * 4, 'psHat'); this.scr = GPU.sbuf(cells * 4, 'psScr');
    // orthonormal DST-II: v_l(i) = c_l sin(π (l+1)(i+½)/N) — the eigenvectors of the 1-D Laplacian with φ = 0
    // on the faces outside cells 0 and N−1 (antisymmetric ghosts), eigenvalue −4/h² sin²(π(l+1)/(2N))
    const dst = N => {
      const q = new Float32Array(N * N), qi = new Float32Array(N * N);
      for (let i = 0; i < N; i++) for (let l = 0; l < N; l++) {
        const c = Math.sqrt((l === N - 1 ? 1 : 2) / N);
        const v = c * Math.sin(Math.PI * (l + 1) * (i + 0.5) / N);
        q[i * N + l] = v; qi[l * N + i] = v;
      }
      return { q, qi };
    };
    const ex = dst(nx), ey = ny === nx ? ex : dst(ny);
    this.ofs = { qix: 0, qx: nx * nx, qiy: 2 * nx * nx, qy: 2 * nx * nx + ny * ny };
    const M = new Float32Array(2 * nx * nx + 2 * ny * ny);
    M.set(ex.qi, this.ofs.qix); M.set(ex.q, this.ofs.qx); M.set(ey.qi, this.ofs.qiy); M.set(ey.q, this.ofs.qy);
    this.mats = GPU.sbuf(M.byteLength, 'psMats'); GPU.write(this.mats, M);
    const lam = new Float32Array(nx + ny);
    for (let l = 0; l < nx; l++) lam[l] = -4 / (dx * dx) * Math.pow(Math.sin(Math.PI * (l + 1) / (2 * nx)), 2);
    for (let m = 0; m < ny; m++) lam[nx + m] = -4 / (dx * dx) * Math.pow(Math.sin(Math.PI * (m + 1) / (2 * ny)), 2);
    this.eig = GPU.sbuf(lam.byteLength, 'psEig'); GPU.write(this.eig, lam);
    this.zop = GPU.sbuf(nz * 16, 'psZop');
    const tp = (mode, ofs) => { const b = GPU.ubuf(32, 'psTP'); GPU.write(b, new Int32Array([nx, ny, nz, mode, ofs, 0, 0, 0])); return b; };
    this.tpU = { fx: tp(0, this.ofs.qix), fy: tp(1, this.ofs.qiy), iy: tp(1, this.ofs.qy), ix: tp(0, this.ofs.qx), tz: tp(0, 0) };
    this.setDensity(new Array(nz).fill(1), new Array(nz + 1).fill(1));
  }
  // rhoC[k] at cell centres, rhoW[k] at the bottom face of cell k (rhoW[nz] = lid)
  setDensity(rhoC, rhoW) {
    const nz = this.nz, a = 1 / (this.dz * this.dz), zo = new Float32Array(nz * 4);
    for (let k = 0; k < nz; k++) {
      const lo = k > 0 ? rhoW[k] * a : 0, up = k < nz - 1 ? rhoW[k + 1] * a : 0;
      zo.set([lo, up, -(lo + up), rhoC[k]], k * 4);
    }
    GPU.write(this.zop, zo);
  }
  bind(rhs, phi) {
    const g = (tp, s, d) => GPU.bind(this.pGemm, 0, [tp, this.mats, s, d]);
    return {
      fx: g(this.tpU.fx, rhs, this.tmp), fy: g(this.tpU.fy, this.tmp, this.hat),
      tri: GPU.bind(this.pTri, 0, [this.tpU.tz, this.eig, this.zop, this.hat, this.scr]),
      iy: g(this.tpU.iy, this.hat, this.tmp), ix: g(this.tpU.ix, this.tmp, phi),
    };
  }
  enc(pass, b) {
    const nx = this.nx, ny = this.ny, nz = this.nz;
    const gx = [Math.ceil(nx / 64), Math.ceil(ny * nz / 64), 1], gy = [Math.ceil(nx / 64), Math.ceil(ny / 64), nz];
    GPU.dispatch(pass, this.pGemm, [b.fx], ...gx);
    GPU.dispatch(pass, this.pGemm, [b.fy], ...gy);
    GPU.dispatch(pass, this.pTri, [b.tri], Math.ceil(nx / 16), Math.ceil(ny / 16));
    GPU.dispatch(pass, this.pGemm, [b.iy], ...gy);
    GPU.dispatch(pass, this.pGemm, [b.ix], ...gx);
  }
  destroy() { [this.tmp, this.hat, this.scr, this.mats, this.eig, this.zop].forEach(b => b && b.destroy()); }
}
