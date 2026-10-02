// Executor worker: runs a share of each epoch's interactions. Pairs within an epoch
// never share a cell, so any number of executors can work at once and the result is
// identical to running the pairs in order on one thread.
//
// Two ways of getting at the soup:
//   shared  the soup is in shared memory; the executor is told which pairs are its
//           share and works on them in place.
//   copied  where shared memory is not available, the coordinator sends a buffer of
//           packed pairs, and gets it back when they have been run.

import { Soup, runPacked } from './soup.js';

self.onmessage = (e) => {
  const port = e.data.port;
  let view = null;
  port.onmessage = ({ data }) => {
    if (data.attach) {
      view = Soup.attach(data.attach, data.capacity);
    } else if (data.buf) {
      const { buf, count, limit } = data;
      const steps = runPacked(new Uint8Array(buf), new Uint32Array(buf), count, limit);
      port.postMessage({ buf, steps }, [buf]);
    } else {
      view.stepLimit = data.limit;
      port.postMessage({ steps: view.runInline(data.start, data.end) });
    }
  };
};
