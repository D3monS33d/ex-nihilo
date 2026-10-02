// The app: wires the universe (running in workers) to the renderer and the controls.

import { Renderer, byteColour } from './render.js';
import { Microscope } from './microscope.js';
import { speciesRgb } from './life.js';
import { speciesName, randomSeed } from './names.js';
import { DEFAULTS } from './soup.js';
import { OP, HALF, textbookReplicator } from './bff.js';
import { KNOWN_UNIVERSES } from './known.js';
import { Sound } from './sound.js';

// The first charted universe wakes up early enough to watch. Most take far longer.
const DEFAULT_SEED = KNOWN_UNIVERSES.length ? KNOWN_UNIVERSES[0].seed : 'ex nihilo';

const GRID_W = DEFAULTS.width;
const GRID_H = DEFAULTS.height;
const CELLS = GRID_W * GRID_H;
const WORLD_W = GRID_W * 8;
const WORLD_H = GRID_H * 8;

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const fmtBig = (n) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`;
const fmtPct = (f) => (f <= 0 ? '0%' : f < 0.001 ? '<0.1%' : `${(f * 100).toFixed(f < 0.1 ? 1 : 0)}%`);
const rgb = (c) => `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`;

// ---- state -------------------------------------------------------------------

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  return {
    seed: q.get('seed') || DEFAULT_SEED,
    mut: q.has('mut') ? Math.max(0, Number(q.get('mut')) || 0) : 4096,
    limit: clamp(Number(q.get('limit')) || DEFAULTS.stepLimit, 128, 65536),
  };
}

const state = {
  ...readHash(),
  running: false,
  mode: 0,
  tool: 'inspect',
  brush: 9,
  inoculum: textbookReplicator(), // what the inoculation tool plants, until another genome is loaded
  stats: null,
  events: [], // this universe's history: births, extinctions, takeover
  complexity: 0,
  selected: -1,
  history: [], // [epoch, alive fraction]
  complexityHistory: [], // [epoch, bits]
};

function writeHash() {
  const q = new URLSearchParams();
  q.set('seed', state.seed);
  if (state.mut !== 4096) q.set('mut', state.mut);
  if (state.limit !== DEFAULTS.stepLimit) q.set('limit', state.limit);
  history.replaceState(null, '', `#${q}`);
}

function universeParams() {
  return {
    width: GRID_W,
    height: GRID_H,
    seed: state.seed,
    mutation: state.mut > 0 ? 1 / state.mut : 0,
    stepLimit: state.limit,
  };
}

// ---- renderer ----------------------------------------------------------------

function fatal(message) {
  $('fatal').hidden = false;
  $('fatal').textContent = message;
  $('intro').classList.add('gone');
  throw new Error(message);
}

let renderer;
try {
  renderer = new Renderer(canvas, GRID_W, GRID_H);
} catch (err) {
  fatal(`${err.message} Ex Nihilo needs WebGL2 to draw the universe.`);
}
renderer.resize();

// ---- workers -----------------------------------------------------------------

const coordinator = new Worker(new URL('./coordinator.js', import.meta.url), { type: 'module' });
{
  const query = new URLSearchParams(location.search);
  const requested = Number(query.get('threads'));
  const cores = navigator.hardwareConcurrency || 4;
  const executorCount = requested > 0 ? requested - 1 : clamp(cores - 2, 0, 14);
  const ports = [];
  for (let i = 0; i < executorCount; i++) {
    const worker = new Worker(new URL('./executor.js', import.meta.url), { type: 'module' });
    const channel = new MessageChannel();
    worker.postMessage({ port: channel.port1 }, [channel.port1]);
    ports.push(channel.port2);
  }
  const metrics = new Worker(new URL('./metrics.js', import.meta.url), { type: 'module' });
  const channel = new MessageChannel();
  metrics.postMessage({ port: channel.port1 }, [channel.port1]);
  metrics.onmessage = ({ data }) => onComplexity(data);
  const pairer = new Worker(new URL('./pair-worker.js', import.meta.url), { type: 'module' });
  const pairChannel = new MessageChannel();
  pairer.postMessage({ port: pairChannel.port1 }, [pairChannel.port1]);
  coordinator.postMessage(
    {
      type: 'init',
      params: universeParams(),
      ports,
      metricsPort: channel.port2,
      pairPort: pairChannel.port2,
      shared: query.get('shared') !== '0', // the coordinator still checks that it is possible
      running: false, // until the intro is dismissed
      eps: 0,
    },
    [...ports, channel.port2, pairChannel.port2],
  );
}

