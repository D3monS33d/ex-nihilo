// The microscope: take one program out of the soup, put it next to a partner, and
// watch the machine execute it one instruction at a time. Runs on a private copy of
// the tape; nothing here touches the universe.

import { Machine, OP, HALF, FULL, genomeToHex } from './bff.js';
import { resemblance } from './assay.js';
import { byteColour } from './render.js';
import { speciesRgb } from './life.js';
import { speciesName } from './names.js';

const OP_TEXT = {
  1: (m) => `head0 moves left to ${m.h0}`,
  2: (m) => `head0 moves right to ${m.h0}`,
  3: (m) => `head1 moves left to ${m.h1}`,
  4: (m) => `head1 moves right to ${m.h1}`,
  5: (m) => `byte at head0 (${m.h0}) decremented`,
  6: (m) => `byte at head0 (${m.h0}) incremented`,
  7: (m) => `copied byte ${m.h0} → ${m.h1}`,
  8: (m) => `copied byte ${m.h1} → ${m.h0}`,
  9: () => 'loop start',
  10: () => 'loop end',
};

const HALT_TEXT = {
  end: 'ran off the end of the tape',
  bracket: 'hit a bracket with no partner',
  budget: 'ran out of steps',
  idle: 'settled into a loop that changes nothing',
};

// Inert partner: bytes that are neither instructions nor zero.
function inertTape() {
  const t = new Uint8Array(HALF);
  let x = 0x9e3779b9;
  for (let i = 0; i < HALF; i++) {
    let b;
    do {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      b = x & 255;
    } while (b === 0 || OP[b]);
    t[i] = b;
  }
  return t;
}

const rgb = (c) => `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`;

export class Microscope {
  constructor(root, { onClose, onUseGenome, onResample }) {
    this.root = root;
    this.onClose = onClose;
    this.info = null;
    // Inert junk is the clean demonstration. A real neighbour can thwart a replicator
    // (a single zero byte in the wrong place stops many copy loops), which is worth
    // seeing, but not first.
    this.partnerKind = 'inert';
    this.machine = null;
    this.playing = false;
    this.speed = 30; // steps per second
    this.carry = 0;
    this.lastTick = 0;

    root.innerHTML = `
      <div class="scope-head">
        <div>
          <div class="scope-title"><span class="swatch" data-ref="swatch"></span><span data-ref="name"></span></div>
          <div class="scope-sub" data-ref="where"></div>
        </div>
        <button class="icon-btn" data-ref="close" aria-label="Close microscope" title="Close (Esc)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="verdict" data-ref="verdict"></div>
      <div class="scope-label">In vitro: this program <b class="c-self">▮</b> glued to
        <select data-ref="partner" aria-label="Partner tape">
          <option value="inert">inert junk</option>
          <option value="neighbour">its real neighbour</option>
          <option value="clone">a copy of itself</option>
        </select> <b class="c-partner">▮</b>
      </div>
      <div class="tape" data-ref="tape" role="img" aria-label="The 128-byte tape being executed"></div>
      <div class="legend">
        <span><i class="k k-pc"></i>instruction pointer</span>
        <span><i class="k k-h0"></i>head 0</span>
        <span><i class="k k-h1"></i>head 1</span>
      </div>
      <div class="scope-controls">
        <button class="btn" data-ref="play">Run</button>
        <button class="btn" data-ref="step">Step</button>
        <button class="btn" data-ref="reset">Reset</button>
        <select data-ref="speed" aria-label="Microscope speed">
          <option value="6">slow</option>
          <option value="30" selected>normal</option>
          <option value="240">fast</option>
          <option value="4000">very fast</option>
        </select>
      </div>
      <div class="readout" data-ref="readout"></div>
      <div class="outcome" data-ref="outcome"></div>
      <div class="scope-actions">
        <button class="btn ghost" data-ref="copy">Copy genome</button>
        <button class="btn ghost" data-ref="use">Load into inoculator</button>
        <button class="btn ghost" data-ref="resample">Re-sample cell</button>
      </div>`;

    this.ref = {};
    for (const el of root.querySelectorAll('[data-ref]')) this.ref[el.dataset.ref] = el;

    this.cells = [];
    this.halfLabels = [];
    for (let i = 0; i < FULL; i++) {
      if (i % HALF === 0) {
        const label = document.createElement('div');
        this.ref.tape.append(label);
        this.halfLabels.push(label);
      }
      const el = document.createElement('i');
      this.ref.tape.append(el);
      this.cells.push(el);
    }

    this.ref.close.onclick = () => this.onClose();
    this.ref.play.onclick = () => this.toggle();
    this.ref.step.onclick = () => {
      this.pause();
      this.advance(1);
    };
    this.ref.reset.onclick = () => this.load();
    this.ref.speed.onchange = () => (this.speed = +this.ref.speed.value);
    this.ref.partner.onchange = () => {
      this.partnerKind = this.ref.partner.value;
      this.load();
    };
    this.ref.copy.onclick = async () => {
      const hex = genomeToHex(this.info.genome);
      try {
        await navigator.clipboard.writeText(hex);
        this.flashButton(this.ref.copy, 'Copied');
      } catch {
        window.prompt('Genome (hex):', hex);
      }
    };
    this.ref.use.onclick = () => {
      onUseGenome(this.info.genome.slice());
      this.flashButton(this.ref.use, 'Loaded');
    };
    this.ref.resample.onclick = () => onResample(this.info.cell);
  }

