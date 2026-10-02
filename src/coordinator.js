// Coordinator worker: owns one universe and drives it as fast as the machine allows.
//
// Each epoch it takes the next pairing (computed ahead of time by the pair worker),
// shares the pairs out among the executor workers, and applies mutations when they
// are done. Pairs within an epoch never share a cell, so the outcome is identical
// however many threads take part. Between epochs it applies queued interventions,
// runs the species census and answers the UI.
//
// Where the page is cross-origin isolated the soup lives in shared memory and the
// executors work on it in place. Otherwise each executor is sent a packed copy of its
// pairs and the results are merged back here, which costs this thread about as much
// as the whole rest of the epoch.

import { Soup, PAIR_BYTES, skeletonKey } from './soup.js';
import { LifeDetector, paintSpecies } from './life.js';
import { assay, fidelity } from './assay.js';
import { HALF } from './bff.js';

const STATS_MS = 250; // how often the UI gets numbers
const CENSUS_MS = 250; // extra display-only censuses while something is alive
const METRICS_MS = 2000; // how often a snapshot goes to the complexity meter
const TOP_SPECIES = 6;

let soup = null;
let life = null;
let pristine = true; // false once the user has intervened
const executors = [];
let executorCapacity = 0; // most pairs one executor is given per epoch
let shared = typeof SharedArrayBuffer === 'function' && self.crossOriginIsolated === true;
let inEpoch = false;
const deferred = []; // inspect requests that arrived mid-epoch
let metricsPort = null;

let running = false;
let targetEps = 0; // 0 = unlimited
let stepsRequested = 0;
const commands = [];
let wake = null;

let census = null;
let alive = 0;
let top = [];
let speciesImage = null; // RGBA per cell, repainted at each census
let speciesFresh = false;

let lastStats = 0;
let lastCensus = 0;
let lastMetrics = 0;
let rateTime = 0;
let rateEpoch = 0;
let rateSteps = 0;
let eps = 0;
let stepsPerSec = 0;

class Executor {
  constructor(port) {
    this.port = port;
    this.resolve = null;
    if (!shared) this.setBuffer(new ArrayBuffer(executorCapacity * PAIR_BYTES));
    port.onmessage = ({ data }) => {
      if (data.buf) this.setBuffer(data.buf);
      this.resolve(data.steps);
    };
  }

  setBuffer(buf) {
    this.buf = buf;
    this.words = new Uint32Array(buf);
  }

  // Copied mode: run the `count` pairs packed into this.words.
  runPacked(count, limit) {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.port.postMessage({ buf: this.buf, count, limit }, [this.buf]);
    });
  }

  // Shared mode: run pairs [start, end) of the attached soup in place.
  runShared(start, end, limit) {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.port.postMessage({ start, end, limit });
    });
  }
}

// Pairings arrive from the pair worker, in order, a few epochs ahead.
let pairPort = null;
let pairGeneration = 0;
const pairQueue = [];
let pairWaiter = null;

function recyclePairs(buffer) {
  pairPort.postMessage({ type: 'recycle', buffer }, [buffer]);
}

function onPairs({ data }) {
  if (data.generation !== pairGeneration) {
    recyclePairs(data.buffer); // left over from a previous universe
    return;
  }
  pairQueue.push(data);
  if (pairWaiter) {
    const w = pairWaiter;
    pairWaiter = null;
    w();
  }
}

async function takePairs() {
  while (!pairQueue.length) await new Promise((resolve) => (pairWaiter = resolve));
  return pairQueue.shift();
}

function createUniverse(params) {
  soup = new Soup({ ...params, shared });
  if (shared) {
    for (const ex of executors) ex.port.postMessage({ attach: soup.share(), capacity: executorCapacity });
  }
  if (pairPort) {
    pairGeneration++;
    for (const stale of pairQueue.splice(0)) recyclePairs(stale.buffer);
    pairPort.postMessage({ type: 'start', generation: pairGeneration, seed: soup.seed, width: soup.W, height: soup.H });
  }
  life = new LifeDetector(soup.stepLimit);
  pristine = true;
  census = null;
  alive = 0;
  top = [];
  speciesImage = new Uint8Array(soup.N * 4);
  rateTime = performance.now();
  rateEpoch = 0;
  rateSteps = 0;
  eps = 0;
  stepsPerSec = 0;
  lastMetrics = 0;
  takeCensus(performance.now(), true);
}

