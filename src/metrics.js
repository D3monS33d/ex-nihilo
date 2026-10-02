// Complexity meter. Measures the soup the way the paper does, with no notion of
// "replicator" at all: Shannon entropy of the bytes minus how well a real compressor
// does on them. Noise scores 0 (every byte is a surprise, and nothing compresses).
// A soup full of copies scores high: individual bytes still look varied, but the
// whole is highly redundant.
//
// The paper uses brotli for the compressor; browsers ship deflate, so absolute
// numbers differ a little but the shape is the same.

async function deflatedSize(bytes) {
  let format = 'deflate-raw';
  let stream;
  try {
    stream = new CompressionStream(format);
  } catch {
    format = 'deflate';
    stream = new CompressionStream(format);
  }
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
  }
  return size;
}

function byteEntropy(bytes) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < bytes.length; i++) hist[bytes[i]]++;
  let h = 0;
  for (let i = 0; i < 256; i++) {
    if (hist[i]) {
      const p = hist[i] / bytes.length;
      h -= p * Math.log2(p);
    }
  }
  return h;
}

let busy = false;

self.onmessage = (e) => {
  const port = e.data.port;
  port.onmessage = async ({ data }) => {
    if (busy || typeof CompressionStream === 'undefined') return;
    busy = true;
    try {
      const bytes = new Uint8Array(data.bytes);
      const entropy = byteEntropy(bytes);
      const compressed = (8 * (await deflatedSize(bytes))) / bytes.length;
      self.postMessage({
        type: 'complexity',
        epoch: data.epoch,
        entropy,
        compressed,
        complexity: Math.max(0, entropy - compressed),
      });
    } finally {
      busy = false;
    }
  };
};
