// The primordial soup: a 2D grid of 64-byte programs that start as pure noise.
//
// Each epoch, programs are paired with a random nearby neighbour. The two tapes are
// concatenated, the result is executed as code, and the tape is split back into the
// two cells. That is the entire physics. Nothing here knows what a replicator is.

import { OP, runMasked, writeMask, HALF, FULL } from './bff.js';
import { RNG } from './rng.js';
import { Pairing } from './pairing.js';

export const DEFAULTS = Object.freeze({
  width: 240,
  height: 135,
  seed: 'ex nihilo',
  mutation: 1 / 4096, // probability per byte per epoch (the paper's default)
  stepLimit: 8192, // execution budget per interaction (the paper's default)
});

const WORDS = HALF / 4; // 32-bit words per program

// Pairs are executed from a packed buffer: 128 tape bytes, then the two programs'
// instruction masks (2 words each), then one word that the executor fills with how
// much each program was rewired. Worker threads receive these buffers.
const MASKS_AT = FULL / 4;
const REWIRED_AT = MASKS_AT + 4;
export const PAIR_WORDS = REWIRED_AT + 1;
export const PAIR_BYTES = PAIR_WORDS * 4;

// A species needs at least this many members to be reported by the census.
export const GROUP_MIN = 4;

const BIT_OPEN = 1 << 9;
const BIT_CLOSE = 1 << 10;
const BIT_COPY = (1 << 7) | (1 << 8);

// The minimum equipment for copying anything: a loop and a copy instruction.
function flagsAreCandidate(flags) {
  return (flags & BIT_OPEN) !== 0 && (flags & BIT_CLOSE) !== 0 && (flags & BIT_COPY) !== 0;
}

// Species identity.
//
// The replicators that emerge here copy themselves back to front, so a child is the
// mirror image of its parent, often shifted by a byte, and the grandchild is the parent
// again. Calling those two forms different species would be silly. So a species is
// defined by its instructions and the gaps between them, read as a ring: reflecting
// or rotating a program does not change its species. The inert bytes in between are
// ignored.
//
// The key is a 53-bit hash, or 0 for programs with no loop or no copy instruction.

const SIG_POS = new Uint8Array(HALF);
const SIG_OP = new Uint8Array(HALF);

function mix(x) {
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
  return x ^ (x >>> 15);
}

// Key for the n instructions listed (by ascending position) in SIG_POS / SIG_OP: a sum
// over every run of two and of three neighbouring instructions around the ring, each
// run hashed in a way that reads the same in both directions.
function signature(n) {
  let h1 = 0;
  let h2 = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 < n ? i + 1 : 0;
    const k = j + 1 < n ? j + 1 : 0;
    const a = SIG_OP[i];
    const b = SIG_OP[j];
    const c = SIG_OP[k];
    const g1 = (SIG_POS[j] - SIG_POS[i]) & (HALF - 1);
    const g2 = (SIG_POS[k] - SIG_POS[j]) & (HALF - 1);
    h1 = (h1 + mix(a < b ? (a << 12) | (b << 8) | g1 : (b << 12) | (a << 8) | g1)) | 0;
    h2 =
      (h2 +
        mix(a | (g1 << 4) | (b << 11) | (g2 << 15) | (c << 22)) +
        mix(c | (g2 << 4) | (b << 11) | (g1 << 15) | (a << 22))) |
      0;
  }
  return (h1 >>> 0) * 2097152 + (h2 >>> 11) || 1;
}

// Species key of a single 64-byte program. Soup.census() computes the same keys
// (faster, from the masks) for every cell.
export function skeletonKey(bytes, o = 0) {
  let n = 0;
  let flags = 0;
  for (let i = 0; i < HALF; i++) {
    const op = OP[bytes[o + i]];
    if (op !== 0) {
      flags |= 1 << op;
      SIG_POS[n] = i;
      SIG_OP[n] = op;
      n++;
    }
  }
  return flagsAreCandidate(flags) ? signature(n) : 0;
}