async function epoch() {
  let count;
  let pairBuffer = null;
  if (pairPort) {
    const next = await takePairs();
    count = next.count;
    if (shared) {
      // The executors read the pairs from shared memory.
      soup.pairs.set(new Uint32Array(next.buffer, 0, 2 * count));
      recyclePairs(next.buffer);
    } else {
      pairBuffer = next.buffer;
      soup.pairs = new Uint32Array(pairBuffer);
    }
    soup.pairCount = count;
  } else {
    count = soup.makePairs();
  }

  inEpoch = true;
  const jobs = [];
  let start = 0;
  if (executors.length && count >= 256) {
    const per = Math.ceil(count / (executors.length + 1));
    for (const ex of executors) {
      const end = Math.min(count, start + per);
      if (end <= start) break;
      if (shared) {
        jobs.push({ done: ex.runShared(start, end, soup.stepLimit) });
      } else {
        soup.pack(start, end, ex.words);
        jobs.push({ ex, start, end, done: ex.runPacked(end - start, soup.stepLimit) });
      }
      start = end;
    }
  }
  // This thread takes the last share while the executors work.
  let steps = start < count ? soup.runInline(start, count) : 0;
  for (const job of jobs) {
    steps += await job.done;
    if (!shared) soup.unpack(job.start, job.end, job.ex.words);
  }
  soup.finishEpoch(steps);
  inEpoch = false;
  if (pairBuffer) recyclePairs(pairBuffer);
  for (const request of deferred.splice(0)) inspect(request);
}

// An official census can make history (births, extinctions); an unofficial one only
// refreshes what the UI shows. See life.js.
function takeCensus(now, official) {
  lastCensus = now;
  census = soup.census();
  const seen = life.observe(census, soup, official);
  alive = seen.alive;
  paintSpecies(soup, census, speciesImage);
  speciesFresh = true;
  top = census.groups.slice(0, TOP_SPECIES).map((g) => ({
    key: g.key,
    count: g.count,
    cell: g.cell,
    replicator: !!(g.verdict && g.verdict.replicator),
    genome: soup.programAt(g.cell),
  }));
  for (const event of seen.events) self.postMessage({ type: 'life', event, pristine });
}

function postStats(now) {
  const dt = (now - rateTime) / 1000;
  if (dt > 0.05) {
    const e = (soup.epoch - rateEpoch) / dt;
    const s = (soup.steps - rateSteps) / dt;
    eps = eps ? eps * 0.5 + e * 0.5 : e;
    stepsPerSec = stepsPerSec ? stepsPerSec * 0.5 + s * 0.5 : s;
    rateTime = now;
    rateEpoch = soup.epoch;
    rateSteps = soup.steps;
  }
  lastStats = now;
  const msg = {
    type: 'stats',
    epoch: soup.epoch,
    censusEpoch: census.epoch,
    running: running || stepsRequested > 0,
    eps: running ? eps : 0,
    stepsPerSec: running ? stepsPerSec : 0,
    totalSteps: soup.steps,
    cells: soup.N,
    alive,
    capable: census.capable,
    species: census.species,
    density: census.instructionDensity,
    threads: executors.length + 1,
    shared,
    pristine,
    living: life.living,
    births: life.births,
    events: life.events,
    top,
    speciesImage: null,
  };
  if (speciesFresh) {
    speciesFresh = false;
    msg.speciesImage = speciesImage.slice();
  }
  self.postMessage(msg);
}

function afterEpoch(now) {
  // In an untouched universe, history is only made by censuses on the fixed epoch
  // schedule, so that it depends on the seed alone and not on how fast this machine
  // is. Once the user has intervened there is nothing to reproduce, and every census counts.
  if (pristine && life.due(soup.epoch)) takeCensus(now, true);
  else if ((life.living || !pristine) && now - lastCensus >= CENSUS_MS) takeCensus(now, !pristine);
  if (now - lastStats >= STATS_MS) postStats(now);
  if (metricsPort && now - lastMetrics >= METRICS_MS) {
    lastMetrics = now;
    const copy = soup.bytes.slice();
    metricsPort.postMessage({ epoch: soup.epoch, bytes: copy.buffer }, [copy.buffer]);
  }
}

function applyTool(c) {
  if (c.tool === 'irradiate') soup.irradiate(c.x, c.y, c.radius);
  else if (c.tool === 'sterilize') soup.sterilize(c.x, c.y, c.radius);
  else if (c.tool === 'implant') {
    soup.forDisk(c.x, c.y, c.radius, (cell) => soup.implant(cell, c.genome));
  }
  pristine = false;
}

