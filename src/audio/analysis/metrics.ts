/**
 * Envelope extraction and entrainment metrics.
 *
 * These are the measurements that answer "is a 40 Hz amplitude envelope
 * actually present, and how deep is it?" — applied offline to synthesised
 * audio here (Layer 1), and later to loopback-captured output (Layer 3).
 * Identical code path, different source, which is what makes a discrepancy
 * between the two diagnostic.
 */

import { fft, ifft, prevPowerOfTwo, dominantFrequency } from './fft.ts';

/**
 * Amplitude envelope via the analytic signal (Hilbert transform).
 *
 * Truncates to the largest power of two at or below the input length.
 */
export function analyticEnvelope(signal: Float64Array): Float64Array {
  const n = prevPowerOfTwo(signal.length);
  const re = Float64Array.from(signal.subarray(0, n));
  const im = new Float64Array(n);

  fft(re, im);

  // Zero the negative frequencies and double the positive ones, leaving DC
  // and Nyquist unchanged. The result is the analytic signal.
  const half = n / 2;
  for (let k = 1; k < half; k++) {
    re[k] *= 2;
    im[k] *= 2;
  }
  for (let k = half + 1; k < n; k++) {
    re[k] = 0;
    im[k] = 0;
  }

  ifft(re, im);

  const env = new Float64Array(n);
  for (let i = 0; i < n; i++) env[i] = Math.hypot(re[i], im[i]);
  return env;
}

/** Drop `fraction` of the samples from each end, where Hilbert edge effects live. */
export function trimEdges(signal: Float64Array, fraction = 0.1): Float64Array {
  const cut = Math.floor(signal.length * fraction);
  return signal.subarray(cut, signal.length - cut);
}

export interface EnvelopeMetrics {
  /** Dominant frequency of the amplitude envelope, in Hz. */
  frequencyHz: number;
  /** Classic AM modulation index, (max - min) / (max + min), in [0, 1]. */
  index: number;
  /** Peak-to-trough ratio in dB. Capped at 120 for a fully gated signal. */
  depthDb: number;
  min: number;
  max: number;
}

/**
 * Measure the amplitude envelope of `signal`.
 *
 * @param minHz Floor for the dominant-frequency search, to reject the DC term.
 */
export function measureEnvelope(
  signal: Float64Array,
  sampleRate: number,
  minHz = 5,
): EnvelopeMetrics {
  const env = trimEdges(analyticEnvelope(signal));

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < env.length; i++) {
    if (env[i] < min) min = env[i];
    if (env[i] > max) max = env[i];
  }

  const index = max + min > 0 ? (max - min) / (max + min) : 0;
  const depthDb = min > 1e-12 ? Math.min(120, 20 * Math.log10(max / min)) : 120;

  return {
    frequencyHz: dominantFrequency(Float64Array.from(env), sampleRate, minHz),
    index,
    depthDb,
    min,
    max,
  };
}

/**
 * Pearson correlation between two channels.
 *
 * Near 1.0 means the channels are identical (diotic). A binaural pair should
 * sit near zero over a whole number of beat periods; a value climbing toward
 * 1.0 on a signal that was rendered dichotically means something downstream
 * has collapsed the channels — a joint-stereo codec, a crossfeed effect, or
 * an OS spatialiser. That is the Layer 3 check.
 */
export function interauralCorrelation(left: Float64Array, right: Float64Array): number {
  const n = Math.min(left.length, right.length);
  let sl = 0;
  let sr = 0;
  for (let i = 0; i < n; i++) {
    sl += left[i];
    sr += right[i];
  }
  const ml = sl / n;
  const mr = sr / n;

  let num = 0;
  let dl = 0;
  let dr = 0;
  for (let i = 0; i < n; i++) {
    const a = left[i] - ml;
    const b = right[i] - mr;
    num += a * b;
    dl += a * a;
    dr += b * b;
  }
  const denom = Math.sqrt(dl * dr);
  return denom > 0 ? num / denom : 0;
}

/** Sum two channels to mono, as the ear does with speakers or a mono downmix. */
export function toMono(left: Float64Array, right: Float64Array): Float64Array {
  const n = Math.min(left.length, right.length);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = (left[i] + right[i]) * 0.5;
  return out;
}

export function peakLevel(signal: Float64Array): number {
  let peak = 0;
  for (let i = 0; i < signal.length; i++) {
    const v = Math.abs(signal[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

export function rms(signal: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < signal.length; i++) sum += signal[i] * signal[i];
  return Math.sqrt(sum / signal.length);
}
