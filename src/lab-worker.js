// One universe per worker, run flat out on a single thread. Used by the multiverse lab.

import { Soup } from './soup.js';
import { LifeDetector, paintSpecies } from './life.js';
import { genomeToString, genomeToHex } from './bff.js';

self.onmessage = (e) => {
  const { seed, maxEpochs, afterGenesis, afterMajority, params } = e.data;
  const soup = new Soup({ ...params, seed });
  const life = new LifeDetector(soup.stepLimit);
  const image = new Uint8ClampedArray(soup.N * 4);
  const history = []; // [epoch, living cells], while alive
  const t0 = performance.now();
  let lastPost = 0;
  let alive = 0;
  let peak = 0;
  let census = null;

  const snapshot = () => {
    paintSpecies(soup, census, image);
    // Give lifeless cells a faint texture so the picture is not flat black.
    for (let p = 0, o = 0; p < soup.N; p++, o += 4) {
      if (image[o + 3] === 0) {
        const v = 10 + ((soup.bytes[p * 64] * 18) >> 8);
        image[o] = v;
        image[o + 1] = v;
        image[o + 2] = v + 6;
      }
      image[o + 3] = 255;
    }
    self.postMessage({
      type: 'progress',
      seed,
      epoch: soup.epoch,
      alive,
      living: life.living,
      births: life.births,
      ms: performance.now() - t0,
      image: image.slice(),
    });
  };

  const describe = (ev) => (ev.genome ? { ...ev, genome: genomeToString(ev.genome), hex: genomeToHex(ev.genome) } : ev);

  // A sterile universe is abandoned at maxEpochs. One that has given birth is followed
  // for afterGenesis more epochs, or afterMajority epochs past the takeover.
  for (;;) {
    const genesis = life.genesis;
    const majority = life.events.find((ev) => ev.type === 'majority');
    if (!genesis && soup.epoch >= maxEpochs) break;
    if (majority && soup.epoch >= majority.epoch + afterMajority) break;
    if (genesis && !majority && soup.epoch >= genesis.epoch + afterGenesis) break;

    soup.step();
    if (!life.due(soup.epoch)) continue;

    census = soup.census();
    const seen = life.observe(census, soup);
    alive = seen.alive;
    peak = Math.max(peak, alive);
    if (life.living) history.push([soup.epoch, alive]);
    for (const ev of seen.events) self.postMessage({ type: 'event', seed, event: describe(ev) });

    const now = performance.now();
    if (now - lastPost > 400) {
      lastPost = now;
      snapshot();
    }
  }

  census = soup.census();
  alive = life.observe(census, soup, false).alive;
  snapshot();
  const ms = performance.now() - t0;
  self.postMessage({
    type: 'done',
    seed,
    epochs: soup.epoch,
    ms,
    eps: soup.epoch / (ms / 1000),
    events: life.events.map(describe),
    births: life.births,
    alive,
    peak,
    species: census.species,
    top: census.groups.slice(0, 5).map((g) => ({
      count: g.count,
      replicator: !!(g.verdict && g.verdict.replicator),
      genome: genomeToString(soup.programAt(g.cell)),
    })),
    history,
  });
};
