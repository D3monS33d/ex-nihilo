// Life detection: turns a species census into verdicts about what is actually alive,
// and keeps the history of a universe: every time life appeared, every time it died
// out again, and the moment it came to hold most of the soup.

import { assay } from './assay.js';

// Official censuses happen on a fixed epoch schedule, so the recorded history depends
// only on the seed and never on how fast the machine is.
export const CENSUS_STERILE = 16; // epochs between censuses while nothing is alive
export const CENSUS_ALIVE = 64; // and while something is

export const GENESIS_MIN = 16; // a replicating species must hold this many cells to count as a birth

const MAX_NEW_ASSAYS = 256; // per census; the rest wait for the next one
const MAX_VERDICTS = 100000;

export class LifeDetector {
  constructor(stepLimit) {
    this.stepLimit = stepLimit;
    this.verdicts = new Map(); // species key -> { replicator, left, right }
    this.living = false;
    this.births = 0;
    this.majority = false;
    this.events = []; // { type: 'birth' | 'extinction' | 'majority', epoch, ... }
  }

  // The first birth, or null while the universe has never been alive.
  get genesis() {
    return this.events.find((e) => e.type === 'birth') || null;
  }

  // Is an official census due at this epoch?
  due(epoch) {
    return epoch % (this.living ? CENSUS_ALIVE : CENSUS_STERILE) === 0;
  }

  // Annotates census.groups[i].verdict. Returns the number of living cells and, for an
  // official census, any history made. Unofficial censuses only refresh the display.
  observe(census, soup, official = true) {
    let alive = 0;
    let lead = null;
    let budget = MAX_NEW_ASSAYS;
    for (const g of census.groups) {
      let v = this.verdicts.get(g.key);
      if (v === undefined) {
        if (budget <= 0) continue;
        budget--;
        v = assay(soup.programAt(g.cell), this.stepLimit);
        if (this.verdicts.size >= MAX_VERDICTS) this.verdicts.clear();
        this.verdicts.set(g.key, v);
      }
      g.verdict = v;
      if (!v.replicator) continue;
      alive += g.count;
      if (!lead) lead = g; // groups are sorted, so the first replicator is the largest
    }

    const events = [];
    if (official) {
      if (!this.living && lead && lead.count >= GENESIS_MIN) {
        this.living = true;
        this.births++;
        events.push({
          type: 'birth',
          epoch: census.epoch,
          number: this.births,
          key: lead.key,
          cell: lead.cell,
          count: lead.count,
          genome: soup.programAt(lead.cell),
        });
      } else if (this.living && alive === 0) {
        this.living = false;
        events.push({ type: 'extinction', epoch: census.epoch, number: this.births });
      }
      if (this.living && !this.majority && alive * 2 >= soup.N) {
        this.majority = true;
        events.push({ type: 'majority', epoch: census.epoch });
      }
      this.events.push(...events);
    }
    return { alive, events };
  }
}

// Stable colour for a species: hue from its key.
export function speciesHue(key) {
  return (key % 3600) / 10;
}

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

export function speciesRgb(key) {
  const hue = speciesHue(key);
  const light = 0.5 + 0.035 * (Math.floor(key / 3600) % 5);
  return hslToRgb(hue, 0.92, light);
}

// Paint one RGBA pixel per cell: living species in their colour (alpha 255),
// copy-capable but non-replicating groups dim (alpha 128), everything else transparent.
// Must be called right after soup.census() + detector.observe().
export function paintSpecies(soup, census, rgba) {
  const { N, speciesOf } = soup;
  const colour = new Map();
  for (const g of census.groups) {
    const [r, gr, b] = speciesRgb(g.key);
    const alive = g.verdict && g.verdict.replicator;
    colour.set(g.s, alive ? [r, gr, b, 255] : [r * 0.35, gr * 0.35, b * 0.35, 128]);
  }
  for (let p = 0, o = 0; p < N; p++, o += 4) {
    const c = colour.get(speciesOf[p]);
    if (c) {
      rgba[o] = c[0];
      rgba[o + 1] = c[1];
      rgba[o + 2] = c[2];
      rgba[o + 3] = c[3];
    } else {
      rgba[o] = 0;
      rgba[o + 1] = 0;
      rgba[o + 2] = 0;
      rgba[o + 3] = 0;
    }
  }
}
