'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  OutbreakLab: setup (warm-sector sounding, domain, boundaries, storm
//  initiation, radars) → GPU run → Level II volumes streamed to the local
//  server, which writes Archive II files and serves GR2Analyst's polling.
// ─────────────────────────────────────────────────────────────────────────────

// NWS reflectivity table (5 dBZ steps from 5 dBZ)
const DBZ_COLORS = ['#04e9e7', '#019ff4', '#0300f4', '#02fd02', '#01c501', '#008e00', '#fdf802', '#e5bc00', '#fd9500', '#fd0000', '#d40000', '#bc0000', '#f800fd', '#9854c6', '#fdfdfd'];
const DBZ_RGB = DBZ_COLORS.map(h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);

const BND_TYPES = {
  cold: { label: 'Cold front', color: '#3b7dff', dT: -8, depth: 1600, slope: 0.012, dq: 0.55, windDir: 320, windSpd: 11, speed: 9, dir: 120, halfW: 7000, nudge: true, rate: 4.0, otherAhead: false, vary: 0.8 },
  warm: { label: 'Warm front', color: '#ff4a4a', dT: -5, depth: 900, slope: 0.005, dq: 0.2, windDir: 95, windSpd: 8, speed: 3, dir: 10, halfW: 12000, nudge: true, rate: 2.0, otherAhead: true, vary: 0.7 },
  dry: { label: 'Dryline', color: '#d09a3c', dT: 2.5, depth: 2800, slope: 0.05, dq: 0.72, windDir: 245, windSpd: 11, speed: 3, dir: 90, halfW: 5000, nudge: true, rate: 3.0, otherAhead: false, vary: 0.8 },
  stat: { label: 'Stationary front', color: '#b84bff', dT: -6, depth: 1200, slope: 0.012, dq: 0.35, windDir: 60, windSpd: 6, speed: 0, dir: 160, halfW: 8000, nudge: true, rate: 2.0, otherAhead: false, vary: 0.7 },
  outflow: { label: 'Outflow boundary', color: '#5fd0ff', dT: -5, depth: 700, slope: 0.05, dq: 0.1, windDir: null, windSpd: 8, speed: 6, dir: 150, halfW: 4000, nudge: false, rate: 3.0, otherAhead: false, vary: 0.6 },
};

const DEFAULT_CFG = {
  grid: 'standard', center: { lat: 35.9, lon: -97.9 },
  snd: { kind: 'sample', index: 0, text: '', gen: { seed: '', regime: '', hour: '00', station: '' } },
  start: '2024-05-06T20:00', hours: 6, dtScale: 1.0,
  vcp: 212, aliasing: true, minDbz: 0,
  radars: ['KTLX', 'KVNX', 'KINX', 'KFDR'],
  bounds: [],
  ci: { warmRate: 1.2, start: 0.25, end: 4.5, seed: 7, wt: 10, rh: 12000, auto: true },
  tor: { on: true, rate: 1.0 },
  manual: [],
  pace: 0, runName: '',
  customGrid: { dx: 500, w: 512, h: 512 },
  micro: 'lin',
  low: { auto: true, speed: 10, dir: 45 },
  mode: 'outbreak', hur: Object.assign({}, HUR_DEFAULT), stash: {},
  v: 2,
};
let CFG = loadCfg();
function loadCfg() {
  try {
    const s = JSON.parse(localStorage.getItem('outbreaklab.cfg') || 'null');
    if (s) {
      // version 2 changed how storms are started: older push strength / radius settings go back to the defaults
      if ((s.v | 0) < 2 && s.ci) { s.ci.wt = DEFAULT_CFG.ci.wt; s.ci.rh = DEFAULT_CFG.ci.rh; }
      s.v = DEFAULT_CFG.v;
      const c = Object.assign(JSON.parse(JSON.stringify(DEFAULT_CFG)), s);
      c.hur = Object.assign({}, HUR_DEFAULT, s.hur || {});
      return c;
    }
  } catch (e) { }
  const c = JSON.parse(JSON.stringify(DEFAULT_CFG));
  // an example setup: a cold front + dryline + warm front triple point over Oklahoma
  c.bounds = [
    mkBound('cold', [[39.4, -101.6], [37.4, -100.2], [36.3, -99.9]]),
    mkBound('warm', [[36.3, -99.9], [36.9, -97.4], [37.4, -94.6]]),
    mkBound('dry', [[36.3, -99.9], [34.8, -99.4], [33.0, -99.6]]),
  ];
  return c;
}
let saveT = 0;
function saveCfg() { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem('outbreaklab.cfg', JSON.stringify(CFG)); } catch (e) { } }, 300); }
function mkBound(type, pts) {
  const T = BND_TYPES[type];
  return { id: Math.random().toString(36).slice(2, 8), type, pts, speed: T.speed, dir: T.dir, flip: false, dT: T.dT, depth: T.depth, slope: T.slope,
    dq: T.dq, windDir: T.windDir, windSpd: T.windSpd, trigger: true, rate: T.rate, nudge: T.nudge, vary: T.vary };
}

// ─── event type: a severe-weather outbreak, or a hurricane ───────────────────
// Each keeps its own domain, grid, time, radars, boundaries and hand-placed storms, so switching back and forth
// doesn't lose either setup.
const MODE_KEYS = ['grid', 'customGrid', 'center', 'hours', 'start', 'radars', 'bounds', 'manual'];
const isHur = () => CFG.mode === 'hurricane';
function setMode(m) {
  if (m === (CFG.mode || 'outbreak')) return;
  if (RUN.state === 'running' || RUN.state === 'paused') { showError('Stop the run before switching the event type.'); buildPanel(); return; }
  const cp = o => JSON.parse(JSON.stringify(o));
  CFG.stash = CFG.stash || {};
  CFG.stash[CFG.mode || 'outbreak'] = cp(Object.fromEntries(MODE_KEYS.map(k => [k, CFG[k]])));
  const back = CFG.stash[m] || (m === 'hurricane' ? HUR_SETUP : null);
  if (back) for (const k of MODE_KEYS) if (back[k] !== undefined) CFG[k] = cp(back[k]);
  CFG.mode = m;
  if (RUN.state !== 'setup') { RUN.state = 'setup'; RUN.maps = null; FIELD.ok = false; replayReset(); }
  LAYER = m === 'hurricane' ? 'ir' : 'comp';
  EDIT.sel = null; setTool('pan');
  buildSounding(); updateGeo(); fitView();
  buildToolbar(); buildPanel(); syncRunButtons(); saveCfg(); draw();
}
// zoom the map to show the whole domain
function fitView() { const [Lx, Ly] = domSize(); VIEW.cx = 0; VIEW.cy = 0; VIEW.s = Math.min(VIEW.w / (Lx * 1.12), VIEW.h / (Ly * 1.12)); }

let MODEL = null, RADAR = null, GEO = null;
const RUN = { state: 'setup', name: '', events: [], log: [], inflight: 0, uploaded: 0, failed: 0, bytes: 0, maps: null, lastMapWall: 0, ciNext: 0,
  wall0: 0, sim0: 0, stepsPerBatch: 4, simRate: 0, lastWall: 0, lastSim: 0, pending: new Set(), server: null };

