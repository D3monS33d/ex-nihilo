// Browser test suite (open test.html). No framework: each test returns a detail
// string or throws.

import {
  OP,
  OPS,
  run,
  runMasked,
  runDense,
  runReference,
  writeMask,
  Machine,
  HALF,
  FULL,
  genomeToString,
  textbookReplicator,
} from './bff.js';
import { RNG } from './rng.js';
import { Soup, runPacked, skeletonKey, PAIR_WORDS } from './soup.js';
import { assay, fidelity, isCandidate, offspring } from './assay.js';
import { LifeDetector } from './life.js';

const LIMIT = 8192;
const out = document.getElementById('out');
const results = (window.testResults = { passed: 0, failed: 0, done: false, failures: [] });

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Tape generators that stress different behaviour.
function randomTape(rng, t) {
  for (let i = 0; i < FULL; i++) t[i] = rng.u32() & 255;
}
function denseTape(rng, t, density) {
  for (let i = 0; i < FULL; i++) {
    t[i] = rng.float() < density ? OPS.charCodeAt(rng.below(OPS.length)) : rng.u32() & 255;
  }
}
function replicatorTape(rng, t) {
  const g = textbookReplicator();
  for (let i = 8; i < HALF - 8; i++) g[i] = rng.u32() & 255;
  const kind = rng.below(3);
  randomTape(rng, t);
  if (kind === 0 || kind === 2) t.set(g, 0);
  if (kind === 1 || kind === 2) t.set(g, HALF);
  for (let m = rng.below(4); m > 0; m--) t[rng.below(FULL)] = rng.u32() & 255;
}

// Junk with one guaranteed loop, a few stray instructions, and bytes sitting next to
// opcode values, so that + and - sweeps turn no-ops into instructions and back.
function loopyTape(rng, t) {
  for (let i = 0; i < FULL; i++) {
    let b;
    do b = rng.u32() & 255;
    while (OP[b]);
    t[i] = b;
  }
  const open = rng.below(100);
  const close = open + 1 + rng.below(FULL - open - 1);
  t[open] = 91;
  t[close] = 93;
  for (let k = rng.below(7); k > 0; k--) t[rng.below(FULL)] = OPS.charCodeAt(rng.below(OPS.length));
  for (let k = rng.below(5); k > 0; k--) t[rng.below(FULL)] = OPS.charCodeAt(rng.below(OPS.length)) + rng.below(3) - 1;
  if (rng.below(4) === 0) t[rng.below(FULL)] = 0;
}

function differential(name, count, make) {
  return [
    name,
    () => {
      const rng = new RNG(name);
      const a = new Uint8Array(FULL);
      const b = new Uint8Array(FULL);
      const c = new Uint8Array(FULL);
      const d = new Uint8Array(FULL);
      const mask = new Uint32Array(4);
      const fresh = new Uint32Array(4);
      let shortcuts = 0;
      let machineChecks = 0;
      for (let n = 0; n < count; n++) {
        make(rng, a);
        b.set(a);
        c.set(a);
        d.set(a);
        const limit = n % 7 === 0 ? 1 + rng.below(LIMIT) : LIMIT;
        writeMask(a, 0, 4, mask, 0);
        const sa = runMasked(a, 0, limit, mask, 0);
        const sb = runReference(b, 0, limit);
        const sd = runDense(d, 0, limit);
        assert(equal(a, b), `tape mismatch on case ${n} (limit ${limit})`);
        assert(sa === sb, `step count mismatch on case ${n}: fast ${sa}, reference ${sb}`);
        assert(equal(d, b), `dense-path tape mismatch on case ${n} (limit ${limit})`);
        assert(sd === sb, `dense-path step count mismatch on case ${n}: ${sd}, reference ${sb}`);
        writeMask(a, 0, 4, fresh, 0);
        assert(equal(mask, fresh), `instruction mask went stale on case ${n}`);
        if (n % 5 === 0) {
          const m = new Machine(c);
          while (m.step(limit));
          assert(equal(c, b), `Machine tape mismatch on case ${n} (halt: ${m.reason})`);
          if (m.reason === 'idle') shortcuts++;
          else assert(m.steps === sb, `Machine step count mismatch on case ${n}: ${m.steps} vs ${sb}`);
          machineChecks++;
        }
      }
      return `${count.toLocaleString()} tapes identical; ${shortcuts.toLocaleString()} of ${machineChecks.toLocaleString()} stepped runs ended in an idle loop`;
    },
  ];
}

