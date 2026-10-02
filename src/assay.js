// The replication assay: how we decide, without trusting appearances, that a program
// is alive. A program is a self-replicator if, placed next to inert material, it
// turns that material into a working copy of itself.

import { OP, run, HALF, FULL } from './bff.js';
import { RNG } from './rng.js';

// Inert filler tapes: random bytes with no instructions and no zeros.
const FILLERS = (() => {
  const rng = new RNG('assay filler');
  const out = [];
  for (let n = 0; n < 3; n++) {
    const f = new Uint8Array(HALF);
    for (let i = 0; i < HALF; i++) {
      let b;
      do b = rng.u32() & 255;
      while (b === 0 || OP[b]);
      f[i] = b;
    }
    out.push(f);
  }
  return out;
})();

const tape = new Uint8Array(FULL);

export function isCandidate(genome) {
  let open = false;
  let close = false;
  let copy = false;
  for (let i = 0; i < HALF; i++) {
    const op = OP[genome[i]];
    if (op === 9) open = true;
    else if (op === 10) close = true;
    else if (op === 7 || op === 8) copy = true;
  }
  return open && close && copy;
}

// Fraction of instruction positions on which two genomes agree.
export function skeletonMatch(a, b) {
  let union = 0;
  let same = 0;
  for (let i = 0; i < HALF; i++) {
    const x = OP[a[i]];
    const y = OP[b[i]];
    if (x || y) {
      union++;
      if (x === y) same++;
    }
  }
  return union ? same / union : 0;
}

// Run genome against a partner and return what the partner's cell turned into.
// leftSide: the genome occupies the first half of the tape (and so executes first).
export function offspring(genome, partner, limit, leftSide = true) {
  if (leftSide) {
    tape.set(genome, 0);
    tape.set(partner, HALF);
  } else {
    tape.set(partner, 0);
    tape.set(genome, HALF);
  }
  run(tape, 0, limit);
  return leftSide ? tape.slice(HALF, FULL) : tape.slice(0, HALF);
}

const SAME = 0.9;

function breedsTrue(genome, limit, leftSide) {
  let passes = 0;
  for (const filler of FILLERS) {
    const child = offspring(genome, filler, limit, leftSide);
    if (!isCandidate(child)) continue;
    if (skeletonMatch(child, genome) >= SAME) {
      passes++;
      continue;
    }
    // Some replicators alternate between two forms (e.g. a program and its mirror
    // image). Accept those if the grandchild comes back to the original.
    const grandchild = offspring(child, filler, limit, leftSide);
    if (skeletonMatch(grandchild, genome) >= SAME) passes++;
  }
  return passes >= 2;
}

// Returns { replicator, left, right }: whether the genome copies itself onto inert
// material when it sits on the left of the tape, on the right, or either.
export function assay(genome, limit) {
  if (!isCandidate(genome)) return { replicator: false, left: false, right: false };
  const left = breedsTrue(genome, limit, true);
  const right = breedsTrue(genome, limit, false);
  return { replicator: left || right, left, right };
}

// How many of the 64 bytes of `copy` match `genome`, either directly or as a mirror
// image, whichever is better. Many replicators here copy back to front, and depending
// on whether their loop moves a head before or after the first copy, the reflection
// is exact or lands one byte to either side; all three count as mirror images.
export function resemblance(copy, genome) {
  let bytes = 0;
  for (let i = 0; i < HALF; i++) if (copy[i] === genome[i]) bytes++;
  let mirrored = false;
  for (const axis of [HALF - 1, HALF, HALF - 2]) {
    let n = 0;
    for (let i = 0; i < HALF; i++) if (copy[i] === genome[(axis - i) & (HALF - 1)]) n++;
    if (n > bytes) {
      bytes = n;
      mirrored = true;
    }
  }
  return { bytes, mirrored };
}

// Exact-byte fidelity of one copy onto inert material.
export function fidelity(genome, limit, leftSide = true) {
  return resemblance(offspring(genome, FILLERS[0], limit, leftSide), genome);
}
