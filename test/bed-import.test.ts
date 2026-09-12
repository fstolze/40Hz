/**
 * Preparing a decoded file to be a bed.
 *
 * The property under test is a safety one: `worstCaseSourcePeak` bounds the
 * bed by `soundscape.gain` and is only true because every source is bounded by
 * unity. This module is what makes that true for a file. Everything else here
 * is in service of that, especially the pipeline *order* — normalising before
 * the loop fold silently undoes the normalisation.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { prepareBed, MIN_BED_PEAK, MAX_BED_SECONDS } from '../src/audio/dsp/bed-import.ts';
import { mulberry32 } from '../src/audio/dsp/noise.ts';

const SR = 48000;

function tone(frames: number, freq: number, amplitude: number): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = amplitude * Math.sin(2 * Math.PI * freq * (i / SR));
  return out;
}

function noise(frames: number, amplitude: number, seed = 3): Float32Array {
  const rng = mulberry32(seed);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = (rng() * 2 - 1) * amplitude;
  return out;
}

function ok(result: ReturnType<typeof prepareBed>) {
  if (!result.ok)
    throw new Error(`expected a prepared bed, got ${result.reason}: ${result.detail}`);
  return result.bed;
}

describe('the peak guarantee', () => {
  it('delivers a buffer at unity peak from quiet material', () => {
    const bed = ok(prepareBed([tone(SR, 137.3, 0.02), tone(SR, 191.1, 0.02)], SR));
    expect(bed.peak).toBeCloseTo(1, 4);
  });

  it('brings hot material down rather than passing it through', () => {
    // A decoder can overshoot, and nothing stops a file being mastered hot.
    // Left unchecked this is what breaks the ceiling.
    const bed = ok(prepareBed([tone(SR, 137.3, 1.8), tone(SR, 191.1, 1.8)], SR));
    expect(bed.peak).toBeCloseTo(1, 4);
    expect(bed.normalizationScale).toBeLessThan(1);
  });

  it('holds at unity across a sweep of input levels', () => {
    // Swept because a single amplitude would not catch a scale computed from
    // the wrong buffer — the ordering bug this module is shaped around.
    for (const amplitude of [0.005, 0.05, 0.3, 0.9, 1, 1.4, 3]) {
      const bed = ok(prepareBed([noise(SR, amplitude, 11), noise(SR, amplitude, 12)], SR));
      expect(bed.peak).toBeLessThanOrEqual(1.0000001);
      expect(bed.peak).toBeCloseTo(1, 4);
    }
  });
});

describe('the pipeline order', () => {
  it('normalises after the fold, not before it', () => {
    // The bug this ordering exists to prevent: an equal-power overlap of two
    // same-polarity samples near unity reaches √2, so a buffer normalised
    // first comes out of the fold above unity. Material engineered so the
    // fold lands on same-polarity peaks makes that visible.
    const frames = SR;
    const constant = new Float32Array(frames).fill(0.999);
    const bed = ok(prepareBed([constant, constant], SR));
    // If normalisation ran first, this would be ~1.41 rather than 1.
    expect(bed.peak).toBeLessThanOrEqual(1.0000001);
  });

  it('reports RMS of the buffer that will actually play', () => {
    // Measured before normalisation it would describe a buffer that no longer
    // exists — and it is displayed against pink noise at the same Level.
    const bed = ok(prepareBed([noise(SR, 0.01, 5), noise(SR, 0.01, 6)], SR));
    let sum = 0;
    let count = 0;
    for (const channel of bed.channels) {
      for (let i = 0; i < bed.frames; i++) {
        sum += channel[i] ** 2;
        count++;
      }
    }
    expect(bed.rms).toBeCloseTo(Math.sqrt(sum / count), 6);
    // Sanity: a peak-normalised buffer has an RMS well under its peak.
    expect(bed.rms).toBeLessThan(bed.peak);
  });
});

describe('rejection rather than repair', () => {
  it('refuses audio carrying NaN instead of measuring around it', () => {
    // Skipping the sample would leave it in the playback buffer, which is a
    // fault nobody inspected rather than a file that is merely quiet.
    const broken = tone(SR, 137.3, 0.5);
    broken[1234] = Number.NaN;
    const result = prepareBed([broken, tone(SR, 191.1, 0.5)], SR);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('not-finite');
  });

  it('refuses infinite samples too', () => {
    const broken = tone(SR, 137.3, 0.5);
    broken[99] = Number.POSITIVE_INFINITY;
    const result = prepareBed([broken, broken.slice()], SR);
    expect(result.ok === false && result.reason).toBe('not-finite');
  });

  it('refuses near-silence rather than amplifying its noise floor', () => {
    const result = prepareBed([tone(SR, 137.3, MIN_BED_PEAK / 10)], SR);
    expect(result.ok === false && result.reason).toBe('too-quiet');
  });

  it('accepts material just above the silence floor', () => {
    // The control: the rejection above is about the level, not about tones.
    const result = prepareBed([tone(SR, 137.3, MIN_BED_PEAK * 10)], SR);
    expect(result.ok).toBe(true);
  });

  it('refuses audio longer than the memory budget allows', () => {
    // Built as a length rather than as real samples: the point is the limit,
    // and allocating ten minutes of audio to prove it would be absurd.
    const long = new Float32Array(Math.ceil((MAX_BED_SECONDS + 1) * SR));
    long.fill(0.5);
    const result = prepareBed([long], SR);
    expect(result.ok === false && result.reason).toBe('too-long');
  });

  it('refuses an empty decode', () => {
    expect(prepareBed([], SR).ok).toBe(false);
    expect(prepareBed([new Float32Array(0)], SR).ok).toBe(false);
  });
});

describe('the channel policy', () => {
  it('duplicates mono, and says that it did', () => {
    const bed = ok(prepareBed([tone(SR, 137.3, 0.5)], SR));
    expect(bed.channels.length).toBe(2);
    expect(bed.mono).toBe(true);
    expect(bed.sourceChannels).toBe(1);
    // Duplicated, so the two channels are identical — which is exactly the
    // decorrelation the noise worklet has and this does not.
    expect(bed.channels[0][100]).toBe(bed.channels[1][100]);
  });

  it('keeps a stereo pair distinct', () => {
    const bed = ok(prepareBed([tone(SR, 137.3, 0.5), noise(SR, 0.5, 8)], SR));
    expect(bed.mono).toBe(false);
    expect(bed.channels[0][100] === bed.channels[1][100]).toBe(false);
  });

  it('places each surround channel where its layout says, not by parity', () => {
    // Alternating channels between the sides looks even-handed and is not: in
    // a conventional L/R/C/LFE/Ls/Rs file it sends the centre only left and
    // the LFE only right, which skews anything with a real centre image.
    const frames = 4096;
    const silent = () => new Float32Array(frames);
    const tone = (amplitude: number) => {
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) out[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / SR);
      return out;
    };

    // Centre only. It must reach both sides equally.
    const centreOnly = [silent(), silent(), tone(0.5), silent(), silent(), silent()];
    const bed = ok(prepareBed(centreOnly, SR));
    let worst = 0;
    for (let i = 0; i < bed.frames; i++) {
      worst = Math.max(worst, Math.abs(bed.channels[0][i] - bed.channels[1][i]));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('drops the LFE channel rather than folding it into either side', () => {
    // The specification's own down-mix discards it, and a bed is background —
    // low-frequency effects energy is not what it is for. Asserted against the
    // same material without an LFE channel: adding one must change nothing.
    const frames = 4096;
    const silent = () => new Float32Array(frames);
    const tone = (amplitude: number, hz: number) => {
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / SR);
      return out;
    };

    const front = () => [tone(0.5, 220), tone(0.5, 330)];
    const withoutLfe = [...front(), silent(), silent(), silent(), silent()];
    const withLfe = [...front(), silent(), tone(0.9, 40), silent(), silent()];

    const a = ok(prepareBed(withoutLfe, SR));
    const b = ok(prepareBed(withLfe, SR));

    let worst = 0;
    for (let i = 0; i < Math.min(a.frames, b.frames); i++) {
      worst = Math.max(worst, Math.abs(a.channels[0][i] - b.channels[0][i]));
      worst = Math.max(worst, Math.abs(a.channels[1][i] - b.channels[1][i]));
    }
    expect(worst).toBeLessThan(1e-6);

    // The control: an LFE that loud would dominate if it were folded in, so a
    // policy that kept it could not possibly produce identical output.
    expect(a.peak).toBeCloseTo(1, 4);
  });

  it('keeps the surround pair on their own sides', () => {
    const frames = 4096;
    const silent = () => new Float32Array(frames);
    const tone = (amplitude: number) => {
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) out[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / SR);
      return out;
    };

    // Left surround only: left must carry it and right must not.
    const leftSurround = [silent(), silent(), silent(), silent(), tone(0.5), silent()];
    const bed = ok(prepareBed(leftSurround, SR));
    let leftPeak = 0;
    let rightPeak = 0;
    for (let i = 0; i < bed.frames; i++) {
      leftPeak = Math.max(leftPeak, Math.abs(bed.channels[0][i]));
      rightPeak = Math.max(rightPeak, Math.abs(bed.channels[1][i]));
    }
    expect(leftPeak).toBeGreaterThan(0.5);
    expect(rightPeak).toBeLessThan(1e-6);
  });

  it('downmixes more than two channels rather than refusing them', () => {
    const six = [0, 1, 2, 3, 4, 5].map((i) => noise(SR, 0.4, 20 + i));
    const bed = ok(prepareBed(six, SR));
    expect(bed.channels.length).toBe(2);
    expect(bed.sourceChannels).toBe(6);
    expect(bed.peak).toBeCloseTo(1, 4);
  });
});
