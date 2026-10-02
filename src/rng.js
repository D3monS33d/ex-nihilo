// Deterministic randomness. Every universe is fully determined by its seed string,
// so the same seed gives birth to the same life at the same epoch on every machine.

// xmur3: string -> stream of well-mixed 32-bit seeds.
export function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

const INV_2_32 = 2.3283064365386963e-10;

// sfc32: small, fast, 128 bits of state, passes PractRand.
export class RNG {
  constructor(seed) {
    const next = xmur3(String(seed));
    this.a = next() | 0;
    this.b = next() | 0;
    this.c = next() | 0;
    this.d = next() | 0;
    for (let i = 0; i < 20; i++) this.u32();
  }

  u32() {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  // Uniform float in [0, 1).
  float() {
    return this.u32() * INV_2_32;
  }

  // Uniform integer in [0, n), n < 2^31.
  below(n) {
    return (this.u32() * INV_2_32 * n) | 0;
  }
}
