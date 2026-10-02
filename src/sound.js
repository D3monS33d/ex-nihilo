// Sound, off until asked for. A sterile universe is filtered noise. As life spreads the
// noise recedes and a chord fades in: one voice per dominant species, its pitch taken
// from the species key, its loudness from how much of the universe that species holds.
// Births ring, extinctions thud.

const SCALE = [0, 3, 5, 7, 10]; // minor pentatonic: any set of voices is consonant
const VOICES = 4;
const BASE_HZ = 110;

function pitch(key) {
  const i = key % (SCALE.length * 2);
  return BASE_HZ * 2 ** (Math.floor(i / SCALE.length) + SCALE[i % SCALE.length] / 12);
}

export class Sound {
  constructor() {
    this.ctx = null;
    this.on = false;
  }

  // Must be called from a user gesture the first time (browsers require it).
  toggle() {
    this.on = !this.on;
    if (this.on && !this.ctx) this.build();
    if (this.ctx) {
      if (this.on) this.ctx.resume();
      this.master.gain.setTargetAtTime(this.on ? 0.5 : 0, this.ctx.currentTime, 0.15);
    }
    return this.on;
  }

  build() {
    const ctx = (this.ctx = new AudioContext());
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const limiter = ctx.createDynamicsCompressor();
    this.master.connect(limiter).connect(ctx.destination);

    // Noise bed.
    const seconds = 2;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'lowpass';
    this.noiseFilter.frequency.value = 700;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0.16;
    noise.connect(this.noiseFilter).connect(this.noiseGain).connect(this.master);
    noise.start();

    // One voice per dominant species: two slightly detuned triangles through a soft filter.
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 1800;
    tone.connect(this.master);
    this.voices = [];
    for (let v = 0; v < VOICES; v++) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(tone);
      const oscillators = [-4, 4].map((cents) => {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.detune.value = cents;
        osc.connect(gain);
        osc.start();
        return osc;
      });
      this.voices.push({ gain, oscillators });
    }

    // A low drone that deepens with complexity.
    this.drone = ctx.createOscillator();
    this.drone.frequency.value = BASE_HZ / 2;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    this.drone.connect(this.droneGain).connect(this.master);
    this.drone.start();
  }

  // stats: the coordinator's stats message. complexity: bits per byte, 0..8.
  update(stats, complexity) {
    if (!this.on || !this.ctx) return;
    const now = this.ctx.currentTime;
    const share = stats.alive / stats.cells;
    const running = stats.running ? 1 : 0.25;
    this.noiseGain.gain.setTargetAtTime(0.16 * (1 - share) ** 2 * running + 0.006, now, 0.4);
    this.noiseFilter.frequency.setTargetAtTime(500 + 6000 * Math.min(1, stats.density * 6), now, 0.6);
    this.droneGain.gain.setTargetAtTime(0.12 * Math.min(1, complexity / 6) * running, now, 0.8);

    const living = stats.top.filter((t) => t.replicator).slice(0, VOICES);
    this.voices.forEach((voice, v) => {
      const species = living[v];
      if (species) {
        const hz = pitch(species.key);
        for (const osc of voice.oscillators) osc.frequency.setTargetAtTime(hz, now, 0.08);
        // Loudness follows the universe's living share, split by each species' standing.
        const level = 0.11 * Math.sqrt(share) * Math.sqrt(species.count / living[0].count) * running;
        voice.gain.gain.setTargetAtTime(level, now, 0.5);
      } else {
        voice.gain.gain.setTargetAtTime(0, now, 0.5);
      }
    });
  }

  // A short struck tone: `hz` falling silent over `seconds`.
  strike(hz, seconds, level) {
    if (!this.on || !this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(level, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + seconds);
  }

  birth() {
    this.strike(880, 2.5, 0.25);
    this.strike(1320, 1.8, 0.12);
  }

  extinction() {
    this.strike(70, 1.6, 0.5);
  }

  takeover() {
    [220, 330, 440, 660].forEach((hz, i) => setTimeout(() => this.strike(hz, 4, 0.18), i * 140));
  }
}