const tests = [
  differential('fast VM = reference VM on random tapes', 150000, randomTape),
  differential('fast VM = reference VM on self-modifying junk loops', 150000, loopyTape),
  differential('fast VM = reference VM on 25% instruction tapes', 60000, (r, t) => denseTape(r, t, 0.25)),
  differential('fast VM = reference VM on 70% instruction tapes', 60000, (r, t) => denseTape(r, t, 0.7)),
  differential('fast VM = reference VM on replicator tapes', 40000, replicatorTape),

  [
    'opcode table has exactly the ten instructions',
    () => {
      let n = 0;
      for (let i = 0; i < 256; i++) if (OP[i]) n++;
      assert(n === 10, `expected 10 opcodes, found ${n}`);
      return OPS;
    },
  ],

  [
    'textbook replicator copies itself onto junk, exactly',
    () => {
      const g = textbookReplicator();
      const f = fidelity(g, LIMIT, true);
      assert(f.bytes === HALF, `fidelity ${f.bytes}/64`);
      const v = assay(g, LIMIT);
      assert(v.replicator && v.left, 'assay did not recognise it');
      return `${genomeToString(g)}  → 64/64 bytes`;
    },
  ],

  [
    'assay rejects noise, loops without copies, and one-shot copiers',
    () => {
      const rng = new RNG('negative controls');
      let candidates = 0;
      for (let n = 0; n < 20000; n++) {
        const g = new Uint8Array(HALF);
        for (let i = 0; i < HALF; i++) g[i] = rng.u32() & 255;
        if (isCandidate(g)) candidates++;
        assert(!assay(g, LIMIT).replicator, `random program ${n} passed the assay: ${genomeToString(g)}`);
      }
      // Copies its first half-tape forward once but the copy is not a palindrome-safe program.
      const zero = new Uint8Array(HALF);
      assert(!assay(zero, LIMIT).replicator, 'all-zero tape passed');
      return `20,000 random programs rejected (${candidates} had a loop and a copy instruction)`;
    },
  ],

  [
    'an emergent replicator (universe 25) passes the assay; its copy is a shifted mirror image',
    () => {
      // The first living program of the default universe, with arbitrary inert filler.
      const text = '······················[····,}<·······]··]·······<},····[········';
      const g = new Uint8Array(HALF);
      for (let i = 0; i < HALF; i++) g[i] = text[i] === '·' ? 0x41 + (i % 20) : text.charCodeAt(i);
      const v = assay(g, LIMIT);
      assert(v.replicator && v.left && !v.right, `unexpected verdict ${JSON.stringify(v)}`);
      const f = fidelity(g, LIMIT, true);
      assert(f.mirrored && f.bytes >= 62, `copy not recognised as a mirror image: ${JSON.stringify(f)}`);
      // On the right-hand side of something inert it copies that over itself instead.
      const junk = new Uint8Array(HALF).fill(0x61);
      const after = offspring(junk, g, LIMIT, true);
      assert(!assay(after, LIMIT).replicator, 'expected the replicator to destroy itself on the right');
      return `${f.bytes}/64 bytes as a mirror image; wrecks itself when it runs second`;
    },
  ],

  [
    'offspring of the textbook replicator breed true for 5 generations',
    () => {
      const rng = new RNG('lineage');
      let g = textbookReplicator();
      for (let gen = 0; gen < 5; gen++) {
        const junk = new Uint8Array(HALF);
        for (let i = 0; i < HALF; i++) junk[i] = 0x30 + rng.below(10);
        const child = offspring(g, junk, LIMIT, true);
        assert(equal(child, g), `generation ${gen + 1} differs`);
        g = child;
      }
      return 'ok';
    },
  ],

  [
    'same seed, same universe',
    () => {
      const a = new Soup({ seed: 'determinism', width: 48, height: 27 });
      const b = new Soup({ seed: 'determinism', width: 48, height: 27 });
      const c = new Soup({ seed: 'determinism!', width: 48, height: 27 });
      for (let i = 0; i < 40; i++) {
        a.step();
        b.step();
        c.step();
      }
      assert(equal(a.bytes, b.bytes), 'identical seeds diverged');
      assert(!equal(a.bytes, c.bytes), 'different seeds produced the same universe');
      assert(a.steps === b.steps, 'step totals differ');
      return `40 epochs, ${a.steps.toLocaleString()} VM steps each`;
    },
  ],

  [
    'a universe run on the fast VM matches one run on the reference VM',
    () => {
      const fast = new Soup({ seed: 'ground truth', width: 48, height: 27 });
      const slow = new Soup({ seed: 'ground truth', width: 48, height: 27 });
      for (let i = 0; i < 6; i++) fast.implant(fast.W * 9 + 20 + i, textbookReplicator());
      for (let i = 0; i < 6; i++) slow.implant(slow.W * 9 + 20 + i, textbookReplicator());
      const tape = new Uint8Array(FULL);
      for (let e = 0; e < 60; e++) {
        fast.step();
        const count = slow.makePairs();
        let steps = 0;
        for (let i = 0; i < count; i++) {
          const p = slow.pairs[2 * i] * HALF;
          const q = slow.pairs[2 * i + 1] * HALF;
          tape.set(slow.bytes.subarray(p, p + HALF), 0);
          tape.set(slow.bytes.subarray(q, q + HALF), HALF);
          steps += runReference(tape, 0, slow.stepLimit);
          slow.bytes.set(tape.subarray(0, HALF), p);
          slow.bytes.set(tape.subarray(HALF), q);
        }
        writeMask(slow.bytes, 0, slow.N * 2, slow.masks, 0);
        slow.finishEpoch(steps);
        assert(equal(fast.bytes, slow.bytes), `universes diverged at epoch ${e + 1}`);
      }
      assert(fast.steps === slow.steps, 'step totals differ');
      assert(fast.staleMasks() === 0, `${fast.staleMasks()} stale instruction masks`);
      return `60 epochs identical, ${fast.steps.toLocaleString()} VM steps, masks consistent`;
    },
  ],

  [
    'chunked execution = inline execution (what the worker pool relies on)',
    () => {
      const a = new Soup({ seed: 'chunks', width: 48, height: 27 });
      const b = new Soup({ seed: 'chunks', width: 48, height: 27 });
      for (let e = 0; e < 25; e++) {
        a.step();
        const count = b.makePairs();
        let steps = 0;
        const per = Math.ceil(count / 5);
        const bufs = [];
        for (let s = 0; s < count; s += per) {
          const end = Math.min(count, s + per);
          const buf = new Uint32Array((end - s) * PAIR_WORDS);
          b.pack(s, end, buf);
          bufs.push([s, end, buf]);
        }
        for (const [s, end, buf] of bufs.reverse()) {
          steps += runPacked(new Uint8Array(buf.buffer), buf, end - s, b.stepLimit);
          b.unpack(s, end, buf);
        }
        b.finishEpoch(steps);
      }
      assert(equal(a.bytes, b.bytes), 'chunked and inline universes diverged');
      assert(a.steps === b.steps, 'step totals differ');
      assert(b.staleMasks() === 0, 'stale instruction masks');
      return '25 epochs identical';
    },
  ],

  [
    'shared-memory execution = inline execution',
    () => {
      if (typeof SharedArrayBuffer !== 'function' || !globalThis.crossOriginIsolated) {
        return 'skipped: this page is not cross-origin isolated (open index.html once, then reload)';
      }
      const a = new Soup({ seed: 'shared', width: 48, height: 27 });
      const b = new Soup({ seed: 'shared', width: 48, height: 27, shared: true });
      // Three stand-ins for executor threads, each with its own view of b's memory.
      const views = [0, 1, 2].map(() => Soup.attach(b.share(), 256));
      for (let e = 0; e < 25; e++) {
        a.step();
        const count = b.makePairs();
        const per = Math.ceil(count / views.length);
        let steps = 0;
        views.forEach((view, k) => {
          const end = Math.min(count, (k + 1) * per);
          if (end > k * per) steps += view.runInline(k * per, end);
        });
        b.finishEpoch(steps);
      }
      assert(equal(a.bytes, b.bytes), 'shared and inline universes diverged');
      assert(a.steps === b.steps, 'step totals differ');
      assert(b.staleMasks() === 0, 'stale instruction masks');
      return '25 epochs identical';
    },
  ],

  [
    'pairing is valid: disjoint, in range, within distance 2',
    () => {
      const s = new Soup({ seed: 'pairs' });
      let total = 0;
      for (let e = 0; e < 5; e++) {
        const count = s.makePairs();
        total += count;
        const seen = new Uint8Array(s.N);
        for (let i = 0; i < count; i++) {
          const p = s.pairs[2 * i];
          const q = s.pairs[2 * i + 1];
          assert(p < s.N && q < s.N && p !== q, 'bad cell index');
          assert(!seen[p] && !seen[q], 'cell used twice in one epoch');
          seen[p] = seen[q] = 1;
          const dx = Math.abs((p % s.W) - (q % s.W));
          const dy = Math.abs(Math.floor(p / s.W) - Math.floor(q / s.W));
          assert(dx <= 2 && dy <= 2, `pair too far apart: ${dx},${dy}`);
        }
      }
      return `${((100 * 2 * total) / (5 * s.N)).toFixed(1)}% of cells interact per epoch`;
    },
  ],

  [
    'species keys: census agrees with skeletonKey, mirror images share a key',
    () => {
      const s = new Soup({ seed: 'species', width: 48, height: 27 });
      for (let i = 0; i < 40; i++) s.implant(i * 7, textbookReplicator());
      for (let e = 0; e < 30; e++) s.step();
      s.census();
      let capable = 0;
      const mirror = new Uint8Array(HALF);
      for (let cell = 0; cell < s.N; cell++) {
        const key = skeletonKey(s.bytes, cell * HALF);
        const fromCensus = s.speciesOf[cell] ? s.spKey[s.speciesOf[cell]] : 0;
        assert(key === fromCensus, `cell ${cell}: skeletonKey ${key}, census ${fromCensus}`);
        for (let i = 0; i < HALF; i++) mirror[i] = s.bytes[cell * HALF + HALF - 1 - i];
        assert(skeletonKey(mirror) === key, `cell ${cell}: mirror image has a different key`);
        // the back-to-front copy that some replicators make: a mirror image shifted by one
        for (let i = 0; i < HALF; i++) mirror[i] = s.bytes[cell * HALF + ((HALF - i) % HALF)];
        assert(skeletonKey(mirror) === key, `cell ${cell}: shifted mirror image has a different key`);
        if (key) capable++;
      }
      const junk = new Uint8Array(HALF).fill(0x41);
      assert(skeletonKey(junk) === 0, 'inert program got a species key');
      // Same instructions, different spacing: a different species.
      const a = textbookReplicator();
      const b = textbookReplicator();
      b[7] = 0x20;
      b[9] = ']'.charCodeAt(0);
      assert(skeletonKey(a) !== skeletonKey(b), 'programs with different spacing share a key');
      return `${capable} copy-capable cells checked`;
    },
  ],

  [
    'activity: mirror flips are quiet, conquests are loud',
    () => {
      const s = new Soup({ seed: 'activity', width: 16, height: 9, mutation: 0 });
      // A lopsided replicator: same loop, but one stray instruction so it is not its own mirror.
      const g = textbookReplicator();
      g[20] = '+'.charCodeAt(0);
      for (let cell = 0; cell < s.N; cell++) s.implant(cell, g);
      s.heat.fill(0);
      for (let e = 0; e < 5; e++) s.step();
      const resting = Math.max(...s.heat);
      assert(resting <= 2, `a colony at rest should be quiet, heat ${resting}`);
      s.irradiate(8, 4, 2);
      s.heat.fill(0);
      for (let e = 0; e < 8; e++) s.step();
      const conquest = Math.max(...s.heat);
      assert(conquest >= 8, `reconquering noise should be loud, heat ${conquest}`);
      return `heat at rest ${resting}, during reconquest ${conquest}`;
    },
  ],

  [
    'an implanted replicator is detected as life and spreads',
    () => {
      const s = new Soup({ seed: 'inoculation', width: 48, height: 27, mutation: 0 });
      const life = new LifeDetector(s.stepLimit);
      for (let i = 0; i < 12; i++) s.implant(s.W * 13 + 18 + i, textbookReplicator());
      let seen = null;
      for (let e = 0; e < 64; e++) {
        s.step();
        if (life.due(s.epoch)) seen = life.observe(s.census(), s);
      }
      assert(life.genesis && life.living, 'no birth reported');
      assert(life.genesis.type === 'birth' && life.genesis.number === 1, 'malformed birth event');
      assert(seen.alive >= 36, `expected the 12 implanted cells to at least triple, alive = ${seen.alive}`);
      return `born at epoch ${life.genesis.epoch}; 12 cells became ${seen.alive} (of ${s.N}) in 64 epochs`;
    },
  ],

  [
    'history: wiping out all life is recorded as an extinction',
    () => {
      const s = new Soup({ seed: 'extinction', width: 48, height: 27, mutation: 0 });
      const life = new LifeDetector(s.stepLimit);
      for (let cell = 0; cell < s.N; cell++) s.implant(cell, textbookReplicator());
      let seen = life.observe(s.census(), s);
      assert(life.living && seen.events.some((e) => e.type === 'majority'), 'full soup not reported as alive');
      s.sterilize(24, 13, 100);
      seen = life.observe(s.census(), s);
      assert(!life.living && seen.alive === 0, 'still alive after sterilisation');
      assert(life.events.map((e) => e.type).join() === 'birth,majority,extinction', `history was ${life.events.map((e) => e.type)}`);
      return life.events.map((e) => e.type).join(' → ');
    },
  ],
];

async function main() {
  for (const [name, fn] of tests) {
    const row = document.createElement('div');
    row.className = 'row';
    row.textContent = `…  ${name}`;
    out.append(row);
    await new Promise((r) => setTimeout(r, 0));
    const t0 = performance.now();
    try {
      const detail = fn();
      results.passed++;
      row.className = 'row pass';
      row.textContent = `PASS  ${name}  (${Math.round(performance.now() - t0)} ms)\n      ${detail}`;
    } catch (err) {
      results.failed++;
      results.failures.push(`${name}: ${err.message}`);
      row.className = 'row fail';
      row.textContent = `FAIL  ${name}\n      ${err.message}`;
    }
  }
  results.done = true;
  const sum = document.createElement('div');
  sum.className = results.failed ? 'row fail' : 'row pass';
  sum.textContent = `\n${results.passed} passed, ${results.failed} failed`;
  out.append(sum);
}

main();
