/**
 * The modulation figures the scope displays.
 *
 * Pure, and separate from the component, because the arithmetic is where this
 * has gone wrong twice and neither failure was visible on screen — a number
 * that is merely wrong looks exactly like a number that is right.
 *
 * **Binning does not work here, at any bin length.** The obvious cheap
 * approach — cut the buffer into bins and take each one's loudest sample — needs
 * a bin much shorter than a modulation period and much longer than a carrier
 * cycle. The engine allows carriers from 20 Hz and modulation to 200 Hz, so
 * those two demands routinely cross: at an 80 Hz carrier and 40 Hz modulation a
 * carrier cycle is exactly half a modulation period, every bin swallows a
 * trough along with a peak, and the reading collapses to near zero and flickers
 * with buffer alignment. Both earlier versions of this were a bin length in
 * disguise, and both were wrong in configurations nobody happened to try.
 *
 * The analytic envelope has no such parameter. It costs a transform, which is
 * why the caller is expected to run it at a readable rate rather than at the
 * frame rate.
 *
 * **What it still cannot do exactly.** Recovering an envelope from the analytic
 * signal assumes the carrier is narrowband against the modulation, and the
 * engine permits configurations where it plainly is not.
 *
 * The figure also depends on the *relative* phase of carrier and modulator, not
 * just on where a window starts. The worklet's accumulators are never reset, so
 * a parameter change during playback leaves that relative phase at whatever it
 * had reached — and at, say, 81 Hz against 40 Hz it walks at 1 Hz, so an
 * unchanged signal reads differently from one moment to the next. Measured over
 * the whole phase space on a fully gated signal:
 *
 * | carrier / rate | reading            |
 * | -------------- | ------------------ |
 * | 124 Hz / 40 Hz | 100% exactly       |
 * | 999 Hz / 40 Hz | 100% exactly       |
 * | 220 Hz / 40 Hz | 97.4 - 100%        |
 * | 160 Hz / 40 Hz | 96.9 - 100%        |
 * | 81 Hz / 40 Hz  | 87.8 - 100%        |
 * | 80 Hz / 40 Hz  | 82.9 - 100%        |
 * | 60 Hz / 40 Hz  | 66.2 - 100%        |
 * | 20 Hz / 40 Hz  | 51.4 - 100%        |
 *
 * Not monotonic in the ratio, and it does not settle until the carrier is
 * several times the rate — 120 Hz still spans 92.6 - 100%.
 *
 * **And the error runs both ways, which is why none of this is smoothed away.**
 * A running maximum or an average would be defensible if the estimator only
 * ever under-read; it does not. At an 80 Hz carrier and depth 0.5 it reports
 * 35-43% where the true figure is 33.4%. Smoothing would trade a visible wobble
 * for a confident wrong number, and it cannot make the reading accurate at
 * these ratios — that would take a different estimator, not a filter.
 *
 * So the reading is left as it is, and its limits are stated here. It is a
 * display; its error at the awkward ratios is single figures to tens of percent
 * rather than the hundreds the binned version produced, and it never leaves
 * [0, 1].
 */

import { measureEnvelope } from './metrics.ts';

export interface ModulationReadout {
  /**
   * What the reading is worth.
   *
   * Three states rather than a number and a flag, because a display has three
   * things to say and conflating two of them is how invalid output came to be
   * shown as a confident 0.0%. `silent` means there is nothing playing;
   * `invalid` means what arrived was not audio; `insufficient` means there was
   * not enough of it to transform; `reading` means the numbers below mean
   * something.
   */
  kind: 'reading' | 'silent' | 'invalid' | 'insufficient';
  /** Classic AM index, `(max - min) / (max + min)`, in [0, 1]. */
  index: number;
  /** Peak-to-trough ratio in dB, capped where a display would stop caring. */
  depthDb: number;
}

/**
 * Whether a buffer is audio at all.
 *
 * Exported because the caller has to know before it draws, not only before it
 * measures: an all-NaN bin leaves the drawing loop's sentinels untouched, and
 * the scope traced a full-scale envelope from them while reporting no
 * modulation.
 */
export function isFinitePcm(samples: Float32Array | Float64Array): boolean {
  for (let i = 0; i < samples.length; i += 1) {
    if (!Number.isFinite(samples[i])) return false;
  }
  return true;
}

/** Above this the trough is silent for display purposes, and the ratio is capped. */
const MAX_DEPTH_DB = 60;

/**
 * Silent, as far as a readout is concerned.
 *
 * Relative to the signal's own peak rather than absolute, so a quiet preset
 * does not read as fully gated purely for being quiet — the mistake the
 * previous version made with a fixed 0.0015 floor.
 */
const TROUGH_FLOOR = 1e-3;

export const SILENT_READOUT: ModulationReadout = Object.freeze({
  kind: 'silent',
  index: 0,
  depthDb: 0,
});

export const INVALID_READOUT: ModulationReadout = Object.freeze({
  kind: 'invalid',
  index: 0,
  depthDb: 0,
});

/**
 * Too little to transform — which is not the same as nothing playing.
 *
 * Its own state because the alternative was calling it silence, and silence is
 * a claim about the output. A short window of a loud tone is not silent; the
 * reading simply has nowhere to stand.
 */
export const INSUFFICIENT_READOUT: ModulationReadout = Object.freeze({
  kind: 'insufficient',
  index: 0,
  depthDb: 0,
});

export function modulationReadout(
  samples: Float32Array | Float64Array,
  sampleRate: number,
): ModulationReadout {
  // `measureEnvelope` finds its extremes by comparison, and no comparison with
  // NaN is true — so a buffer of them yields extremes drawn from whatever else
  // is present, and a confident number about output that is not audio. Cheaper
  // to refuse here than to make the shared primitive defensive for one caller.
  //
  // Asked before the length, because the two questions are independent and
  // answering the cheaper one first got the answer wrong: a short buffer of NaN
  // was reported as silence, which is a claim about the output rather than
  // about the buffer.
  if (!isFinitePcm(samples)) return INVALID_READOUT;

  // The envelope is found by transforming the window, which truncates to a
  // power of two: too short a buffer has nothing left after the edges are
  // trimmed, and would produce a confident figure from a handful of samples.
  if (samples.length < 1024) return INSUFFICIENT_READOUT;

  const signal = samples instanceof Float64Array ? samples : Float64Array.from(samples);
  const { index, max, min } = measureEnvelope(signal, sampleRate);
  if (!Number.isFinite(index) || max <= 0) return SILENT_READOUT;

  return {
    kind: 'reading',
    // The analytic envelope is non-negative, so this cannot leave [0, 1] — but
    // clamping says so at the boundary rather than trusting it.
    index: Math.min(1, Math.max(0, index)),
    depthDb:
      min > max * TROUGH_FLOOR ? Math.min(MAX_DEPTH_DB, 20 * Math.log10(max / min)) : MAX_DEPTH_DB,
  };
}