// Buffers that shuttle between this thread and the coordinator, one snapshot per frame.
let buffers = { bytes: new ArrayBuffer(CELLS * HALF), heat: new ArrayBuffer(CELLS) };
let frameEpoch = 0;
let inspectId = 0; // the latest inspect request; replies to older ones are ignored
let revealId = 0; // the request whose reply should also move the camera

coordinator.onmessage = ({ data }) => {
  switch (data.type) {
    case 'frame':
      renderer.setFrame(new Uint8Array(data.bytes), new Uint8Array(data.heat));
      buffers = { bytes: data.bytes, heat: data.heat };
      if (data.epoch !== frameEpoch) {
        frameEpoch = data.epoch;
        $('s-epoch').textContent = fmtInt(frameEpoch);
      }
      break;
    case 'stats':
      onStats(data);
      break;
    case 'life':
      onLifeEvent(data.event, data.pristine);
      break;
    case 'inspect':
      if (data.id === inspectId) {
        state.selected = data.cell; // may differ from the cell asked for; see select()
        if (data.id === revealId) flyTo(data.cell, 13);
        microscope.show(data);
        layoutHud();
      }
      break;
  }
};
coordinator.onerror = (err) => toast(`Simulation error: ${err.message}`);

// ---- camera ------------------------------------------------------------------

const view = { cx: WORLD_W / 2, cy: WORLD_H / 2, zoom: 1 };
const target = { cx: view.cx, cy: view.cy, zoom: 1 };
let anchor = null; // { sx, sy, wx, wy }: world point pinned under a screen point while zooming
let fitted = true;

const dpr = () => renderer.width / Math.max(1, canvas.clientWidth);
const fitZoom = () => Math.min(renderer.width / WORLD_W, renderer.height / WORLD_H) * 0.97;

function fitView(animate = true) {
  target.zoom = fitZoom();
  target.cx = WORLD_W / 2;
  target.cy = WORLD_H / 2;
  anchor = null;
  fitted = true;
  if (!animate) Object.assign(view, target);
}

function toWorld(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const sx = (clientX - r.left) * dpr();
  const sy = (clientY - r.top) * dpr();
  return { sx, sy, wx: view.cx + (sx - renderer.width / 2) / view.zoom, wy: view.cy + (sy - renderer.height / 2) / view.zoom };
}

function zoomAt(clientX, clientY, factor) {
  const p = toWorld(clientX, clientY);
  target.zoom = clamp(target.zoom * factor, fitZoom() * 0.5, 72 * dpr());
  anchor = p;
  fitted = false;
}

function flyTo(cell, zoom) {
  target.cx = (cell % GRID_W) * 8 + 4;
  target.cy = Math.floor(cell / GRID_W) * 8 + 4;
  target.zoom = Math.max(target.zoom, zoom * dpr());
  anchor = null;
  fitted = false;
}

function updateCamera(dt) {
  const k = 1 - Math.exp(-dt * 12);
  view.zoom = Math.exp(Math.log(view.zoom) + (Math.log(target.zoom) - Math.log(view.zoom)) * k);
  if (anchor) {
    view.cx = anchor.wx - (anchor.sx - renderer.width / 2) / view.zoom;
    view.cy = anchor.wy - (anchor.sy - renderer.height / 2) / view.zoom;
    target.cx = view.cx;
    target.cy = view.cy;
  } else {
    view.cx += (target.cx - view.cx) * k;
    view.cy += (target.cy - view.cy) * k;
  }
  view.cx = clamp(view.cx, 0, WORLD_W);
  view.cy = clamp(view.cy, 0, WORLD_H);
}

// ---- pointer input -----------------------------------------------------------

const pointers = new Map();
let dragged = false;
let pinch = null;
let hover = null; // world position of the cursor, for the brush preview

canvas.addEventListener('pointerdown', (e) => {
  dismissIntro();
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
  dragged = pointers.size > 1;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: target.zoom };
  }
});

