/**
 * Output ceiling tests.
 *
 * `MAX_MASTER_LEVEL` is documented as a ceiling on the output peak, and the
 * limiter is documented as never engaging beneath it. Both claims are only
 * true because the master gain is divided by the worst-case source sum, so
 * they are asserted here against the real DSP rather than against the bound.
 *
 * The bound itself is checked the same way: rendered peaks must not exceed
 * what `worstCaseSourcePeak` predicts, or the guarantee rests on nothing.
 *
 * The bed is now rendered **through the notch chain**, which it was not
 * before. That omission was the bug: the previous version summed raw noise
 * with the entrainment path and so could never have observed the filter
 * raising a peak. The chain here is the model in `dsp/biquad.ts`; that it
 * matches Chromium's `BiquadFilterNode` is established by the Electron
 * measurement, not by this file.
 */

import { describe, it, expect } from './helpers/expect.ts';
import {
  MAX_MASTER_LEVEL,
  headroomScale,
  transitionPeakBound,
  worstCaseSourcePeak,
} from '../src/audio/graph.ts';
import { DEFAULT_SOUNDSCAPE, type SoundscapeOptions } from '../src/audio/configuration.ts';
import {
  DEFAULT_PARAMS,
  createState,
  render,
  type EntrainmentParams,
} from '../src/audio/dsp/entrainment-core.ts';
import { createNoise } from '../src/audio/dsp/noise.ts';
import { BOUND_MARGIN, notchChain, type BiquadSection } from '../src/audio/dsp/biquad.ts';
import { scheduleSessionEnvelope, type EnvelopeParam } from '../src/audio/session-envelope.ts';

/** Records the highest value the envelope is ever scheduled to reach. */
class FakeEnvelopeParam implements EnvelopeParam {
  value = 0;
  peak = 0;
  setValueAtTime(value: number): void {
    this.peak = Math.max(this.peak, value);
  }
  linearRampToValueAtTime(value: number): void {
    this.peak = Math.max(this.peak, value);
  }
  cancelScheduledValues(): void {}
}

const SR = 48000;
const FRAMES = SR * 2;

/** -1 dBFS, the limiter threshold set in graph.ts. */
const LIMITER_THRESHOLD = Math.pow(10, -1 / 20);

/** Run a cascade over a buffer from zero state, as the graph's chain does. */
function throughChain(sections: readonly BiquadSection[], signal: Float64Array): Float64Array {
  const out = Float64Array.from(signal);
  for (const s of sections) {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < out.length; i++) {
      const x0 = out[i];
      const y0 = s.b0 * x0 + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
      out[i] = y0;
    }
  }
  return out;
}

/**
 * Peak of the entrainment path plus the bed **after the notch chain**.
 *
 * The bed is filtered before it is summed, exactly as the graph wires it. The
 * two are then added sample-for-sample, which is a worst-case alignment no
 * real moment achieves — the point is the bound, not the likely value.
 */
function renderPeak(params: EntrainmentParams, soundscape: SoundscapeOptions): number {
  const left = new Float32Array(FRAMES);
  const right = new Float32Array(FRAMES);
  render(params, createState(), SR, left, right, FRAMES);

  const noise = createNoise(soundscape.color, 7);
  const raw = new Float64Array(FRAMES);
  for (let i = 0; i < FRAMES; i++) raw[i] = noise.next();

  const filtered = throughChain(
    notchChain(
      params.carrierHz,
      params.modulationHz,
      soundscape.notchQ,
      soundscape.notchDepthDb,
      SR,
    ),
    raw,
  );

  let peak = 0;
  for (let i = 0; i < FRAMES; i++) {
    const bed = filtered[i] * soundscape.gain;
    const l = Math.abs(left[i] + bed);
    const r = Math.abs(right[i] + bed);
    // Finiteness in the loop, not once per module: every comparison with NaN
    // is false, so an unguarded scan reports the healthy channel's peak.
    if (Number.isFinite(l) && l > peak) peak = l;
    if (Number.isFinite(r) && r > peak) peak = r;
  }
  return peak;
}

/** The loudest settings the UI permits: both level sliders cap at 0.6. */
const MAX_MIX: EntrainmentParams = {
  ...DEFAULT_PARAMS,
  duty: 0.5,
  edge: 0.5,
  depth: 1,
  amGain: 0.6,
  twoToneGain: 0.6,
  twoToneMode: 'dichotic',
};

/** Soundscape gain caps at 0.8 in the UI. */
const MAX_BED: SoundscapeOptions = { ...DEFAULT_SOUNDSCAPE, gain: 0.8 };

