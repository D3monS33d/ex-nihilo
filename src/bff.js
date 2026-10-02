// BFF: the ten-instruction virtual machine the whole universe runs on.
//
// Semantics follow "Computational Life" (Agüera y Arcas et al., 2024, arXiv:2406.19108)
// and its reference implementation (cubff, `bff_noheads`). Code and data share one
// 128-byte tape, formed by concatenating two 64-byte programs. There is one
// instruction pointer and two data heads, all starting at 0. Heads wrap around.
//
//   <  head0--            {  head1--
//   >  head0++            }  head1++
//   -  tape[head0]--      .  tape[head1] = tape[head0]
//   +  tape[head0]++      ,  tape[head0] = tape[head1]
//   [  if tape[head0] == 0, jump forward to the matching ]
//   ]  if tape[head0] != 0, jump back to the matching [
//
// Every other byte value (246 of 256) is a no-op. Execution halts when the
// instruction pointer leaves the tape, on a jump with no matching bracket, or
// when the step budget runs out. Every byte read costs one step, no-ops included.

export const HALF = 64; // bytes in one program
export const FULL = 128; // bytes on an interaction tape
const MASK = FULL - 1;

export const OPS = '<>{}-+.,[]';

// byte value -> opcode (1..10), 0 for no-op
export const OP = new Uint8Array(256);
for (let i = 0; i < OPS.length; i++) OP[OPS.charCodeAt(i)] = i + 1;

const OPEN = 91; // [
const CLOSE = 93; // ]

// ---------------------------------------------------------------------------
// The production interpreter.
//
// run() produces exactly the same tape and step count as runReference() below (the
// test suite checks this on hundreds of thousands of tapes), but gets there with two
// exact shortcuts:
//
// 1. Idle loops are fast-forwarded. If the machine takes a backward jump from the same
//    place, with both heads where they were at an earlier such jump, and the tape has
//    not changed in between, its whole state has repeated. It will spin until the
//    budget runs out without changing anything, so we stop and report the full budget
//    as spent. Random junk is full of such loops, and a replicator enters one as soon
//    as its copy is complete.
//
// 2. No-ops are skipped. Junk tapes are ~96% no-ops, so the tape is first compiled to
//    a list of its instructions with jump targets resolved, and execution hops from
//    instruction to instruction, charging the skipped bytes to the step budget. If the
//    program rewrites its own instructions the list is rebuilt (lazily); the rare tape
//    that forces many rebuilds is handed to a plain byte-by-byte loop, dense(), to finish.
//
// Even finding the instructions is too slow to do from scratch every time, so each
// program carries a 64-bit mask (two 32-bit words) saying which of its bytes are
// instructions. runMasked() compiles from the masks and keeps them up to date.

const POS = new Uint8Array(FULL + 1); // tape position of each instruction
const CODE = new Uint8Array(FULL + 1); // its opcode
const JMP = new Int16Array(FULL + 1); // for brackets: index of the partner, or -1
const STACK = new Uint8Array(FULL);
const SCRATCH_MASK = new Uint32Array(FULL / 32);

const MAX_RECOMPILES = 32; // tapes that need more list rebuilds than this finish in dense()

// Compute instruction masks for `words` * 32 bytes starting at t[o]. Bit b of word w
// is set when byte w*32 + b is an instruction.
export function writeMask(t, o, words, m, mo) {
  for (let w = 0; w < words; w++) {
    const base = o + (w << 5);
    let bits = 0;
    for (let b = 0; b < 32; b++) {
      if (OP[t[base + b]] !== 0) bits |= 1 << b;
    }
    m[mo + w] = bits;
  }
}

// Build the instruction list for the tape at t[o] from its mask at m[mo..mo+3].
function compile(t, o, m, mo) {
  let n = 0;
  for (let w = 0; w < FULL / 32; w++) {
    let bits = m[mo + w] | 0;
    const base = w << 5;
    while (bits !== 0) {
      const p = base + 31 - Math.clz32(bits & -bits);
      POS[n] = p;
      CODE[n] = OP[t[o + p]];
      n++;
      bits &= bits - 1;
    }
  }
  let sp = 0;
  for (let i = 0; i < n; i++) {
    const c = CODE[i];
    if (c === 9) {
      STACK[sp++] = i;
      JMP[i] = -1;
    } else if (c === 10) {
      if (sp > 0) {
        const j = STACK[--sp];
        JMP[i] = j;
        JMP[j] = i;
      } else {
        JMP[i] = -1;
      }
    }
  }
  return n;
}

// Run the 128-byte tape at t[o..o+127] in place. Returns the number of steps taken.
export function run(t, o, limit) {
  writeMask(t, o, FULL / 32, SCRATCH_MASK, 0);
  return runMasked(t, o, limit, SCRATCH_MASK, 0);
}