canvas.addEventListener('pointermove', (e) => {
  const w = toWorld(e.clientX, e.clientY);
  hover = { x: w.wx, y: w.wy };
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x;
  const dy = e.clientY - p.y;
  p.x = e.clientX;
  p.y = e.clientY;
  if (pointers.size === 2 && pinch) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = toWorld((a.x + b.x) / 2, (a.y + b.y) / 2);
    target.zoom = clamp((pinch.zoom * dist) / Math.max(1, pinch.dist), fitZoom() * 0.5, 72 * dpr());
    anchor = mid;
    fitted = false;
    return;
  }
  if (!dragged && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 5) return;
  dragged = true;
  canvas.classList.add('panning');
  anchor = null;
  fitted = false;
  view.cx = target.cx = clamp(view.cx - (dx * dpr()) / view.zoom, 0, WORLD_W);
  view.cy = target.cy = clamp(view.cy - (dy * dpr()) / view.zoom, 0, WORLD_H);
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  canvas.classList.remove('panning');
  if (pointers.size < 2) pinch = null;
  if (!dragged && e.type === 'pointerup' && e.button === 0) clickAt(e.clientX, e.clientY);
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => (hover = null));

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    dismissIntro();
    const unit = e.deltaMode === 1 ? 32 : 1;
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * 0.0016));
  },
  { passive: false },
);

canvas.addEventListener('dblclick', (e) => zoomAt(e.clientX, e.clientY, 2.6));

function clickAt(clientX, clientY) {
  const w = toWorld(clientX, clientY);
  if (w.wx < 0 || w.wy < 0 || w.wx >= WORLD_W || w.wy >= WORLD_H) {
    if (state.tool === 'inspect') closeScope();
    return;
  }
  const x = w.wx / 8;
  const y = w.wy / 8;
  if (state.tool === 'inspect') {
    select(Math.floor(y) * GRID_W + Math.floor(x));
  } else if (state.tool === 'implant') {
    coordinator.postMessage({ type: 'tool', tool: 'implant', x: Math.floor(x), y: Math.floor(y), radius: Math.max(1, state.brush / 3), genome: state.inoculum });
    toast('Inoculated. Whether it takes hold is up to the soup.');
  } else {
    coordinator.postMessage({ type: 'tool', tool: state.tool, x: x - 0.5, y: y - 0.5, radius: state.brush });
  }
}

// ---- selection and microscope --------------------------------------------------

const microscope = new Microscope($('scope'), {
  onClose: closeScope,
  onUseGenome: (genome) => {
    state.inoculum = genome;
    setSeg('tool', 'tool', 'implant');
    state.tool = 'implant';
    toast('Inoculator loaded with this genome. Click anywhere to plant it.');
  },
  onResample: (cell) => select(cell),
});

// Put a cell under the microscope. `species`, when given, is the key of the species
// the caller hopes to find there: cells change hands quickly, so if this one no longer
// holds it the coordinator picks another that does. `reveal` flies the camera there.
function select(cell, reveal = false, species = 0) {
  state.selected = cell;
  inspectId++;
  if (reveal) revealId = inspectId;
  coordinator.postMessage({ type: 'inspect', cell, id: inspectId, key: species });
}

function closeScope() {
  state.selected = -1;
  microscope.hide();
}

// The dock wraps onto more rows on narrow screens and the stats panel varies in height,
// so the panels that sit above or below them are positioned from their measured sizes.
function layoutHud() {
  const root = document.documentElement.style;
  root.setProperty('--above-dock', `${Math.round(window.innerHeight - $('dock').getBoundingClientRect().top + 12)}px`);
  if (window.innerWidth > 860) $('scope').style.top = `${$('stats').getBoundingClientRect().bottom + 12}px`;
  else $('scope').style.top = '';
}

// ---- HUD ---------------------------------------------------------------------


// The charted history of the current universe, if it has one and still applies
// (it only does with the default physics and no interference).
function charted(pristine = true) {
  if (!pristine || state.mut !== 4096 || state.limit !== DEFAULTS.stepLimit) return null;
  return KNOWN_UNIVERSES.find((u) => u.seed === state.seed) || null;
}