describe('worst-case source peak', () => {
  it('bounds the rendered peak at the loudest permitted settings', () => {
    expect(renderPeak(MAX_MIX, MAX_BED)).toBeLessThanOrEqual(
      worstCaseSourcePeak(MAX_MIX, MAX_BED, SR),
    );
  });

  it('bounds the rendered peak for every built-in routing', () => {
    for (const twoToneMode of ['off', 'dichotic', 'diotic'] as const) {
      const params = { ...MAX_MIX, twoToneMode };
      expect(renderPeak(params, MAX_BED)).toBeLessThanOrEqual(
        worstCaseSourcePeak(params, MAX_BED, SR),
      );
    }
  });

  it('ignores the two-tone gain when the path is off', () => {
    const params = {
      ...DEFAULT_PARAMS,
      amGain: 0.3,
      twoToneGain: 0.6,
      twoToneMode: 'off' as const,
    };
    // A 0 dB notch is exactly the identity — the cookbook's numerator and
    // denominator coincide when A is 1 — so the bed contributes its gain and
    // the unconditional safety margin, and nothing else. That keeps this test
    // about the two-tone term, which is what it is for.
    const flat = { ...DEFAULT_SOUNDSCAPE, gain: 0.2, notchDepthDb: 0 };
    expect(worstCaseSourcePeak(params, flat, SR)).toBeCloseTo(0.3 + 0.2 * BOUND_MARGIN, 6);
  });

  it('counts the notch chain’s ringing, not just the bed’s gain', () => {
    // The correction. "The notches only cut" is about magnitude response; a
    // cut biquad still rings, and the bound has to carry that or it is not a
    // bound. Asserted as a strict inequality against the same mix with the
    // notches flat, so it cannot pass by the bed term being ignored entirely.
    const flat = { ...MAX_BED, notchDepthDb: 0 };
    expect(worstCaseSourcePeak(MAX_MIX, MAX_BED, SR)).toBeGreaterThan(
      worstCaseSourcePeak(MAX_MIX, flat, SR),
    );
  });
});

describe('headroom scale', () => {
  it('leaves an ordinary mix untouched', () => {
    // The Focus preset. Its bed term is 0.32 x 1.97 once the notch ringing is
    // counted, so the sum is 0.91 — still under unity, which is why this
    // preset costs nothing at all under the correction.
    const params = { ...DEFAULT_PARAMS, amGain: 0.28, twoToneMode: 'off' as const };
    const focusBed = { ...DEFAULT_SOUNDSCAPE, gain: 0.32 };
    expect(headroomScale(params, focusBed, SR)).toBe(1);
  });

  it('divides an overloaded mix back to unity', () => {
    // 0.6 + 0.6 + 0.8 x margin, with the notches flat so the arithmetic is
    // exactly checkable rather than resting on the swept bound.
    const flat = { ...MAX_BED, notchDepthDb: 0 };
    expect(headroomScale(MAX_MIX, flat, SR)).toBeCloseTo(1 / (1.2 + 0.8 * BOUND_MARGIN), 9);
  });

  it('always brings the worst-case sum to exactly unity when it overloads', () => {
    // The property, rather than one arithmetic instance: whatever the bound
    // works out to, the scaled sum lands on unity.
    for (const notchDepthDb of [0, 6, 12, 18, 24]) {
      const bed = { ...MAX_BED, notchDepthDb };
      const scale = headroomScale(MAX_MIX, bed, SR);
      expect(worstCaseSourcePeak(MAX_MIX, bed, SR) * scale).toBeCloseTo(1, 10);
    }
  });
});

describe('output ceiling', () => {
  it('holds the peak at or below the ceiling for the loudest settings', () => {
    const master = 1 * MAX_MASTER_LEVEL * headroomScale(MAX_MIX, MAX_BED, SR);
    expect(renderPeak(MAX_MIX, MAX_BED) * master).toBeLessThanOrEqual(MAX_MASTER_LEVEL);
  });

  it('holds for every routing at full request', () => {
    for (const twoToneMode of ['off', 'dichotic', 'diotic'] as const) {
      const params = { ...MAX_MIX, twoToneMode };
      const master = 1 * MAX_MASTER_LEVEL * headroomScale(params, MAX_BED, SR);
      expect(renderPeak(params, MAX_BED) * master).toBeLessThanOrEqual(MAX_MASTER_LEVEL);
    }
  });

  it('keeps the peak under the limiter threshold, so it never engages', () => {
    const master = 1 * MAX_MASTER_LEVEL * headroomScale(MAX_MIX, MAX_BED, SR);
    expect(renderPeak(MAX_MIX, MAX_BED) * master).toBeLessThan(LIMITER_THRESHOLD);
  });

  it('scales with the requested level', () => {
    const master = 0.5 * MAX_MASTER_LEVEL * headroomScale(MAX_MIX, MAX_BED, SR);
    expect(renderPeak(MAX_MIX, MAX_BED) * master).toBeLessThanOrEqual(0.5 * MAX_MASTER_LEVEL);
  });
});

