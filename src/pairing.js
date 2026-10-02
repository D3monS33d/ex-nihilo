// Who meets whom. Each epoch the cells are shuffled, then every cell that has not been
// taken yet tries to claim one random neighbour within 2 steps in x and y; if that
// neighbour is free, the two become a pair.
//
// Pairing has its own random stream and never looks at the soup, so the pairings for
// future epochs can be computed ahead of time on another thread (see pair-worker.js)
// without changing the result.

import { RNG } from './rng.js';

const NEIGHBOURS = 24;
const NB_DX = new Int8Array(NEIGHBOURS);
const NB_DY = new Int8Array(NEIGHBOURS);
{
  let k = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (dx || dy) {
        NB_DX[k] = dx;
        NB_DY[k] = dy;
        k++;
      }
    }
  }
}

export class Pairing {
  constructor(seed, width, height) {
    this.W = width;
    this.H = height;
    this.N = width * height;
    this.rng = new RNG(`${seed}/pairing`);
    this.cellX = new Uint16Array(this.N);
    this.cellY = new Uint16Array(this.N);
    this.order = new Uint32Array(this.N);
    for (let i = 0; i < this.N; i++) {
      this.cellX[i] = i % width;
      this.cellY[i] = (i / width) | 0;
      this.order[i] = i;
    }
    this.taken = new Uint8Array(this.N);
  }

  // Write the next epoch's pairs into `pairs` as (a, b) cell indices; `a` runs first.
  // `pairs` needs room for N entries. Returns the number of pairs.
  next(pairs) {
    const { N, W, H, order, taken, rng, cellX, cellY } = this;
    for (let i = N - 1; i > 0; i--) {
      const j = rng.below(i + 1);
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
    taken.fill(0);
    let n = 0;
    for (let i = 0; i < N; i++) {
      const p = order[i];
      if (taken[p]) continue;
      const k = rng.below(NEIGHBOURS);
      const x = cellX[p] + NB_DX[k];
      const y = cellY[p] + NB_DY[k];
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      const q = y * W + x;
      if (taken[q]) continue;
      taken[p] = 1;
      taken[q] = 1;
      pairs[n++] = p;
      pairs[n++] = q;
    }
    return n >> 1;
  }
}