function story(s) {
  const share = s.alive / s.cells;
  const first = s.events.find((e) => e.type === 'birth');
  const author = s.pristine ? 'Nobody wrote them.' : 'You have had a hand in this universe.';
  if (!first) {
    const known = charted(s.pristine);
    const due = known ? ` This universe has been charted: life is due at epoch <b>${fmtInt(known.life)}</b>.` : '';
    if (s.epoch < 400) {
      return `<b>2,073,600 random bytes.</b> Neighbouring programs are glued together and run as code. Nothing here can copy itself.${due}`;
    }
    return `Still noise. By pure accident, <b>${fmtInt(s.capable)}</b> of the 32,400 programs contain a loop and a copy instruction. None of them breeds true.${due || ' Yet.'}`;
  }
  if (!s.living) {
    const history =
      s.births === 1
        ? `Life appeared at epoch <b>${fmtInt(first.epoch)}</b> and died out.`
        : `Life has appeared <b>${s.births} times</b> since epoch ${fmtInt(first.epoch)} and died out every time.`;
    return `${history} Its wreckage is still here: <b>${fmtInt(s.capable)}</b> programs can copy <i>something</i>.`;
  }
  const attempts = s.births > 1 ? ` It took ${s.births} attempts.` : '';
  if (share > 0.5) {
    return `The noise is gone. <b>${fmtInt(s.species)}</b> variants of self-replicating code now compete for every cell.${attempts} ${author}`;
  }
  return `Self-replicating programs hold <b>${fmtPct(share)}</b> of the universe.${attempts} ${author}`;
}

let speciesSignature = '';

function updateSpecies(s) {
  const living = s.top.filter((t) => t.replicator).slice(0, 4);
  $('species').hidden = living.length === 0;
  const list = $('species-list');
  const signature = living.map((t) => t.key).join(',');
  if (signature !== speciesSignature) {
    speciesSignature = signature;
    list.textContent = '';
    for (const t of living) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.title = 'Find one of these and put it under the microscope';
      const strip = document.createElement('canvas');
      strip.width = HALF;
      strip.height = 1;
      const img = new ImageData(HALF, 1);
      for (let i = 0; i < HALF; i++) {
        const c = byteColour(t.genome[i]);
        const lift = OP[t.genome[i]] ? 0 : 22;
        img.data.set([c[0] + lift, c[1] + lift, c[2] + lift, 255], i * 4);
      }
      strip.getContext('2d').putImageData(img, 0, 0);
      btn.innerHTML = `<span class="swatch" style="background:${rgb(speciesRgb(t.key))}"></span><span class="name">${speciesName(t.key)}</span><span class="share"></span>`;
      btn.append(strip);
      li.append(btn);
      list.append(li);
    }
  }
  living.forEach((t, i) => {
    const btn = list.children[i].firstChild;
    btn.querySelector('.share').textContent = fmtPct(t.count / s.cells);
    btn.onclick = () => select(t.cell, true, t.key);
  });
}

function onStats(s) {
  state.stats = s;
  state.events = s.events;
  $('s-eps').textContent = s.running ? fmtInt(s.eps) : 'paused';
  $('s-steps').textContent = s.running ? fmtBig(s.stepsPerSec) : '–';
  $('s-alive').textContent = fmtPct(s.alive / s.cells);
  $('threads').textContent = `${s.threads} threads`;
  $('threads').title = s.shared
    ? 'The threads share the soup in memory.'
    : 'Without shared memory, data is copied between threads. That is two to three times slower.';

  $('status').className = `status ${s.living ? 'alive' : 'sterile'}`;
  $('status-text').textContent = s.living ? 'Alive' : s.births ? 'Extinct' : 'Sterile';
  $('story').innerHTML = story(s);

  if (s.speciesImage) renderer.setSpecies(new Uint8Array(s.speciesImage));
  updateSpecies(s);
  sound.update(s, state.complexity);

  const h = state.history;
  if (!h.length || h[h.length - 1][0] !== s.epoch) {
    h.push([s.epoch, s.alive / s.cells]);
    if (h.length > 900) state.history = h.filter((_, i) => i % 2 === 0 || i > h.length - 200);
  }
  drawTimeline();
}

function onComplexity(data) {
  state.complexity = data.complexity;
  $('s-complexity').textContent = data.complexity.toFixed(2);
  const h = state.complexityHistory;
  // Snapshots from a previous universe can still be in flight after a reset.
  if (h.length && data.epoch < h[h.length - 1][0]) return;
  h.push([data.epoch, data.complexity]);
  if (h.length > 900) state.complexityHistory = h.filter((_, i) => i % 2 === 0 || i > h.length - 200);
  drawTimeline();
}