  flashButton(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = old), 1100);
  }

  get open() {
    return this.info !== null;
  }

  // info: the coordinator's reply to an inspect request.
  show(info) {
    this.info = info;
    this.root.hidden = false;
    const { ref } = this;
    const alive = info.verdict.replicator;
    if (info.key) {
      ref.swatch.style.background = rgb(speciesRgb(info.key));
      ref.name.textContent = speciesName(info.key);
    } else {
      ref.swatch.style.background = '#2a2a3a';
      ref.name.textContent = 'Inert matter';
    }
    ref.where.textContent =
      `cell ${info.x}, ${info.y} · sampled at epoch ${info.epoch.toLocaleString()}` +
      (info.population > 1 ? ` · ${info.population.toLocaleString()} cells share this code` : '');

    if (alive) {
      const how = info.verdict.left && info.verdict.right ? 'from either side' : info.verdict.left ? 'when it runs first' : 'when it runs second';
      const what = info.fidelity.mirrored ? 'writes its own mirror image there, which copies itself back' : 'rebuilds itself there';
      ref.verdict.className = 'verdict alive';
      ref.verdict.innerHTML = `<b>Self-replicator.</b> Placed next to inert junk it ${what}, ${how} (${info.fidelity.bytes}/64 bytes).`;
    } else if (info.key) {
      ref.verdict.className = 'verdict capable';
      ref.verdict.innerHTML = '<b>Not alive.</b> It has a loop and a copy instruction, but its copies do not copy themselves.';
    } else {
      ref.verdict.className = 'verdict';
      ref.verdict.innerHTML = '<b>Not alive.</b> No loop, or nothing that copies. It cannot reproduce.';
    }
    this.load();
  }

  hide() {
    this.pause();
    this.info = null;
    this.root.hidden = true;
  }

  partnerTape() {
    if (this.partnerKind === 'inert') return inertTape();
    if (this.partnerKind === 'clone') return this.info.genome;
    return this.info.partner;
  }

  // Put a fresh tape in the machine. Replicators that only work from the right-hand
  // side are placed there.
  load() {
    this.pause();
    const { genome, verdict } = this.info;
    this.selfFirst = !(verdict.replicator && !verdict.left);
    const partner = this.partnerTape();
    const tape = new Uint8Array(FULL);
    tape.set(this.selfFirst ? genome : partner, 0);
    tape.set(this.selfFirst ? partner : genome, HALF);
    this.initial = tape.slice();
    this.machine = new Machine(tape);
    this.lastOp = 0;
    const partnerName = { neighbour: 'its real neighbour', inert: 'inert junk', clone: 'a copy of itself' }[this.partnerKind];
    this.halfLabels.forEach((label, half) => {
      const self = (half === 0) === this.selfFirst;
      label.className = self ? 'half-label self' : 'half-label';
      label.textContent = `bytes ${half * HALF}–${half * HALF + HALF - 1} · ${self ? 'this program' : partnerName}`;
    });
    this.paint(true);
    this.describe();
    this.ref.outcome.textContent = '';
  }

  toggle() {
    if (this.playing) this.pause();
    else {
      if (this.machine.halted) this.load();
      this.playing = true;
      this.carry = 0;
      this.lastTick = performance.now();
      this.ref.play.textContent = 'Pause';
    }
  }

  pause() {
    this.playing = false;
    if (this.ref) this.ref.play.textContent = 'Run';
  }

  // Called once per animation frame by the app.
  tick(now) {
    if (!this.playing || !this.machine) return;
    this.carry += ((now - this.lastTick) / 1000) * this.speed;
    this.lastTick = now;
    const n = Math.floor(this.carry);
    if (n > 0) {
      this.carry -= n;
      this.advance(Math.min(n, 2000));
    }
  }

  advance(n) {
    const m = this.machine;
    const limit = this.info.stepLimit;
    for (let i = 0; i < n && !m.halted; i++) {
      this.lastOp = OP[m.tape[m.pc]];
      this.lastPc = m.pc;
      m.step(limit);
    }
    this.paint(false);
    this.describe();
    if (m.halted) {
      this.pause();
      this.conclude();
    }
  }

  paint(full) {
    const m = this.machine;
    const t = m.tape;
    for (let i = 0; i < FULL; i++) {
      const el = this.cells[i];
      const b = t[i];
      if (full || el._b !== b) {
        el._b = b;
        const op = OP[b];
        el.textContent = op ? String.fromCharCode(b) : b.toString(16).padStart(2, '0');
        el.className = op ? 'op' : 'nop';
        el.style.color = op ? rgb(byteColour(b).map((v) => v * 0.55 + 115)) : '';
        el.style.background = op ? rgb(byteColour(b).map((v) => v * 0.26)) : '';
        if (!full) {
          el.classList.remove('wrote');
          void el.offsetWidth;
          el.classList.add('wrote');
        }
      }
      el.classList.toggle('pc', i === m.pc && !m.halted);
      el.classList.toggle('h0', i === m.h0);
      el.classList.toggle('h1', i === m.h1);
      el.classList.toggle('changed', b !== this.initial[i]);
    }
  }

  describe() {
    const m = this.machine;
    const limit = this.info.stepLimit;
    let text = `step ${m.steps.toLocaleString()} of ${limit.toLocaleString()} · ${m.changes} bytes rewritten`;
    if (m.steps > 0 && !m.halted) {
      text += this.lastOp ? ` · ${OP_TEXT[this.lastOp](m)}` : ' · no-op';
    }
    this.ref.readout.textContent = text;
  }

  conclude() {
    const m = this.machine;
    const selfAt = this.selfFirst ? 0 : HALF;
    const otherAt = this.selfFirst ? HALF : 0;
    const self = this.initial.subarray(selfAt, selfAt + HALF);
    const copy = resemblance(m.tape.subarray(otherAt, otherAt + HALF), self);
    const before = resemblance(this.initial.subarray(otherAt, otherAt + HALF), self);
    const survived = resemblance(m.tape.subarray(selfAt, selfAt + HALF), self);
    const end = m.reason === 'idle' ? `${HALT_TEXT.idle} (it would spin there until its ${this.info.stepLimit.toLocaleString()} steps ran out)` : HALT_TEXT[m.reason];
    const as = copy.mirrored ? 'mirror image' : 'copy';
    let result;
    if (before.bytes === HALF && copy.bytes === HALF) result = `The partner was already a ${as} of this program, and still is.`;
    else if (copy.bytes === HALF) result = `The partner is now a perfect ${as} of this program.`;
    else if (copy.bytes >= 48 && copy.bytes > before.bytes) result = `The partner is now a ${copy.bytes}/64 ${as} of this program.`;
    else if (survived.bytes < 48) result = `This program was damaged: only ${survived.bytes}/64 of its own bytes survive.`;
    else result = `No copy was made (${copy.bytes}/64 bytes of the partner match).`;
    this.ref.outcome.textContent = `Halted after ${m.steps.toLocaleString()} steps: ${end}. ${result}`;
  }
}
