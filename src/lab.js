// Multiverse lab: run many independent universes in parallel and compare when
// (and whether) each one gives birth, and what becomes of the life in it.
// Settings can be passed in the query string, e.g.
//   lab.html?n=12&seed=u&max=150000&auto=1
//   lab.html?seeds=u2,u7,u13&max=200000&auto=1

const form = document.getElementById('form');
const grid = document.getElementById('grid');
const summary = document.getElementById('summary');

const query = new URLSearchParams(location.search);
for (const [k, v] of query) if (form.elements[k]) form.elements[k].value = v;

const W = 240;
const H = 135;
const fmt = (n) => Math.round(n).toLocaleString('en-US');
let workers = [];
const lab = (window.lab = { results: [], events: [], running: 0, done: false });

function start() {
  for (const w of workers) w.terminate();
  workers = [];
  grid.textContent = '';
  lab.results = [];
  lab.events = [];
  lab.done = false;

  const f = form.elements;
  const mut = Number(f.mut.value);
  const params = { stepLimit: Number(f.limit.value) || 8192, mutation: mut > 0 ? 1 / mut : 0 };
  const listed = f.seeds.value.split(',').map((s) => s.trim()).filter(Boolean);
  const n = Math.max(1, Math.min(64, Number(f.n.value) || 1));
  const queue = listed.length ? listed : Array.from({ length: n }, (_, i) => `${f.seed.value}${i + 1}`);
  const cores = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
  lab.running = 0;

  const launch = () => {
    while (lab.running < cores && queue.length) run(queue.shift());
    if (!lab.running && !queue.length) {
      lab.done = true;
      report();
    }
  };

  const run = (seed) => {
    lab.running++;
    const card = document.createElement('div');
    card.className = 'u';
    const link = `./#seed=${encodeURIComponent(seed)}${mut !== 4096 ? `&mut=${mut}` : ''}`;
    card.innerHTML =
      `<canvas width="${W}" height="${H}"></canvas><div class="meta">` +
      `<div class="seed"><a href="${link}">${seed}</a></div>` +
      `<div class="state">starting…</div><div class="log"></div></div>`;
    grid.append(card);
    const ctx = card.querySelector('canvas').getContext('2d');
    const state = card.querySelector('.state');
    const log = card.querySelector('.log');

    const worker = new Worker(new URL('./lab-worker.js', import.meta.url), { type: 'module' });
    workers.push(worker);
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        ctx.putImageData(new ImageData(data.image, W, H), 0, 0);
        const rate = `${fmt(data.epoch / (data.ms / 1000))}/s`;
        card.classList.toggle('alive', data.living);
        state.textContent = data.living
          ? `alive · ${((100 * data.alive) / (W * H)).toFixed(1)}% of cells · epoch ${fmt(data.epoch)} · ${rate}`
          : `${data.births ? 'extinct' : 'sterile'} · epoch ${fmt(data.epoch)} · ${rate}`;
      } else if (data.type === 'event') {
        lab.events.push({ seed, ...data.event });
        const ev = data.event;
        const line = document.createElement('div');
        line.className = ev.type;
        line.textContent =
          ev.type === 'birth'
            ? `${fmt(ev.epoch)}  life${ev.number > 1 ? ` (attempt ${ev.number})` : ''}  ${ev.genome}`
            : ev.type === 'extinction'
              ? `${fmt(ev.epoch)}  extinct`
              : `${fmt(ev.epoch)}  life holds most of the universe`;
        log.append(line);
      } else if (data.type === 'done') {
        lab.results.push(data);
        state.textContent = `finished at epoch ${fmt(data.epochs)} · ${((100 * data.alive) / (W * H)).toFixed(1)}% alive · ${data.births} birth${data.births === 1 ? '' : 's'}`;
        worker.terminate();
        lab.running--;
        report();
        launch();
      }
    };
    worker.onerror = (err) => {
      state.textContent = `error: ${err.message}`;
      lab.running--;
      launch();
    };
    worker.postMessage({
      seed,
      maxEpochs: Number(f.max.value),
      afterGenesis: Number(f.after.value),
      afterMajority: Number(f.settle.value),
      params,
    });
  };

  launch();
}

function report() {
  const r = lab.results;
  if (!r.length) return;
  const first = r.map((x) => x.events.find((e) => e.type === 'birth')).filter(Boolean).map((e) => e.epoch).sort((a, b) => a - b);
  const won = r.filter((x) => x.events.some((e) => e.type === 'majority')).length;
  summary.innerHTML =
    `<b>${first.length}</b> of <b>${r.length}</b> finished universes gave birth` +
    (first.length ? ` · earliest at epoch <b>${fmt(first[0])}</b> · median <b>${fmt(first[first.length >> 1])}</b>` : '') +
    ` · life took over in <b>${won}</b>` +
    (lab.done ? ' · done' : ' · running…');
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  start();
});

if (query.get('auto')) start();