function drawTimeline() {
  const c = $('timeline');
  const g = c.getContext('2d');
  const W = c.width;
  const H = c.height;
  g.clearRect(0, 0, W, H);
  const lastEpoch = state.stats ? state.stats.epoch : 0;
  // While a charted universe is still sterile, leave room for the moment life is due.
  const known = state.events.length ? null : charted(state.stats ? state.stats.pristine : true);
  const span = Math.max(1000, lastEpoch, known ? known.life * 1.12 : 0);
  const X = (e) => (e / span) * W;
  if (known) {
    g.setLineDash([3, 7]);
    g.strokeStyle = 'rgba(92, 242, 166, 0.45)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(X(known.life), 0);
    g.lineTo(X(known.life), H);
    g.stroke();
    g.setLineDash([]);
  }

  g.strokeStyle = 'rgba(255,255,255,0.08)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, H - 0.5);
  g.lineTo(W, H - 0.5);
  g.stroke();

  const h = state.history;
  if (h.length > 1) {
    g.beginPath();
    g.moveTo(X(h[0][0]), H);
    for (const [e, a] of h) g.lineTo(X(e), H - a * (H - 6));
    g.lineTo(X(h[h.length - 1][0]), H);
    g.closePath();
    g.fillStyle = 'rgba(92, 242, 166, 0.22)';
    g.fill();
    g.beginPath();
    h.forEach(([e, a], i) => (i ? g.lineTo(X(e), H - a * (H - 6)) : g.moveTo(X(e), H - a * (H - 6))));
    g.strokeStyle = '#5cf2a6';
    g.lineWidth = 2.5;
    g.stroke();
  }

  const ch = state.complexityHistory;
  if (ch.length > 1) {
    const top = Math.max(1, ...ch.map((p) => p[1])) * 1.1;
    g.beginPath();
    ch.forEach(([e, v], i) => (i ? g.lineTo(X(e), H - (v / top) * (H - 6)) : g.moveTo(X(e), H - (v / top) * (H - 6))));
    g.strokeStyle = '#ffb020';
    g.lineWidth = 2.5;
    g.stroke();
  }

  // History: a tick for every birth, a dashed line for the first one and for the takeover.
  let firstBirth = true;
  for (const ev of state.events) {
    const x = X(ev.epoch);
    if (ev.type === 'birth') {
      g.fillStyle = '#5cf2a6';
      g.fillRect(x - 1.5, 0, 3, 12);
    }
    if ((ev.type === 'birth' && firstBirth) || ev.type === 'majority') {
      g.setLineDash([5, 5]);
      g.strokeStyle = ev.type === 'majority' ? 'rgba(255,176,32,0.85)' : 'rgba(255,255,255,0.55)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, H);
      g.stroke();
      g.setLineDash([]);
    }
    if (ev.type === 'birth') firstBirth = false;
  }
}

// ---- moments: birth, extinction, takeover --------------------------------------

let flashAt = -10; // seconds; the screen flashes white for a moment after this time
let marker = null; // { x, y, t0 } ring expanding from where life was first seen
let momentTimer = 0;

function genomeMarkup(genome) {
  let html = '';
  for (let i = 0; i < HALF; i++) {
    const b = genome[i];
    if (OP[b]) {
      const c = byteColour(b);
      html += `<i style="color:${rgb(c.map((v) => v * 0.6 + 100))};background:${rgb(c.map((v) => v * 0.24))}">${String.fromCharCode(b)}</i>`;
    } else {
      html += '<i>·</i>';
    }
  }
  return html;
}

// A full-screen card for the moments that matter. `action` is what its main button does.
let momentAction = null;

function showMoment({ when, title, text, genome, actionLabel, action, takeover = false }) {
  dismissIntro();
  flashAt = performance.now() / 1000;
  $('moment-when').textContent = when;
  $('moment-title').textContent = title;
  $('moment-text').textContent = text;
  $('moment-genome').innerHTML = genome ? genomeMarkup(genome) : '';
  $('moment-action').textContent = actionLabel;
  momentAction = action;
  const el = $('moment');
  el.classList.remove('leaving');
  el.classList.toggle('takeover', takeover);
  el.hidden = false;
  clearTimeout(momentTimer);
  momentTimer = setTimeout(hideMoment, 12000);
}

function hideMoment() {
  const el = $('moment');
  if (el.hidden) return;
  clearTimeout(momentTimer);
  el.classList.add('leaving');
  momentTimer = setTimeout(() => (el.hidden = true), 800);
}

$('moment-close').onclick = hideMoment;
$('moment-action').onclick = () => {
  hideMoment();
  if (momentAction) momentAction();
};