describe('ceiling with the playback envelope in the chain', () => {
  it('holds, because the envelope can only attenuate', () => {
    // envelopeGain sits between the summed sources and the master bus. It is
    // scheduled between 0 and 1 and never above, so the peak reaching the
    // master bus is at most the source peak the ceiling was derived from.
    const p = new FakeEnvelopeParam();
    scheduleSessionEnvelope(p, {
      startAt: 0,
      rampInSeconds: 3,
      fadeStartAt: 600 - 1.5,
      fadeOutSeconds: 1.5,
    });
    expect(p.peak).toBeLessThanOrEqual(1);

    const master = 1 * MAX_MASTER_LEVEL * headroomScale(MAX_MIX, MAX_BED, SR);
    for (const envelope of [0, 0.5, p.peak]) {
      expect(renderPeak(MAX_MIX, MAX_BED) * envelope * master).toBeLessThanOrEqual(
        MAX_MASTER_LEVEL,
      );
    }
  });
});

describe('the transition envelope', () => {
  /**
   * Both endpoints under the ceiling does not put the path between them under
   * it. Three mechanisms carry a configuration change and none is simultaneous
   * with the others, so the master has to be safe for every mixture.
   */
  const at = (
    amGain: number,
    gain: number,
  ): { params: EntrainmentParams; soundscape: SoundscapeOptions } => ({
    params: { ...DEFAULT_PARAMS, amGain, twoToneMode: 'off' as const, twoToneGain: 0 },
    soundscape: { ...DEFAULT_SOUNDSCAPE, gain },
  });

  it('is at least as large as either endpoint', () => {
    for (const [a, b] of [
      [at(0.6, 0.2), at(0.05, 0.5)],
      [at(0.05, 0.5), at(0.6, 0.2)],
      [at(0.3, 0.3), at(0.3, 0.3)],
    ]) {
      const envelope = transitionPeakBound([a, b], SR);
      expect(envelope).toBeGreaterThanOrEqual(worstCaseSourcePeak(a.params, a.soundscape, SR));
      expect(envelope).toBeGreaterThanOrEqual(worstCaseSourcePeak(b.params, b.soundscape, SR));
    }
  });

  it('exceeds both endpoints when the source falls as the bed rises', () => {
    // The case that broke the ceiling: the master rises toward what the new
    // configuration permits while the old, louder gains are still decaying
    // through the worklet's one-pole. A bound taken at either end misses it.
    const a = at(0.6, 0.2);
    const b = at(0.05, 0.5);
    const envelope = transitionPeakBound([a, b], SR);
    expect(envelope).toBeGreaterThan(worstCaseSourcePeak(a.params, a.soundscape, SR));
    expect(envelope).toBeGreaterThan(worstCaseSourcePeak(b.params, b.soundscape, SR));
  });

  it('costs nothing when a change leaves the source gains alone', () => {
    // Most changes. The envelope must not attenuate for a transition that has
    // no smoothed term moving, or every bed tweak would be needlessly quiet.
    const a = at(0.3, 0.4);
    const b = { params: a.params, soundscape: { ...a.soundscape, notchDepthDb: 12 } };
    const envelope = transitionPeakBound([a, b], SR);
    const worse = Math.max(
      worstCaseSourcePeak(a.params, a.soundscape, SR),
      worstCaseSourcePeak(b.params, b.soundscape, SR),
    );
    expect(envelope).toBeCloseTo(worse, 12);
  });

  it('counts the two-tone path whenever either end has it on', () => {
    // The routing flag switches instantly while its gain is still smoothing,
    // so a transition through 'off' still carries the gain for a while.
    const off = {
      params: { ...DEFAULT_PARAMS, amGain: 0.1, twoToneMode: 'off' as const, twoToneGain: 0.5 },
      soundscape: { ...DEFAULT_SOUNDSCAPE, gain: 0.1 },
    };
    const on = {
      params: { ...off.params, twoToneMode: 'dichotic' as const, twoToneGain: 0.5 },
      soundscape: off.soundscape,
    };
    // Turning it off does not make the gain vanish at once.
    expect(transitionPeakBound([on, off], SR)).toBeGreaterThan(
      worstCaseSourcePeak(off.params, off.soundscape, SR),
    );
  });
});
