// Pair worker: computes pairings a few epochs ahead of the coordinator.
//
// It owns a small pool of buffers. Whenever it holds a free one it fills it with the
// next epoch's pairs and sends it over; the coordinator sends every buffer back when
// it is finished with it. A `start` message begins a new universe; pairings still in
// flight from the old one carry the old generation number, and the coordinator
// returns them unused.

import { Pairing } from './pairing.js';

const AHEAD = 3;

self.onmessage = (e) => {
  const port = e.data.port;
  let pairing = null;
  let generation = 0;
  let bytes = 0;
  let free = null;

  port.onmessage = ({ data }) => {
    if (data.type === 'start') {
      generation = data.generation;
      pairing = new Pairing(data.seed, data.width, data.height);
      bytes = pairing.N * 4;
      if (!free) free = Array.from({ length: AHEAD }, () => new ArrayBuffer(bytes));
    } else if (data.type === 'recycle') {
      free.push(data.buffer);
    }
    while (pairing && free.length) {
      let buffer = free.pop();
      if (buffer.byteLength !== bytes) buffer = new ArrayBuffer(bytes);
      const count = pairing.next(new Uint32Array(buffer));
      port.postMessage({ generation, count, buffer }, [buffer]);
    }
  };
};
