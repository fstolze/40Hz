import { describe, it, expect } from './helpers/expect.ts';
import { pulseEnvelope, modulatorGain, ENVELOPE_SHAPES } from '../src/audio/dsp/envelope.ts';

const STEPS = 10000;

function sweep(fn: (phase: number) => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < STEPS; i++) out.push(fn(i / STEPS));
  return out;
}

describe('pulseEnvelope', () => {
  it('reduces to sin^2(pi * phase) at duty = 1, edge = 1', () => {
    const { duty, edge } = ENVELOPE_SHAPES.sine;
    for (let i = 0; i < STEPS; i++) {
      const phase = i / STEPS;
      const expected = Math.sin(Math.PI * phase) ** 2;
      expect(pulseEnvelope(phase, duty, edge)).toBeCloseTo(expected, 12);
    }
  });

  it('is a hard-gated square at edge = 0', () => {
    const { duty, edge } = ENVELOPE_SHAPES.square;
    expect(pulseEnvelope(0.0, duty, edge)).toBe(1);
    expect(pulseEnvelope(0.25, duty, edge)).toBe(1);
    expect(pulseEnvelope(0.499, duty, edge)).toBe(1);
    expect(pulseEnvelope(0.5, duty, edge)).toBe(0);
    expect(pulseEnvelope(0.9, duty, edge)).toBe(0);
  });

  it('stays within [0, 1] across the whole parameter space', () => {
    for (const duty of [0.05, 0.25, 0.5, 0.75, 1]) {
      for (const edge of [0, 0.1, 0.5, 0.9, 1]) {
        for (const v of sweep((p) => pulseEnvelope(p, duty, edge))) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('opens and closes at zero whenever a taper is present', () => {
    for (const edge of [0.1, 0.5, 1]) {
      expect(pulseEnvelope(0, 0.5, edge)).toBeCloseTo(0, 12);
      expect(pulseEnvelope(0.5 - 1e-9, 0.5, edge)).toBeCloseTo(0, 6);
    }
  });

  it('reaches full amplitude when the taper leaves a plateau', () => {
    expect(pulseEnvelope(0.25, 0.5, 0.5)).toBe(1);
  });
});

describe('transition continuity', () => {
  // The specification's concern is that abrupt steps generate broadband
  // transients heard as clicks. A tapered envelope should have no step larger
  // than a small fraction of full scale between adjacent samples.
  const framesPerPeriod = 1200; // 48 kHz / 40 Hz

  function maxStep(duty: number, edge: number): number {
    let prev = pulseEnvelope(0, duty, edge);
    let worst = 0;
    for (let i = 1; i < framesPerPeriod; i++) {
      const v = pulseEnvelope(i / framesPerPeriod, duty, edge);
      worst = Math.max(worst, Math.abs(v - prev));
      prev = v;
    }
    // Include the wrap from the last sample back to phase 0.
    return Math.max(worst, Math.abs(pulseEnvelope(0, duty, edge) - prev));
  }

  it('keeps the raised-cosine shape continuous at 48 kHz', () => {
    expect(
      maxStep(ENVELOPE_SHAPES.raisedCosine.duty, ENVELOPE_SHAPES.raisedCosine.edge),
    ).toBeLessThan(0.02);
  });

  it('keeps the sine shape continuous at 48 kHz', () => {
    expect(maxStep(ENVELOPE_SHAPES.sine.duty, ENVELOPE_SHAPES.sine.edge)).toBeLessThan(0.01);
  });

  it('confirms the square shape does step discontinuously', () => {
    // Guards the test above: if this ever drops, the continuity check has
    // stopped discriminating between shapes.
    expect(maxStep(ENVELOPE_SHAPES.square.duty, ENVELOPE_SHAPES.square.edge)).toBeCloseTo(1, 6);
  });
});

describe('modulatorGain', () => {
  it('leaves the carrier unmodulated at depth = 0', () => {
    for (const v of sweep((p) => modulatorGain(p, 0.5, 0.5, 0))) {
      expect(v).toBe(1);
    }
  });

  it('passes the envelope through unchanged at depth = 1', () => {
    for (let i = 0; i < STEPS; i++) {
      const p = i / STEPS;
      expect(modulatorGain(p, 0.5, 0.5, 1)).toBe(pulseEnvelope(p, 0.5, 0.5));
    }
  });

  it('floors at 1 - depth for partial depth', () => {
    const depth = 0.5;
    const values = sweep((p) => modulatorGain(p, 0.5, 0.5, depth));
    expect(Math.min(...values)).toBeCloseTo(1 - depth, 12);
    expect(Math.max(...values)).toBeCloseTo(1, 12);
  });
});
