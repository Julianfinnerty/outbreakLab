'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Small math + WebGPU helpers shared by every module (classic script, globals).
// ─────────────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const DEG = Math.PI / 180;

const V3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: a => Math.hypot(a[0], a[1], a[2]),
  norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};

// Column-major 4×4 matrices (WGSL mat4x4f layout).
const M4 = {
  ident() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  },
  // Reverse-Z infinite perspective for WebGPU (depth 1 at near, 0 at infinity).
  perspRevZ(fovy, aspect, near) {
    const f = 1 / Math.tan(fovy / 2), m = new Float32Array(16);
    m[0] = f / aspect; m[5] = f; m[10] = 0; m[11] = -1; m[14] = near; m[15] = 0;
    return m;
  },
  lookAt(eye, at, up) {
    const f = V3.norm(V3.sub(at, eye));
    let s = V3.cross(f, up); if (V3.len(s) < 1e-6) s = V3.cross(f, [0, 1, 0]); s = V3.norm(s);
    const u = V3.cross(s, f), m = new Float32Array(16);
    m[0] = s[0]; m[4] = s[1]; m[8] = s[2];
    m[1] = u[0]; m[5] = u[1]; m[9] = u[2];
    m[2] = -f[0]; m[6] = -f[1]; m[10] = -f[2];
    m[12] = -V3.dot(s, eye); m[13] = -V3.dot(u, eye); m[14] = V3.dot(f, eye); m[15] = 1;
    return m;
  },
  invert(m) {
    const inv = new Float32Array(16);
    const a = m;
    inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
    inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
    inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
    inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
    inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
    inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
    inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
    inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
    inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
    inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
    inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
    inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
    inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
    inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
    inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
    inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
    let det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
    det = det === 0 ? 1 : 1 / det;
    for (let i = 0; i < 16; i++) inv[i] *= det;
    return inv;
  },
  xform(m, p) { // p = [x,y,z,w]
    const o = [0, 0, 0, 0];
    for (let r = 0; r < 4; r++) o[r] = m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] * p[3];
    return o;
  },
};

// ─── Uniform block builder ──────────────────────────────────────────────────
// Every uniform struct is made of vec4f / mat4x4f members only, so the WGSL
// layout is trivially 16-byte packed. `fields` is a list of [name, 'v4'|'m4'].
class UBlock {
  constructor(fields) {
    this.off = {}; let o = 0;
    for (const [n, t] of fields) { this.off[n] = o; o += t === 'm4' ? 16 : 4; }
    this.f = new Float32Array(o); this.size = o * 4;
    this.wgsl = fields.map(([n, t]) => `  ${n}: ${t === 'm4' ? 'mat4x4f' : 'vec4f'},`).join('\n');
  }
  set(name, a, b, c, d) {
    const o = this.off[name];
    if (o === undefined) throw new Error('UBlock: no field ' + name);
    if (a && a.length !== undefined) { for (let i = 0; i < a.length; i++) this.f[o + i] = a[i]; return this; }
    this.f[o] = a ?? 0; this.f[o + 1] = b ?? 0; this.f[o + 2] = c ?? 0; this.f[o + 3] = d ?? 0;
    return this;
  }
  setc(name, comp, v) { this.f[this.off[name] + comp] = v; return this; }
}