function applyCommands() {
  if (!commands.length) return;
  let touched = false;
  for (const c of commands.splice(0)) {
    switch (c.type) {
      case 'reset':
        createUniverse(c.params);
        touched = false;
        postStats(performance.now());
        break;
      case 'run':
        running = c.running;
        rateTime = performance.now();
        rateEpoch = soup ? soup.epoch : 0;
        rateSteps = soup ? soup.steps : 0;
        if (soup) postStats(performance.now());
        break;
      case 'speed':
        targetEps = c.eps;
        break;
      case 'step':
        stepsRequested += c.count || 1;
        break;
      case 'set':
        if (!soup) break;
        if (c.mutation !== undefined) soup.mutation = c.mutation;
        if (c.stepLimit !== undefined && c.stepLimit !== soup.stepLimit) {
          // Verdicts depend on the step budget, so start a fresh detector but keep the history.
          soup.stepLimit = c.stepLimit;
          const old = life;
          life = new LifeDetector(soup.stepLimit);
          life.living = old.living;
          life.births = old.births;
          life.majority = old.majority;
          life.events = old.events;
        }
        pristine = false;
        break;
      case 'tool':
        if (!soup) break;
        applyTool(c);
        touched = true;
        break;
    }
  }
  if (touched) {
    const now = performance.now();
    takeCensus(now, true);
    postStats(now);
  }
}

// A macrotask yield, so queued messages get handled between epochs.
const tickChannel = new MessageChannel();
let tickResolve = null;
tickChannel.port1.onmessage = () => {
  const r = tickResolve;
  tickResolve = null;
  r();
};
function tick() {
  return new Promise((resolve) => {
    tickResolve = resolve;
    tickChannel.port2.postMessage(0);
  });
}

// Sleep that a command (but not a frame request) can cut short.
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

async function loop() {
  for (;;) {
    applyCommands();
    if (!soup || (!running && stepsRequested === 0)) {
      await new Promise((resolve) => (wake = resolve));
      continue;
    }
    const t0 = performance.now();
    await epoch();
    if (stepsRequested > 0) {
      stepsRequested--;
      const now = performance.now();
      if (stepsRequested === 0 && !running) {
        takeCensus(now, pristine ? life.due(soup.epoch) : true);
        postStats(now);
        continue;
      }
    }
    afterEpoch(performance.now());
    if (running && targetEps > 0) {
      const wait = 1000 / targetEps - (performance.now() - t0);
      if (wait > 1) await sleep(wait);
      else await tick();
    } else {
      await tick();
    }
  }
}

function serveFrame(data) {
  if (soup) {
    new Uint8Array(data.bytes).set(soup.bytes);
    new Uint8Array(data.heat).set(soup.heat);
    soup.heat.fill(0);
  }
  self.postMessage({ type: 'frame', bytes: data.bytes, heat: data.heat, epoch: soup ? soup.epoch : 0 }, [
    data.bytes,
    data.heat,
  ]);
}

// Report on one cell. If the caller was after a particular species (`data.key`) and
// the cell has been overwritten since the census that suggested it, report on another
// cell that holds that species now, if there is one.
function inspect(data) {
  if (!soup) return;
  let cell = data.cell;
  if (data.key && skeletonKey(soup.bytes, cell * HALF) !== data.key) {
    for (let p = 0; p < soup.N; p++) {
      if (skeletonKey(soup.bytes, p * HALF) === data.key) {
        cell = p;
        break;
      }
    }
  }
  const x = cell % soup.W;
  const y = (cell / soup.W) | 0;
  const genome = soup.programAt(cell);
  const neighbour = x + 1 < soup.W ? cell + 1 : cell - 1;
  const key = skeletonKey(genome);
  const verdict = assay(genome, soup.stepLimit);
  let population = 0;
  if (census && key) {
    for (const g of census.groups) {
      if (g.key === key) {
        population = g.count;
        break;
      }
    }
  }
  self.postMessage({
    type: 'inspect',
    id: data.id,
    cell,
    x,
    y,
    epoch: soup.epoch,
    genome,
    partner: soup.programAt(neighbour),
    key,
    population,
    verdict,
    fidelity: verdict.replicator ? fidelity(genome, soup.stepLimit, verdict.left) : null,
    stepLimit: soup.stepLimit,
  });
}

self.onmessage = ({ data }) => {
  switch (data.type) {
    case 'init': {
      if (data.shared === false) shared = false;
      const shares = data.ports.length + 1;
      executorCapacity = Math.ceil(((data.params.width * data.params.height) >> 1) / shares) + 1;
      for (const port of data.ports) executors.push(new Executor(port));
      metricsPort = data.metricsPort || null;
      pairPort = data.pairPort || null;
      if (pairPort) pairPort.onmessage = onPairs;
      running = !!data.running;
      targetEps = data.eps || 0;
      commands.push({ type: 'reset', params: data.params });
      break;
    }
    case 'frame':
      serveFrame(data);
      return;
    case 'inspect':
      // Mid-epoch, other threads may be halfway through rewriting the cell.
      if (inEpoch && shared) deferred.push(data);
      else inspect(data);
      return;
    default:
      commands.push(data);
  }
  if (wake) {
    const w = wake;
    wake = null;
    w();
  }
};

loop();
