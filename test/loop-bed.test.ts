/**
 * The loop seam.
 *
 * `noise.ts` picked procedural synthesis partly so this problem would not
 * exist. A user file brings it back, and the assertion that matters is the
 * discontinuity a listener would hear at the splice — not the shape of the
 * fade, which is an implementation detail.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { makeSeamless, seamDiscontinuity } from '../src/audio/dsp/loop-bed.ts';
import { mulberry32 } from '../src/audio/dsp/noise.ts';

const SR = 48000;

/**
 * A bed with a deliberately mismatched loop point.
 *
 * A sine at a frequency that does not divide the buffer length leaves a real
 * step between the last frame and the first — the ordinary case for any
 * recording that was not cut to a zero crossing.
 */
function mismatchedTone(frames: number, freq: number): Float32Array[] {
  const make = (phase: number): Float32Array => {
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) out[i] = Math.sin(2 * Math.PI * (freq * (i / SR) + phase));
    return out;
  };
  return [make(0), make(0.25)];
}

describe('folding the loop point', () => {
  it('removes a discontinuity the raw buffer has', () => {
    const frames = SR;
    const raw = mismatchedTone(frames, 137.3);
    const before = seamDiscontinuity(raw, frames);

    const folded = makeSeamless(raw, SR, 0.05);
    const after = seamDiscontinuity(folded.channels, folded.frames);

    // The control: the untreated buffer really does have a seam, so the
    // comparison below is against a fault rather than against nothing.
    expect(before).toBeGreaterThan(0.05);
    expect(after).toBeLessThan(before / 10);
  });

  it('shortens the buffer by exactly the fold', () => {
    const frames = SR;
    const folded = makeSeamless(mismatchedTone(frames, 137.3), SR, 0.05);
    expect(folded.crossfadeFrames).toBe(Math.floor(0.05 * SR));
    expect(folded.frames).toBe(frames - folded.crossfadeFrames);
    expect(folded.channels[0].length).toBe(folded.frames);
  });

  it('does not modify the caller’s buffers', () => {
    const raw = mismatchedTone(SR, 137.3);
    const firstBefore = raw[0][0];
    makeSeamless(raw, SR, 0.05);
    expect(raw[0][0]).toBe(firstBefore);
  });

  it('never consumes more than half the material', () => {
    // Asking for a fade longer than the bed would otherwise fold the tail onto
    // frames that are themselves part of the tail.
    const frames = 1000;
    const folded = makeSeamless(mismatchedTone(frames, 137.3), SR, 10);
    expect(folded.crossfadeFrames).toBeLessThanOrEqual(frames / 2);
    expect(folded.frames).toBeGreaterThan(0);
  });

  it('copies rather than aliases when there is nothing to fold', () => {
    const raw = mismatchedTone(64, 137.3);
    const folded = makeSeamless(raw, SR, 0);
    expect(folded.crossfadeFrames).toBe(0);
    folded.channels[0][0] = 0.5;
    // Aliasing the decoded audio would let a later edit reach back into it.
    expect(raw[0][0]).toBe(0);
  });
});

describe('the equal-power choice', () => {
  it('holds level across the fold for uncorrelated material', () => {
    // Tail and head of a recording are different moments of different sound,
    // so the fold adds power rather than amplitude. A linear pair would dip
    // audibly in the middle; equal power is why it does not.
    const frames = SR;
    const rng = mulberry32(9);
    const noise = new Float32Array(frames);
    for (let i = 0; i < frames; i++) noise[i] = rng() * 2 - 1;

    const folded = makeSeamless([noise], SR, 0.1);
    const crossfade = folded.crossfadeFrames;

    const rmsOver = (from: number, to: number): number => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += folded.channels[0][i] ** 2;
      return Math.sqrt(sum / (to - from));
    };

    const inFold = rmsOver(0, crossfade);
    const outside = rmsOver(crossfade, crossfade * 2);
    // Within a decibel of the untouched material either side of it.
    expect(20 * Math.log10(inFold / outside)).toBeGreaterThan(-1);
    expect(20 * Math.log10(inFold / outside)).toBeLessThan(1);
  });
});

describe('seam measurement', () => {
  it('refuses to judge a broken buffer rather than calling it perfect', () => {
    // Zero would be the natural-looking answer and the wrong one: every
    // comparison with NaN is false, so an unguarded scan skips the sample and
    // returns 0, which reads as a flawless seam.
    const broken = new Float32Array([Number.NaN, 0.1, 0.2, 0.9]);
    expect(Number.isNaN(seamDiscontinuity([broken], 4))).toBe(true);

    // The control: the same shape without the fault measures normally, so the
    // assertion above is about the NaN and not about the buffer being short.
    const real = new Float32Array([0.1, 0.1, 0.2, 0.9]);
    expect(seamDiscontinuity([real], 4)).toBeCloseTo(0.8, 6);
  });
});