// ─── WebGPU helpers ─────────────────────────────────────────────────────────
const GPU = {
  device: null, adapter: null, hasTimestamps: false, features: new Set(),
  modules: new Map(), errors: [],

  async init() {
    if (!navigator.gpu) throw new Error('This browser has no WebGPU support. Use a current Chrome or Edge on a WebGPU-capable GPU.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');
    const want = ['float32-filterable', 'timestamp-query', 'shader-f16', 'texture-formats-tier1'];
    const feats = want.filter(f => adapter.features.has(f));
    const L = adapter.limits;
    const lim = {};
    for (const k of ['maxBufferSize', 'maxStorageBufferBindingSize', 'maxStorageTexturesPerShaderStage', 'maxStorageBuffersPerShaderStage',
      'maxSampledTexturesPerShaderStage', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY',
      'maxComputeWorkgroupSizeZ', 'maxComputeWorkgroupStorageSize', 'maxTextureDimension2D', 'maxTextureDimension3D',
      'maxBindingsPerBindGroup', 'maxUniformBufferBindingSize', 'maxColorAttachmentBytesPerSample', 'maxComputeWorkgroupsPerDimension']) {
      if (L[k] !== undefined) lim[k] = L[k];
    }
    const device = await adapter.requestDevice({ requiredFeatures: feats, requiredLimits: lim });
    this.adapter = adapter; this.device = device; this.features = new Set(feats);
    this.hasTimestamps = feats.includes('timestamp-query');
    this.floatFilter = feats.includes('float32-filterable');
    device.addEventListener('uncapturederror', e => { const m = e.error && e.error.message; console.error('WebGPU:', m); this.errors.push(m); if (this.errors.length > 50) this.errors.shift(); });
    device.lost.then(info => { console.error('Device lost', info); if (window.onDeviceLost) window.onDeviceLost(info); });
    this.info = adapter.info || {};
    return device;
  },

  module(code, label) {
    const m = this.device.createShaderModule({ code, label });
    m.getCompilationInfo().then(ci => {
      for (const msg of ci.messages) {
        if (msg.type === 'error') {
          const lines = code.split('\n');
          const ctx = lines.slice(Math.max(0, msg.lineNum - 3), msg.lineNum + 2).map((l, i) => (Math.max(0, msg.lineNum - 3) + i + 1) + ': ' + l).join('\n');
          const s = `[${label}] ${msg.lineNum}:${msg.linePos} ${msg.message}\n${ctx}`;
          console.error(s); this.errors.push(s);
        }
      }
    });
    return m;
  },

  compute(code, label, entry = 'main', constants) {
    const module = this.module(code, label);
    return this.device.createComputePipeline({ label, layout: 'auto', compute: { module, entryPoint: entry, constants } });
  },

  buffer(size, usage, label) {
    return this.device.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16), usage, label });
  },
  ubuf(size, label) { return this.buffer(size, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label); },
  sbuf(size, label, extra = 0) { return this.buffer(size, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | extra, label); },

  tex3d(w, h, d, format, label, extraUsage = 0) {
    return this.device.createTexture({
      size: [w, h, d], dimension: '3d', format, label,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | extraUsage,
    });
  },
  tex2d(w, h, format, label, usage) {
    return this.device.createTexture({
      size: [w, h], format, label,
      usage: usage ?? (GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST),
    });
  },

  // Bind group from an 'auto' layout. entries: array of resources in binding order,
  // or an object {binding: resource}. Resources: GPUBuffer | GPUTextureView | GPUSampler | GPUTexture.
  bind(pipeline, group, res, label) {
    const entries = [];
    const add = (b, r) => {
      if (r === undefined || r === null) return;
      let resource = r;
      if (r instanceof GPUBuffer) resource = { buffer: r };
      else if (r instanceof GPUTexture) resource = r.createView();
      else if (r && r.buffer instanceof GPUBuffer) resource = r;
      entries.push({ binding: b, resource });
    };
    if (Array.isArray(res)) res.forEach((r, i) => add(i, r)); else for (const k in res) add(+k, res[k]);
    return this.device.createBindGroup({ label, layout: pipeline.getBindGroupLayout(group), entries });
  },

  dispatch(pass, pipeline, groups, x, y = 1, z = 1) {
    pass.setPipeline(pipeline);
    groups.forEach((g, i) => { if (g) pass.setBindGroup(i, g); });
    pass.dispatchWorkgroups(Math.max(1, Math.ceil(x)), Math.max(1, Math.ceil(y)), Math.max(1, Math.ceil(z)));
  },

  write(buf, data, offset = 0) { this.device.queue.writeBuffer(buf, offset, data.buffer ?? data, data.byteOffset ?? 0, data.byteLength); },
};

// ─── GPU timestamp profiler (optional) ──────────────────────────────────────
class GPUProfiler {
  constructor(maxPasses = 24) {
    this.ok = GPU.hasTimestamps; this.max = maxPasses; this.names = []; this.times = {}; this.pending = false;
    if (!this.ok) return;
    const d = GPU.device;
    this.qs = d.createQuerySet({ type: 'timestamp', count: maxPasses * 2 });
    this.resolve = d.createBuffer({ size: maxPasses * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    this.read = d.createBuffer({ size: maxPasses * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  }
  begin() { this.names = []; }
  // Returns timestampWrites descriptor for a pass, or undefined.
  tw(name) {
    if (!this.ok || this.pending || this.names.length >= this.max) return undefined;
    const i = this.names.length; this.names.push(name);
    return { querySet: this.qs, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 };
  }
  end(enc) {
    if (!this.ok || this.pending || !this.names.length) return;
    const n = this.names.length;
    enc.resolveQuerySet(this.qs, 0, n * 2, this.resolve, 0);
    enc.copyBufferToBuffer(this.resolve, 0, this.read, 0, n * 16);
    this._n = n; this._names = this.names.slice(); this._arm = true;
  }
  after() {
    if (!this._arm) return; this._arm = false; this.pending = true;
    this.read.mapAsync(GPUMapMode.READ).then(() => {
      const t = new BigInt64Array(this.read.getMappedRange().slice(0, this._n * 16));
      const acc = {};
      for (let i = 0; i < this._n; i++) {
        const dt = Number(t[i * 2 + 1] - t[i * 2]) / 1e6;
        if (dt >= 0 && dt < 1000) acc[this._names[i]] = (acc[this._names[i]] || 0) + dt;
      }
      for (const k in acc) this.times[k] = this.times[k] === undefined ? acc[k] : this.times[k] * 0.85 + acc[k] * 0.15;
      this.read.unmap(); this.pending = false;
    }).catch(() => { this.pending = false; });
  }
}
