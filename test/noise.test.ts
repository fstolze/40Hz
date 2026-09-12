import { describe, it, expect } from './helpers/expect.ts';
import { createNoise, PinkNoise, BrownNoise, WhiteNoise } from '../src/audio/dsp/noise.ts';
import { spectralSlope } from '../src/audio/analysis/fft.ts';

const SR = 48000;
const N = 1 << 18; // 262144 samples, about 5.5 seconds

function generate(color: 'white' | 'pink' | 'brown', seed = 1): Float64Array {
  const gen = createNoise(color, seed);
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) out[i] = gen.next();
  return out;
}

describe('spectral slope', () => {
  it('white noise is flat', () => {
    expect(spectralSlope(generate('white'), SR, 200, 8000)).toBeCloseTo(0, 0);
  });

  it('pink noise falls at about -10 dB/decade (-3 dB/octave)', () => {
    const slope = spectralSlope(generate('pink'), SR, 100, 8000);
    expect(slope).toBeGreaterThan(-12.5);
    expect(slope).toBeLessThan(-7.5);
  });

  it('brown noise falls at about -20 dB/decade (-6 dB/octave)', () => {
    // Fitted above the leaky integrator's ~38 Hz corner, below which the
    // spectrum deliberately flattens to avoid DC wander.
    const slope = spectralSlope(generate('brown'), SR, 200, 8000);
    expect(slope).toBeGreaterThan(-23);
    expect(slope).toBeLessThan(-17);
  });
});

describe('output hygiene', () => {
  for (const color of ['white', 'pink', 'brown'] as const) {
    it(`${color} noise stays finite and bounded`, () => {
      const signal = generate(color);
      let peak = 0;
      for (let i = 0; i < signal.length; i++) {
        expect(Number.isFinite(signal[i])).toBe(true);
        peak = Math.max(peak, Math.abs(signal[i]));
      }
      expect(peak).toBeLessThan(1.5);
      expect(peak).toBeGreaterThan(0.05);
    });
  }
});

describe('determinism', () => {
  it('produces identical output for identical seeds', () => {
    const a = new PinkNoise(42);
    const b = new PinkNoise(42);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it('produces different output for different seeds', () => {
    const a = new PinkNoise(1);
    const b = new PinkNoise(2);
    let differences = 0;
    for (let i = 0; i < 1000; i++) if (a.next() !== b.next()) differences++;
    expect(differences).toBeGreaterThan(900);
  });

  it('decorrelates the stereo pair the graph builds from two seeds', () => {
    const l = new BrownNoise(1);
    const r = new BrownNoise(2);
    let same = 0;
    for (let i = 0; i < 1000; i++) if (l.next() === r.next()) same++;
    expect(same).toBe(0);
  });
});

describe('fill', () => {
  it('writes the same sequence as repeated next() calls', () => {
    const viaFill = new Float32Array(256);
    new WhiteNoise(7).fill(viaFill);

    const gen = new WhiteNoise(7);
    for (let i = 0; i < 256; i++) {
      expect(viaFill[i]).toBe(Math.fround(gen.next()));
    }
  });
});