function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function reverseBits(x) {
  x = ((x >>> 1) & 0x55555555) | ((x & 0x55555555) << 1);
  x = ((x >>> 2) & 0x33333333) | ((x & 0x33333333) << 2);
  x = ((x >>> 4) & 0x0f0f0f0f) | ((x & 0x0f0f0f0f) << 4);
  x = ((x >>> 8) & 0x00ff00ff) | ((x & 0x00ff00ff) << 8);
  return (x >>> 16) | (x << 16);
}

// How much one interaction rewired a program: the number of positions that changed
// between instruction and no-op, given its instruction mask before and after. A
// program replaced by its own mirror image (exact, or shifted one byte either way)
// counts as unchanged, so a colony of replicators at rest is quiet and only real
// conquests score.
function rewiring(old0, old1, new0, new1) {
  let best = popcount(old0 ^ new0) + popcount(old1 ^ new1);
  if (best <= 2) return best;
  const r0 = reverseBits(old1);
  const r1 = reverseBits(old0);
  let d = popcount(r0 ^ new0) + popcount(r1 ^ new1);
  if (d < best) best = d;
  if (best <= 2) return best;
  d = popcount(((r0 << 1) | (r1 >>> 31)) ^ new0) + popcount(((r1 << 1) | (r0 >>> 31)) ^ new1);
  if (d < best) best = d;
  d = popcount(((r0 >>> 1) | (r1 << 31)) ^ new0) + popcount(((r1 >>> 1) | (r0 << 31)) ^ new1);
  return d < best ? d : best;
}

// Execute `count` packed pairs in place. Returns the number of VM steps taken.
export function runPacked(bytes, words, count, limit) {
  let steps = 0;
  for (let i = 0; i < count; i++) {
    const m = i * PAIR_WORDS + MASKS_AT;
    const a0 = words[m];
    const a1 = words[m + 1];
    const b0 = words[m + 2];
    const b1 = words[m + 3];
    steps += runMasked(bytes, i * PAIR_BYTES, limit, words, m);
    words[i * PAIR_WORDS + REWIRED_AT] =
      rewiring(a0, a1, words[m], words[m + 1]) | (rewiring(b0, b1, words[m + 2], words[m + 3]) << 8);
  }
  return steps;
}

export class Soup {
  constructor(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    this.W = o.width;
    this.H = o.height;
    this.N = this.W * this.H;
    this.seed = String(o.seed);
    this.mutation = o.mutation;
    this.stepLimit = o.stepLimit;
    this.rng = new RNG(this.seed);

    // With `shared`, the soup lives in SharedArrayBuffers so that executor threads can
    // work on it in place (see attach) instead of being sent copies.
    const alloc = (bytes) => (o.shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes));

    this.buffer = alloc(this.N * HALF);
    this.bytes = new Uint8Array(this.buffer);
    this.words = new Uint32Array(this.buffer);
    for (let i = 0; i < this.words.length; i++) this.words[i] = this.rng.u32();

    // Which bytes of each program are instructions (2 words per cell).
    this.masks = new Uint32Array(alloc(this.N * 8));
    writeMask(this.bytes, 0, this.N * 2, this.masks, 0);

    // This epoch's interactions: (a, b) cell indices, pairCount of them. Filled by
    // makePairs(), or set directly by a caller that computes pairings elsewhere.
    this.pairs = new Uint32Array(alloc(this.N * 4));
    this.pairCount = 0;
    this.pairing = null;

    // Per cell: the most positions rewired by a single interaction since last cleared.
    this.heat = new Uint8Array(alloc(this.N));

    this.epoch = 0;
    this.steps = 0; // total VM steps, all time
    this.lastSteps = 0; // VM steps in the most recent epoch

    // Workspace for running a whole epoch on this thread.
    this.allocateWork(this.N >> 1);