// Put a living cell under the microscope, preferring the latest census over `fallback`
// (which may have been overwritten since).
function inspectSomethingAlive(fallback) {
  const living = state.stats && state.stats.top.find((t) => t.replicator);
  if (living) select(living.cell, true, living.key);
  else select(fallback, true);
}

function onLifeEvent(ev, pristine) {
  state.events = [...state.events, ev];
  const epoch = `epoch ${fmtInt(ev.epoch)}`;
  if (ev.type === 'birth') sound.birth();
  else if (ev.type === 'extinction') sound.extinction();
  else if (ev.type === 'majority') sound.takeover();
  if (ev.type === 'birth') {
    marker = { x: (ev.cell % GRID_W) * 8 + 4, y: Math.floor(ev.cell / GRID_W) * 8 + 4, t0: performance.now() / 1000 };
    if (ev.number === 1) {
      showMoment({
        when: epoch,
        title: 'LIFE',
        text: pristine
          ? 'A program that copies itself now exists. Nobody wrote it.'
          : 'A program that copies itself has taken hold.',
        genome: ev.genome,
        actionLabel: 'Put it under the microscope',
        action: () => inspectSomethingAlive(ev.cell),
      });
    } else {
      toast(`${epoch}: life again, attempt ${ev.number}.`);
    }
  } else if (ev.type === 'extinction') {
    toast(`${epoch}: extinct. These replicators were too fragile to last.`);
  } else if (ev.type === 'majority') {
    const tries = state.events.filter((e) => e.type === 'birth').length;
    showMoment({
      when: epoch,
      title: 'TAKEOVER',
      text:
        tries > 1
          ? `After ${tries - 1} failed attempt${tries > 2 ? 's' : ''}, life now holds most of the universe. From here on it only competes with itself.`
          : 'Life now holds most of the universe. From here on it only competes with itself.',
      actionLabel: 'See who is who',
      action: () => setMode(1),
      takeover: true,
    });
  }
  drawTimeline();
}

// ---- controls ----------------------------------------------------------------

function setSeg(id, attr, value) {
  for (const b of $(id).children) b.setAttribute('aria-checked', String(b.dataset[attr] === String(value)));
}

function setRunning(running) {
  state.running = running;
  coordinator.postMessage({ type: 'run', running });
  $('play').classList.toggle('paused', !running);
  $('play').setAttribute('aria-label', running ? 'Pause' : 'Run');
}

const sound = new Sound();
$('sound').onclick = () => {
  const on = sound.toggle();
  $('sound').setAttribute('aria-pressed', String(on));
  if (on && state.stats) sound.update(state.stats, state.complexity);
};

$('play').onclick = () => setRunning(!state.running);
$('step').onclick = () => {
  if (state.running) setRunning(false);
  coordinator.postMessage({ type: 'step', count: 1 });
};

$('speed').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  setSeg('speed', 'eps', b.dataset.eps);
  coordinator.postMessage({ type: 'speed', eps: Number(b.dataset.eps) });
  if (!state.running) setRunning(true);
};

function setMode(mode) {
  state.mode = mode;
  setSeg('mode', 'mode', mode);
  $('legend').dataset.mode = mode;
}
$('mode').onclick = (e) => {
  const b = e.target.closest('button');
  if (b) setMode(Number(b.dataset.mode));
};

$('tool').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.tool = b.dataset.tool;
  setSeg('tool', 'tool', state.tool);
};
$('brush').oninput = (e) => (state.brush = Number(e.target.value));
$('fit').onclick = () => fitView();

$('mutation').value = String(state.mut);
if ($('mutation').value !== String(state.mut)) {
  $('mutation').add(new Option(`1 / ${fmtInt(state.mut)}`, String(state.mut), true, true));
}
$('mutation').onchange = (e) => {
  state.mut = Number(e.target.value);
  coordinator.postMessage({ type: 'set', mutation: state.mut > 0 ? 1 / state.mut : 0 });
  writeHash();
  toast(state.mut ? `Radiation set to 1 / ${fmtInt(state.mut)} per byte per epoch.` : 'Radiation off. Only the programs themselves change the soup now.');
};