// The same, for a tape whose instruction mask is already known: m[mo..mo+3] must
// describe the tape on entry, and describes the final tape on return.
export function runMasked(t, o, limit, m, mo) {
  let n = compile(t, o, m, mo);
  let i = 0; // index of the next instruction
  let last = -1; // tape position execution continues after
  let h0 = 0;
  let h1 = 0;
  let steps = 0;
  let recompiles = 0;
  // When the program rewires a byte (turns it into a different instruction, or into or
  // out of a no-op), the mask is corrected at once but the instruction list is not.
  // Instead the list is trusted only for tape positions below `stale`, and rebuilt the
  // next time execution needs something at or beyond it. Entries below `stale` and the
  // matches between them depend only on bytes below `stale`, so they stay valid. This
  // matters for replicators: their copy loop rewires the far half of the tape on every
  // iteration, while itself running entirely inside the half that does not change.
  let stale = FULL;
  // Remembered backward jumps since the tape last changed (see dense() for details).
  let aI = -1;
  let aH0 = 0;
  let aH1 = 0;
  let bI = -1;
  let bH0 = 0;
  let bH1 = 0;
  let bAge = 0;
  let bSpan = 1;

  for (;;) {
    if (stale < FULL && (i >= n || POS[i] >= stale)) {
      if (++recompiles > MAX_RECOMPILES) {
        steps = dense(t, o, limit, last + 1, h0, h1, steps);
        writeMask(t, o, FULL / 32, m, mo);
        return steps;
      }
      n = compile(t, o, m, mo);
      i = 0;
      while (i < n && POS[i] <= last) i++;
      stale = FULL;
    }
    if (i >= n) {
      // Nothing but no-ops until the end of the tape.
      steps += FULL - 1 - last;
      return steps > limit ? limit : steps;
    }
    const p = POS[i];
    steps += p - last;
    if (steps > limit) return limit; // budget ran out among the no-ops before p

    // Tape position where this step changed which instruction (if any) a byte is.
    let rewired = -1;
    switch (CODE[i]) {
      case 1:
        h0 = (h0 - 1) & MASK;
        break;
      case 2:
        h0 = (h0 + 1) & MASK;
        break;
      case 3:
        h1 = (h1 - 1) & MASK;
        break;
      case 4:
        h1 = (h1 + 1) & MASK;
        break;
      case 5: {
        const was = t[o + h0];
        const now = (was - 1) & 255;
        t[o + h0] = now;
        aI = -1;
        if (OP[was] !== OP[now]) rewired = h0;
        break;
      }
      case 6: {
        const was = t[o + h0];
        const now = (was + 1) & 255;
        t[o + h0] = now;
        aI = -1;
        if (OP[was] !== OP[now]) rewired = h0;
        break;
      }
      case 7: {
        const was = t[o + h1];
        const now = t[o + h0];
        if (was !== now) {
          t[o + h1] = now;
          aI = -1;
          if (OP[was] !== OP[now]) rewired = h1;
        }
        break;
      }
      case 8: {
        const was = t[o + h0];
        const now = t[o + h1];
        if (was !== now) {
          t[o + h0] = now;
          aI = -1;
          if (OP[was] !== OP[now]) rewired = h0;
        }
        break;
      }
      case 9:
        if (t[o + h0] === 0) {
          let j = JMP[i];
          if (stale < FULL && (j < 0 || POS[j] >= stale)) {
            // The partner, if there is one, lies in the stale part of the list.
            if (++recompiles > MAX_RECOMPILES) {
              steps = dense(t, o, limit, p, h0, h1, steps - 1); // re-executes this [
              writeMask(t, o, FULL / 32, m, mo);
              return steps;
            }
            n = compile(t, o, m, mo); // entries below `stale` keep their index, so i still points here
            stale = FULL;
            j = JMP[i];
          }
          if (j < 0) return steps;
          last = POS[j];
          i = j + 1;
          continue;
        }
        break;
      case 10:
        // A ] always has its partner earlier on the tape, so its match is never stale.
        if (t[o + h0] !== 0) {
          if (aI < 0) {
            aI = bI = i;
            aH0 = bH0 = h0;
            aH1 = bH1 = h1;
            bAge = 0;
            bSpan = 1;
          } else if ((i === aI && h0 === aH0 && h1 === aH1) || (i === bI && h0 === bH0 && h1 === bH1)) {
            return limit;
          } else if (++bAge === bSpan) {
            bI = i;
            bH0 = h0;
            bH1 = h1;
            bAge = 0;
            bSpan <<= 1;
          }
          const j = JMP[i];
          if (j < 0) return steps;
          last = POS[j];
          i = j + 1;
          continue;
        }
        break;
    }

    if (rewired >= 0) {
      const bit = 1 << (rewired & 31);
      if (OP[t[o + rewired]] !== 0) m[mo + (rewired >> 5)] |= bit;
      else m[mo + (rewired >> 5)] &= ~bit;
      if (rewired < stale) stale = rewired;
    }
    last = p;
    i++;
  }
}