    // Census workspace.
    this.speciesOf = new Uint32Array(this.N); // cell -> species index (valid until next census)
    this.spKey = new Float64Array(this.N + 1);
    this.spCount = new Uint32Array(this.N + 1);
    this.spRep = new Uint32Array(this.N + 1);
  }

  allocateWork(pairs) {
    const work = new ArrayBuffer(pairs * PAIR_BYTES);
    this.work8 = new Uint8Array(work);
    this.work32 = new Uint32Array(work);
  }

  // The shared memory of a soup created with `shared`, to hand to another thread.
  share() {
    return { buffer: this.buffer, masks: this.masks.buffer, pairs: this.pairs.buffer, heat: this.heat.buffer };
  }

  // A second thread's view of a shared soup: enough of a Soup to call runInline() on
  // up to `capacity` pairs at a time. Pairs within an epoch never share a cell, so
  // threads working on different pairs never touch the same memory.
  static attach(shared, capacity) {
    const view = Object.create(Soup.prototype);
    view.bytes = new Uint8Array(shared.buffer);
    view.words = new Uint32Array(shared.buffer);
    view.masks = new Uint32Array(shared.masks);
    view.pairs = new Uint32Array(shared.pairs);
    view.heat = new Uint8Array(shared.heat);
    view.stepLimit = DEFAULTS.stepLimit;
    view.allocateWork(capacity);
    return view;
  }

  // Decide who meets whom this epoch (see pairing.js). Returns the number of pairs.
  makePairs() {
    if (!this.pairing) this.pairing = new Pairing(this.seed, this.W, this.H);
    this.pairCount = this.pairing.next(this.pairs);
    return this.pairCount;
  }

  // Copy the tapes and masks of pairs [start, end) into dst.
  pack(start, end, dst) {
    const { words, masks, pairs } = this;
    let d = 0;
    for (let i = start; i < end; i++) {
      const a = pairs[2 * i];
      const b = pairs[2 * i + 1];
      const wa = a * WORDS;
      const wb = b * WORDS;
      for (let k = 0; k < WORDS; k++) dst[d + k] = words[wa + k];
      for (let k = 0; k < WORDS; k++) dst[d + WORDS + k] = words[wb + k];
      dst[d + MASKS_AT] = masks[2 * a];
      dst[d + MASKS_AT + 1] = masks[2 * a + 1];
      dst[d + MASKS_AT + 2] = masks[2 * b];
      dst[d + MASKS_AT + 3] = masks[2 * b + 1];
      d += PAIR_WORDS;
    }
  }

  // Write executed pairs back into the soup, noting how much each cell was rewired.
  unpack(start, end, src) {
    const { words, masks, pairs, heat } = this;
    let d = 0;
    for (let i = start; i < end; i++) {
      for (let half = 0; half < 2; half++) {
        const cell = pairs[2 * i + half];
        const base = cell * WORDS;
        const from = d + half * WORDS;
        let changed = false;
        for (let k = 0; k < WORDS; k++) {
          const v = src[from + k];
          if (words[base + k] !== v) {
            words[base + k] = v;
            changed = true;
          }
        }
        if (changed) {
          masks[2 * cell] = src[d + MASKS_AT + 2 * half];
          masks[2 * cell + 1] = src[d + MASKS_AT + 2 * half + 1];
          const rewired = (src[d + REWIRED_AT] >>> (8 * half)) & 255;
          if (rewired > heat[cell]) heat[cell] = rewired;
        }
      }
      d += PAIR_WORDS;
    }
  }

  // Execute pairs [start, end) on this thread.
  runInline(start, end) {
    this.pack(start, end, this.work32);
    const steps = runPacked(this.work8, this.work32, end - start, this.stepLimit);
    this.unpack(start, end, this.work32);
    return steps;
  }

  // Cosmic rays: overwrite random bytes with random values.
  mutate() {
    const { bytes, masks, rng } = this;
    const total = bytes.length;
    const expected = total * this.mutation;
    let n = Math.floor(expected);
    if (rng.float() < expected - n) n++;
    for (let i = 0; i < n; i++) {
      const pos = rng.below(total);
      const value = rng.u32() & 255;
      bytes[pos] = value;
      const word = (pos >> 6) * 2 + ((pos >> 5) & 1);
      const bit = 1 << (pos & 31);
      if (OP[value] !== 0) masks[word] |= bit;
      else masks[word] &= ~bit;
    }
  }

  finishEpoch(steps) {
    this.mutate();
    this.lastSteps = steps;
    this.steps += steps;
    this.epoch++;
  }

  // One full epoch, single-threaded.
  step() {
    const count = this.makePairs();
    this.finishEpoch(this.runInline(0, count));
  }

  // Species census (see skeletonKey for what a species is). Programs with no loop or
  // no copy instruction cannot replicate and are all lumped into species 0.
  //
  // Returns `groups`: every species with at least GROUP_MIN members, largest first.
  // `s` indexes this.spCount etc. and matches this.speciesOf[cell]; both stay valid
  // until the next census.
  census() {
    const { N, bytes, masks, speciesOf, spKey, spCount, spRep } = this;
    const index = new Map();
    let n = 1;
    spKey[0] = 0;
    spCount[0] = 0;
    spRep[0] = 0;
    let instructions = 0;
    for (let p = 0; p < N; p++) {
      const o = p * HALF;
      let count = 0;
      let flags = 0;
      for (let w = 0; w < 2; w++) {
        let bits = masks[2 * p + w] | 0;
        const base = w << 5;
        while (bits !== 0) {
          const i = base + 31 - Math.clz32(bits & -bits);
          const op = OP[bytes[o + i]];
          flags |= 1 << op;
          SIG_POS[count] = i;
          SIG_OP[count] = op;
          count++;
          bits &= bits - 1;
        }
      }
      instructions += count;
      if (!flagsAreCandidate(flags)) {
        speciesOf[p] = 0;
        spCount[0]++;
        continue;
      }
      const key = signature(count);
      let s = index.get(key);
      if (s === undefined) {
        s = n++;
        index.set(key, s);
        spKey[s] = key;
        spCount[s] = 0;
        spRep[s] = p;
      }
      spCount[s]++;
      speciesOf[p] = s;
    }

    const groups = [];
    let replicated = 0;
    for (let s = 1; s < n; s++) {
      const count = spCount[s];
      if (count < GROUP_MIN) continue;
      replicated += count;
      groups.push({ s, key: spKey[s], count, cell: spRep[s] });
    }
    groups.sort((a, b) => b.count - a.count || a.key - b.key);

    return {
      epoch: this.epoch,
      species: n - 1, // distinct copy-capable skeletons
      capable: N - spCount[0], // cells holding a loop and a copy instruction
      replicated, // cells in groups
      instructionDensity: instructions / bytes.length,
      groups,
    };
  }

  programAt(cell) {
    return this.bytes.slice(cell * HALF, cell * HALF + HALF);
  }

  // Number of cells whose instruction mask disagrees with their bytes (should be 0).
  staleMasks() {
    const fresh = new Uint32Array(2);
    let stale = 0;
    for (let p = 0; p < this.N; p++) {
      writeMask(this.bytes, p * HALF, 2, fresh, 0);
      if (fresh[0] !== this.masks[2 * p] || fresh[1] !== this.masks[2 * p + 1]) stale++;
    }
    return stale;
  }

  // --- interventions -------------------------------------------------------

  touched(cell) {
    writeMask(this.bytes, cell * HALF, 2, this.masks, cell * 2);
    this.heat[cell] = HALF;
  }

  forDisk(cx, cy, radius, fn) {
    const r2 = radius * radius;
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(this.H - 1, Math.ceil(cy + radius));
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(this.W - 1, Math.ceil(cx + radius));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2) fn(y * this.W + x);
      }
    }
  }

  // Meteor strike: everything in the disk becomes noise again.
  irradiate(cx, cy, radius) {
    this.forDisk(cx, cy, radius, (cell) => {
      const base = cell * WORDS;
      for (let k = 0; k < WORDS; k++) this.words[base + k] = this.rng.u32();
      this.touched(cell);
    });
  }

  // Everything in the disk becomes zeros: inert, empty tape.
  sterilize(cx, cy, radius) {
    this.forDisk(cx, cy, radius, (cell) => {
      this.bytes.fill(0, cell * HALF, cell * HALF + HALF);
      this.touched(cell);
    });
  }

  implant(cell, genome) {
    this.bytes.set(genome.subarray(0, HALF), cell * HALF);
    this.touched(cell);
  }
}