function newUniverse(seed) {
  state.seed = seed;
  state.events = [];
  state.stats = null;
  state.history = [];
  state.complexityHistory = [];
  state.complexity = 0;
  speciesSignature = '';
  marker = null;
  closeScope();
  hideMoment();
  renderer.clearGlow();
  renderer.setSpecies(new Uint8Array(CELLS * 4));
  $('seed').value = seed;
  $('seed').style.width = `${Math.max(4, seed.length + 1)}ch`;
  $('s-complexity').textContent = '0.00';
  writeHash();
  coordinator.postMessage({ type: 'reset', params: universeParams() });
  if (!state.running) setRunning(true);
}

$('new').onclick = () => {
  newUniverse(randomSeed());
  toast('A new universe. Most stay sterile for a long time. Some never wake up.');
};

for (const u of KNOWN_UNIVERSES) {
  const fate = u.note || `takeover at ${fmtInt(u.takeover)}`;
  $('charted').add(new Option(`${u.seed} · life at ${fmtInt(u.life)} · ${fate}`, u.seed));
}
$('charted').onchange = (e) => {
  const seed = e.target.value;
  e.target.value = '';
  if (seed) newUniverse(seed);
};
$('seed').onchange = (e) => {
  const seed = e.target.value.trim();
  if (seed && seed !== state.seed) newUniverse(seed);
  else e.target.value = state.seed;
  e.target.blur();
};
$('share').onclick = async () => {
  writeHash();
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link copied. The same seed replays the same universe, byte for byte.');
  } catch {
    toast(location.href);
  }
};

$('help-open').onclick = () => $('help').showModal();
// On GitHub Pages the repository address follows from the page address.
if (location.hostname.endsWith('.github.io')) {
  const repo = location.pathname.split('/')[1];
  $('source-link').href = `https://github.com/${location.hostname.split('.')[0]}/${repo}`;
  $('source-link').hidden = !repo;
}

let toastTimer = 0;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
}

// The universe waits at epoch 0 behind the intro, and starts when the intro goes:
// on a click or a key, or by itself after a while. Returns true if it was showing.
// Visitors who have dismissed it themselves before (`byVisitor`) go straight in next time.
let introShowing = true;
function dismissIntro(byVisitor = false) {
  if (!introShowing) return false;
  introShowing = false;
  $('intro').classList.add('gone');
  setRunning(true);
  if (byVisitor) {
    try {
      localStorage.setItem('ex-nihilo-intro-seen', '1');
    } catch {
      // storage unavailable: the intro will simply show again next time
    }
  }
  return true;
}
$('begin').onclick = () => dismissIntro(true);
$('intro').onclick = (e) => {
  if (e.target === $('intro')) dismissIntro(true);
};

// The show starts by itself after 20 seconds, but only counted while the page is
// actually on screen: a tab opened in the background waits for its audience.
let autoStart = 0;
function armAutoStart() {
  clearTimeout(autoStart);
  if (introShowing && !document.hidden) autoStart = setTimeout(dismissIntro, 20000);
}
document.addEventListener('visibilitychange', armAutoStart);
armAutoStart();

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || $('help').open) return;
  // A focused button handles Space and Enter itself.
  if ((e.key === ' ' || e.key === 'Enter') && e.target instanceof HTMLButtonElement) return;
  if (dismissIntro(true)) return; // the first key press only starts the show
  const centre = () => [canvas.clientWidth / 2, canvas.clientHeight / 2];
  switch (e.key) {
    case ' ':
      e.preventDefault();
      setRunning(!state.running);
      break;
    case 's':
    case 'S':
      $('step').click();
      break;
    case 'f':
    case 'F':
    case '0':
      fitView();
      break;
    case '1':
    case '2':
    case '3':
      setMode(Number(e.key) - 1);
      break;
    case 'n':
    case 'N':
      $('new').click();
      break;
    case 'p':
    case 'P':
      screenshot();
      break;
    case 'm':
    case 'M':
      $('sound').click();
      break;
    case '?':
      $('help').showModal();
      break;
    case '+':
    case '=':
      zoomAt(...centre(), 1.6);
      break;
    case '-':
      zoomAt(...centre(), 1 / 1.6);
      break;
    case 'Escape':
      if (!$('moment').hidden) hideMoment();
      else closeScope();
      break;
  }
});

window.addEventListener('resize', () => {
  if (renderer.resize() && fitted) fitView(false);
  layoutHud();
});

window.addEventListener('hashchange', () => {
  const next = readHash();
  if (next.seed !== state.seed || next.mut !== state.mut || next.limit !== state.limit) {
    Object.assign(state, next);
    $('mutation').value = String(state.mut);
    newUniverse(state.seed);
  }
});