// Byte-by-byte interpreter with idle-loop detection, entered at an arbitrary state.
function dense(t, o, limit, pc, h0, h1, steps) {
  if (pc >= FULL) return steps;
  // Two remembered backward jumps since the tape last changed: the first one (catches
  // pure cycles as early as possible) and a checkpoint that moves forward at doubling
  // intervals (Brent's algorithm; catches cycles that are entered later).
  let aPc = -1;
  let aH0 = 0;
  let aH1 = 0;
  let bPc = -1;
  let bH0 = 0;
  let bH1 = 0;
  let bAge = 0;
  let bSpan = 1;
  while (steps < limit) {
    steps++;
    switch (OP[t[o + pc]]) {
      case 1:
        h0 = (h0 - 1) & MASK;
        break;
      case 2:
        h0 = (h0 + 1) & MASK;
        break;
      case 3:
        h1 = (h1 - 1) & MASK;
        break;
      case 4:
        h1 = (h1 + 1) & MASK;
        break;
      case 5:
        t[o + h0]--;
        aPc = -1;
        break;
      case 6:
        t[o + h0]++;
        aPc = -1;
        break;
      case 7: {
        const v = t[o + h0];
        if (t[o + h1] !== v) {
          t[o + h1] = v;
          aPc = -1;
        }
        break;
      }
      case 8: {
        const v = t[o + h1];
        if (t[o + h0] !== v) {
          t[o + h0] = v;
          aPc = -1;
        }
        break;
      }
      case 9:
        if (t[o + h0] === 0) {
          let depth = 1;
          pc++;
          for (; pc < FULL; pc++) {
            const c = t[o + pc];
            if (c === CLOSE) {
              if (--depth === 0) break;
            } else if (c === OPEN) depth++;
          }
          if (depth !== 0) return steps;
        }
        break;
      case 10:
        if (t[o + h0] !== 0) {
          if (aPc < 0) {
            aPc = bPc = pc;
            aH0 = bH0 = h0;
            aH1 = bH1 = h1;
            bAge = 0;
            bSpan = 1;
          } else if ((pc === aPc && h0 === aH0 && h1 === aH1) || (pc === bPc && h0 === bH0 && h1 === bH1)) {
            return limit;
          } else if (++bAge === bSpan) {
            bPc = pc;
            bH0 = h0;
            bH1 = h1;
            bAge = 0;
            bSpan <<= 1;
          }
          let depth = 1;
          pc--;
          for (; pc >= 0; pc--) {
            const c = t[o + pc];
            if (c === OPEN) {
              if (--depth === 0) break;
            } else if (c === CLOSE) depth++;
          }
          if (depth !== 0) return steps;
        }
        break;
    }
    pc++;
    if (pc >= FULL) break;
  }
  return steps;
}

// The byte-by-byte path on its own, exported so the tests can exercise it directly.
export function runDense(t, o, limit) {
  return dense(t, o, limit, 0, 0, 0, 0);
}

// The plain interpreter, a direct transcription of the semantics above with no
// shortcuts. Kept as the ground truth that run() is tested against (see test.html).
export function runReference(t, o, limit) {
  let pc = 0;
  let h0 = 0;
  let h1 = 0;
  let steps = 0;
  while (steps < limit) {
    steps++;
    switch (OP[t[o + pc]]) {
      case 1:
        h0 = (h0 - 1) & MASK;
        break;
      case 2:
        h0 = (h0 + 1) & MASK;
        break;
      case 3:
        h1 = (h1 - 1) & MASK;
        break;
      case 4:
        h1 = (h1 + 1) & MASK;
        break;
      case 5:
        t[o + h0]--;
        break;
      case 6:
        t[o + h0]++;
        break;
      case 7:
        t[o + h1] = t[o + h0];
        break;
      case 8:
        t[o + h0] = t[o + h1];
        break;
      case 9:
        if (t[o + h0] === 0) {
          let depth = 1;
          pc++;
          for (; pc < FULL; pc++) {
            const c = t[o + pc];
            if (c === CLOSE) {
              if (--depth === 0) break;
            } else if (c === OPEN) depth++;
          }
          if (depth !== 0) return steps;
        }
        break;
      case 10:
        if (t[o + h0] !== 0) {
          let depth = 1;
          pc--;
          for (; pc >= 0; pc--) {
            const c = t[o + pc];
            if (c === OPEN) {
              if (--depth === 0) break;
            } else if (c === CLOSE) depth++;
          }
          if (depth !== 0) return steps;
        }
        break;
    }
    pc++;
    if (pc >= FULL) break;
  }
  return steps;
}

