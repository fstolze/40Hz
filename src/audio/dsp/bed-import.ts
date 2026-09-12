/**
 * Preparing a decoded file to be used as a bed.
 *
 * The whole reason this module exists is a safety property. `worstCaseSourcePeak`
 * in `graph.ts` bounds the bed by `soundscape.gain`, and that bound is true for
 * the procedural generators because every one of them is bounded by unity.
 * Decoded audio is not: a lossy decoder can overshoot, and nothing stops a file
 * being mastered hot. So the ceiling stops holding the moment a file reaches the
 * graph unprepared.
 *
 * The order below is load-bearing and was got wrong once already. Normalising
 * before the loop fold undoes the normalisation, because an equal-power overlap
 * of two same-polarity samples near unity reaches √2. Measure and normalise
 * *last*, after every transformation is already in the buffer.
 *
 * Rejection is preferred to repair throughout. A file carrying NaN is corrupt,
 * not quiet; zero-filling it would hand the graph a buffer nobody inspected.
 *
 * Written in erasable TypeScript only, so it runs under Node's native type
 * stripping without a build.
 */

import { makeSeamless, DEFAULT_CROSSFADE_SECONDS } from './loop-bed.ts';

/**
 * Limits applied to *decoded* audio.
 *
 * A cap on the compressed file bounds nothing useful: a few megabytes of Opus
 * can decode into hours of multichannel PCM. These are the figures that
 * actually bound memory, and they are applied after `decodeAudioData` has said
 * what it really produced.
 */
export const MAX_BED_SECONDS = 600;
export const MAX_BED_CHANNELS = 8;
/** Float32, so four bytes per sample per channel. Two stereo copies fit easily. */
export const MAX_DECODED_BYTES = 256 * 1024 * 1024;

/**
 * Quietest bed worth keeping, as a true peak.
 *
 * Below this, "normalise to 1.0" is a scale of 1000 or more, which turns the
 * noise floor of a near-silent recording into the bed. A file this quiet is
 * almost certainly not the one the user meant to pick.
 */
export const MIN_BED_PEAK = 0.001;

export const BED_REJECTIONS = [
  'empty',
  'too-long',
  'too-many-channels',
  'too-large',
  'not-finite',
  'too-quiet',
] as const;

export type BedRejection = (typeof BED_REJECTIONS)[number];

export interface PreparedBed {
  /** Exactly two channels, normalised, already folded for seamless looping. */
  channels: Float32Array[];
  frames: number;
  sampleRate: number;
  /** True peak of the delivered buffer. 1.0 by construction; asserted, not assumed. */
  peak: number;
  /**
   * RMS of the delivered buffer.
   *
   * Measured *after* normalisation, because it is displayed against pink noise
   * at the same Level setting and has to describe the buffer that will play.
   * The figure from before normalisation describes a buffer that no longer
   * exists.
   */
  rms: number;
  durationSeconds: number;
  /** How many channels the file actually had, before the stereo policy. */
  sourceChannels: number;
  /** True when the source was mono, so the bed is not decorrelated. */
  mono: boolean;
  /** Gain applied by normalisation, for the record. */
  normalizationScale: number;
}

export type BedPreparation =
  { ok: true; bed: PreparedBed } | { ok: false; reason: BedRejection; detail: string };

function reject(reason: BedRejection, detail: string): BedPreparation {
  return { ok: false, reason, detail };
}

/**
 * True peak across every channel.
 *
 * The finiteness check is written into the loop rather than done once per
 * module. `Math.abs(NaN) > peak` is false, so a scan without it walks straight
 * past a broken sample and reports the healthy channel's peak for both — a
 * mistake this repo has now made three times in `src/integrity/`.
 */
function truePeak(channels: readonly Float32Array[]): { peak: number; finite: boolean } {
  let peak = 0;
  let finite = true;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const v = channel[i];
      if (!Number.isFinite(v)) {
        finite = false;
        continue;
      }
      const magnitude = Math.abs(v);
      if (magnitude > peak) peak = magnitude;
    }
  }
  return { peak, finite };
}

/** RMS across every channel, with the same finiteness discipline. */
function measureRms(channels: readonly Float32Array[]): number {
  let sum = 0;
  let count = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const v = channel[i];
      if (!Number.isFinite(v)) continue;
      sum += v * v;
      count++;
    }
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

/**
 * Exactly two channels, whatever arrived.
 *
 * Mono is duplicated, which costs the left/right decorrelation the noise
 * worklet has by design — the caller surfaces that rather than hiding it.
 * More than two are downmixed rather than refused: a 5.1 field recording is a
 * reasonable thing to want as a bed, and refusing it would be a limitation
 * dressed up as a standard.
 */
/**
 * Per-channel contributions to left and right, by channel count.
 *
 * Alternating channels between the two sides looked even-handed and is not:
 * in a conventional L/R/C/LFE/Ls/Rs file it sends the centre only left and the
 * LFE only right, which skews any material with a real centre image. These
 * follow the Web Audio specification's own down-mix, including dropping LFE —
 * a bed is background, and low-frequency effects energy is not what it is for.
 *
 * `null` for a channel count with no conventional layout; those fall back to a
 * plain average into both sides, which is even-handed because nothing is known
 * about the order rather than in spite of it.
 */