// ---- frame loop --------------------------------------------------------------

function renderOptions(t) {
  const d = dpr();
  const sinceFlash = t - flashAt;
  const opts = {
    mode: state.mode,
    time: t,
    flash: sinceFlash >= 0 && sinceFlash < 0.9 ? 0.6 * (1 - sinceFlash / 0.9) ** 2 : 0,
    // Bloom suits the wide view; up close it would smear the code, so it fades with zoom.
    bloom: 0.9 * clamp(1 - Math.log2(Math.max(1, view.zoom / d)) / 3.2, 0.12, 1),
  };
  if (state.selected >= 0) {
    const x = state.selected % GRID_W;
    const y = Math.floor(state.selected / GRID_W);
    opts.selected = [x, y, 1, 0];
    if (microscope.open && microscope.partnerKind === 'neighbour') opts.partner = [x + 1 < GRID_W ? x + 1 : x - 1, y, 0.8, 0];
  }
  if (hover && state.tool !== 'inspect') {
    const cells = state.tool === 'implant' ? Math.max(1, state.brush / 3) : state.brush;
    opts.brush = [hover.x, hover.y, cells * 8, 0.9];
  }
  if (marker) {
    const age = Math.max(0, t - marker.t0);
    if (age > 6) marker = null;
    else opts.marker = [marker.x, marker.y, (20 + age * 260) / (view.zoom / d), Math.max(0, 1 - age / 6)];
  }
  return opts;
}

let lastT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const t = now / 1000;
  const dt = Math.min(0.1, t - lastT);
  lastT = t;
  if (buffers) {
    coordinator.postMessage({ type: 'frame', bytes: buffers.bytes, heat: buffers.heat }, [buffers.bytes, buffers.heat]);
    buffers = null;
  }
  if (renderer.resize() && fitted) fitView(false);
  updateCamera(dt);
  microscope.tick(now);
  renderer.render(view, renderOptions(t));
}

// Save the canvas as a picture (PNG, or JPEG with { jpeg: true }). With { save: 'name' }
// it is posted to the dev server (tools/serve.ps1 -AllowSave) instead of downloaded.
// With { width, height } the picture is taken at that size whatever the window is,
// showing the whole universe unless { camera: { cx, cy, zoom } } says otherwise.
async function screenshot({ save, width, height, camera, jpeg = false } = {}) {
  const sized = width > 0 && height > 0;
  const before = { ...view };
  if (sized) {
    const scale = dpr();
    canvas.style.width = `${width / scale}px`;
    canvas.style.height = `${height / scale}px`;
    renderer.resize();
    const whole = { cx: WORLD_W / 2, cy: WORLD_H / 2, zoom: Math.min(renderer.width / WORLD_W, renderer.height / WORLD_H) };
    Object.assign(view, camera || whole);
  }
  // Not lastT: while the tab is in the background no frames are drawn and it goes stale.
  renderer.render(view, renderOptions(performance.now() / 1000));
  // toBlob copies the pixels now and encodes them later, so the canvas can go straight back.
  const extension = jpeg ? 'jpg' : 'png';
  const encoded = new Promise((resolve) => canvas.toBlob(resolve, jpeg ? 'image/jpeg' : 'image/png', 0.9));
  if (sized) {
    canvas.style.width = canvas.style.height = '';
    renderer.resize();
    Object.assign(view, before);
  }
  const blob = await encoded;
  if (save) {
    const res = await fetch(`/__save/${save}.${extension}`, { method: 'POST', headers: { 'X-Ex-Nihilo': 'save' }, body: blob });
    return res.text();
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ex-nihilo-${state.seed}-epoch-${frameEpoch}.${extension}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return a.download;
}

// ---- go ----------------------------------------------------------------------

$('seed').value = state.seed;
$('seed').style.width = `${Math.max(4, state.seed.length + 1)}ch`;
$('play').classList.add('paused');
writeHash();
fitView(false);
layoutHud();
requestAnimationFrame(frame);

let seenBefore = false;
try {
  seenBefore = localStorage.getItem('ex-nihilo-intro-seen') === '1';
} catch {
  // storage unavailable
}
if (seenBefore) dismissIntro();

// A small console API for tinkering.
window.exNihilo = { state, view, target, renderer, coordinator, newUniverse, select, fitView, flyTo, setMode, setRunning, screenshot };