// The same machine, one step at a time, with its state exposed. Used by the
// microscope to show an organism at work. Ends with the same tape as run(), and
// halts with reason 'idle' at the same moment run() would fast-forward.
export class Machine {
  constructor(tape) {
    this.tape = tape; // Uint8Array(128), mutated in place
    this.pc = 0;
    this.h0 = 0;
    this.h1 = 0;
    this.steps = 0;
    this.halted = false;
    this.reason = ''; // 'end' | 'bracket' | 'budget' | 'idle'
    this.lastWrite = -1; // tape index written by the most recent step, or -1
    this.writes = 0; // write instructions executed
    this.changes = 0; // writes that actually changed a byte
    this.a = null; // remembered backward jumps, as in run()
    this.b = null;
    this.bAge = 0;
    this.bSpan = 1;
  }

  step(limit) {
    if (this.halted) return false;
    if (this.steps >= limit) return this.halt('budget');
    const t = this.tape;
    this.steps++;
    this.lastWrite = -1;
    switch (OP[t[this.pc]]) {
      case 1:
        this.h0 = (this.h0 - 1) & MASK;
        break;
      case 2:
        this.h0 = (this.h0 + 1) & MASK;
        break;
      case 3:
        this.h1 = (this.h1 - 1) & MASK;
        break;
      case 4:
        this.h1 = (this.h1 + 1) & MASK;
        break;
      case 5:
        this.write(this.h0, (t[this.h0] - 1) & 255);
        break;
      case 6:
        this.write(this.h0, (t[this.h0] + 1) & 255);
        break;
      case 7:
        this.write(this.h1, t[this.h0]);
        break;
      case 8:
        this.write(this.h0, t[this.h1]);
        break;
      case 9:
        if (t[this.h0] === 0) {
          let depth = 1;
          let pc = this.pc + 1;
          for (; pc < FULL; pc++) {
            const c = t[pc];
            if (c === CLOSE) {
              if (--depth === 0) break;
            } else if (c === OPEN) depth++;
          }
          if (depth !== 0) return this.halt('bracket');
          this.pc = pc;
        }
        break;
      case 10:
        if (t[this.h0] !== 0) {
          const here = (this.pc << 14) | (this.h0 << 7) | this.h1;
          if (this.a === null) {
            this.a = this.b = here;
            this.bAge = 0;
            this.bSpan = 1;
          } else if (here === this.a || here === this.b) {
            return this.halt('idle');
          } else if (++this.bAge === this.bSpan) {
            this.b = here;
            this.bAge = 0;
            this.bSpan <<= 1;
          }
          let depth = 1;
          let pc = this.pc - 1;
          for (; pc >= 0; pc--) {
            const c = t[pc];
            if (c === OPEN) {
              if (--depth === 0) break;
            } else if (c === CLOSE) depth++;
          }
          if (depth !== 0) return this.halt('bracket');
          this.pc = pc;
        }
        break;
    }
    this.pc++;
    if (this.pc >= FULL) return this.halt('end');
    if (this.steps >= limit) return this.halt('budget');
    return true;
  }

  write(i, value) {
    this.lastWrite = i;
    this.writes++;
    if (this.tape[i] !== value) {
      this.tape[i] = value;
      this.changes++;
      this.a = null;
    }
  }

  halt(reason) {
    this.halted = true;
    this.reason = reason;
    return false;
  }
}

// The replicator described in the paper. Its loop copies the tape back to front, and
// the program is its own mirror image, so the copy is a working program too.
// Used by the inoculation tool and the tests; nothing in the simulation refers to it.
export function textbookReplicator() {
  const genome = new Uint8Array(HALF).fill(0x20);
  const loop = '[[{.>]-]';
  for (let i = 0; i < loop.length; i++) {
    genome[i] = loop.charCodeAt(i);
    genome[HALF - 1 - i] = loop.charCodeAt(i);
  }
  return genome;
}

// Render 64 bytes as text: instructions as themselves, everything else as a dot.
export function genomeToString(bytes, offset = 0, length = HALF) {
  let s = '';
  for (let i = 0; i < length; i++) {
    const b = bytes[offset + i];
    s += OP[b] ? String.fromCharCode(b) : '·';
  }
  return s;
}

export function genomeToHex(bytes, offset = 0, length = HALF) {
  let s = '';
  for (let i = 0; i < length; i++) s += bytes[offset + i].toString(16).padStart(2, '0');
  return s;
}