// ─── small DOM helpers ─────────────────────────────────────────────────────
const el = (tag, attrs = {}, kids = []) => {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === 'text') e.textContent = attrs[k]; else if (k === 'html') e.innerHTML = attrs[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]); else if (k === 'class') e.className = attrs[k];
    else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
  }
  for (const c of [].concat(kids)) if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
};
function section(title, open, badgeId) {
  const d = el('details', { class: 'sec' }); if (open) d.open = true;
  d.appendChild(el('summary', {}, [title, badgeId ? el('span', { class: 'badge', id: badgeId }) : null]));
  const b = el('div', { class: 'secbody' }); d.appendChild(b);
  $('sections').appendChild(d);
  return b;
}
function row(parent, label, ctl) { const r = el('div', { class: 'row' }, [el('label', { text: label }), el('div', { class: 'ctl' }, [ctl])]); parent.appendChild(r); return ctl; }
function numIn(v, step, onchange, attrs = {}) { return el('input', Object.assign({ type: 'number', value: v, step, onchange: e => onchange(+e.target.value) }, attrs)); }
function selIn(opts, v, onchange) {
  const s = el('select', { onchange: e => onchange(e.target.value) });
  for (const [val, txt] of opts) s.appendChild(el('option', { value: val, text: txt }));
  s.value = v; return s;
}
function chk(v, onchange) { return el('input', { type: 'checkbox', checked: v, onchange: e => onchange(e.target.checked) }); }
function showError(msg) { const e = $('err'); e.textContent = msg; e.classList.remove('hidden'); clearTimeout(showError.t); showError.t = setTimeout(() => e.classList.add('hidden'), 12000); }
function logMsg(s) { RUN.log.push(new Date().toLocaleTimeString() + '  ' + s); if (RUN.log.length > 200) RUN.log.shift(); const L = $('runlog'); if (L) { L.textContent = RUN.log.slice(-60).join('\n'); L.scrollTop = L.scrollHeight; } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── sounding ──────────────────────────────────────────────────────────────
let SND = { text: '', A: null, meta: null, err: '' };
function buildSounding() {
  const s = CFG.snd;
  try {
    let text, meta = null;
    if (isHur()) text = Hurricane.sounding(CFG.hur);
    else if (s.kind === 'sample') text = (window.SAMPLE_SOUNDINGS[s.index] || window.SAMPLE_SOUNDINGS[0]).text;
    else if (s.kind === 'gen') {
      const o = { seed: s.gen.seed || undefined, hour: s.gen.hour || '00', resolution: 'high' };
      if (s.gen.station) o.station = s.gen.station;
      if (s.gen.regime) o.regime = s.gen.regime;
      const res = SoundingGen.generate(o);
      s.gen.seed = res.seed; meta = res.meta;
      text = SoundingGen.toSPC(res);
    } else text = s.text;
    const snd = Sounding.parseSharppy(text);
    SND = { text, A: Sounding.analyze(snd), meta, err: '', sfcH: snd.levels.slice().sort((a, b) => a.h - b.h)[0].h };
  } catch (e) { SND = { text: '', A: null, meta: null, err: e.message }; }
  renderSndParams();
}
function renderSndParams() {
  const box = $('sndparams'); if (!box) return;
  if (!SND.A) { box.innerHTML = `<span style="color:var(--bad)">${SND.err || 'no sounding'}</span>`; return; }
  const P = SND.A.P, f = (v, d = 0) => isFinite(v) ? v.toFixed(d) : '–';
  if (isHur()) {
    const H = CFG.hur;
    box.innerHTML = `<div class="params">
      <div>SBCAPE <b>${f(P.sbcape)}</b> J/kg</div><div>MLCAPE <b>${f(P.mlcape)}</b></div>
      <div>SST <b>${f(H.sst, 1)}</b> °C</div><div>sfc air <b>${f(H.sst - 1, 1)}</b> °C · 80 %</div>
      <div>steering <b>${f(H.steerKt)}</b> kt → ${f(H.steerDir)}°</div><div>shear <b>${f(H.shearKt)}</b> kt from ${f(H.shearFrom)}°</div></div>`;
    return;
  }
  const m = SND.meta ? `<div class="note">${SND.meta.station} ${SND.meta.time} · ${SND.meta.regimeLabel || ''} (seed ${CFG.snd.gen.seed})</div>` : '';
  box.innerHTML = m + `<div class="params">
    <div>MLCAPE <b>${f(P.mlcape)}</b> J/kg</div><div>MLCIN <b>${f(P.mlcin)}</b></div>
    <div>SBCAPE <b>${f(P.sbcape)}</b></div><div>ML LCL <b>${f(P.mllcl)}</b> m</div>
    <div>0–1 km SRH <b>${f(P.srh1)}</b></div><div>0–3 km SRH <b>${f(P.srh3)}</b></div>
    <div>0–6 km shear <b>${f(P.shr6 / 0.5144)}</b> kt</div><div>STP <b>${f(P.stp, 1)}</b></div>
    <div>Bunkers RM <b>${f(Math.hypot(SND.A.rm[0], SND.A.rm[1]) / 0.5144)}</b> kt</div><div>sfc <b>${f(SND.sfcH)}</b> m MSL</div></div>`;
}

// ─── panel ─────────────────────────────────────────────────────────────────
function buildPanel() {
  $('sections').innerHTML = '';
  let secN = 0; const N = t => `${++secN} · ${t}`;
  const s0 = section('Event type', true);
  row(s0, 'Simulate', selIn([['outbreak', 'Severe-weather outbreak (supercells, fronts)'], ['hurricane', 'Hurricane (tropical cyclone over a warm sea)']], CFG.mode || 'outbreak', setMode));
  if (isHur()) { buildHurricanePanel(N); return; }
  // sounding
  const s1 = section(N('Warm-sector sounding'), true);
  const kind = row(s1, 'Source', selIn([['sample', 'Sample sounding'], ['gen', 'SoundingGen (procedural)'], ['paste', 'Paste SHARPpy text']], CFG.snd.kind, v => { CFG.snd.kind = v; buildPanel(); buildSounding(); saveCfg(); }));
  void kind;
  if (CFG.snd.kind === 'sample') {
    row(s1, 'Sounding', selIn(window.SAMPLE_SOUNDINGS.map((x, i) => [i, x.name]), CFG.snd.index, v => { CFG.snd.index = +v; buildSounding(); saveCfg(); }));
  } else if (CFG.snd.kind === 'gen') {
    const g = CFG.snd.gen;
    const regs = [['', 'Any regime (weighted by season)']].concat((SoundingGen.Regimes.list || []).map(r => [r.key, `${r.label} · ${r.tier}`]));
    row(s1, 'Regime', selIn(regs, g.regime, v => { g.regime = v; g.seed = ''; buildSounding(); saveCfg(); }));
    row(s1, 'Station', selIn([['', 'Any']].concat(SoundingGen.STATIONS.map(st => [st.id, `${st.id} · ${st.name}`])), g.station, v => { g.station = v; g.seed = ''; buildSounding(); saveCfg(); }));
    row(s1, 'Hour (UTC)', selIn([['00', '00Z'], ['12', '12Z'], ['18', '18Z'], ['21', '21Z']], g.hour, v => { g.hour = v; buildSounding(); saveCfg(); }));
    const seed = row(s1, 'Seed', el('input', { type: 'text', value: g.seed, placeholder: 'random', onchange: e => { g.seed = e.target.value.trim(); buildSounding(); saveCfg(); } }));
    s1.appendChild(el('div', { class: 'btns' }, [el('button', { text: 'New random sounding', onclick: () => { g.seed = ''; buildSounding(); seed.value = g.seed; saveCfg(); } })]));
  } else {
    const ta = el('textarea', { placeholder: '%TITLE% ... %RAW% p, hght, t, td, wdir, wspd(kt) ... %END%', oninput: e => { CFG.snd.text = e.target.value; clearTimeout(ta.t); ta.t = setTimeout(() => { buildSounding(); saveCfg(); }, 400); } });
    ta.value = CFG.snd.text; s1.appendChild(ta);
  }
  s1.appendChild(el('div', { id: 'sndparams' }));
  s1.appendChild(el('div', { class: 'note', text: 'The sounding is the open warm sector. Boundaries below replace it with their own air mass on their cold / cool / dry side.' }));

  buildDomainSection(N);
  // boundaries
  buildBoundarySection(N, true);
  // storms
  const s4 = section(N('Storm initiation'), true);
  const ci = CFG.ci;
  row(s4, 'Random storms', chk(ci.auto, v => { ci.auto = v; saveCfg(); }));
  row(s4, 'Warm sector rate', numIn(ci.warmRate, 0.1, v => { ci.warmRate = Math.max(0, v); saveCfg(); }, { title: 'initiation attempts per 100,000 km² per hour in the open warm sector' }));
  row(s4, 'Window (h)', el('div', { style: 'display:flex;gap:6px' }, [numIn(ci.start, 0.25, v => { ci.start = Math.max(0, v); saveCfg(); }), numIn(ci.end, 0.25, v => { ci.end = Math.max(ci.start, v); saveCfg(); })]));
  row(s4, 'Updraft push (m/s)', numIn(ci.wt, 1, v => { ci.wt = clamp(v, 3, 20); saveCfg(); }));
  row(s4, 'Push radius (km)', numIn(ci.rh / 1000, 1, v => { ci.rh = clamp(v, 4, 20) * 1000; saveCfg(); }));
  row(s4, 'Random seed', numIn(ci.seed, 1, v => { ci.seed = v | 0; saveCfg(); }));
  row(s4, 'Sub-grid tornadoes', chk(CFG.tor.on, v => { CFG.tor.on = v; saveCfg(); }));
  row(s4, 'Tornado rate ×', numIn(CFG.tor.rate, 0.1, v => { CFG.tor.rate = clamp(v, 0, 5); saveCfg(); }, { title: 'multiplies the STP-scaled tornado probability of strong low-level mesocyclones' }));
  s4.appendChild(el('div', { class: 'note', html: 'On 500 m – 2 km grids the model resolves mesocyclones but not tornadoes: this scheme spawns them from mature mesocyclones (the one thing added to the radar data: a beam-smeared vortex and debris). On 250 m and 100 m grids it is off and the radar shows only the model\'s own vortices.' }));
  s4.appendChild(el('div', { class: 'note', html: `Each boundary has its own rate (per 1000 km per hour, on its warm side). Storms are started by a growing, storm-following updraft push (after Naylor &amp; Gilmore 2012) with 0–5 satellite towers that merge into it, drawn at random for every storm (size, strength, timing, layout from a round cluster to a line; along boundaries the towers line up along them); it ends after 25–38 min and whether the storm lives on is up to the sounding. The random seed makes a run repeatable. Use <b>Add storm</b> to place one by hand (before or during the run). Hand-placed: <b id="manualN">${CFG.manual.length}</b> <button id="clrMan">clear</button>` }));
  setTimeout(() => { const b = $('clrMan'); if (b) b.onclick = () => { CFG.manual = []; saveCfg(); buildPanel(); draw(); }; });

  // radars
  buildRadarRunSections(N);
}
function buildRadarRunSections(N) {
  const s5 = section(N('Radars'), true, 'radBadge');
  row(s5, 'VCP', selIn(Object.entries(VCPS).map(([k, v]) => [k, v.label]), CFG.vcp, v => { CFG.vcp = +v; saveCfg(); }));
  row(s5, 'Velocity aliasing', chk(CFG.aliasing, v => { CFG.aliasing = v; saveCfg(); }));
  row(s5, 'Echo floor (dBZ)', numIn(CFG.minDbz ?? 0, 1, v => { CFG.minDbz = clamp(v, -20, 20); saveCfg(); }, { title: 'gates with weaker model reflectivity are left empty' }));
  s5.appendChild(el('div', { class: 'note', html: 'Click sites with the <b>Radars</b> tool. Any WSR-88D works; its beams are traced over the model domain. The data is only what the model holds: precipitation and its winds (no clear-air returns, fine lines or noise).' }));
  s5.appendChild(el('div', { class: 'chips', id: 'radChips' }));
  renderRadars();

  // run
  const s6 = section(N('Run and GR2Analyst'), true);
  row(s6, 'Run name', el('input', { type: 'text', value: CFG.runName, placeholder: 'auto', onchange: e => { CFG.runName = e.target.value.trim(); saveCfg(); } }));
  s6.appendChild(el('div', { class: 'btns' }, [
    el('button', { class: 'primary', id: 'btnStart', text: 'Start simulation', onclick: startRun }),
    el('button', { id: 'btnPause', text: 'Pause', onclick: togglePause, disabled: true }),
    el('button', { id: 'btnStop', class: 'danger', text: 'Stop', onclick: stopRun, disabled: true }),
  ]));
  s6.appendChild(el('div', { class: 'progress' }, [el('div', { id: 'prog' })]));
  s6.appendChild(el('div', { class: 'note', id: 'srvNote' }));
  s6.appendChild(el('div', { class: 'note', html: `<b>Live in GR2Analyst:</b> File → Configure Polling → Add, enter <code>http://127.0.0.1:${location.port || 8820}/poll/</code> and move it to the top of the list (above Iowa State, or GR2 takes those radars from there), enable polling, then choose one of the run's radars. Volumes appear as the model makes them (use a speed limit so GR2 keeps up); the latest run is served, or a replay.<br><b>Files:</b> <code>OutbreakLab\\output\\&lt;run&gt;\\&lt;ICAO&gt;\\</code> for File → Open.` }));
  const rp = el('div', { class: 'btns' }, [
    el('span', { class: 'note', text: 'Replay a finished run through polling at' }),
    selIn([[5, '5×'], [10, '10×'], [20, '20×'], [40, '40×']], 10, v => { RUN.replayF = +v; }),
    el('button', { text: 'Replay', onclick: startReplay }),
    el('button', { text: 'Stop replay', onclick: () => fetch('/api/replay', { method: 'POST', body: '{}' }).then(() => logMsg('replay stopped')) }),
  ]);
  s6.appendChild(rp);
  s6.appendChild(el('div', { class: 'log', id: 'runlog' }));
  buildSounding();
  syncRunButtons();
}

function buildDomainSection(N) {
  const s2 = section(N('Domain, time and speed'), true);
  const gridOpts = Object.entries(GRID_PRESETS).map(([k, v]) => [k, v.label]).concat([['custom', 'Custom: choose the spacing and size']]);
  const gridChanged = () => { updateGeo(); draw(); saveCfg(); showGridEstimate(); };
  row(s2, 'Grid', selIn(gridOpts, GRID_PRESETS[CFG.grid] || CFG.grid === 'custom' ? CFG.grid : 'standard', v => { CFG.grid = v; buildPanel(); gridChanged(); }));
  if (CFG.grid === 'custom') {
    const cg = CFG.customGrid;
    row(s2, 'Grid spacing', selIn(CUSTOM_DX.map(d => [d, d >= 1000 ? `${d / 1000} km` : `${d} m`]), cg.dx, v => { cg.dx = +v; gridChanged(); }));
    row(s2, 'Width × height (km)', el('div', { style: 'display:flex;gap:6px' }, [
      numIn(cg.w, 16, v => { cg.w = clamp(v, 16, 4000); gridChanged(); }, { min: 16 }), numIn(cg.h, 16, v => { cg.h = clamp(v, 16, 4000); gridChanged(); }, { min: 16 })]));
  }
  s2.appendChild(el('div', { class: 'note', id: 'gridEst' }));
  setTimeout(showGridEstimate);
  row(s2, 'Centre lat, lon', el('div', { class: 'mono', id: 'centerTxt', text: `${CFG.center.lat.toFixed(3)}, ${CFG.center.lon.toFixed(3)}` }));
  row(s2, 'Start (UTC)', el('input', { type: 'datetime-local', value: CFG.start, onchange: e => { CFG.start = e.target.value; saveCfg(); } }));
  const maxH = isHur() ? 120 : 24;
  row(s2, 'Length (hours)', numIn(CFG.hours, isHur() ? 6 : 0.5, v => { CFG.hours = clamp(v, 0.5, maxH); saveCfg(); }, { min: 0.5, max: maxH }));
  row(s2, 'Time step ×', numIn(CFG.dtScale, 0.1, v => { CFG.dtScale = clamp(v, 0.3, 1.5); saveCfg(); }, { min: 0.3, max: 1.5 }));
  row(s2, 'Microphysics', selIn([['lin', 'Lin-type (single-moment)'], ['thompson', 'Thompson-style (double-moment rain)']], CFG.micro || 'lin', v => { CFG.micro = v; saveCfg(); }));
  s2.appendChild(el('div', { class: 'note', html: `<b>Thompson-style</b> (after Thompson et al. 2008) predicts the number of raindrops as well as their mass, so drops size-sort as they fall (big drops at the forward-flank edge: ZDR arcs), rain from melted graupel is big drops that evaporate slowly, and graupel particles get fewer and larger as graupel builds up. Cloud water, ice and snow stay Lin-type. It is a port of the scheme's main ideas, not WRF's full code.` }));
  row(s2, 'Speed limit', selIn([[0, 'As fast as possible'], [10, '10× real time'], [20, '20× real time'], [60, '60× real time'], [1, 'Real time']], CFG.pace, v => { CFG.pace = +v; saveCfg(); }));
  s2.appendChild(el('div', { class: 'note', html: 'Use the <b>Move domain</b> tool to drag the box over the map. Terrain is flat at the sounding\'s surface height.' }));

}
function buildBoundarySection(N, open) {
  // boundaries
  const s3 = section(N('Boundaries'), open, 'bndBadge');
  s3.appendChild(el('div', { class: 'note', html: 'Pick a <b>draw</b> tool above the map, click points, double-click (or Enter) to finish. The other air mass sits on the side opposite the motion (ahead of a warm front).' }));
  const list = el('div', { class: 'list', id: 'bndList' }); s3.appendChild(list);
  renderBounds();

}
// hurricane mode: the tropical environment (a generated sounding) and the initial vortex replace the warm sector
function buildHurricanePanel(N) {
  const H = CFG.hur;
  const s1 = section(N('Tropical environment'), true);
  const upd = (k, lo, hi) => v => { H[k] = clamp(v, lo, hi); buildSounding(); saveCfg(); draw(); };
  row(s1, 'Sea-surface temp (°C)', numIn(H.sst, 0.5, upd('sst', 20, 34), { title: 'the sea under the whole domain; 26.5 °C is about the least a hurricane needs, 30–31 °C feeds the strongest' }));
  row(s1, 'SST change per °N (°C)', numIn(H.sstGrad, 0.1, upd('sstGrad', -3, 3), { title: 'e.g. −0.3: the sea cools by 0.3 °C per degree of latitude northward of the starting point' }));
  row(s1, 'Mid-level humidity (%)', numIn(H.rhMid, 5, upd('rhMid', 10, 95), { title: '700–500 hPa relative humidity: dry air (40 % or less) chokes a storm, moist air (70 %+) helps it' }));
  row(s1, 'Instability (K)', numIn(H.instab, 0.5, upd('instab', 0, 6), { title: 'how cold the free troposphere is: 3 = the observed hurricane-season mean (Jordan 1958, shifted by half the SST’s departure from 28.5 °C), each K more = 1 K colder aloft. At 29.5 °C: 2 K ≈ 2600 J/kg of surface-based CAPE, 3 K ≈ 3100, 4 K ≈ 3700' }));
  row(s1, 'Steering toward (°)', numIn(H.steerDir, 5, v => { H.steerDir = ((v % 360) + 360) % 360; buildSounding(); saveCfg(); draw(); }, { title: 'the deep-layer flow that carries the storm; 0 = north, 270 = west' }));
  row(s1, 'Steering speed (kt)', numIn(H.steerKt, 1, upd('steerKt', 0, 30)));
  row(s1, 'Shear from (°)', numIn(H.shearFrom, 5, v => { H.shearFrom = ((v % 360) + 360) % 360; buildSounding(); saveCfg(); }, { title: '850–200 hPa shear direction, as forecasters give it: 270 = westerly shear' }));
  row(s1, 'Shear (kt)', numIn(H.shearKt, 1, upd('shearKt', 0, 60), { title: '850–200 hPa vertical wind shear: under 10 kt favourable, 20 kt+ tilts and weakens the storm' }));
  s1.appendChild(el('div', { id: 'sndparams' }));
  s1.appendChild(el('div', { class: 'note', html: 'A hurricane-season tropical sounding (after Jordan 1958 / Dunion 2011) is generated from these: sea-level pressure 1012 hPa, surface air 1 °C cooler than the sea, a −76 °C tropopause near 16 km. The storm is steered by the sounding’s winds on an f-plane (no beta drift).' }));
  const vupd = (k, lo, hi) => v => { H[k] = clamp(v, lo, hi); saveCfg(); draw(); };
  const s1b = section(N(H.start === 'cluster' ? 'How it starts: a convective cluster' : 'Initial vortex'), true);
  row(s1b, 'Start from', selIn([['vortex', 'A balanced vortex (tropical storm or stronger)'], ['cluster', 'A cluster of active convection (genesis)']], H.start || 'vortex', v => { H.start = v; saveCfg(); buildPanel(); draw(); }));
  if (H.start === 'cluster') {
    row(s1b, 'Cluster radius (km)', numIn(H.clusterKm, 10, vupd('clusterKm', 50, 400)));
    row(s1b, 'Storm starts per hour', numIn(H.cellRate, 1, vupd('cellRate', 0, 40), { title: 'new thunderstorms set off at random in the cluster each hour (each with its own satellite towers); they drift with the 850–500 hPa wind' }));
    row(s1b, 'For (hours)', numIn(H.seedHours, 1, vupd('seedHours', 0, 72), { title: 'after this the cluster has to keep itself going' }));
    row(s1b, 'Mid-level vortex (kt)', numIn(H.mcvKt, 5, vupd('mcvKt', 0, 40), { title: 'a weak vortex strongest at ~5 km and nearly calm at the surface (a tropical wave or a leftover convective vortex); 0 = convection alone, which rarely spins anything up on an f-plane' }));
    row(s1b, 'Moist column', chk(H.moistCore, v => { H.moistCore = v; saveCfg(); }));
    row(s1b, 'Centre', el('div', { class: 'mono', id: 'hurPos', text: `${H.lat.toFixed(2)}°, ${H.lon.toFixed(2)}°` }));
    row(s1b, 'Calm beyond (km)', numIn(H.envKm ?? 300, 25, vupd('envKm', 150, 1500), { title: 'from this distance from the disturbance (fully by 1.5×) the air is held to the sounding and stray cloud dies away' }));
    row(s1b, 'Land moisture (0–1)', numIn(H.landMoist, 0.05, vupd('landMoist', 0, 1)));
    s1b.appendChild(el('div', { class: 'note', html: 'Genesis instead of a ready-made storm: thunderstorms keep firing at random in the cluster (the outbreak mode\u2019s storm starts, with smaller, gentler tropical pushes) and drift with the mid-level wind, like a tropical wave\u2019s convection; <b>Moist column</b> starts the air there 90 % humid up to ~8 km. Their heating, merging updrafts and outflows may organize into a tropical depression — or the cluster may just rain itself out. The map shows the disturbance until the model has a closed surface circulation with 25 kt winds and a 2 hPa low for an hour; the log reports when a depression forms. Move it with <b>Place hurricane</b>.' }));
  } else {
  row(s1b, 'Max wind (kt)', numIn(H.vmaxKt, 5, vupd('vmaxKt', 15, 120), { title: 'the starting disturbance: 25–30 kt a depression, 40 kt a tropical storm. Weak starts take a day or two to organize' }));
  row(s1b, 'Radius of max wind (km)', numIn(H.rmwKm, 5, vupd('rmwKm', 15, 200)));
  row(s1b, 'Outer radius (km)', numIn(H.r0Km, 25, vupd('r0Km', 100, 900), { title: 'where its winds fade to zero (the storm’s size)' }));
  row(s1b, 'Moist core', chk(H.moistCore, v => { H.moistCore = v; saveCfg(); }));
  row(s1b, 'Starts at', el('div', { class: 'mono', id: 'hurPos', text: `${H.lat.toFixed(2)}°, ${H.lon.toFixed(2)}°` }));
  row(s1b, 'Calm beyond (km)', numIn(H.envKm ?? 300, 25, vupd('envKm', 150, 1500), { title: 'from this distance (fully by 1.5×) the air is held to the sounding within ~1 h and stray cloud there dies away: the large-scale sinking that keeps a real hurricane’s surroundings mostly clear. Raise it for a wider field of outer bands and convection' }));
  row(s1b, 'Land moisture (0–1)', numIn(H.landMoist, 0.05, vupd('landMoist', 0, 1), { title: 'how much moisture land gives the storm compared with the sea (land never gives it heat): it weakens over land' }));
  }
  if (H.start !== 'cluster') s1b.appendChild(el('div', { class: 'note', html: 'Drag the starting point with <b>Place hurricane</b>. The vortex is warm-core and balanced (gradient wind and thermal wind), with winds fading upward to 16 km; the moist core starts it nearly saturated inside 2.5× its radius of maximum wind. From there the sea does the work: the model adds the ocean’s heat and moisture (bulk fluxes that grow with the wind), sea-surface drag, a turbulent boundary layer and slow radiative cooling. Land (US states; Mexico and the islands count as sea) gives little moisture, no heat and more drag, so storms weaken after landfall.' }));
  buildDomainSection(N);
  buildBoundarySection(N, false);
  buildRadarRunSections(N);
}

function renderBounds() {
  const list = $('bndList'); if (!list) return;
  list.innerHTML = '';
  $('bndBadge') && ($('bndBadge').textContent = CFG.bounds.length ? CFG.bounds.length + '' : 'none');
  if (!CFG.bounds.length) list.appendChild(el('div', { class: 'note', text: 'No boundaries: an open warm sector.' }));
  const lows = findLows().filter(L => L.front);
  if (lows.length) {
    const lm = CFG.low, ll = GEO.inv(lows[0].x, lows[0].y), m = lowMotion(lows[0]);
    const it = el('div', { class: 'item' });
    it.appendChild(el('div', { class: 'head' }, [el('span', { class: 'sw', style: 'background:#ff3b30' }),
      el('span', { class: 'ttl', text: `Surface low${lows.length > 1 ? 's' : ''} (L) · ${ll[0].toFixed(2)}°, ${ll[1].toFixed(2)}°` })]));
    const g = el('div', { class: 'grid' });
    g.appendChild(el('label', { title: 'the low moves at the average motion of the boundaries that meet there' }, ['Moves with its fronts', chk(lm.auto !== false, v => { lm.auto = v; saveCfg(); renderBounds(); draw(); })]));
    if (lm.auto !== false) g.appendChild(el('div', { class: 'note', text: `${Math.hypot(m[0], m[1]).toFixed(1)} m/s toward ${((Math.atan2(m[0], m[1]) / DEG + 360) % 360).toFixed(0)}°` }));
    else {
      g.appendChild(el('label', {}, ['Moves at (m/s)', numIn(lm.speed, 0.5, v => { lm.speed = clamp(v, 0, 40); saveCfg(); draw(); })]));
      g.appendChild(el('label', { title: 'direction of motion, 0 = north, 90 = east' }, ['toward (deg)', numIn(lm.dir, 5, v => { lm.dir = ((v % 360) + 360) % 360; saveCfg(); draw(); })]));
    }
    it.appendChild(g);
    it.appendChild(el('div', { class: 'note', html: 'To move the low, drag the <b>L</b> with <b>Edit boundary</b>: its fronts come along (Shift-drag moves only the point where they meet, and the fronts pivot). <b>Move fronts</b> moves every boundary. During the run the fronts stay joined at the low as it moves.' }));
    list.appendChild(it);
  }
  CFG.bounds.forEach((b, i) => {
    const T = BND_TYPES[b.type];
    if (b.vary === undefined) b.vary = T.vary;          // boundaries drawn before the setting existed
    const upd = (k, v) => { b[k] = v; saveCfg(); draw(); };
    const it = el('div', { class: 'item' + (EDIT.sel === b.id ? ' sel' : ''), onclick: () => { EDIT.sel = b.id; draw(); } });
    it.appendChild(el('div', { class: 'head' }, [
      el('span', { class: 'sw', style: `background:${T.color}` }),
      el('span', { class: 'ttl', text: `${T.label}` }),
      el('button', { text: 'flip side', title: 'swap which side holds the other air mass', onclick: e => { e.stopPropagation(); upd('flip', !b.flip); } }),
      el('button', { text: '✕', title: 'delete', onclick: e => { e.stopPropagation(); CFG.bounds.splice(i, 1); saveCfg(); renderBounds(); draw(); } }),
    ]));
    const g = el('div', { class: 'grid' });
    const f = (label, key, step, title) => g.appendChild(el('label', { title }, [label, numIn(b[key] ?? '', step, v => upd(key, v))]));
    f('Moves at (m/s)', 'speed', 0.5); f('toward (deg)', 'dir', 5, 'direction of motion, 0 = north, 90 = east');
    f(b.type === 'dry' ? 'ΔT dry side (K)' : 'ΔT other side (K)', 'dT', 0.5); f('Depth (m)', 'depth', 100);
    f('Moisture deficit 0–0.9', 'dq', 0.05); f('Slope (m/m)', 'slope', 0.001, 'how fast the air mass deepens away from the boundary');
    f('Wind from (deg)', 'windDir', 5, 'surface wind in the other air mass (blank = along the motion)'); f('Wind (m/s)', 'windSpd', 1);
    f('Storm rate', 'rate', 0.1, 'initiation attempts per 1000 km of boundary per hour, on its warm side');
    f('Along-front variation 0–1', 'vary', 0.1, 'how unevenly the boundary lifts air: its lift is concentrated in hot spots about every 50 km that fade and re-form elsewhere over ~1.5 h (its depth and contrast also vary along it). 0 = one uniform wall of lift, which fires a continuous fine line of storms wherever the cap is weak; 0.8 = storms fire from a few spots at a time; 1 = very patchy');
    g.appendChild(el('label', {}, ['Keep it (nudge)', chk(b.nudge, v => upd('nudge', v))]));
    it.appendChild(g);
    list.appendChild(it);
  });
}
function renderRadars() {
  const c = $('radChips'); if (!c) return;
  c.innerHTML = '';
  $('radBadge') && ($('radBadge').textContent = CFG.radars.length + '');
  for (const id of CFG.radars) {
    const s = SITES.find(x => x.id === id);
    const inDom = s && GEO ? (() => { const [x, y] = GEO.fwd(s.lat, s.lon); const h = domHalf(); return Math.abs(x) < h[0] + 150000 && Math.abs(y) < h[1] + 150000; })() : true;
    c.appendChild(el('span', { class: 'chip', title: s ? `${s.name}, ${s.st} — click to remove` : id, style: inDom ? '' : 'opacity:0.5', text: id + ' ✕', onclick: () => { CFG.radars = CFG.radars.filter(x => x !== id); saveCfg(); renderRadars(); draw(); } }));
  }
  if (!CFG.radars.length) c.appendChild(el('span', { class: 'note', text: 'No radars selected (the model still runs; nothing is exported).' }));
}

// ─── toolbar / map state ───────────────────────────────────────────────────
const TOOL = { cur: 'pan' };
const EDIT = { sel: null, draft: null, drag: null };
let LAYER = 'comp';
function buildToolbar() {
  const tb = $('toolbar'); tb.innerHTML = '';
  const tool = (id, label, title) => tb.appendChild(el('button', { class: 'tool' + (TOOL.cur === id ? ' on' : ''), text: label, title, onclick: () => setTool(id) }));
  tool('pan', 'Pan', 'drag to pan, wheel to zoom');
  tool('domain', 'Move domain', 'drag the model domain');
  tool('radar', 'Radars', 'click a radar site to add / remove it');
  tool('edit', 'Edit boundary', 'drag the L to move the surface low with its fronts (Shift-drag: only where they meet), a vertex to reshape, a line to move that boundary; right-click a vertex to delete it');
  tool('movebnd', 'Move fronts', 'drag to move every boundary together: the whole frontal system with its surface low');
  if (isHur()) tool('hur', 'Place hurricane', 'click or drag to set where the hurricane starts');
  tb.appendChild(el('span', { class: 'sep' }));
  for (const [k, T] of Object.entries(BND_TYPES)) tool('draw:' + k, '+ ' + T.label, 'click points, double-click or Enter to finish');
  tb.appendChild(el('span', { class: 'sep' }));
  if (!isHur()) tool('storm', 'Add storm', 'click to start a storm there (before or during the run)');
  tb.appendChild(el('span', { class: 'sep' }));
  tb.appendChild(selIn([['comp', 'Composite reflectivity'], ['low', '1 km reflectivity'], ['vel', 'Radial velocity (0.5°)'], ['srv', 'Storm-relative velocity (0.5°)'], ['ir', 'Infrared satellite (simulated)'],
    ['wind', 'Surface wind (kt, ~10 m)'], ['mslp', 'Sea-level pressure (hPa)'], ['thp', 'Surface θ′ (fronts, cold pools)'], ['uh', '2–5 km updraft helicity'], ['wmax', 'Max updraft']], LAYER, v => { LAYER = v; buildToolbar(); paintField(); draw(); }));
  if (LAYER === 'vel' || LAYER === 'srv') {
    const sites = velSites();
    if (!sites.some(q => q.id === VEL.site)) VEL.site = sites.length ? sites[0].id : null;
    tb.appendChild(selIn(sites.map(q => [q.id, `${q.id} · ${q.name}`]), VEL.site, v => { VEL.site = v; paintField(); draw(); }));
  }
}
function setTool(t) { TOOL.cur = t; EDIT.draft = t.startsWith('draw:') ? { type: t.slice(5), pts: [] } : null; buildToolbar(); updateHint(); draw(); }
function updateHint() {
  const h = { pan: 'Drag to pan · wheel to zoom', domain: 'Drag the domain box', radar: 'Click a radar site to add or remove it',
    edit: 'Drag the L to move the surface low with its fronts (Shift-drag: only the point where they meet) · drag a vertex to reshape (drop an end on another boundary to join them) · drag a line to move that boundary · right-click deletes a vertex',
    movebnd: 'Drag to move all boundaries together (the whole frontal system and its surface low)',
    storm: RUN.state === 'setup' ? 'Click to place a storm start (at t = 0 + 5 min)' : 'Click to start a storm now',
    hur: 'Click or drag to set where the hurricane starts (the circles: radius of maximum wind and outer radius; the arrow: 24 h of steering)' };
  $('hint').textContent = TOOL.cur.startsWith('draw:') ? `Drawing ${BND_TYPES[TOOL.cur.slice(5)].label}: click points · double-click / Enter to finish · Esc to cancel` : h[TOOL.cur] || '';
}

// ─── geometry of the domain on the map ─────────────────────────────────────
// the grid in use: a preset, or the custom spacing × size (cells per side a multiple of 8, at most 2040)
const CUSTOM_DX = [100, 150, 200, 250, 300, 400, 500, 600, 750, 1000, 1250, 1500, 2000, 3000, 4000];
function gridSpec() {
  if (CFG.grid === 'custom') return customGrid(CFG.customGrid || DEFAULT_CFG.customGrid);
  const k = GRID_PRESETS[CFG.grid] ? CFG.grid : 'standard';
  return Object.assign({ key: k }, GRID_PRESETS[k]);
}
// wall time of one model step ≈ cells × (a + b (nx + ny)): the pressure solve's sine transforms (GEMMs) cost more per
// cell the wider the grid (at 1024 wide they are ~60 % of a step). Fitted to runs on an RTX 5090 without radars.
function gridEstimate(g) {
  const [nx, ny, nz] = g.n, cells = nx * ny * nz;
  const step = cells * (STEP_COST[0] + STEP_COST[1] * (nx + ny));
  return { cells, gb: gridBytes(g) / 1e9, speed: 6 * (g.dx / 1000) * (CFG.dtScale || 1) / step };
}
const STEP_COST = [4.4e-10, 3.2e-13];
function showGridEstimate() {
  const n = $('gridEst'); if (!n) return;
  const g = gridSpec(), e = gridEstimate(g);
  const sp = e.speed >= 100 ? Math.round(e.speed / 10) * 10 : e.speed >= 10 ? Math.round(e.speed) : e.speed.toFixed(1);
  const side = gridMaxSide(g.dx) * g.dx / 1000;
  const tooBig = gridFieldBytes(g) > gridFieldLimit();
  n.innerHTML = `${g.n[0]} × ${g.n[1]} × ${g.n[2]} = <b>${(e.cells / 1e6).toFixed(0)} M cells</b> (${(g.n[0] * g.dx / 1000).toFixed(0)} × ${(g.n[1] * g.dx / 1000).toFixed(0)} km) · needs about <b>${e.gb.toFixed(1)} GB</b> of free GPU memory · about <b>${sp}× real time</b> without radars (each exported radar slows it down)` +
    (tooBig ? `<br><span style="color:var(--bad)"><b>Too big for the browser:</b> one model field would be ${(gridFieldBytes(g) / 2 ** 30).toFixed(2)} GiB, and WebGPU can only set up fields of up to ${(gridFieldLimit() / 2 ** 30).toFixed(0)} GiB. At this spacing the largest domain is about ${side.toFixed(0)} × ${side.toFixed(0)} km (or the same area in another shape).</span>`
      : e.gb > 24 ? ' · <span style="color:var(--bad)">very large: close other GPU-heavy programs first</span>' : '') +
    (CFG.grid === 'custom' && !tooBig ? `<br>Largest domain at this spacing: about ${side.toFixed(0)} × ${side.toFixed(0)} km (WebGPU's 2 GiB limit per model field).` : '');
}
function domSize() { const p = gridSpec(); return [p.n[0] * p.dx, p.n[1] * p.dx]; }
function domHalf() { const s = domSize(); return [s[0] / 2, s[1] / 2]; }
let LINES = null, PROJ = null, CITIES = [];
function updateGeo() {
  const [Lx, Ly] = domSize();
  GEO = new Geo(CFG.center.lat, CFG.center.lon, Lx, Ly, SND.sfcH || 0);
  if (!LINES && window.MAPDATA) {
    LINES = { states: decodeRings(MAPDATA.states), counties: decodeRings(MAPDATA.counties) };
    CITIES = MAPDATA.cities.filter(c => c[2] > 25000).map(c => ({ lat: c[0], lon: c[1], pop: c[2], name: c[3] }));
  }
  if (LINES) {
    const pr = rings => rings.map(r => {
      const n = r.lat.length, a = new Float32Array(n * 2); let x0 = 1e30, x1 = -1e30, y0 = 1e30, y1 = -1e30;
      for (let i = 0; i < n; i++) { const [x, y] = GEO.fwd(r.lat[i], r.lon[i]); a[2 * i] = x; a[2 * i + 1] = y; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      return { a, bb: [x0, y0, x1, y1] };
    });
    PROJ = { states: pr(LINES.states), counties: pr(LINES.counties) };
    for (const c of CITIES) { const [x, y] = GEO.fwd(c.lat, c.lon); c.x = x; c.y = y; }
    for (const s of SITES) { const [x, y] = GEO.fwd(s.lat, s.lon); s.x = x; s.y = y; }
  }
  const t = $('centerTxt'); if (t) t.textContent = `${CFG.center.lat.toFixed(3)}, ${CFG.center.lon.toFixed(3)}`;
  renderRadars();
}

// ─── view transform (projected metres ↔ canvas pixels) ────────────────────
const VIEW = { cx: 0, cy: 0, s: 1 / 1400, w: 800, h: 600, dpr: 1 };
const toScr = (x, y) => [VIEW.w / 2 + (x - VIEW.cx) * VIEW.s, VIEW.h / 2 - (y - VIEW.cy) * VIEW.s];
const toWorld = (px, py) => [VIEW.cx + (px - VIEW.w / 2) / VIEW.s, VIEW.cy - (py - VIEW.h / 2) / VIEW.s];
function resize() {
  const c = $('map'), r = c.getBoundingClientRect(); VIEW.dpr = window.devicePixelRatio || 1;
  VIEW.w = Math.max(200, r.width); VIEW.h = Math.max(200, r.height);
  c.width = Math.round(VIEW.w * VIEW.dpr); c.height = Math.round(VIEW.h * VIEW.dpr);
  draw();
}

// ─── boundary geometry (lat/lon points, moved with time) ──────────────────
function bndSide(b, ptsXY) {
  // +1: the other air mass is on the left of the drawing direction
  const T = BND_TYPES[b.type];
  const md = [Math.sin(b.dir * DEG), Math.cos(b.dir * DEG)];
  const oth = T.otherAhead ? md : [-md[0], -md[1]];
  const a = ptsXY[0], e = ptsXY[ptsXY.length - 1], ab = [e[0] - a[0], e[1] - a[1]];
  const left = [-ab[1], ab[0]];
  let s = (left[0] * oth[0] + left[1] * oth[1]) >= 0 ? 1 : -1;
  if (b.flip) s = -s;
  return s;
}
function bndMotion(b) { return [b.speed * Math.sin(b.dir * DEG), b.speed * Math.cos(b.dir * DEG)]; }
// ─── surface lows ──────────────────────────────────────────────────────────
// A surface low is where two or more boundaries meet (their vertices within 8 km, e.g. the cold front / warm front /
// dryline triple point). Those vertices move as one point with the low, by default at the mean motion of the
// boundaries that meet there, so the fronts stay joined at the low instead of each drifting off on its own.
function findLows() {
  if (!GEO) return [];
  const V = [];
  CFG.bounds.forEach((b, bi) => b.pts.forEach((p, i) => { const [x, y] = GEO.fwd(p[0], p[1]); V.push({ bi, i, x, y }); }));
  const used = new Array(V.length).fill(false), lows = [];
  for (let a = 0; a < V.length; a++) {
    if (used[a]) continue;
    const gi = [a];
    for (let c = a + 1; c < V.length; c++) {
      if (used[c] || gi.some(k => V[k].bi === V[c].bi)) continue;
      if (Math.hypot(V[c].x - V[a].x, V[c].y - V[a].y) < 8000) gi.push(c);
    }
    if (gi.length < 2) continue;
    gi.forEach(k => { used[k] = true; });
    const grp = gi.map(k => V[k]);
    lows.push({ x: grp.reduce((q, g) => q + g.x, 0) / grp.length, y: grp.reduce((q, g) => q + g.y, 0) / grp.length, members: grp,
      front: grp.some(g => ['cold', 'warm', 'stat'].includes(CFG.bounds[g.bi].type)) });
  }
  return lows;
}
function lowMotion(L) {
  const lm = CFG.low || {};
  if (lm.auto === false && isFinite(lm.speed) && isFinite(lm.dir)) return [lm.speed * Math.sin(lm.dir * DEG), lm.speed * Math.cos(lm.dir * DEG)];
  const ms = L.members.map(g => bndMotion(CFG.bounds[g.bi]));
  return [ms.reduce((q, m) => q + m[0], 0) / ms.length, ms.reduce((q, m) => q + m[1], 0) / ms.length];
}
// per-point velocities of every boundary (m/s): its own motion, or its low's where it meets other boundaries
function boundaryVels(lows = findLows()) {
  const vel = CFG.bounds.map(b => { const m = bndMotion(b); return b.pts.map(() => m); });
  for (const L of lows) { const m = lowMotion(L); for (const g of L.members) vel[g.bi][g.i] = m; }
  return vel;
}
function bndModel(b) {
  const pts = b.pts.map(p => GEO.toModel(p[0], p[1]));
  const T = BND_TYPES[b.type];
  const side = bndSide(b, pts);
  const ws = SND.A ? SND.A.windAt(0.15) : [0, 0];
  let wd = b.windDir;
  if (wd === null || wd === '' || !isFinite(wd)) wd = (b.dir + 180) % 360;
  const wo = [-b.windSpd * Math.sin(wd * DEG), -b.windSpd * Math.cos(wd * DEG)];
  const Hmax = Math.max(200, b.depth);
  // a stable noise seed per boundary (from its id), so the same setup gives the same along-front pattern
  let seed = 0; for (const ch of String(b.id || b.type)) seed = (seed * 31 + ch.charCodeAt(0)) % 9973;
  return { pts, motion: bndMotion(b), halfW: T.halfW, dT: b.dT, Hmax, slope: Math.max(1e-4, b.slope), Hmin: Math.min(300, Hmax),
    dq: clamp(b.dq, 0, 0.9), qRatio: 1.0, du: wo[0] - ws[0], dv: wo[1] - ws[1], wRatio: 1.0, nudge: !!b.nudge, dFree: 25000, side,
    vary: clamp(b.vary ?? T.vary ?? 0.7, 0, 1), seed: seed * 0.731 + 11.3, varyL: 50000 };
}
// CPU copy of the GPU signed distance (model metres), for the scheduler
function bndPtsAt(mb, t) { return mb.pts.map((p, i) => { const v = (mb.vel && mb.vel[i]) || mb.motion; return [p[0] + v[0] * t, p[1] + v[1] * t]; }); }
function sdistCPU(mb, x, y, t) {
  const n = mb.pts.length, P = bndPtsAt(mb, t);
  let best = 1e30, sg = 1, over = 0;
  for (let i = 0; i < n - 1; i++) {
    const ax = P[i][0], ay = P[i][1], bx = P[i + 1][0], by = P[i + 1][1];
    const abx = bx - ax, aby = by - ay, la = Math.max(Math.hypot(abx, aby), 1);
    const t0 = ((x - ax) * abx + (y - ay) * aby) / (la * la);
    let tt = t0;
    if (i > 0) tt = Math.max(tt, 0);
    if (i < n - 2) tt = Math.min(tt, 1);
    const d = Math.hypot(x - (ax + tt * abx), y - (ay + tt * aby));
    if (d < best) { best = d; sg = abx * (y - ay) - aby * (x - ax) > 0 ? 1 : -1; over = (i === 0 ? Math.max(-t0, 0) * la : 0) + (i === n - 2 ? Math.max(t0 - 1, 0) * la : 0); }
  }
  return [best * sg * mb.side, over];
}
function otherWeight(mbs, x, y, t) {
  let w = 0;
  for (const mb of mbs) { const [d, over] = sdistCPU(mb, x, y, t); w = Math.max(w, smooth(-mb.halfW, mb.halfW, d) * (1 - smooth(0, 60000, over))); }
  return w;
}

// ─── drawing ───────────────────────────────────────────────────────────────
// ─── velocity layers ─────────────────────────────────────────────────────────
// radial velocity as one radar sees it: the model wind blended from the lowest level to ~1 km by the 0.5° beam's
// height at that range (4/3 earth), shown only where there is echo (the radar sees precipitation only); storm-relative
// subtracts the sounding's Bunkers right-mover motion
const VEL = { site: null };
const VEL_T = [-40, -30, -20, -12, -5, -1, 1, 5, 12, 20, 30, 40];
const VEL_C = [[176, 255, 255], [0, 251, 144], [0, 187, 0], [0, 143, 0], [0, 100, 0], [55, 69, 55], [118, 118, 118], [80, 48, 48], [139, 0, 0], [176, 0, 0], [224, 0, 0], [255, 80, 80], [255, 208, 160]];
function velColor(v) { let k = 0; while (k < VEL_T.length && v >= VEL_T[k]) k++; return VEL_C[k]; }
// radars that can see the domain: the run's radars first, then the nearest others
function velSites() {
  if (!GEO) return [];
  const [hx, hy] = domHalf();
  const near = SITES.filter(q => q.x !== undefined && Math.abs(q.x) < hx + 250000 && Math.abs(q.y) < hy + 250000);
  near.sort((a, b) => (CFG.radars.includes(b.id) - CFG.radars.includes(a.id)) || (Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y)));
  return near.slice(0, 16);
}

// ─── replay frames ───────────────────────────────────────────────────────────
// Every few simulated minutes the map fields are kept as bytes — reflectivity, θ′, helicity, updraft and the winds
// for the velocity layers — shrunk on very big grids and kept within ~300 MB (when a run outgrows that, every other
// frame is dropped and the interval doubles). The bar under the map plays them back, during or after the run.
const REPLAY = { frames: [], idx: -1, playing: false, fps: 6, timer: 0, next: 0, every: 180, ds: 1, w: 0, h: 0, budget: 300e6 };
const FR_CH = 12;  // composite dBZ, 1-km dBZ, sfc θ′, UH, max w, u, v lowest level, u, v ~1 km, sfc p′, IR temperature, ~10-m wind
const q8 = (v, a, sc) => Math.max(0, Math.min(255, Math.round((v - a) * sc)));
function replayReset() {
  replayStop(); REPLAY.frames = []; REPLAY.idx = -1; REPLAY.next = 0;
  if (MODEL && MODEL.nx) {
    REPLAY.ds = Math.max(1, Math.ceil(Math.max(MODEL.nx, MODEL.ny) / 640));
    REPLAY.w = Math.ceil(MODEL.nx / REPLAY.ds); REPLAY.h = Math.ceil(MODEL.ny / REPLAY.ds);
    const maxF = Math.max(20, Math.floor(REPLAY.budget / (REPLAY.w * REPLAY.h * FR_CH)));
    REPLAY.every = Math.max(60, Math.ceil((RUN.tEnd || 21600) / maxF / 60) * 60);
  }
  updateReplayBar();
}
// frames are read back at the first model step at or past each multiple of the interval (the loop schedules them)
const frameSlot = (t, every) => Math.floor(t / every);
function captureFrame(m) {
  if (!m.m2 || !MODEL) return;
  const last = REPLAY.frames[REPLAY.frames.length - 1];
  if (last && frameSlot(m.t, REPLAY.every) <= frameSlot(last.t, REPLAY.every)) return;
  const nx = MODEL.nx, ny = MODEL.ny, ds = REPLAY.ds, W = REPLAY.w, H = REPLAY.h, q = new Uint8Array(W * H * FR_CH);
  const m0 = m.m0, m1 = m.m1, m2 = m.m2, m3 = m.m3;
  for (let J = 0; J < H; J++) for (let I = 0; I < W; I++) {
    let zc = -32, zl = -32, th = 99, uh = 0, w = 0, pp = 99, ir = 999, w10 = 0;
    for (let j = J * ds; j < Math.min(ny, J * ds + ds); j++) for (let i = I * ds; i < Math.min(nx, I * ds + ds); i++) {
      const c = i + nx * j;
      if (m0[4 * c] > zc) zc = m0[4 * c]; if (m0[4 * c + 1] > zl) zl = m0[4 * c + 1]; if (m0[4 * c + 2] < th) th = m0[4 * c + 2];
      if (m1[4 * c + 1] > uh) uh = m1[4 * c + 1]; if (m1[4 * c] > w) w = m1[4 * c];
      if (m3) { pp = Math.min(pp, m3[4 * c]); ir = Math.min(ir, m3[4 * c + 1]); w10 = Math.max(w10, m3[4 * c + 2]); }
    }
    const c = Math.min(nx - 1, I * ds + (ds >> 1)) + nx * Math.min(ny - 1, J * ds + (ds >> 1)), o = FR_CH * (I + W * J);
    q[o] = q8(zc, -32, 2); q[o + 1] = q8(zl, -32, 2); q[o + 2] = q8(th, -12.8, 10); q[o + 3] = q8(Math.sqrt(Math.max(uh, 0)), 0, 5); q[o + 4] = q8(w, 0, 2.5);
    q[o + 5] = q8(m2[4 * c], -64, 2); q[o + 6] = q8(m2[4 * c + 1], -64, 2); q[o + 7] = q8(m2[4 * c + 2], -64, 2); q[o + 8] = q8(m2[4 * c + 3], -64, 2);
    q[o + 9] = q8(pp, -140, 1.7); q[o + 10] = q8(ir - 273.15, -110, 2); q[o + 11] = q8(w10, 0, 2.5);
  }
  REPLAY.frames.push({ t: m.t, q, tor: TOR.list.map(T => [T.id, T.x, T.y, T.ef, T.done ? 0 : 1, T.track.length]) });
  if (REPLAY.frames.length * W * H * FR_CH > REPLAY.budget) {
    const e2 = REPLAY.every * 2, keep = [];
    for (const f of REPLAY.frames) if (!keep.length || frameSlot(f.t, e2) > frameSlot(keep[keep.length - 1].t, e2)) keep.push(f);
    if (REPLAY.idx >= 0) { const tc = REPLAY.frames[REPLAY.idx].t; REPLAY.idx = Math.max(0, keep.findLastIndex(f => f.t <= tc)); }
    REPLAY.frames = keep; REPLAY.every = e2;
    REPLAY.next = Math.max(REPLAY.next, (frameSlot(m.t, e2) + 1) * e2);
  }
  updateReplayBar();
}
// what the map shows: the live fields, or the replay frame being played
function mapSource() {
  const f = REPLAY.idx >= 0 ? REPLAY.frames[REPLAY.idx] : null;
  if (f) {
    const q = f.q;
    return { W: REPLAY.w, H: REPLAY.h, ds: REPLAY.ds, t: f.t,
      comp: c => q[FR_CH * c] / 2 - 32, low: c => q[FR_CH * c + 1] / 2 - 32, thp: c => q[FR_CH * c + 2] / 10 - 12.8,
      uh: c => (q[FR_CH * c + 3] / 5) ** 2, w: c => q[FR_CH * c + 4] / 2.5,
      pp: c => q[FR_CH * c + 9] / 1.7 - 140, ir: c => q[FR_CH * c + 10] / 2 - 110, w10: c => q[FR_CH * c + 11] / 2.5,
      wind: (c, f1) => { const o = FR_CH * c, u0 = q[o + 5] / 2 - 64, v0 = q[o + 6] / 2 - 64; return [u0 + (q[o + 7] / 2 - 64 - u0) * f1, v0 + (q[o + 8] / 2 - 64 - v0) * f1]; } };
  }
  const M = RUN.maps; if (!M) return null;
  const m0 = M.m0, m1 = M.m1, m2 = M.m2, m3 = M.m3;
  return { W: MODEL.nx, H: MODEL.ny, ds: 1, t: M.t,
    comp: c => m0[4 * c], low: c => m0[4 * c + 1], thp: c => m0[4 * c + 2], uh: c => m1[4 * c + 1], w: c => m1[4 * c],
    pp: c => m3[4 * c], ir: c => m3[4 * c + 1] - 273.15, w10: c => m3[4 * c + 2],
    wind: (c, f1) => m2 ? [m2[4 * c] + (m2[4 * c + 2] - m2[4 * c]) * f1, m2[4 * c + 1] + (m2[4 * c + 3] - m2[4 * c + 1]) * f1] : [0, 0] };
}
// the model time on the map: the replay frame's, or the live one
function dispTime() {
  const f = REPLAY.idx >= 0 ? REPLAY.frames[REPLAY.idx] : null;
  return f ? f.t : (MODEL && RUN.state !== 'setup' ? MODEL.time : 0);
}
function fmtClock(t) { return new Date(RUN.epoch0 + t * 1000).toISOString().slice(11, 16) + 'Z (t+' + Math.floor(t / 3600) + ':' + String(Math.floor(t / 60) % 60).padStart(2, '0') + ')'; }
// the player bar along the bottom of the map
function buildReplayBar() {
  let bar = $('replaybar');
  if (!bar) { bar = el('div', { id: 'replaybar', class: 'hidden' }); $('mapwrap').appendChild(bar); }
  bar.innerHTML = '';
  const btn = (txt, title, fn, id) => { const b = el('button', { text: txt, title, onclick: fn }); if (id) b.id = id; bar.appendChild(b); return b; };
  btn('⏮', 'first frame', () => { replayStop(); replayGo(0); });
  btn('‹', 'previous frame (←)', () => replayStep(-1));
  btn('▶', 'play / pause (space)', replayToggle, 'rpPlay');
  btn('›', 'next frame (→)', () => replayStep(1));
  btn('⏭', 'last frame', () => { replayStop(); replayGo(REPLAY.frames.length - 1); });
  bar.appendChild(el('input', { type: 'range', id: 'rpSlider', min: 0, max: 0, step: 1, value: 0, oninput: e => { replayStop(); replayGo(+e.target.value); } }));
  bar.appendChild(el('span', { id: 'rpTime', class: 'mono' }));
  bar.appendChild(selIn([[2, '2 fps'], [4, '4 fps'], [6, '6 fps'], [10, '10 fps'], [15, '15 fps']], REPLAY.fps, v => { REPLAY.fps = +v; }));
  btn('Live', 'back to the latest model state', () => { replayStop(); REPLAY.idx = -1; paintField(); draw(); updateReplayBar(); status(true); }, 'rpLive');
  updateReplayBar();
}
function updateReplayBar() {
  const bar = $('replaybar'); if (!bar) return;
  const n = REPLAY.frames.length, show = n >= 2 && RUN.state !== 'setup';
  bar.classList.toggle('hidden', !show);
  const L = $('legend'); if (L) L.style.bottom = show ? '50px' : '';
  if (!show) return;
  const sl = $('rpSlider'); sl.max = n - 1; sl.value = REPLAY.idx >= 0 ? REPLAY.idx : n - 1;
  const f = REPLAY.idx >= 0 ? REPLAY.frames[REPLAY.idx] : null;
  $('rpTime').textContent = `${fmtClock(f ? f.t : (MODEL ? MODEL.time : 0))} · ${f ? `frame ${REPLAY.idx + 1}/${n}` : `live · ${n} frames`} · every ${Math.round(REPLAY.every / 60)} min`;
  $('rpPlay').textContent = REPLAY.playing ? '❚❚' : '▶';
  $('rpLive').classList.toggle('on', REPLAY.idx < 0);
}
function replayGo(i) { const n = REPLAY.frames.length; if (!n) return; REPLAY.idx = clamp(i, 0, n - 1); paintField(); draw(); updateReplayBar(); status(true); }
function replayStep(d) { replayStop(); const n = REPLAY.frames.length; if (!n) return; replayGo((REPLAY.idx >= 0 ? REPLAY.idx : n - 1) + d); }
function replayStop() { REPLAY.playing = false; clearTimeout(REPLAY.timer); }
function replayToggle() {
  if (REPLAY.playing) { replayStop(); updateReplayBar(); return; }
  const n = REPLAY.frames.length; if (n < 2) return;
  REPLAY.playing = true;
  if (REPLAY.idx < 0 || REPLAY.idx >= n - 1) REPLAY.idx = 0;
  replayGo(REPLAY.idx);
  // loops, holding the last frame a little longer, like a radar loop
  const tick = () => {
    if (!REPLAY.playing) return;
    const m = REPLAY.frames.length, last = REPLAY.idx >= m - 1;
    replayGo(last ? 0 : REPLAY.idx + 1);
    REPLAY.timer = setTimeout(tick, (REPLAY.idx >= m - 1 ? 3 : 1) * 1000 / REPLAY.fps);
  };
  REPLAY.timer = setTimeout(tick, 1000 / REPLAY.fps);
}
const FIELD = { canvas: document.createElement('canvas'), ok: false };
// The simulated satellite at 3× the model's resolution: the brightness temperature is interpolated bicubically between
// cells (drawn cell by cell, 2 km squares and thin-cirrus speckle looked nothing like GOES imagery), then given a fine
// cloud-top texture where there is cloud (a few tenths of a K over thin cloud, ~1.5 K over cold tops: bubbling anvils,
// overshooting tops), and coloured with SatPainter's table.
const IRUP = 3;
function irHash(i, j) { let h = (i * 374761393 + j * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function irNoise(x, y) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = irHash(i, j), b = irHash(i + 1, j), c = irHash(i, j + 1), d = irHash(i + 1, j + 1);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v - 0.5;
}
function paintIR(F, c) {
  const W = F.W, H = F.H, Wo = W * IRUP, Ho = H * IRUP;
  if (c.width !== Wo || c.height !== Ho) { c.width = Wo; c.height = Ho; }
  const ctx = c.getContext('2d'), img = ctx.createImageData(Wo, Ho), d = img.data;
  const T = new Float32Array(W * H); for (let s = 0; s < W * H; s++) T[s] = F.ir(s);
  const sst = F.ir(0) > 0 ? F.ir(0) : 28;
  const at = (i, j) => T[Math.min(W - 1, Math.max(0, i)) + W * Math.min(H - 1, Math.max(0, j))];
  const cub = (p0, p1, p2, p3, t) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  for (let J = 0; J < Ho; J++) {
    const y = (J + 0.5) / IRUP - 0.5, j = Math.floor(y), fy = y - j;
    for (let I = 0; I < Wo; I++) {
      const x = (I + 0.5) / IRUP - 0.5, i = Math.floor(x), fx = x - i;
      const r = [-1, 0, 1, 2].map(q => cub(at(i - 1, j + q), at(i, j + q), at(i + 1, j + q), at(i + 2, j + q), fx));
      let t = Math.min(cub(r[0], r[1], r[2], r[3], fy), 45);
      // texture: only where the scene is colder than the sea (cloud), stronger over colder, thicker cloud
      const cl = Math.max(0, Math.min(1, (sst - 2 - t) / 30));
      if (cl > 0) t += (irNoise(I / 2.3, J / 2.3) * 2.2 + irNoise(I / 0.9 + 31.7, J / 0.9 + 7.3) * 1.2) * (0.25 + 1.25 * cl) * cl;
      const [rr, gg, bb] = Hurricane.irColor(t), o = 4 * (I + Wo * (Ho - 1 - J));
      d[o] = rr; d[o + 1] = gg; d[o + 2] = bb; d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  FIELD.ok = true;
}
function paintField() {
  const F = MODEL ? mapSource() : null; if (!F) { FIELD.ok = false; return; }
  if (LAYER === 'ir') { paintIR(F, FIELD.canvas); return; }
  const W = F.W, H = F.H, c = FIELD.canvas;
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const ctx = c.getContext('2d'), img = ctx.createImageData(W, H), d = img.data;
  const vel = LAYER === 'vel' || LAYER === 'srv', cell = MODEL.dx * F.ds;
  const site = vel ? SITES.find(q => q.id === VEL.site) : null;
  const sm = LAYER === 'srv' ? stormMotion() : [0, 0];
  const p0 = MODEL.base ? MODEL.base.sfcP : 1012;
  const z0 = 0.5 * MODEL.dz, z1 = (clamp(Math.floor(1000 / MODEL.dz), 1, MODEL.nz - 2) + 0.5) * MODEL.dz;
  const rx = site ? site.x + GEO.Lx / 2 : 0, ry = site ? site.y + GEO.Ly / 2 : 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const s = i + W * j, o = 4 * (i + W * (H - 1 - j));
    let r = 0, g = 0, b = 0, a = 0;
    if (LAYER === 'comp' || LAYER === 'low') {
      const z = LAYER === 'comp' ? F.comp(s) : F.low(s);
      if (z >= 5) { const k = Math.min(14, Math.floor((z - 5) / 5)); [r, g, b] = DBZ_RGB[k]; a = 230; }
    } else if (vel) {
      if (site) {
        const x = (i + 0.5) * cell - rx, y = (j + 0.5) * cell - ry, rr = Math.hypot(x, y);
        const h = rr * 0.0087265 + rr * rr / 1.6989e7;        // 0.5° beam height, 4/3 earth
        if (rr > 1000 && rr < 300000 && (F.low(s) >= 5 || (h > 1500 && F.comp(s) >= 15))) {
          const wv = F.wind(s, clamp((h - z0) / (z1 - z0), 0, 1));
          [r, g, b] = velColor(((wv[0] - sm[0]) * x + (wv[1] - sm[1]) * y) / rr); a = 235;
        }
      }
    } else if (LAYER === 'ir') {
      [r, g, b] = Hurricane.irColor(F.ir(s)); a = 255;
    } else if (LAYER === 'wind') {
      const c = Hurricane.windColor(F.w10(s) / Hurricane.KT); if (c) [r, g, b, a] = c;
    } else if (LAYER === 'mslp') {
      const p = p0 + F.pp(s);
      [r, g, b, a] = Hurricane.pColor(p);
      // isobars every 4 hPa
      const bin = Math.floor(p / 4);
      if ((i > 0 && Math.floor((p0 + F.pp(s - 1)) / 4) !== bin) || (j > 0 && Math.floor((p0 + F.pp(s - W)) / 4) !== bin)) { r = g = b = 15; a = 200; }
    } else if (LAYER === 'thp') {
      const t = F.thp(s);
      const u = clamp(t / 10, -1, 1);
      if (u < 0) { r = 40; g = 90 + 60 * (1 + u); b = 255; a = 200 * Math.min(1, -u * 1.6); } else { r = 255; g = 140; b = 40; a = 200 * Math.min(1, u * 1.6); }
      const z = F.comp(s); if (z >= 30) { r = r * 0.4 + 200 * 0.6; g = g * 0.4 + 200 * 0.6; b = b * 0.4 + 200 * 0.6; a = Math.max(a, 140); }
    } else if (LAYER === 'uh') {
      const u = F.uh(s);
      if (u > 25) { const q = clamp((u - 25) / 300, 0, 1); r = 255; g = 220 * (1 - q); b = 60 * (1 - q); a = 120 + 130 * q; }
      else { const z = F.comp(s); if (z >= 20) { r = g = b = 120; a = 110; } }
    } else if (LAYER === 'wmax') {
      const w = F.w(s);
      if (w > 2) { const q = clamp((w - 2) / 50, 0, 1); r = 255 * q; g = 80 + 175 * (1 - q); b = 255 * (1 - q); a = 90 + 160 * q; }
    }
    d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
  }
  ctx.putImageData(img, 0, 0);
  FIELD.ok = true;
}
let drawQueued = false;
function draw() { if (drawQueued) return; drawQueued = true; requestAnimationFrame(() => { drawQueued = false; drawNow(); }); setTimeout(() => { if (drawQueued) { drawQueued = false; drawNow(); } }, 120); }
function drawNow() {
  const c = $('map'), ctx = c.getContext('2d');
  ctx.setTransform(VIEW.dpr, 0, 0, VIEW.dpr, 0, 0);
  ctx.fillStyle = '#0b0e13'; ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  if (!GEO) return;
  const [hx, hy] = domHalf();
  // model field
  if (FIELD.ok && RUN.state !== 'setup') {
    const [x0, y0] = toScr(-hx, hy), [x1, y1] = toScr(hx, -hy);
    ctx.imageSmoothingEnabled = LAYER === 'ir' || VIEW.s * gridSpec().dx < 3;
    ctx.drawImage(FIELD.canvas, x0, y0, x1 - x0, y1 - y0);
  }
  // map lines
  const vw = toWorld(0, VIEW.h), ve = toWorld(VIEW.w, 0);
  const strokeRings = (rings, color, width) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    for (const r of rings) {
      if (r.bb[2] < vw[0] || r.bb[0] > ve[0] || r.bb[3] < vw[1] || r.bb[1] > ve[1]) continue;
      const a = r.a;
      for (let i = 0; i < a.length; i += 2) { const [px, py] = toScr(a[i], a[i + 1]); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
    }
    ctx.stroke();
  };
  if (PROJ) {
    if (VIEW.s > 1 / 2600) strokeRings(PROJ.counties, 'rgba(120,135,155,0.28)', 0.6);
    strokeRings(PROJ.states, 'rgba(170,185,205,0.75)', 1.1);
  }
  // domain + sponge
  {
    const [x0, y0] = toScr(-hx, hy), [x1, y1] = toScr(hx, -hy);
    ctx.setLineDash([6, 4]); ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1.2; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.setLineDash([]);
    const sp = (MODEL ? MODEL.params.spongeW : 36000) * VIEW.s;
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.strokeRect(x0 + sp, y0 + sp, x1 - x0 - 2 * sp, y1 - y0 - 2 * sp);
  }
  // cities
  if (VIEW.s > 1 / 3000) {
    ctx.font = '11px Segoe UI'; ctx.fillStyle = 'rgba(210,215,225,0.8)';
    const minPop = VIEW.s > 1 / 900 ? 25000 : VIEW.s > 1 / 1800 ? 80000 : 250000;
    for (const ct of CITIES) {
      if (ct.pop < minPop) continue;
      const [px, py] = toScr(ct.x, ct.y);
      if (px < -50 || py < -20 || px > VIEW.w + 50 || py > VIEW.h + 20) continue;
      ctx.fillRect(px - 1.5, py - 1.5, 3, 3); ctx.fillText(ct.name, px + 4, py - 3);
    }
  }
  drawBounds(ctx);
  drawRadars(ctx);
  drawEvents(ctx);
  drawTornadoes(ctx);
  if (isHur()) drawHurricane(ctx);
  drawLegend();
}
// the hurricane symbol: a disc with two curved arms (reversed in the southern hemisphere)
function hurSymbol(ctx, px, py, col, sz, major) {
  const sh = (CFG.hur.lat < 0) ? -1 : 1;
  ctx.save(); ctx.translate(px, py); ctx.scale(1, sh);
  ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.fillStyle = col;
  for (const a of [0, Math.PI]) {
    ctx.save(); ctx.rotate(a); ctx.beginPath(); ctx.moveTo(0, -sz * 0.55);
    ctx.quadraticCurveTo(sz * 1.15, -sz * 0.9, sz * 1.25, sz * 0.15); ctx.quadraticCurveTo(sz * 0.75, -sz * 0.35, 0, -sz * 0.05);
    ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
  }
  ctx.beginPath(); ctx.arc(0, 0, sz * 0.6, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
  ctx.fillStyle = major ? '#000' : 'rgba(0,0,0,0.75)'; ctx.beginPath(); ctx.arc(0, 0, sz * 0.22, 0, 2 * Math.PI); ctx.fill();
  ctx.restore();
}
function drawHurricane(ctx) {
  const H = CFG.hur, HT = Hurricane.T;
  const clusterRing = (x, y, label) => {
    const [px, py] = toScr(x, y);
    ctx.save(); ctx.setLineDash([3, 5]); ctx.strokeStyle = 'rgba(255,160,90,0.9)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, H.clusterKm * 1000 * VIEW.s, 0, 2 * Math.PI); ctx.stroke(); ctx.restore();
    ctx.font = 'bold 12px Segoe UI'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.fillStyle = '#ffb070';
    ctx.strokeText(label, px + 10, py - 8); ctx.fillText(label, px + 10, py - 8);
    ctx.strokeStyle = '#ffb070'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px - 6, py - 6); ctx.lineTo(px + 6, py + 6); ctx.moveTo(px + 6, py - 6); ctx.lineTo(px - 6, py + 6); ctx.stroke();
    return [px, py];
  };
  if (RUN.state === 'setup' && H.start === 'cluster') {
    const [x, y] = GEO.fwd(H.lat, H.lon);
    const [px, py] = clusterRing(x, y, `convective cluster ${H.cellRate}/h for ${H.seedHours} h${H.mcvKt > 0 ? ` · ${H.mcvKt} kt mid-level vortex` : ''}`);
    const d = H.steerKt * Hurricane.KT * 86400, [qx, qy] = toScr(x + d * Math.sin(H.steerDir * DEG), y + d * Math.cos(H.steerDir * DEG));
    ctx.strokeStyle = 'rgba(255,220,120,0.9)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(qx, qy); ctx.stroke();
    return;
  }
  if (RUN.state !== 'setup' && RUN.genesis && !HT.formed) {
    const t = dispTime(), [gx, gy] = genesisCentre(Math.min(t, RUN.genesis.until));
    clusterRing(gx - GEO.Lx / 2, gy - GEO.Ly / 2, t < RUN.genesis.until ? 'disturbance (seeding)' : 'disturbance');
    return;
  }
  if (RUN.state === 'setup') {
    const [x, y] = GEO.fwd(H.lat, H.lon), [px, py] = toScr(x, y);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(px, py, H.rmwKm * 1000 * VIEW.s, 0, 2 * Math.PI); ctx.stroke();
    ctx.setLineDash([6, 5]); ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath(); ctx.arc(px, py, H.r0Km * 1000 * VIEW.s, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
    // 24 h of the steering flow
    const d = H.steerKt * Hurricane.KT * 86400, ax = x + d * Math.sin(H.steerDir * DEG), ay = y + d * Math.cos(H.steerDir * DEG), [qx, qy] = toScr(ax, ay);
    ctx.strokeStyle = 'rgba(255,220,120,0.9)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(qx, qy); ctx.stroke();
    const an = Math.atan2(qy - py, qx - px);
    ctx.fillStyle = 'rgba(255,220,120,0.9)'; ctx.beginPath(); ctx.moveTo(qx, qy);
    ctx.lineTo(qx - 11 * Math.cos(an - 0.4), qy - 11 * Math.sin(an - 0.4)); ctx.lineTo(qx - 11 * Math.cos(an + 0.4), qy - 11 * Math.sin(an + 0.4)); ctx.closePath(); ctx.fill();
    const ci = Hurricane.catIndex(H.vmaxKt);
    hurSymbol(ctx, px, py, Hurricane.CATS[ci].color, 11, ci >= 4);
    ctx.font = 'bold 12px Segoe UI'; ctx.fillStyle = '#fff'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    const lbl = `start ${Hurricane.CATS[ci].short} ${H.vmaxKt} kt`;
    ctx.strokeText(lbl, px + 16, py - 10); ctx.fillText(lbl, px + 16, py - 10);
    return;
  }
  const tNow = dispTime(), pts = HT.track.filter(q => q.t <= tNow + 1);
  if (pts.length) {
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.beginPath();
    pts.forEach((q, i) => { const [px, py] = toScr(q.x - GEO.Lx / 2, q.y - GEO.Ly / 2); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
    ctx.stroke();
    // a dot every 6 h in the category colour, labelled every 12 h
    ctx.font = '11px Segoe UI';
    for (const q of pts) {
      if (q.t % 21600 > 1) continue;
      const [px, py] = toScr(q.x - GEO.Lx / 2, q.y - GEO.Ly / 2), c = Hurricane.CATS[Hurricane.catIndex(q.kt)];
      ctx.fillStyle = c.color; ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(px, py, 5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      if (q.t % 43200 < 1) {
        const lbl = `${new Date(RUN.epoch0 + q.t * 1000).toISOString().slice(8, 13).replace('T', '/')}Z ${q.kt.toFixed(0)} kt ${q.p.toFixed(0)}`;
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.strokeText(lbl, px + 8, py + 4); ctx.fillStyle = '#fff'; ctx.fillText(lbl, px + 8, py + 4);
      }
    }
  }
  const cur = REPLAY.idx >= 0 ? pts[pts.length - 1] : HT.cur;
  if (cur) {
    const [px, py] = toScr(cur.x - GEO.Lx / 2, cur.y - GEO.Ly / 2), ci = Hurricane.catIndex(cur.kt);
    hurSymbol(ctx, px, py, Hurricane.CATS[ci].color, 12, ci >= 4);
    ctx.font = 'bold 12px Segoe UI'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.fillStyle = '#fff';
    const lbl = `${Hurricane.CATS[ci].short} · ${cur.kt.toFixed(0)} kt · ${cur.p.toFixed(0)} hPa`;
    ctx.strokeText(lbl, px + 18, py - 12); ctx.fillText(lbl, px + 18, py - 12);
  }
}
// the storm motion the storm-relative velocity subtracts: the hurricane's track over the last 3 h (or its steering
// flow early on), else the sounding's Bunkers right mover
function stormMotion() {
  if (isHur()) {
    const tr = Hurricane.T.track, b = tr[tr.length - 1];
    const a = b && tr.slice().reverse().find(q => b.t - q.t >= 10800);
    if (a) return [(b.x - a.x) / (b.t - a.t), (b.y - a.y) / (b.t - a.t)];
    const H = CFG.hur; return [H.steerKt * Hurricane.KT * Math.sin(H.steerDir * DEG), H.steerKt * Hurricane.KT * Math.cos(H.steerDir * DEG)];
  }
  return SND.A ? SND.A.rm : [0, 0];
}
// after each map readback: the storm's centre, intensity and category, landfalls, and a track point every 30 min
function hurricaneUpdate(m) {
  const HT = Hurricane.T, G = RUN.genesis;
  // where to look: around the storm once there is one; around the drifting cluster while it develops
  const near = HT.formed || !G ? (HT.cur ? { x: HT.cur.x, y: HT.cur.y, r: 300000 } : null)
    : (() => { const [x, y] = genesisCentre(m.t); return { x, y, r: G.r + 150000 }; })();
  const a = Hurricane.analyze(m, MODEL, MODEL.base.sfcP, RUN.surf, near); if (!a) return;
  HT.cur = a;
  if (G && !HT.formed) {
    // genesis: a tropical depression once there is a closed surface circulation (ring-mean tangential wind ≥ 5 m/s)
    // with depression-strength winds (≥ 25 kt) and a low (≥ 2 hPa), held for an hour; until then it is a disturbance
    // and the model's storm-relative settings follow the cluster
    if (MODEL.hur) MODEL.hur.centre = near ? [near.x, near.y] : [a.x, a.y];
    const ok = a.ring >= 5 && a.kt >= 25 && a.p <= MODEL.base.sfcP - 2;
    if (!ok) { HT.formT = -1; return; }
    if (HT.formT < 0) HT.formT = a.t;
    if (a.t - HT.formT < 3600) return;
    HT.formed = true;
    logMsg(`TROPICAL DEPRESSION formed ${nearestCity(GEO.fromModel(a.x, a.y))} at ${new Date(RUN.epoch0 + a.t * 1000).toISOString().slice(5, 16).replace('T', ' ')}Z, ${(a.t / 3600).toFixed(1)} h in: ${a.kt.toFixed(0)} kt, ${a.p.toFixed(0)} hPa, closed circulation ${(a.ring / Hurricane.KT).toFixed(0)} kt (${G.n} storm starts in the cluster)`);
  }
  if (MODEL.hur) {
    MODEL.hur.centre = [a.x, a.y];         // the model's storm-relative settings follow the storm
    // the trigger thermals are only for getting convection going: they fade out as the storm strengthens (35–55 kt),
    // or they keep setting off convection in its light-wind eye
    if (MODEL.hur.thermalFade) MODEL.hur.thermalScale = 1 - smooth(35, 55, a.kt);
  }
  const ci = Hurricane.catIndex(a.kt), when = new Date(RUN.epoch0 + a.t * 1000).toISOString().slice(5, 16).replace('T', ' ') + 'Z';
  if (!HT.peak || a.kt > HT.peak.kt) HT.peak = a;
  // a category change counts once it has held for 20 minutes, and a downgrade only 4 kt below the threshold (no
  // flip-flopping on a storm that sits at it)
  const hold = HT.lastCat >= 0 && ci === HT.lastCat - 1 && a.kt >= Hurricane.CATS[HT.lastCat].min - 4;
  if (ci !== HT.lastCat && !hold) {
    if (HT.pendCat !== ci) { HT.pendCat = ci; HT.pendT = a.t; }
    else if (a.t - HT.pendT >= 1200 || HT.lastCat < 0) {
      const up = ci > HT.lastCat;
      if (HT.lastCat >= 0) logMsg(`${up ? '▲' : '▼'} ${Hurricane.CATS[ci].name}: ${a.kt.toFixed(0)} kt, ${a.p.toFixed(0)} hPa at ${when}`);
      HT.lastCat = ci;
    }
  } else HT.pendCat = ci;
  // near the domain's edge a vortex drifts along it (like a vortex by a wall) and is worn down by the sponge: say so
  const edge = Math.min(a.x, a.y, MODEL.Lx - a.x, MODEL.Ly - a.y) - MODEL.params.spongeW;
  if (edge < 200000 && !HT.edgeWarned) { HT.edgeWarned = true; logMsg(`the storm is ${(edge / 1000).toFixed(0)} km from the domain's sponge: from here on its track and intensity are distorted by the edge (a larger domain, or one placed further along its track, avoids this)`); }
  const onLand = a.land > 0.5;
  if (onLand && !HT.overLand) { HT.landfalls++; logMsg(`LANDFALL ${nearestCity(GEO.fromModel(a.x, a.y))} at ${when}: ${Hurricane.CATS[ci].name}, ${a.kt.toFixed(0)} kt, ${a.p.toFixed(0)} hPa`); }
  HT.overLand = onLand;
  const slot = Math.floor(a.t / 1800) * 1800, last = HT.track[HT.track.length - 1];
  if (!last || slot > last.t) HT.track.push(Object.assign({}, a, { t: slot }));
}
function hurStatus() {
  const c = Hurricane.T.cur; if (!c) return '';
  if (RUN.genesis && !Hurricane.T.formed) return `<span><b style="color:#9fb4c8">Disturbance</b> (convective cluster, ${RUN.genesis.n} storm starts${MODEL.time < RUN.genesis.until ? '' : ', seeding over'}) · lowest ${c.p.toFixed(1)} hPa · winds ${c.kt.toFixed(0)} kt · circulation ${(c.ring / Hurricane.KT).toFixed(0)} kt (a depression needs ≥ 10 kt, 25 kt winds and a 2 hPa low for an hour)</span>`;
  const k = Hurricane.CATS[Hurricane.catIndex(c.kt)], m = stormMotion(), spd = Math.hypot(m[0], m[1]) / Hurricane.KT;
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const dir = dirs[Math.round(((Math.atan2(m[0], m[1]) / DEG + 360) % 360) / 22.5) % 16];
  return `<span><b style="color:${k.color}">${k.name}</b> · <b>${c.kt.toFixed(0)}</b> kt · <b>${c.p.toFixed(0)}</b> hPa · RMW ${(c.rmw / 1000).toFixed(0)} km · moving ${dir} ${spd.toFixed(0)} kt${Hurricane.T.peak ? ` · peak ${Hurricane.T.peak.kt.toFixed(0)} kt / ${Hurricane.T.peak.p.toFixed(0)} hPa` : ''}</span>`;
}
function boundaryXY(b, tSim, vel) {
  const mo = bndMotion(b);
  return b.pts.map((p, i) => { const [x, y] = GEO.fwd(p[0], p[1]); const v = (vel && vel[i]) || mo; return [x + v[0] * tSim, y + v[1] * tSim]; });
}
function drawBounds(ctx) {
  const tSim = RUN.state === 'setup' || !MODEL ? 0 : dispTime();
  const lows = findLows(), BV = tSim > 0 ? boundaryVels(lows) : null;
  const all = CFG.bounds.slice();
  if (EDIT.draft && EDIT.draft.pts.length) all.push(Object.assign(mkBound(EDIT.draft.type, EDIT.draft.pts), { id: 'draft' }));
  for (const b of all) {
    const T = BND_TYPES[b.type];
    const xy = boundaryXY(b, b.id === 'draft' ? 0 : tSim, BV && BV[CFG.bounds.indexOf(b)]);
    const sp = xy.map(p => toScr(p[0], p[1]));
    if (sp.length < 1) continue;
    const sel = EDIT.sel === b.id;
    ctx.strokeStyle = T.color; ctx.lineWidth = sel ? 3.2 : 2.4;
    if (b.type === 'outflow') ctx.setLineDash([10, 5]);
    if (b.type === 'dry') ctx.setLineDash([2, 0]);
    ctx.beginPath(); sp.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.stroke(); ctx.setLineDash([]);
    if (sp.length >= 2) {
      // symbols on the warm side (cold fronts, drylines, outflow) or the cool side (warm fronts)
      const side = bndSide(b, xy);
      const symSide = b.type === 'warm' ? side : -side;
      let acc = 0; const step = 34;
      for (let i = 0; i < sp.length - 1; i++) {
        const a = sp[i], e = sp[i + 1], L = Math.hypot(e[0] - a[0], e[1] - a[1]);
        if (L < 1) continue;
        const ux = (e[0] - a[0]) / L, uy = (e[1] - a[1]) / L;
        // screen y is flipped: the left normal of (ux, uy) in world is (−uy, ux) → on screen (uy, ux)... use world-consistent normal
        const nx = uy * symSide, ny = -ux * symSide;
        let s = (step - acc) % step;
        for (; s < L; s += step) {
          const px = a[0] + ux * s, py = a[1] + uy * s;
          ctx.fillStyle = T.color;
          ctx.beginPath();
          const kind = b.type === 'stat' ? (Math.floor((acc + s) / step) % 2 ? 'semi' : 'tri') : b.type === 'warm' ? 'semi' : b.type === 'dry' ? 'scal' : 'tri';
          const flipStat = b.type === 'stat' && kind === 'semi' ? -1 : 1;
          const qx = nx * flipStat, qy = ny * flipStat;
          if (kind === 'tri') { ctx.moveTo(px - ux * 7, py - uy * 7); ctx.lineTo(px + ux * 7, py + uy * 7); ctx.lineTo(px + qx * 9, py + qy * 9); ctx.closePath(); ctx.fill(); }
          else if (kind === 'semi') { const ang = Math.atan2(uy, ux); ctx.arc(px, py, 6.5, ang, ang + Math.PI, qx * (-uy) + qy * ux > 0 ? false : true); ctx.closePath(); ctx.fillStyle = b.type === 'stat' ? '#ff4a4a' : T.color; ctx.fill(); }
          else { const ang = Math.atan2(uy, ux); ctx.lineWidth = 2; ctx.strokeStyle = T.color; ctx.arc(px, py, 6, ang, ang + Math.PI, qx * (-uy) + qy * ux > 0 ? false : true); ctx.stroke(); }
        }
        acc = (acc + L) % step;
      }
      // shade a strip on the other air mass side
      const o = side;
      ctx.strokeStyle = T.color + '33'; ctx.lineWidth = 14;
      ctx.beginPath();
      sp.forEach((p, i) => {
        const q = sp[Math.min(i + 1, sp.length - 1)], r0 = sp[Math.max(i - 1, 0)];
        const tx = q[0] - r0[0], ty = q[1] - r0[1], L = Math.hypot(tx, ty) || 1;
        const px = p[0] + (ty / L) * o * 9, py = p[1] - (tx / L) * o * 9;
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      });
      ctx.stroke();
    }
    if (TOOL.cur === 'edit' || b.id === 'draft' || sel) {
      ctx.fillStyle = '#fff';
      for (const p of sp) ctx.fillRect(p[0] - 3, p[1] - 3, 6, 6);
    }
  }
  // surface lows: a red L where fronts meet
  ctx.font = 'bold 26px Segoe UI'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  for (const L of lows) {
    if (!L.front) continue;
    const m = lowMotion(L), [px, py] = toScr(L.x + m[0] * tSim, L.y + m[1] * tSim);
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.strokeText('L', px, py);
    ctx.fillStyle = '#ff3b30'; ctx.fillText('L', px, py);
  }
  ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'miter';
}
function drawRadars(ctx) {
  ctx.font = '11px Segoe UI';
  const [hx, hy] = domHalf();
  for (const s of SITES) {
    if (s.x === undefined) continue;
    const [px, py] = toScr(s.x, s.y);
    if (px < -400 || py < -400 || px > VIEW.w + 400 || py > VIEW.h + 400) continue;
    const on = CFG.radars.includes(s.id);
    if (!on && (Math.abs(s.x) > hx + 460000 || Math.abs(s.y) > hy + 460000)) continue;
    ctx.fillStyle = on ? '#ffd24a' : 'rgba(170,180,200,0.7)';
    ctx.fillRect(px - (on ? 4 : 2.5), py - (on ? 4 : 2.5), on ? 8 : 5, on ? 8 : 5);
    if (on || VIEW.s > 1 / 2200) { ctx.fillStyle = on ? '#ffd24a' : 'rgba(170,180,200,0.7)'; ctx.fillText(s.id, px + 6, py + 4); }
    if (on) {
      ctx.strokeStyle = 'rgba(255,210,74,0.35)'; ctx.lineWidth = 1;
      for (const r of [230000, 460000]) { ctx.beginPath(); ctx.arc(px, py, r * VIEW.s, 0, 2 * Math.PI); ctx.stroke(); }
    }
  }
}
function drawEvents(ctx) {
  const t = MODEL && RUN.state !== 'setup' ? dispTime() : 0;
  if (RUN.state === 'setup') {
    for (const m of CFG.manual) { const [x, y] = GEO.fwd(m.lat, m.lon); const [px, py] = toScr(x, y); ctx.strokeStyle = '#ff9d2e'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, 7, 0, 2 * Math.PI); ctx.stroke(); }
    return;
  }
  for (const e of RUN.events) {
    if (t < e.t0) continue;
    const active = t >= e.t0 && t <= e.t1;
    if (!active && t - e.t1 > 1800) continue;
    const [ex, ey] = towerPos(e, t);
    const [px, py] = toScr(ex - GEO.Lx / 2, ey - GEO.Ly / 2);
    ctx.strokeStyle = active ? '#ff9d2e' : 'rgba(255,157,46,0.3)'; ctx.lineWidth = active ? 2 : 1;
    ctx.beginPath(); ctx.arc(px, py, Math.max(4, e.rh * VIEW.s), 0, 2 * Math.PI); ctx.stroke();
  }
}
function drawTornadoes(ctx) {
  if (RUN.state === 'setup') return;
  ctx.font = 'bold 11px Segoe UI';
  // in replay: the tornadoes as they were in that frame
  const f = REPLAY.idx >= 0 ? REPLAY.frames[REPLAY.idx] : null;
  const list = !f ? TOR.list : f.tor.map(([id, x, y, ef, act, n]) => { const T = TOR.list.find(q => q.id === id); return T && { ef, x, y, done: !act, track: T.track.slice(0, n) }; }).filter(Boolean);
  for (const T of list) {
    if (T.track.length > 1) {
      ctx.strokeStyle = T.done ? 'rgba(255,80,80,0.55)' : '#ff3030'; ctx.lineWidth = 1 + 0.6 * T.ef; ctx.beginPath();
      T.track.forEach((p, i) => { const [px, py] = toScr(p[0] - GEO.Lx / 2, p[1] - GEO.Ly / 2); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
      if (!T.done) { const [px, py] = toScr(T.x - GEO.Lx / 2, T.y - GEO.Ly / 2); ctx.lineTo(px, py); }
      ctx.stroke();
    }
    if (T.done) continue;
    const [px, py] = toScr(T.x - GEO.Lx / 2, T.y - GEO.Ly / 2);
    ctx.fillStyle = '#ff2020'; ctx.beginPath(); ctx.moveTo(px - 7, py - 7); ctx.lineTo(px + 7, py - 7); ctx.lineTo(px, py + 6); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText('EF' + T.ef, px + 8, py - 4);
  }
}
function drawLegend() {
  const L = $('legend');
  if (RUN.state === 'setup') { L.innerHTML = '<span style="color:var(--dim)">Set up the event, then Start</span>'; return; }
  if (LAYER === 'comp' || LAYER === 'low') {
    if (L.dataset.k === 'dbz') return; L.dataset.k = 'dbz';
    L.innerHTML = `${LAYER === 'comp' ? 'Composite' : '1 km'} reflectivity (dBZ)<div class="bar">${DBZ_COLORS.map(c => `<span style="background:${c}"></span>`).join('')}</div><div class="ticks"><span>5</span><span>20</span><span>35</span><span>50</span><span>65</span><span>75</span></div>`;
  } else if (LAYER === 'vel' || LAYER === 'srv') {
    const k = LAYER + ':' + VEL.site; if (L.dataset.k === k) return; L.dataset.k = k;
    const sm = stormMotion(), spd = Math.hypot(sm[0], sm[1]) / 0.5144, dir = (Math.atan2(sm[0], sm[1]) / DEG + 360) % 360;
    L.innerHTML = `${LAYER === 'srv' ? 'Storm-relative' : 'Radial'} velocity from <b>${VEL.site || 'no radar'}</b> (m/s, + away)${LAYER === 'srv' ? `<br>storm motion toward ${dir.toFixed(0)}° at ${spd.toFixed(0)} kt (${isHur() ? 'the hurricane’s track' : 'Bunkers right mover'})` : ''}<div class="bar">${VEL_C.map(c => `<span style="background:rgb(${c})"></span>`).join('')}</div><div class="ticks"><span>−40</span><span>−20</span><span>−5</span><span>0</span><span>5</span><span>20</span><span>40</span></div>`;
  } else if (LAYER === 'ir') {
    if (L.dataset.k === 'ir') return; L.dataset.k = 'ir';
    const ts = []; for (let t = 40; t >= -90; t -= 2.5) ts.push(t);
    L.innerHTML = `Simulated infrared (cloud-top brightness temperature, °C), SatPainter / Tropical Tidbits colours<div class="bar">${ts.map(t => `<span style="background:rgb(${Hurricane.irColor(t).map(Math.round)})"></span>`).join('')}</div><div class="ticks"><span>40</span><span>10</span><span>−25</span><span>−57</span><span>−90</span></div>`;
  } else if (LAYER === 'wind') {
    if (L.dataset.k === 'wind') return; L.dataset.k = 'wind';
    L.innerHTML = 'Surface wind (~10 m, kt), Saffir–Simpson colours<div class="bar">' + [25, 40, 70, 88, 100, 120, 140].map(k => `<span style="background:rgb(${Hurricane.windColor(k).slice(0, 3).map(Math.round)})"></span>`).join('') + '</div><div class="ticks"><span>20</span><span>TS 34</span><span>C1 64</span><span>C3 96</span><span>C5 137</span></div>';
  } else if (LAYER === 'mslp') {
    if (L.dataset.k === 'mslp') return; L.dataset.k = 'mslp';
    L.innerHTML = 'Sea-level pressure (hPa), isobars every 4 hPa<div class="bar">' + [1012, 1004, 996, 985, 972, 958, 942, 928, 905].map(p => `<span style="background:rgb(${Hurricane.pColor(p).slice(0, 3).map(Math.round)})"></span>`).join('') + '</div><div class="ticks"><span>1012</span><span>996</span><span>972</span><span>942</span><span>905</span></div>';
  } else { L.dataset.k = ''; L.textContent = { thp: 'Surface θ′ vs warm sector: blue cold, orange warm (±10 K)', uh: '2–5 km updraft helicity > 25 m²/s²', wmax: 'Max updraft 2–52 m/s' }[LAYER]; }
}

// ─── map interaction ───────────────────────────────────────────────────────
// boundaries can only be edited before the run, so these work on the t = 0 geometry
function hitVertex(px, py) {
  for (const b of CFG.bounds) {
    const xy = boundaryXY(b, 0);
    for (let i = 0; i < xy.length; i++) { const [sx, sy] = toScr(xy[i][0], xy[i][1]); if (Math.hypot(sx - px, sy - py) < 8) return { b, i, group: vertexGroup(b, i) }; }
  }
  return null;
}
// the vertex and the other boundaries' vertices joined to it (within 8 km: a surface low), which move with it
function vertexGroup(b0, i0) {
  const [x0, y0] = GEO.fwd(b0.pts[i0][0], b0.pts[i0][1]), g = [{ b: b0, i: i0 }];
  for (const b of CFG.bounds) {
    if (b === b0) continue;
    let bi = -1, bd = 8000;
    b.pts.forEach((p, i) => { const [x, y] = GEO.fwd(p[0], p[1]); const d = Math.hypot(x - x0, y - y0); if (d < bd) { bd = d; bi = i; } });
    if (bi >= 0) g.push({ b, i: bi });
  }
  return g;
}
function hitLine(px, py) {
  for (const b of CFG.bounds) {
    const sp = boundaryXY(b, 0).map(p => toScr(p[0], p[1]));
    for (let i = 0; i < sp.length - 1; i++) {
      const a = sp[i], e = sp[i + 1], abx = e[0] - a[0], aby = e[1] - a[1], l2 = Math.max(abx * abx + aby * aby, 1);
      const t = clamp(((px - a[0]) * abx + (py - a[1]) * aby) / l2, 0, 1);
      if (Math.hypot(px - (a[0] + t * abx), py - (a[1] + t * aby)) < 6) return b;
    }
  }
  return null;
}
// start dragging whole boundaries: remember their points (projected) and the grab point
function dragBounds(bounds, px, py) {
  return { kind: 'move', bounds, start: toWorld(px, py), orig: bounds.map(b => b.pts.map(p => GEO.fwd(p[0], p[1]))) };
}
function setupMap() {
  const c = $('map');
  let down = null;
  c.addEventListener('contextmenu', e => e.preventDefault());
  c.addEventListener('wheel', e => {
    e.preventDefault();
    const r = c.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    const [wx, wy] = toWorld(px, py);
    VIEW.s = clamp(VIEW.s * Math.pow(1.0015, -e.deltaY), 1 / 12000, 1 / 60);
    const [nx, ny] = toWorld(px, py); VIEW.cx += wx - nx; VIEW.cy += wy - ny;
    draw();
  }, { passive: false });
  c.addEventListener('mousedown', e => {
    const r = c.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    down = { px, py, cx: VIEW.cx, cy: VIEW.cy, btn: e.button, moved: false, lat: CFG.center.lat, lon: CFG.center.lon };
    if (e.button === 2 && TOOL.cur === 'edit') {
      const h = hitVertex(px, py);
      if (h && h.b.pts.length > 2 && RUN.state === 'setup') { h.b.pts.splice(h.i, 1); saveCfg(); draw(); }
      down = null; return;
    }
    if (e.button === 0 && TOOL.cur === 'edit' && RUN.state === 'setup') {
      const h = hitVertex(px, py);
      // the L (where boundaries meet) carries its fronts along; Shift-drag moves only the meeting point
      if (h && h.group.length > 1 && !e.shiftKey) { EDIT.drag = dragBounds([...new Set(h.group.map(g => g.b))], px, py); EDIT.sel = h.b.id; renderBounds(); }
      else if (h) { EDIT.drag = { kind: 'vertex', group: h.group }; EDIT.sel = h.b.id; renderBounds(); }
      else { const b = hitLine(px, py); if (b) { EDIT.drag = dragBounds([b], px, py); EDIT.sel = b.id; renderBounds(); } }
    }
    if (e.button === 0 && TOOL.cur === 'movebnd' && RUN.state === 'setup' && CFG.bounds.length) EDIT.drag = dragBounds(CFG.bounds.slice(), px, py);
    if (e.button === 0 && TOOL.cur === 'hur' && RUN.state === 'setup') { EDIT.drag = { kind: 'hur' }; placeHurricane(px, py); }
  });
  window.addEventListener('mousemove', e => {
    if (!down) return;
    const r = c.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    if (Math.hypot(px - down.px, py - down.py) > 3) down.moved = true;
    if (EDIT.drag && EDIT.drag.kind === 'hur') { placeHurricane(px, py); return; }
    if (EDIT.drag) {
      const D = EDIT.drag, [wx, wy] = toWorld(px, py);
      if (D.kind === 'vertex') { const ll = GEO.inv(wx, wy); for (const g of D.group) g.b.pts[g.i] = ll.slice(); }
      else { const ddx = wx - D.start[0], ddy = wy - D.start[1]; D.bounds.forEach((b, k) => { b.pts = D.orig[k].map(q => GEO.inv(q[0] + ddx, q[1] + ddy)); }); }
      draw(); return;
    }
    if (TOOL.cur === 'domain' && down.btn === 0 && RUN.state === 'setup') {
      // drag the domain: move its centre by the drag vector
      const dxm = (px - down.px) / VIEW.s, dym = -(py - down.py) / VIEW.s;
      const g0 = new Geo(down.lat, down.lon);
      const [la, lo] = g0.inv(dxm, dym);
      CFG.center = { lat: la, lon: lo };
      updateGeoThrottled();
      return;
    }
    if (down.btn === 0 || down.btn === 1 || down.btn === 2) { VIEW.cx = down.cx - (px - down.px) / VIEW.s; VIEW.cy = down.cy + (py - down.py) / VIEW.s; draw(); }
  });
  window.addEventListener('mouseup', e => {
    if (!down) return;
    const r = c.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    const d = down; down = null;
    if (EDIT.drag && EDIT.drag.kind === 'hur') { EDIT.drag = null; saveCfg(); return; }
    if (EDIT.drag) {
      const D = EDIT.drag; EDIT.drag = null;
      // dropping a boundary end on another boundary's vertex joins them there (a surface low)
      if (D.kind === 'vertex') {
        const inG = (b, i) => D.group.some(g => g.b === b && g.i === i);
        let hit = null, bd = 10;
        for (const b of CFG.bounds) {
          if (D.group.some(g => g.b === b)) continue;
          b.pts.forEach((q, i) => { if (inG(b, i)) return; const [x, y] = GEO.fwd(q[0], q[1]); const sc = toScr(x, y); const dd = Math.hypot(sc[0] - px, sc[1] - py); if (dd < bd) { bd = dd; hit = q; } });
        }
        if (hit) for (const g of D.group) g.b.pts[g.i] = hit.slice();
      }
      saveCfg(); renderBounds(); draw(); return;
    }
    if (TOOL.cur === 'domain' && d.btn === 0) { regeoKeepView(); saveCfg(); return; }
    if (d.moved || d.btn !== 0) return;
    const [wx, wy] = toWorld(px, py);
    if (TOOL.cur === 'radar') {
      let best = null, bd = 12;
      for (const s of SITES) { if (s.x === undefined) continue; const [sx, sy] = toScr(s.x, s.y); const dd = Math.hypot(sx - px, sy - py); if (dd < bd) { bd = dd; best = s; } }
      if (best && RUN.state === 'setup') { CFG.radars = CFG.radars.includes(best.id) ? CFG.radars.filter(x => x !== best.id) : CFG.radars.concat(best.id); saveCfg(); renderRadars(); draw(); }
      else if (best) showError('Radars can only be changed before the run starts.');
    } else if (TOOL.cur.startsWith('draw:') && RUN.state === 'setup') {
      EDIT.draft.pts.push(GEO.inv(wx, wy)); draw();
    } else if (TOOL.cur === 'storm') {
      const [la, lo] = GEO.inv(wx, wy);
      // storm starts have to keep clear of the edge sponge (a storm there is erased, and one right at the edge used
      // to blow up the edge pressure)
      const edge = Math.min(wx + GEO.Lx / 2, GEO.Lx / 2 - wx, wy + GEO.Ly / 2, GEO.Ly / 2 - wy);
      if (edge < ciMargin()) { showError(`Too close to the edge of the domain: storms have to start at least ${(ciMargin() / 1000).toFixed(0)} km inside it.`); return; }
      if (RUN.state === 'setup') { CFG.manual.push({ lat: la, lon: lo, tMin: 5 }); saveCfg(); const m = $('manualN'); if (m) m.textContent = CFG.manual.length; draw(); }
      else { addEvent(wx + GEO.Lx / 2, wy + GEO.Ly / 2, MODEL.time, 'manual'); draw(); }
    }
  });
  c.addEventListener('dblclick', () => finishDraft());
  window.addEventListener('keydown', e => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.key === 'Enter') finishDraft();
    if (REPLAY.frames.length >= 2 && RUN.state !== 'setup') {
      if (e.key === ' ' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'SELECT') { e.preventDefault(); replayToggle(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); replayStep(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); replayStep(1); }
    }
    if (e.key === 'Escape') { EDIT.draft = null; setTool('pan'); }
  });
  window.addEventListener('resize', resize);
}
function placeHurricane(px, py) {
  const [la, lo] = GEO.inv(...toWorld(px, py));
  CFG.hur.lat = la; CFG.hur.lon = lo;
  const t = $('hurPos'); if (t) t.textContent = `${la.toFixed(2)}°, ${lo.toFixed(2)}°`;
  draw();
}
let geoT = 0;
function regeoKeepView() {
  const ll = GEO.inv(VIEW.cx, VIEW.cy);
  updateGeo();
  const [x, y] = GEO.fwd(ll[0], ll[1]); VIEW.cx = x; VIEW.cy = y;
  draw();
}
function updateGeoThrottled() { const now = performance.now(); if (now - geoT > 120) { geoT = now; regeoKeepView(); } }
function finishDraft() {
  if (!EDIT.draft) return;
  // a double-click also delivers two clicks: drop duplicate trailing points
  const p = EDIT.draft.pts;
  while (p.length >= 2 && Math.abs(p[p.length - 1][0] - p[p.length - 2][0]) < 1e-3 && Math.abs(p[p.length - 1][1] - p[p.length - 2][1]) < 1e-3) p.pop();
  if (p.length >= 2) { const b = mkBound(EDIT.draft.type, p.slice(0, MAX_BPTS)); CFG.bounds.push(b); EDIT.sel = b.id; saveCfg(); renderBounds(); }
  EDIT.draft = { type: EDIT.draft.type, pts: [] };
  draw();
}

// ─── storm-initiation scheduler ────────────────────────────────────────────
let RNG = null;
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function poisson(lam) { let L = Math.exp(-lam), k = 0, p = 1; do { k++; p *= RNG(); } while (p > L && k < 50); return k - 1; }
// A storm start: a 0–3 km updraft push (after Naylor & Gilmore 2012) that moves with the storm (about the Bunkers
// right-mover motion) and grows from a third of its radius and 40 % of its speed to a ~12 km dome, plus satellite
// towers that go up at different times and merge into it, so the first echoes are small cells aloft. Every start is
// drawn at random: the main push's size, strength, growth (10–18 min), length (25–38 min) and motion (±15 %, ±11°),
// and 0–5 satellites of random size, strength, timing and height, scattered over an ellipse of random shape (a round
// cluster … a line of towers) and orientation; along a boundary the ellipse lies roughly along it.
// Tested: a push fixed to the ground is left behind by the storm (a forced, rain-free hole); a push drifting with the
// mean wind, or towers spread outside it, starve the storm (dead within an hour); a full-size flat disk grows one
// round, sharp-edged storm within 10 minutes. So the satellites move with the storm and stay near its footprint.
function uniform(a, b) { return a + (b - a) * RNG(); }
function pickWeighted(w) { let r = RNG() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < w.length; i++) { r -= w[i]; if (r < 0) return i; } return w.length - 1; }
// opts (genesis): {motion: [vx, vy] m/s instead of the Bunkers right mover, rh m, wt m/s}
function towerCluster(x, y, t0, why, axis, opts = {}) {
  const ci = CFG.ci, A = SND.A, rm = opts.motion || (A ? A.rm : [0, 0]);
  const rh = (opts.rh ?? ci.rh) * uniform(0.8, 1.2), wt = (opts.wt ?? ci.wt) * uniform(0.9, 1.1), ramp = uniform(600, 1080), dur = ramp + uniform(900, 1200);
  const sp = Math.hypot(rm[0], rm[1]) * uniform(0.85, 1.15), dm = Math.atan2(rm[1], rm[0]) + uniform(-0.2, 0.2);
  const vx = sp * Math.cos(dm), vy = sp * Math.sin(dm);
  // 0–4 km (not NG12's 0–3 km): the same lift over a deeper layer draws its inflow less violently (a 0–3 km push of
  // this size pulled in a ring of 25–38 m/s surface winds)
  const out = [{ x, y, zc: 2000, rh, rz: 2000, wt, t0, t1: t0 + dur, vx, vy, seed: RNG() * 100, ramp, why }];
  const n = pickWeighted([0.08, 0.17, 0.25, 0.25, 0.15, 0.10]);
  const ang = axis !== undefined ? axis + uniform(-0.4, 0.4) : RNG() * Math.PI;
  const aspect = axis !== undefined ? uniform(1.8, 4) : uniform(1, 3.5);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  for (let k = 0; k < n; k++) {
    // uniform over the ellipse: 0.7 rh along the axis, 0.7 rh / aspect across it
    const r = Math.sqrt(RNG()) * 0.7 * rh, th = RNG() * 2 * Math.PI;
    const a = r * Math.cos(th), b = r * Math.sin(th) / aspect;
    const start = t0 + uniform(0, 600);
    out.push({ x: x + a * ca - b * sa, y: y + a * sa + b * ca, zc: uniform(1600, 2100), rh: rh * uniform(0.25, 0.5), rz: uniform(1500, 1900),
      wt: wt * uniform(0.7, 1.1), t0: start, t1: start + uniform(360, 960), vx, vy, seed: RNG() * 100, ramp: uniform(90, 300), why });
  }
  return out;
}
// how far inside the domain edge storms may start: the edge sponge + the start's push radius + 5 km (the push also
// fades out over the 10 km inside the sponge, so it never forces an updraft into it)
function ciMargin() {
  const L = MODEL && MODEL.Lx ? Math.min(MODEL.Lx, MODEL.Ly) : Math.min(...domSize());
  return clamp(0.08 * L, 5000, 40000) + CFG.ci.rh + 5000;
}
function addEvent(x, y, t0, why, axis, opts) {
  RUN.events.push(...towerCluster(x, y, t0, why, axis, opts));
  MODEL.setCI(RUN.events);
  if (!(opts && opts.quiet)) logMsg(`storm start (${why}) at ${fmtLatLon(GEO.fromModel(x, y))}, t+${(t0 / 60).toFixed(0)} min`);
}
// ─── hurricane genesis: a patch of active convection ──────────────────────────
// Instead of a ready-made vortex, new thunderstorms keep firing in a ~150 km patch of the sea for the first hours
// (the same storm starts as outbreaks, with smaller, gentler tropical pushes), drifting with the 850–500 hPa wind like
// a tropical wave's convection, optionally around a weak mid-level vortex. Whether their heating, merging updrafts
// and outflows organize into a depression is up to the model.
// The cluster follows its mid-level vortex: its centre drifts with the 850–500 hPa wind and is pulled toward the
// centroid of positive ζ at ~5 km nearby (tested: seeded at a point drifting with the wind, the convection and the
// vortex parted ~150 km in 18 h, and nothing could form)
function genesisCentre(t) { const G = RUN.genesis; return [G.x + G.vx * (t - (G.t || 0)), G.y + G.vy * (t - (G.t || 0))]; }
function genesisFollow(m) {
  const G = RUN.genesis; if (!G || !m.m3 || Hurricane.T.formed) return;
  const [cx, cy] = genesisCentre(m.t), nx = MODEL.nx, ny = MODEL.ny, dx = MODEL.dx, R = G.r + 100000, Ri = Math.ceil(R / dx);
  const ic = Math.floor(cx / dx), jc = Math.floor(cy / dx), sg = (MODEL.params.lat || 0) < 0 ? -1 : 1;
  let sw = 0, sx = 0, sy = 0;
  for (let j = Math.max(0, jc - Ri); j <= Math.min(ny - 1, jc + Ri); j += 2) for (let i = Math.max(0, ic - Ri); i <= Math.min(nx - 1, ic + Ri); i += 2) {
    const x = (i + 0.5) * dx, y = (j + 0.5) * dx, d = Math.hypot(x - cx, y - cy); if (d > R) continue;
    const z = Math.max(0, sg * m.m3[4 * (i + nx * j) + 3]); const w = z * z * (1 - d / R); sw += w; sx += w * x; sy += w * y;
  }
  if (sw <= 0) return;
  const k = 0.2;   // per readback: a gentle pull, so convective spikes don't throw the cluster around
  G.x = cx + k * (sx / sw - cx); G.y = cy + k * (sy / sw - cy); G.t = m.t;
}
function genesisCI(t, dtWin) {
  const G = RUN.genesis; if (!G || t > G.until) return;
  const [cx, cy] = genesisCentre(t), mar = MODEL.params.spongeW + 15000;
  const n = poisson(G.rate * dtWin / 3600);
  for (let k = 0; k < n; k++) {
    for (let tries = 0; tries < 6; tries++) {
      const r = G.r * Math.sqrt(RNG()), a = RNG() * 2 * Math.PI, x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
      if (Math.min(x, y, MODEL.Lx - x, MODEL.Ly - y) < mar) continue;
      // not right on top of a cell that is still being pushed
      if (RUN.events.some(e => t >= e.t0 && t <= e.t1 && Math.hypot(towerPos(e, t)[0] - x, towerPos(e, t)[1] - y) < 15000)) continue;
      addEvent(x, y, t, 'cluster', undefined, { motion: [G.vx, G.vy], rh: 8000, wt: 8, quiet: true }); G.n++;
      break;
    }
  }
}
function fmtLatLon(ll) { return `${ll[0].toFixed(2)}°, ${ll[1].toFixed(2)}°`; }
function echoNear(x, y, rad) {
  const M = RUN.maps; if (!M) return false;
  const nx = MODEL.nx, ny = MODEL.ny, dx = MODEL.dx, r = Math.ceil(rad / dx);
  const i0 = Math.floor(x / dx), j0 = Math.floor(y / dx);
  for (let j = Math.max(0, j0 - r); j <= Math.min(ny - 1, j0 + r); j += 2) for (let i = Math.max(0, i0 - r); i <= Math.min(nx - 1, i0 + r); i += 2) if (M.m0[4 * (i + nx * j)] > 35) return true;
  return false;
}
function scheduleCI(t, dtWin) {
  const ci = CFG.ci;
  if (isHur()) { genesisCI(t, dtWin); return; }
  if (!ci.auto || t < ci.start * 3600 || t > ci.end * 3600) return;
  const mbs = RUN.mbs, Lx = MODEL.Lx, Ly = MODEL.Ly, mar = ciMargin();
  // open warm sector
  const area = (Lx - 2 * mar) * (Ly - 2 * mar) / 1e6;
  let n = poisson(ci.warmRate * area / 1e5 * dtWin / 3600);
  for (let k = 0; k < n; k++) {
    for (let tries = 0; tries < 6; tries++) {
      const x = mar + RNG() * (Lx - 2 * mar), y = mar + RNG() * (Ly - 2 * mar);
      if (otherWeight(mbs, x, y, t) > 0.25 || echoNear(x, y, 35000)) continue;   // not into another storm (its push would stir its outflow)
      addEvent(x, y, t, 'warm sector'); break;
    }
  }
  // along boundaries, on their warm side
  mbs.forEach(mb => {
    const b = mb.b; if (!b || !(b.rate > 0)) return;
    const segs = []; let L = 0; const P = bndPtsAt(mb, t);
    for (let i = 0; i < P.length - 1; i++) { const a = P[i], e = P[i + 1]; const l = Math.hypot(e[0] - a[0], e[1] - a[1]); segs.push([a, e, l]); L += l; }
    n = poisson(b.rate * (L / 1e6) * dtWin / 3600);
    for (let k = 0; k < n; k++) {
      let s = RNG() * L, seg = segs[0];
      for (const sg of segs) { if (s <= sg[2]) { seg = sg; break; } s -= sg[2]; }
      const [a, e, l] = seg, f = s / Math.max(l, 1);
      const ux = (e[0] - a[0]) / l, uy = (e[1] - a[1]) / l;
      const off = (6000 + RNG() * 16000) * -mb.side;          // into the warm side
      const x = a[0] + (e[0] - a[0]) * f + (-uy) * off, y = a[1] + (e[1] - a[1]) * f + ux * off;
      if (x < mar || y < mar || x > Lx - mar || y > Ly - mar) continue;
      if (echoNear(x, y, 25000)) continue;
      addEvent(x, y, t, BND_TYPES[b.type].label.toLowerCase(), Math.atan2(uy, ux));
    }
  });
}

// ─── sub-grid tornadoes ─────────────────────────────────────────────────────
// The km-scale model resolves the low-level mesocyclone but not the tornado. Where a surface-based storm has a
// strong 1-km vortex under a rotating updraft, tornadoes are spawned at a rate scaled by the warm sector's STP,
// ride with that mesocyclone, and are drawn into the radar data as a beam-smeared vortex + lofted debris.
const EF_V = [33, 44, 55, 68, 82, 96];
const TOR = { list: [], lastT: 0, rng: null };
function nearestCity(ll) {
  let best = null, bd = 1e30;
  for (const c of CITIES) { if (c.pop < 20000) continue; const d = gcDist(ll[0], ll[1], c.lat, c.lon); if (d < bd) { bd = d; best = c; } }
  if (!best) return fmtLatLon(ll);
  const brg = Math.atan2(Math.sin((ll[1] - best.lon) * DEG) * Math.cos(ll[0] * DEG), Math.cos(best.lat * DEG) * Math.sin(ll[0] * DEG) - Math.sin(best.lat * DEG) * Math.cos(ll[0] * DEG) * Math.cos((ll[1] - best.lon) * DEG));
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return (bd / 1609).toFixed(0) + ' mi ' + dirs[Math.round(((brg / DEG + 360) % 360) / 22.5) % 16] + ' of ' + best.name;
}
// resolved low-level vorticity scales roughly with 1/Δx: a strong 1-km mesocyclone is ~0.006–0.012 s⁻¹ at 1.5 km
function zetaScale() { return 1500 / MODEL.dx; }
function zetaMin() { return 0.003 * zetaScale(); }
function tornadoCandidates(maps) {
  const m0 = maps.m0, m1 = maps.m1, nx = MODEL.nx, ny = MODEL.ny, dx = MODEL.dx, out = [];
  for (let j = 6; j < ny - 6; j += 2) for (let i = 6; i < nx - 6; i += 2) {
    const s = i + nx * j, z1 = m0[4 * s + 3];
    if (z1 < zetaMin() || m0[4 * s + 2] < -4.5) continue;
    let isMax = true, uh = 0, w = 0;
    for (let dj = -4; dj <= 4; dj += 2) for (let di = -4; di <= 4; di += 2) {
      const q = (i + di) + nx * (j + dj);
      if ((di || dj) && m0[4 * q + 3] > z1) isMax = false;
      uh = Math.max(uh, m1[4 * q + 1]); w = Math.max(w, m1[4 * q]);
    }
    if (isMax && uh > 60 && w > 12) out.push({ x: (i + 0.5) * dx, y: (j + 0.5) * dx, z1, uh, w });
  }
  return out;
}
function gauss() { return Math.sqrt(-2 * Math.log(Math.max(TOR.rng(), 1e-9))) * Math.cos(2 * Math.PI * TOR.rng()); }
// Mesocyclones are tracked from readback to readback. A tornado needs a *mature* one: the initiation push itself
// (updraft nudging in a high-SRH environment) spins up a strong low-level vortex within minutes, long before there
// is a storm with a precipitation core and outflow, so rotation under / just after a push does not count.
const MESO = { list: [], next: 1 };
function fieldAround(arr, ch, x, y, rad, fn, init) {
  const nx = MODEL.nx, ny = MODEL.ny, dx = MODEL.dx, r = Math.ceil(rad / dx);
  const i0 = Math.floor(x / dx), j0 = Math.floor(y / dx);
  let v = init;
  for (let j = Math.max(0, j0 - r); j <= Math.min(ny - 1, j0 + r); j += 2)
    for (let i = Math.max(0, i0 - r); i <= Math.min(nx - 1, i0 + r); i += 2) {
      if ((i - i0) * (i - i0) + (j - j0) * (j - j0) > r * r) continue;
      v = fn(v, arr[4 * (i + nx * j) + ch]);
    }
  return v;
}
function towerPos(e, t) { const dt = Math.max(0, Math.min(t, e.t1) - e.t0); return [e.x + (e.vx || 0) * dt, e.y + (e.vy || 0) * dt]; }
function forcedNear(x, y, t) { return RUN.events.some(e => { if (t < e.t0 || t > e.t1) return false; const [ex, ey] = towerPos(e, t); return Math.hypot(ex - x, ey - y) < 1.5 * e.rh + 8000; }); }
function mesoUpdate(maps, t, dt) {
  const cands = tornadoCandidates(maps);
  for (const M of MESO.list) M.hit = null;
  for (const c of cands) {
    let best = null, bd = 16000;
    for (const M of MESO.list) {
      if (M.hit) continue;
      const d = Math.hypot(c.x - (M.x + M.vx * dt), c.y - (M.y + M.vy * dt));
      if (d < bd) { bd = d; best = M; }
    }
    const forced = forcedNear(c.x, c.y, t);
    if (best) {
      const k = 1 - Math.exp(-dt / 300);
      best.vx = lerp(best.vx, (c.x - best.x) / dt, 0.3); best.vy = lerp(best.vy, (c.y - best.y) / dt, 0.3);
      best.x = c.x; best.y = c.y; best.seen = t; best.z1 = lerp(best.z1, c.z1, k); best.uh = lerp(best.uh, c.uh, k);
      best.hit = c; c.meso = best;
      best.strongFor = forced ? 0 : best.strongFor + dt;
      if (forced) best.freeSince = t;
    } else {
      const M = { id: MESO.next++, x: c.x, y: c.y, vx: 0, vy: 0, born: t, seen: t, z1: c.z1, uh: c.uh, strongFor: 0, freeSince: forced ? t : t - 1e9, lastTor: -1e9, hit: c };
      MESO.list.push(M); c.meso = M;
    }
  }
  MESO.list = MESO.list.filter(M => t - M.seen < 360);
  return cands;
}
function torScheme() { return CFG.tor.on && !isHur() && MODEL && MODEL.dx >= 400; }
function tornadoUpdate(maps, t) {
  if (!torScheme() || !TOR.rng) return;
  const dt = Math.max(1, t - TOR.lastT); TOR.lastT = t;
  const cands = mesoUpdate(maps, t, dt);
  TOR.cands = cands.length;
  const stp = SND.A && isFinite(SND.A.P.stp) ? SND.A.P.stp : 1;
  const fStp = clamp(0.25 + stp / 3, 0.2, 2.5) * CFG.tor.rate;
  // follow each tornado's mesocyclone
  for (const T of TOR.list) {
    if (T.done) continue;
    let best = null, bd = 12000;
    for (const c of cands) { const d = Math.hypot(c.x - T.x, c.y - T.y); if (d < bd) { bd = d; best = c; } }
    if (best) {
      const k = Math.min(1, dt / 120);
      T.vx = lerp(T.vx, (best.x - T.mx) / Math.max(dt, 1), 0.3); T.vy = lerp(T.vy, (best.y - T.my) / Math.max(dt, 1), 0.3);
      T.mx = best.x; T.my = best.y; T.x = lerp(T.x, best.x, k * 0.5); T.y = lerp(T.y, best.y, k * 0.5); T.lost = 0;
    } else T.lost += dt;
    if (T.lost > 300 && T.t1 > t + 120) T.t1 = t + 120;          // lost its mesocyclone: rope out
    if (t > T.t1) { T.done = true; logMsg('tornado #' + T.id + ' (EF' + T.ef + ') lifted after ' + ((T.t1 - T.t0) / 60).toFixed(0) + ' min'); }
  }
  // new tornadoes: only from mature mesocyclones of storms with a precipitation core and outflow
  TOR.mature = 0;
  for (const M of MESO.list) {
    const c = M.hit;
    if (!c) continue;
    if (t - M.born < 900 || M.strongFor < 480 || t - M.freeSince < 600 || t - M.lastTor < 600) continue;
    if (TOR.list.some(T => !T.done && Math.hypot(T.x - c.x, T.y - c.y) < 20000)) continue;
    const core = fieldAround(maps.m0, 1, c.x, c.y, 10000, Math.max, -30);     // heavy precipitation reaching low levels
    const cold = fieldAround(maps.m0, 2, c.x, c.y, 12000, Math.min, 99);      // storm outflow (RFD / FFD cold pool)
    if (core < 40 || cold > -1.0) continue;
    TOR.mature++;
    const zs = zetaScale();
    const p = 0.08 * fStp * smooth(0.003 * zs, 0.010 * zs, M.z1) * smooth(60, 400, M.uh);
    if (TOR.rng() >= p * dt / 60) continue;
    M.lastTor = t;
    // intensity: how strong this mesocyclone is (resolved 1-km ζ, 2–5 km UH) × how tornadic the air is (STP)
    const fI = clamp(0.3 + stp / 4, 0.3, 2.2);
    const s = fI * smooth(0.003 * zs, 0.010 * zs, M.z1) * smooth(80, 600, M.uh);
    const ef = clamp(Math.round(0.2 + 1.8 * s + 1.0 * gauss()), 0, 5);
    const life = (4 + 7 * ef + 15 * TOR.rng()) * 60;
    const T = { id: TOR.list.length + 1, ef, x: c.x, y: c.y, mx: c.x, my: c.y, vx: 0, vy: 0, t0: t, t1: t + life, R: 40 + 55 * ef + 50 * TOR.rng(), lost: 0, track: [] };
    TOR.list.push(T);
    logMsg('TORNADO #' + T.id + ' EF' + ef + ' ' + nearestCity(GEO.fromModel(c.x, c.y)) + ' at ' + new Date(RUN.epoch0 + t * 1000).toISOString().slice(11, 16) + 'Z');
  }
}
// advance every step and hand the active ones to the radars
function tornadoTick(t, dt) {
  if (!torScheme()) { if (RADAR.nTor) RADAR.setTornadoes([]); return; }
  const act = [];
  for (const T of TOR.list) {
    if (T.done) continue;
    T.x += T.vx * dt; T.y += T.vy * dt;
    const age = (t - T.t0) / Math.max(T.t1 - T.t0, 1);
    const env = smooth(0, 0.15, age) * (1 - smooth(0.7, 1, age));
    const v = EF_V[T.ef] * env * (0.92 + 0.08 * Math.sin(t / 47 + T.id));
    const lp = T.track[T.track.length - 1];
    if (!lp || Math.hypot(T.x - lp[0], T.y - lp[1]) > 1500) T.track.push([T.x, T.y]);
    act.push({ x: T.x, y: T.y, R: T.R * (0.6 + 0.4 * env), v, debrisTop: 500 + 800 * T.ef, debrisDbz: 40 + 4 * T.ef, debris: T.ef >= 1 ? smooth(60, 240, t - T.t0) * env : 0 });
  }
  RADAR.setTornadoes(act);
}

// ─── run ───────────────────────────────────────────────────────────────────
function syncRunButtons() {
  const st = RUN.state;
  const s = $('btnStart'), p = $('btnPause'), x = $('btnStop');
  if (!s) return;
  s.disabled = st === 'running' || st === 'paused';
  s.textContent = st === 'done' || st === 'stopped' ? 'New run (reset)' : 'Start simulation';
  p.disabled = !(st === 'running' || st === 'paused'); p.textContent = st === 'paused' ? 'Resume' : 'Pause';
  x.disabled = !(st === 'running' || st === 'paused');
}
async function startRun() {
  if (RUN.state === 'done' || RUN.state === 'stopped') { RUN.state = 'setup'; RUN.maps = null; FIELD.ok = false; replayReset(); syncRunButtons(); updateHint(); draw(); return; }
  if (!SND.A) { showError('The sounding could not be read: ' + (SND.err || '')); return; }
  try {
    // model first, so a grid the GPU / browser can't hold leaves no empty run folder behind
    if (!MODEL) MODEL = new RegionalModel();
    const grid = gridSpec();
    if (MODEL.key !== grid.key) { logMsg(`allocating ${grid.label} (about ${(gridBytes(grid) / 1e9).toFixed(1)} GB)`); await MODEL.allocate(grid.key, grid); }
    // server
    const name = (CFG.runName || 'run') + '_' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    let run = name;
    try {
      const r = await fetch('/api/run', { method: 'POST', body: JSON.stringify({ name, cfg: CFG, sounding: SND.text }) });
      const j = await r.json(); run = j.run; RUN.server = true;
      $('srvNote').innerHTML = `Server OK · output folder <code>${j.dir}</code>`;
    } catch (e) {
      RUN.server = false;
      $('srvNote').innerHTML = '<span style="color:var(--bad)">No OutbreakLab server: start <code>start.bat</code> (python server.py). The model will run but nothing is exported.</span>';
    }
    RUN.name = run;
    MODEL.params.lat = CFG.center.lat;
    MODEL.params.scheme = CFG.micro === 'thompson' ? 'thompson' : 'lin';
    // maritime tropical air rains faster (cloud water turns to rain from 1 g/kg, not continental 2 g/kg); the damping
    // layer starts above the hurricane's outflow (at 12–15 km under a ~16 km tropopause)
    const hur = isHur();
    // Full-strength MacCormack advection for hurricanes: in the vortex the Courant numbers are small (~0.1), where the
    // outbreak setup's weakened correction (mcFloor 0.25) leaves mostly first-order semi-Lagrangian interpolation — a
    // numerical diffusion of order U·Δx/2 ≈ 10⁴ m²/s that held 2700 J/kg core updrafts to 3–6 m/s (28 m/s with full)
    // Rain evaporates at 10 % of Kessler's rate (22 % for outbreaks): the Plains setting chilled the hurricane's inflow
    Object.assign(MODEL.params, hur ? { qc0: 1e-3, dampZ: 16500, dampTau: 300, mcFloor: 1.0, evap: 0.10 } : { qc0: 2e-3, dampZ: 15000, dampTau: 150, mcFloor: 0.25, evap: 0.22 });
    MODEL.setSounding(SND.text);
    updateGeo();
    GEO.groundMSL = MODEL.base.sfcH;
    const BV = boundaryVels();
    RUN.mbs = CFG.bounds.map((b, i) => Object.assign(bndModel(b), { vel: BV[i], b })).filter(mb => mb.pts.length >= 2);
    MODEL.setBoundaries(RUN.mbs);
    RUN.events = []; MODEL.setCI(RUN.events);
    Hurricane.reset(); RUN.surf = null;
    if (hur) {
      const H = CFG.hur, [vx, vy] = GEO.toModel(H.lat, H.lon);
      const edge = Math.min(vx, vy, MODEL.Lx - vx, MODEL.Ly - vy);
      if (edge < MODEL.params.spongeW + 30000) throw new Error('the hurricane starts outside (or at the edge of) the domain: move it with Place hurricane, or move the domain');
      const sf = Hurricane.surface(MODEL, GEO, H, LINES && LINES.states);
      RUN.surf = sf.data;
      // sea fluxes: Ck 1.3·10⁻³ and the drag levelling off at 2.0·10⁻³ (Ck/Cd ≈ 0.8 at hurricane winds, within what field
      // campaigns measure; 1.2 / 2.4 gave ~0.5–0.6 and a lower ceiling), dissipative heating on, and the trigger
      // thermals fading out once the storm has 35–55 kt
      MODEL.setSurface(sf.data, { ck: 1.3e-3, cdCap: 2.0e-3, dissHeat: true, thermalFade: true, landMoist: H.landMoist, sfcP: MODEL.base.sfcP * 100, tauRad: 43200, radCap: 2 / 86400, blDepth: 1000, u10f: 0.8, gust: 1.5, thermals: 0.4 / 300, maritime: true, centre: [vx, vy], thermalR: 200000, envR: (H.envKm || 300) * 1000 });
      RUN.genesis = null;
      if (H.start === 'cluster') {
        // the cluster drifts with the 850–500 hPa wind; a weak mid-level vortex (or none) and a moist column under it
        let gu = 0, gv = 0; for (let z = 1500; z <= 5500; z += 1000) { const w = MODEL.baseWind(z); gu += w[0] / 5; gv += w[1] / 5; }
        RUN.genesis = { x: vx, y: vy, t: 0, vx: gu, vy: gv, r: H.clusterKm * 1000, until: H.seedHours * 3600, rate: H.cellRate, n: 0 };
        MODEL.hur.centre = [vx, vy];
        const X = MODEL.setVortex({ x: vx, y: vy, vmax: H.mcvKt * Hurricane.KT, rmw: Math.max(40, 0.5 * H.clusterKm) * 1000, r0: 2.5 * H.clusterKm * 1000, ztop: 16000, shape: 'mid', moistR: H.moistCore ? H.clusterKm * 1000 : 0, moistRH: 0.9 });
        logMsg(`hurricane mode, genesis: SST ${H.sst.toFixed(1)} °C; a ${H.clusterKm} km cluster of storms (${H.cellRate}/h for ${H.seedHours} h) at ${fmtLatLon([H.lat, H.lon])}, drifting ${(Math.hypot(gu, gv) / Hurricane.KT).toFixed(0)} kt toward ${((Math.atan2(gu, gv) / DEG + 360) % 360).toFixed(0)}°${H.mcvKt > 0 ? `, around a ${H.mcvKt} kt mid-level vortex (${(MODEL.base.sfcP + X.pc).toFixed(1)} hPa at the surface)` : ', no vortex'}`);
      }
      const X = RUN.genesis ? MODEL.vortex : MODEL.setVortex({ x: vx, y: vy, vmax: H.vmaxKt * Hurricane.KT, rmw: H.rmwKm * 1000, r0: H.r0Km * 1000, ztop: 16000, moistR: H.moistCore ? 2.5 * H.rmwKm * 1000 : 0, moistRH: 0.93 });
      if (!RUN.genesis) logMsg(`hurricane mode: SST ${H.sst.toFixed(1)} °C, land ${(100 * sf.landFrac).toFixed(0)} % of the domain; vortex ${H.vmaxKt} kt at ${H.rmwKm} km (${(MODEL.base.sfcP + X.pc).toFixed(0)} hPa, warm core +${X.warm.toFixed(1)} K) at ${fmtLatLon([H.lat, H.lon])}`);
      if (!RUN.genesis && X.minStab < 0.5) logMsg(`warning: the starting vortex's warm core leaves its upper levels nearly unstable (dθ/dz ${X.minStab.toFixed(1)} K/km), so it will partly overturn; a weaker or wider vortex starts cleaner`);
    } else { MODEL.setSurface(null, null); MODEL.setVortex(null); RUN.genesis = null; }
    MODEL.reset();
    RNG = mulberry((CFG.ci.seed | 0) * 7919 + 13);
    TOR.list = []; TOR.lastT = 0; TOR.rng = mulberry((CFG.ci.seed | 0) * 104729 + 71);
    MESO.list = []; MESO.next = 1;
    for (const m of CFG.manual) {
      const [x, y] = GEO.toModel(m.lat, m.lon);
      if (Math.min(x, y, MODEL.Lx - x, MODEL.Ly - y) < ciMargin()) { logMsg(`hand-placed storm at ${fmtLatLon([m.lat, m.lon])} skipped: too close to the domain edge`); continue; }
      RUN.events.push(...towerCluster(x, y, (m.tMin || 5) * 60, 'placed'));
    }
    MODEL.setCI(RUN.events);
    // radars
    if (RADAR) RADAR.destroy();
    RADAR = new RadarSim(MODEL, GEO);
    for (const id of CFG.radars) {
      const s = SITES.find(x => x.id === id); if (!s) continue;
      RADAR.addRadar(s, { vcp: CFG.vcp, aliasing: CFG.aliasing, minDbz: CFG.minDbz ?? 0 });
    }
    RUN.epoch0 = Date.parse(CFG.start + ':00Z');
    if (!isFinite(RUN.epoch0)) RUN.epoch0 = Date.UTC(2024, 4, 6, 20, 0, 0);
    RUN.tEnd = CFG.hours * 3600;
    replayReset();
    RUN.dt = 6 * (MODEL.dx / 1000) * CFG.dtScale;
    RUN.uploaded = 0; RUN.failed = 0; RUN.bytes = 0; RUN.inflight = 0; RUN.ciNext = 0; RUN.maps = null; RUN.lastMapWall = 0;
    RUN.wall0 = performance.now(); RUN.sim0 = 0; RUN.lastWall = RUN.wall0; RUN.lastSim = 0; RUN.simRate = 0;
    RUN.state = 'running';
    syncRunButtons(); updateHint();
    logMsg(`run ${run}: ${grid.label}, dt ${RUN.dt.toFixed(1)} s, ${RADAR.radars.length} radar(s), ${RUN.mbs.length} boundary(ies)`);
    loop();
  } catch (e) { console.error(e); showError('Could not start: ' + e.message); RUN.state = 'setup'; syncRunButtons(); }
}
function togglePause() { if (RUN.state === 'running') RUN.state = 'paused'; else if (RUN.state === 'paused') { RUN.state = 'running'; RUN.wall0 = performance.now(); RUN.sim0 = MODEL.time; loop(); } syncRunButtons(); }
function stopRun() { RUN.state = 'stopped'; syncRunButtons(); logMsg('stopped at t+' + (MODEL.time / 60).toFixed(0) + ' min'); }

async function loop() {
  const d = GPU.device;
  while (RUN.state === 'running') {
    // backpressure: radar readbacks and uploads
    // (and a replay frame never waits on a busy readback: the model holds until one is free)
    const frameWait = () => MODEL.time + RUN.dt >= REPLAY.next && MODEL.mapBusy[0] && MODEL.mapBusy[1];
    const radarWait = () => RUN.inflight > 3 || (RADAR && RADAR.radars.some(R => R.readBusy[0] && R.readBusy[1]));
    while (radarWait() || frameWait()) { await sleep(radarWait() ? 15 : 1); if (RUN.state !== 'running') return; }
    const nb = RUN.stepsPerBatch;
    const t0 = performance.now();
    const reqs = [];   // map readbacks: each replay frame at the step that reaches its time, else one for the display
    let ran = 0;
    for (let s = 0; s < nb && MODEL.time < RUN.tEnd && !frameWait(); s++) {
      if (MODEL.time >= RUN.ciNext) { scheduleCI(MODEL.time, 60); RUN.ciNext = MODEL.time + 60; }
      const enc = d.createCommandEncoder();
      MODEL.encStep(enc, RUN.dt); ran++;
      tornadoTick(MODEL.time, RUN.dt);
      const due = RADAR.encDue(enc, MODEL.time);
      const frame = MODEL.time >= REPLAY.next;
      if (frame || (!reqs.length && s === nb - 1 && performance.now() - RUN.lastMapWall > 350)) {
        const r = MODEL.requestMaps(enc);
        if (r) { reqs.push([r, frame]); RUN.lastMapWall = performance.now(); if (frame) REPLAY.next = Math.floor(MODEL.time / REPLAY.every + 1) * REPLAY.every; }
      }
      d.queue.submit([enc.finish()]);
      for (const v of due) handleVolume(v);
    }
    await d.queue.onSubmittedWorkDone();
    const el_ = performance.now() - t0;
    // aim for ~60 ms of GPU work per batch
    RUN.stepsPerBatch = clamp(Math.round(Math.max(ran, 1) * (60 / Math.max(el_, 5))), 1, 40);
    reqs.forEach(([r, frame], k) => r().then(m => {
      if (frame) captureFrame(m);
      if (k === reqs.length - 1) { RUN.maps = m; tornadoUpdate(m, m.t); if (isHur()) { genesisFollow(m); hurricaneUpdate(m); } if (REPLAY.idx < 0) paintField(); draw(); }
    }).catch(e => console.error(e)));
    // pacing
    if (CFG.pace > 0) {
      const want = RUN.wall0 + (MODEL.time - RUN.sim0) / CFG.pace * 1000;
      const wait = want - performance.now();
      if (wait > 0) await sleep(Math.min(wait, 2000));
    }
    const now = performance.now();
    if (now - RUN.lastWall > 1000) { RUN.simRate = (MODEL.time - RUN.lastSim) / ((now - RUN.lastWall) / 1000); RUN.lastWall = now; RUN.lastSim = MODEL.time; }
    status();
    if (GPU.errors.length) { showError('WebGPU: ' + GPU.errors.slice(-3).join('\n')); RUN.state = 'stopped'; syncRunButtons(); return; }
    if (MODEL.time >= RUN.tEnd) {
      RUN.state = 'done'; syncRunButtons();
      logMsg(`finished: ${(RUN.tEnd / 3600).toFixed(1)} h simulated; waiting for ${RUN.inflight} upload(s)`);
      while (RUN.inflight > 0) await sleep(100);
      logMsg(`all volumes written (${RUN.uploaded} files, ${(RUN.bytes / 1e6).toFixed(0)} MB)`);
      status(true);
      return;
    }
    await sleep(0);
  }
}
// gzip in the browser (native CompressionStream): a volume is ~52 MB of mostly empty gates, and handing Chrome
// dozens of raw 52 MB request bodies exhausts its blob storage (net::ERR_BLOB_OUT_OF_MEMORY)
async function gzipParts(parts) {
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter();
  const out = new Response(cs.readable).arrayBuffer();
  for (const p of parts) await w.write(p);
  await w.close();
  return new Uint8Array(await out);
}
async function handleVolume(v) {
  RUN.inflight++;
  try {
    const { R, header, bytes } = await RADAR.collect(v, RUN.name, RUN.epoch0);
    if (!RUN.server) return;
    const hj = new TextEncoder().encode(JSON.stringify(header));
    const pre = new Uint8Array(4); new DataView(pre.buffer).setUint32(0, hj.length, true);
    const body = await gzipParts([pre, hj, bytes]);
    let j = null, err = null;
    for (let attempt = 0; attempt < 4 && !j; attempt++) {
      try {
        const res = await fetch('/api/volume', { method: 'POST', headers: { 'X-OB-Gzip': '1' }, body });
        j = await res.json();
        if (!j.ok) { err = new Error(j.error || 'server error'); j = null; break; }
      } catch (e) { err = e; await sleep(400 * (attempt + 1)); }
    }
    if (!j) throw err || new Error('upload failed');
    RUN.uploaded++; RUN.bytes += j.size; R.done++;
    if (R.done <= 2 || R.done % 10 === 0) logMsg(`${R.site.id} ${j.name} (${(j.size / 1e6).toFixed(1)} MB, ${j.ms} ms)`);
  } catch (e) { RUN.failed++; v.R.failed++; logMsg('volume failed: ' + e.message); }
  finally { RUN.inflight--; }
}
async function startReplay() {
  const run = RUN.name || CFG.lastRun;
  if (!run) { showError('No run to replay yet.'); return; }
  const r = await fetch('/api/replay', { method: 'POST', body: JSON.stringify({ run, factor: RUN.replayF || 10, lead_min: 20 }) });
  const j = await r.json();
  logMsg(j.ok ? `replaying ${run} at ${RUN.replayF || 10}× through /poll/` : 'replay failed: ' + j.error);
}

let statusT = 0;
function status(force) {
  const nowS = performance.now(); if (!force && nowS - statusT < 250) return; statusT = nowS;
  const S = $('status');
  if (!MODEL || RUN.state === 'setup') { S.innerHTML = `<span>WebGPU: <b>${GPU.adapter && GPU.adapter.info ? (GPU.adapter.info.description || GPU.adapter.info.vendor || 'ok') : 'ok'}</b></span><span>Set up the event, then <b>Start simulation</b></span>`; return; }
  const t = MODEL.time, clock = new Date(RUN.epoch0 + t * 1000).toISOString().slice(11, 16) + 'Z';
  const rf = REPLAY.idx >= 0 ? REPLAY.frames[REPLAY.idx] : null;
  const mx = RUN.maps ? (() => { let z = -30, u = 0; const m0 = RUN.maps.m0, m1 = RUN.maps.m1; for (let i = 0; i < m0.length; i += 4) { if (m0[i] > z) z = m0[i]; if (m1[i + 1] > u) u = m1[i + 1]; } return { z, u }; })() : null;
  const rs = RADAR ? RADAR.radars.map(R => `${R.site.id} ${R.done}${R.failed ? `<span class="bad">/${R.failed}✗</span>` : ''}`).join(' · ') : '';
  S.innerHTML = `${rf ? `<span class="warn">map: replay frame <b>${fmtClock(rf.t)}</b></span>` : ''}<span><b>${clock}</b> (t+${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')})</span>
    <span>speed <b>${RUN.simRate.toFixed(0)}×</b></span><span>dt ${RUN.dt.toFixed(1)} s · ${MODEL.steps} steps</span>
    ${mx ? `<span>max <b>${mx.z.toFixed(0)}</b> dBZ · UH <b>${mx.u.toFixed(0)}</b></span>` : ''}
    ${isHur() ? hurStatus() : `<span>storm starts <b>${RUN.events.length}</b></span><span>tornadoes <b>${TOR.list.filter(T => !T.done).length}</b> now / <b>${TOR.list.length}</b></span>`}<span>volumes: ${rs || 'no radars'} ${RUN.inflight ? `<span class="warn">(${RUN.inflight} writing)</span>` : ''}</span>
    <span class="${RUN.state === 'running' ? 'ok' : ''}">${RUN.state}</span>`;
  const p = $('prog'); if (p) p.style.width = (100 * t / RUN.tEnd).toFixed(1) + '%';
}

// ─── boot ──────────────────────────────────────────────────────────────────
// Reset everything: every setting back to its default (the start-up example), any run or server replay stopped,
// then a fresh page, which also frees the GPU memory of the grid. Files already written to output\ are kept.
async function resetEverything() {
  const busy = RUN.state === 'running' || RUN.state === 'paused';
  const msg = 'Reset everything to the defaults?\n\nThe sounding, domain and grid, boundaries and surface low, storm settings, ' +
    'hand-placed storms, radars and run settings all go back to the start-up example.' +
    (busy ? '\n\nThe run in progress will be stopped.' : '') + ' A replay running through polling stops too.' +
    '\n\nFiles already written to output\\ are kept.';
  if (!confirm(msg)) return;
  const b = $('btnReset'); if (b) { b.disabled = true; b.textContent = 'Resetting…'; }
  if (busy) { RUN.state = 'stopped'; syncRunButtons(); logMsg('reset: run stopped'); }
  for (let k = 0; k < 80 && RUN.inflight > 0; k++) await sleep(100);   // let volumes on their way finish (≤ 8 s)
  try { await fetch('/api/replay', { method: 'POST', body: '{}' }); } catch (e) { }
  clearTimeout(saveT);                                                  // a pending save must not write the old settings back
  try { localStorage.removeItem('outbreaklab.cfg'); } catch (e) { }
  location.reload();
}
async function boot() {
  const rb = $('btnReset'); if (rb) rb.onclick = resetEverything;

  // Build the ordinary interface before requesting WebGPU. Previously a failed WebGPU
  // initialization returned here and left only the page header visible (the iPhone
  // blank-screen symptom). The setup controls and map can still render without a GPU;
  // only running the numerical model requires WebGPU.
  buildSounding();
  updateGeo();
  buildToolbar(); buildPanel(); setupMap(); buildReplayBar(); resize(); updateHint(); status();

  try {
    await GPU.init();
  } catch (e) {
    console.error('WebGPU initialization failed:', e);
    showError('Simulation unavailable: ' + e.message + ' The setup interface is available, but running the storm model requires a compatible WebGPU browser/device.');
    const S = $('status');
    if (S) S.innerHTML = '<span class="bad"><b>WebGPU unavailable</b></span><span>Setup controls are available; the storm simulation cannot start on this browser/device.</span>';
    return;
  }
  if (!GPU.floatFilter) {
    showError('This GPU/browser lacks float32-filterable textures; the model needs them.');
    const S = $('status');
    if (S) S.innerHTML = '<span class="bad"><b>Required GPU feature unavailable</b></span><span>Setup controls are available; this device cannot run the model as configured.</span>';
    return;
  }
  status();
  fetch('/api/status').then(r => r.json()).then(j => { RUN.server = true; const n = $('srvNote'); if (n) n.innerHTML = `Server OK on port ${j.port}${j.live ? ` · last run <code>${j.live}</code>` : ''}`; CFG.lastRun = j.live; })
    .catch(() => { const n = $('srvNote'); if (n) n.innerHTML = '<span style="color:var(--bad)">Server not reachable — run <code>start.bat</code> for Level II export.</span>'; });
  window.OB = { get model() { return MODEL; }, get radar() { return RADAR; }, get geo() { return GEO; }, CFG, RUN, startRun, stopRun, draw, paintField, setTool, setMode, Hurricane };
}
boot();