const HALF_POWER = Math.SQRT1_2;
const LAYOUTS: Record<number, { left: number[]; right: number[] } | undefined> = {
  // L, R
  2: { left: [1, 0], right: [0, 1] },
  // L, R, C
  3: { left: [1, 0, HALF_POWER], right: [0, 1, HALF_POWER] },
  // L, R, Ls, Rs
  4: { left: [1, 0, HALF_POWER, 0], right: [0, 1, 0, HALF_POWER] },
  // L, R, C, LFE, Ls, Rs
  6: {
    left: [1, 0, HALF_POWER, 0, HALF_POWER, 0],
    right: [0, 1, HALF_POWER, 0, 0, HALF_POWER],
  },
  // L, R, C, LFE, Ls, Rs, Lb, Rb
  8: {
    left: [1, 0, HALF_POWER, 0, HALF_POWER, 0, HALF_POWER, 0],
    right: [0, 1, HALF_POWER, 0, 0, HALF_POWER, 0, HALF_POWER],
  },
};

function toStereo(channels: readonly Float32Array[], frames: number): Float32Array[] {
  if (channels.length === 1) {
    return [channels[0].slice(0, frames), channels[0].slice(0, frames)];
  }
  if (channels.length === 2) {
    return [channels[0].slice(0, frames), channels[1].slice(0, frames)];
  }

  const layout = LAYOUTS[channels.length];
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);

  if (layout) {
    channels.forEach((channel, index) => {
      const l = layout.left[index];
      const r = layout.right[index];
      for (let i = 0; i < frames; i++) {
        left[i] += channel[i] * l;
        right[i] += channel[i] * r;
      }
    });
    return [left, right];
  }

  // No conventional layout for this count: average everything into both,
  // which at least treats every channel alike.
  for (const channel of channels) {
    for (let i = 0; i < frames; i++) {
      left[i] += channel[i] / channels.length;
      right[i] += channel[i] / channels.length;
    }
  }
  return [left, right];
}

/**
 * Run a decoded file through the whole pipeline.
 *
 * Sanitize, reject, transform, then measure and normalise — in that order, and
 * the order is the point. See the module comment.
 */
export function prepareBed(
  channels: readonly Float32Array[],
  sampleRate: number,
  crossfadeSeconds: number = DEFAULT_CROSSFADE_SECONDS,
): BedPreparation {
  const sourceChannels = channels.length;
  const sourceFrames = sourceChannels === 0 ? 0 : channels[0].length;

  if (
    sourceChannels === 0 ||
    sourceFrames === 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0
  ) {
    return reject('empty', 'the file decoded to no audio');
  }
  if (sourceChannels > MAX_BED_CHANNELS) {
    return reject(
      'too-many-channels',
      `${sourceChannels} channels, over the ${MAX_BED_CHANNELS} limit`,
    );
  }

  const durationSeconds = sourceFrames / sampleRate;
  if (durationSeconds > MAX_BED_SECONDS) {
    return reject(
      'too-long',
      `${Math.round(durationSeconds)} s of audio, over the ${MAX_BED_SECONDS} s limit`,
    );
  }
  if (sourceFrames * sourceChannels * 4 > MAX_DECODED_BYTES) {
    return reject('too-large', 'the decoded audio is larger than the memory budget');
  }

  // An early-out, not the authoritative check.
  //
  // Every source sample reaches the output — the fold blends the tail into the
  // head rather than discarding it — so the scan after the transform catches
  // everything this one would. What this buys is not correctness but work: a
  // corrupt or silent file is refused before up to a quarter of a gigabyte is
  // copied, downmixed and folded. Both checks are kept deliberately; neither
  // alone is a reason to remove the other.
  const sourceScan = truePeak(channels);
  if (!sourceScan.finite) {
    return reject('not-finite', 'the decoded audio contains NaN or infinite samples');
  }
  if (sourceScan.peak < MIN_BED_PEAK) {
    return reject(
      'too-quiet',
      'the file is silent, or so quiet that using it would raise its noise floor',
    );
  }

  // Transform: stereo, then the loop fold. Both before any measurement that
  // the delivered buffer has to satisfy.
  const stereo = toStereo(channels, sourceFrames);
  const seamless = makeSeamless(stereo, sampleRate, crossfadeSeconds);
  if (seamless.frames === 0) {
    return reject('empty', 'nothing remained after folding the loop point');
  }

  // Measure and normalise last, on exactly the buffer that will play — and
  // this is the scan the guarantee rests on. The fold can raise a peak (an
  // equal-power overlap of two same-polarity samples reaches √2), so a figure
  // taken before it describes a buffer that no longer exists.
  const finalScan = truePeak(seamless.channels);
  if (!finalScan.finite) {
    return reject('not-finite', 'the folded audio contains non-finite samples');
  }
  if (finalScan.peak < MIN_BED_PEAK) {
    return reject('too-quiet', 'nothing audible remained after folding the loop point');
  }

  const normalizationScale = 1 / finalScan.peak;
  for (const channel of seamless.channels) {
    for (let i = 0; i < channel.length; i++) channel[i] *= normalizationScale;
  }

  return {
    ok: true,
    bed: {
      channels: seamless.channels,
      frames: seamless.frames,
      sampleRate,
      peak: truePeak(seamless.channels).peak,
      rms: measureRms(seamless.channels),
      durationSeconds: seamless.frames / sampleRate,
      sourceChannels,
      mono: sourceChannels === 1,
      normalizationScale,
    },
  };
}
