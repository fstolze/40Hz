/**
 * Procedurally generated soundscape beds.
 *
 * The specification assumes compressed audio assets streamed into buffers,
 * which forces dual-buffer equal-power crossfades to hide loop seams. Noise
 * synthesised in the audio thread is infinite by construction: no loop points,
 * no seam artifacts, a negligible binary, and an analytically known spectrum
 * so notch placement around the carrier can be exact.
 *
 * Written in erasable TypeScript only (no parameter properties, no abstract
 * members), so it runs under Node's native type stripping without a build.
 */

/** Deterministic PRNG, so renders and tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface NoiseGenerator {
  next(): number;
  fill(out: Float32Array, frames?: number): void;
}

function fillFrom(gen: NoiseGenerator, out: Float32Array, frames: number): void {
  for (let i = 0; i < frames; i++) out[i] = gen.next();
}

/** White noise, uniform in [-1, 1). Flat power spectral density. */
export class WhiteNoise implements NoiseGenerator {
  private rng: () => number;

  constructor(seed = 1) {
    this.rng = mulberry32(seed);
  }

  next(): number {
    return this.rng() * 2 - 1;
  }

  fill(out: Float32Array, frames: number = out.length): void {
    fillFrom(this, out, frames);
  }
}

/**
 * Pink noise (-3 dB/octave, 1/f power) via the Voss-McCartney algorithm.
 *
 * Pink matches the psychoacoustic frequency response of human hearing, which
 * is what makes it an effective mask for pulse transients while leaving the
 * low-frequency amplitude envelope intact.
 */
export class PinkNoise implements NoiseGenerator {
  private rows: Float64Array;
  private runningSum = 0;
  private counter = 0;
  private numRows: number;
  private rng: () => number;

  constructor(seed = 1, numRows = 16) {
    this.rng = mulberry32(seed);
    this.numRows = numRows;
    this.rows = new Float64Array(numRows);
    for (let i = 0; i < numRows; i++) {
      this.rows[i] = this.white();
      this.runningSum += this.rows[i];
    }
  }

  private white(): number {
    return this.rng() * 2 - 1;
  }

  next(): number {
    this.counter = (this.counter + 1) >>> 0;

    // Row index is the number of trailing zero bits of the counter, so row k
    // is refreshed every 2^k samples, producing octave-spaced contributions.
    let n = this.counter;
    let k = 0;
    while ((n & 1) === 0 && k < this.numRows - 1) {
      n >>>= 1;
      k++;
    }

    this.runningSum -= this.rows[k];
    this.rows[k] = this.white();
    this.runningSum += this.rows[k];

    return (this.runningSum + this.white()) / (this.numRows + 1);
  }

  fill(out: Float32Array, frames: number = out.length): void {
    fillFrom(this, out, frames);
  }
}

/**
 * Brown / red noise (-6 dB/octave, 1/f^2 power) via a leaky integrator.
 *
 * The leak prevents the DC wander an ideal integrator would accumulate, at the
 * cost of flattening the spectrum below the corner frequency. leak = 0.005
 * puts that corner near 38 Hz at 48 kHz.
 */
export class BrownNoise implements NoiseGenerator {
  private last = 0;
  private leak: number;
  private rng: () => number;

  constructor(seed = 1, leak = 0.005) {
    this.rng = mulberry32(seed);
    this.leak = leak;
  }

  next(): number {
    const white = this.rng() * 2 - 1;
    this.last = (this.last + this.leak * white) / (1 + this.leak);
    return this.last * 3; // restore roughly unit peak level
  }

  fill(out: Float32Array, frames: number = out.length): void {
    fillFrom(this, out, frames);
  }
}

/** Runtime list, so untrusted input can be checked against it. */
export const NOISE_COLORS = ['white', 'pink', 'brown'] as const;

export type NoiseColor = (typeof NOISE_COLORS)[number];

export function createNoise(color: NoiseColor, seed = 1): NoiseGenerator {
  switch (color) {
    case 'white':
      return new WhiteNoise(seed);
    case 'pink':
      return new PinkNoise(seed);
    case 'brown':
      return new BrownNoise(seed);
  }
}
