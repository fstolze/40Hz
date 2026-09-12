/**
 * The notch chain's peak-gain bound.
 *
 * This is what makes the output ceiling true, so it is asserted as a bound —
 * something no input may exceed — rather than as a measurement of any
 * particular signal.
 *
 * What is *not* established here: that this model matches Chromium's
 * `BiquadFilterNode`. It is a transcription of the Web Audio specification's
 * peaking formulae, and an Electron test measuring the real node is what
 * closes that gap. Calling this "the real chain" is how the gap gets assumed
 * away.
 */

import { describe, it, expect } from './helpers/expect.ts';
import {
  BOUND_MARGIN,
  failClosedBound,
  notchChain,
  notchFrequencies,
  notchPeakGain,
  peakGainBound,
  peakingSection,
  poleRadius,
  type BiquadSection,
} from '../src/audio/dsp/biquad.ts';
import { createNoise } from '../src/audio/dsp/noise.ts';

function run(sections: readonly BiquadSection[], signal: Float64Array): Float64Array {
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

function peakOf(signal: Float64Array): number {
  let peak = 0;
  for (let i = 0; i < signal.length; i++) {
    const v = Math.abs(signal[i]);
    if (Number.isFinite(v) && v > peak) peak = v;
  }
  return peak;
}

/** Impulse response of a cascade, for constructing the worst-case input. */
function impulseResponse(sections: readonly BiquadSection[], frames: number): Float64Array {
  const impulse = new Float64Array(frames);
  impulse[0] = 1;
  return run(sections, impulse);
}

describe('the peaking section', () => {
  it('is exactly the identity at 0 dB', () => {
    // The cookbook's numerator and denominator coincide when A is 1, which is
    // what lets the ceiling tests state exact arithmetic with the notches flat.
    const section = peakingSection(220, 8, 0, 48000);
    expect(section.b0).toBeCloseTo(1, 12);
    expect(section.b1 - section.a1).toBeCloseTo(0, 12);
    expect(section.b2 - section.a2).toBeCloseTo(0, 12);

    // The L1 norm is 1; the reported bound is that times the margin, which is
    // applied unconditionally rather than only where it is needed.
    const result = peakGainBound([section]);
    expect(result.truncatedSum).toBeCloseTo(1, 6);
    expect(result.bound).toBeCloseTo(BOUND_MARGIN, 6);
  });

  it('stays stable across the whole admitted parameter space', () => {
    // An unstable pole has no finite L1 norm, so the bound would be Infinity
    // and the headroom scale would collapse to silence.
    for (const rate of [22050, 32000, 44100, 48000, 88200, 96000])
      for (const q of [0.1, 1, 8, 40])
        for (const depth of [0, 6, 24])
          for (const f of [20, 80, 220, 1000, 8000]) {
            const r = poleRadius(peakingSection(f, q, -depth, rate));
            expect(r).toBeLessThan(1);
          }
  });
});

describe('the L1 bound', () => {
  it('is attained by the worst-case input, so it is not merely conservative', () => {
    // The signal that realises the L1 norm is the one whose signs match the
    // time-reversed impulse response. If the bound were loose this would fall
    // well short of it; if it were wrong, this would exceed it.
    const sections = notchChain(220, 40, 8, 12, 48000);
    const { bound } = peakGainBound(sections);

    const n = 20000;
    const h = impulseResponse(sections, n);
    const adversarial = new Float64Array(n);
    for (let i = 0; i < n; i++) adversarial[i] = Math.sign(h[n - 1 - i]) || 1;

    const attained = peakOf(run(sections, adversarial));
    expect(attained).toBeLessThanOrEqual(bound * 1.000001);
    // Within a few percent of the bound: close enough that the bound is the
    // right measure rather than an arbitrary overestimate.
    expect(attained).toBeGreaterThan(bound * 0.95);
  });

  it('bounds real bed material across the parameter space', () => {
    // The sweep is an assertion here, not the source of a number. Every
    // combination has to satisfy the bound; none is allowed to set it.
    const frames = 48000;
    for (const color of ['white', 'pink', 'brown'] as const) {
      const gen = createNoise(color, 5);
      const raw = new Float64Array(frames);
      for (let i = 0; i < frames; i++) raw[i] = gen.next();
      const norm = peakOf(raw);
      for (let i = 0; i < frames; i++) raw[i] /= norm;

      for (const q of [0.1, 1, 8, 20, 40])
        for (const depth of [0, 6, 12, 24])
          for (const fc of [20, 80, 220, 1000, 8000]) {
            const sections = notchChain(fc, 40, q, depth, 48000);
            const bound = peakGainBound(sections).bound;
            // A relative epsilon, because three cascaded IIR sections in
            // double precision do not reproduce their own algebra exactly: at
            // 0 dB the chain *is* the identity and still lands about 1e-12
            // above it. 1e-9 is nine orders of magnitude below anything that
            // could matter to a ceiling and still catches a real overshoot,
            // which starts in the second decimal place.
            expect(peakOf(run(sections, raw))).toBeLessThanOrEqual(bound * (1 + 1e-9));
          }
    }
  });

  it('really can exceed unity, which is the whole point', () => {
    // The control for the test above. If the chain never raised a peak, every
    // assertion here would hold under a bound hard-coded to 1, and the
    // correction would be measuring nothing.
    const frames = 48000;
    const gen = createNoise('white', 5);
    const raw = new Float64Array(frames);
    for (let i = 0; i < frames; i++) raw[i] = gen.next();
    const norm = peakOf(raw);
    for (let i = 0; i < frames; i++) raw[i] /= norm;

    const sections = notchChain(220, 40, 8, 24, 48000);
    expect(peakOf(run(sections, raw))).toBeGreaterThan(1);
  });

  it('carries the margin, and does not pretend the tail is certified', () => {
    const sections = notchChain(150, 200, 14, 24, 96000);
    const result = peakGainBound(sections);
    expect(result.bound).toBeCloseTo((result.truncatedSum + result.tailEstimate) * BOUND_MARGIN, 9);
    expect(result.margin).toBe(BOUND_MARGIN);
    expect(result.tailEstimate).toBeGreaterThanOrEqual(0);
    // The window is sized from the pole radius, so the remainder is negligible
    // to begin with — which is why the margin, not the geometric estimate, is
    // what actually carries the safety.
    expect(result.tailEstimate).toBeLessThan(result.truncatedSum * 1e-6);
  });

  it('fails closed rather than open when no bound can be established', () => {
    // The policy, tested directly, because no notch configuration the app can
    // produce has an unstable pole — so this cannot be reached through
    // `notchPeakGain` with real parameters, and a test that went through it
    // would prove nothing about the guard.
    //
    // The first version of this returned 1 for a non-finite bound. That is a
    // safety ceiling removing its own attenuation at the moment it knows
    // least.
    expect(failClosedBound(Infinity)).toBe(Infinity);
    expect(failClosedBound(Number.NaN)).toBe(Infinity);
    // Under unity is raised, never used as-is: a bound below 1 would let the
    // headroom scale raise the master rather than lower it.
    expect(failClosedBound(0.4)).toBe(1);
    expect(failClosedBound(2.5)).toBe(2.5);

    // And the consequence the caller sees: an unbounded peak means silence.
    expect(1 / Math.max(1, failClosedBound(Number.NaN))).toBe(0);
  });

  it('reports an unstable cascade as unbounded', () => {
    // An unstable section has no finite L1 norm. The caller divides the master
    // gain by this, so Infinity means silence — the correct answer when the
    // peak is unknown. Answering unity would remove the attenuation at exactly
    // the moment nothing has been established.
    const unstable: BiquadSection = { b0: 1, b1: 0, b2: 0, a1: -1.9, a2: 0.99999999 };
    expect(poleRadius(unstable)).toBeGreaterThanOrEqual(0.999);

    const runaway: BiquadSection = { b0: 1, b1: 0, b2: 0, a1: 0, a2: -1.5 };
    expect(poleRadius(runaway)).toBeGreaterThan(1);
    expect(peakGainBound([runaway]).bound).toBe(Infinity);
  });
});

describe('the chain the graph builds', () => {
  it('places notches at fc and both sidebands, floored at 20 Hz', () => {
    const at220 = notchFrequencies(220, 40);
    expect(at220.join(',')).toBe('180,220,260');
    // Mirrors updateNotchFrequencies: a sideband below 20 Hz is clamped there
    // rather than becoming a negative frequency.
    expect(notchFrequencies(30, 40).join(',')).toBe('20,30,70');
  });

  it('never reports a gain below unity, whatever the configuration', () => {
    // A bound under one would let the headroom scale *raise* the master, which
    // is the opposite of what it exists to do.
    for (const q of [0.1, 1, 40])
      for (const depth of [0, 12, 24])
        for (const fc of [20, 220, 8000]) {
          expect(notchPeakGain(fc, 40, q, depth, 48000)).toBeGreaterThanOrEqual(1);
        }
  });

  it('answers the same value from the cache as from a cold computation', () => {
    const cold = peakGainBound(notchChain(330, 40, 6, 9, 44100)).bound;
    expect(notchPeakGain(330, 40, 6, 9, 44100)).toBeCloseTo(cold, 12);
    expect(notchPeakGain(330, 40, 6, 9, 44100)).toBeCloseTo(cold, 12);
  });
});
