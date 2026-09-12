import { describe, it, expect } from './helpers/expect.ts';
import {
  render,
  createState,
  DEFAULT_PARAMS,
  type EntrainmentParams,
  type EngineState,
} from '../src/audio/dsp/entrainment-core.ts';
import { renderOffline } from '../src/audio/dsp/render-offline.ts';
import { ENVELOPE_SHAPES } from '../src/audio/dsp/envelope.ts';
import { amplitudeAt, dominantFrequency } from '../src/audio/analysis/fft.ts';
import {
  measureEnvelope,
  interauralCorrelation,
  toMono,
  peakLevel,
} from '../src/audio/analysis/metrics.ts';

const SR = 48000;
const MOD = 40;
const CARRIER = 220;
const RENDER_QUANTUM = 128;

function params(overrides: Partial<EntrainmentParams> = {}): EntrainmentParams {
  return { ...DEFAULT_PARAMS, modulationHz: MOD, carrierHz: CARRIER, ...overrides };
}

// ---------------------------------------------------------------------------
// The central claim: a 40 Hz amplitude envelope is present in the output.
// ---------------------------------------------------------------------------

describe('40 Hz envelope is present', () => {
  for (const [name, shape] of Object.entries(ENVELOPE_SHAPES)) {
    it(`carries a 40 Hz envelope with the ${name} shape`, () => {
      const { left } = renderOffline(
        params({ ...shape, depth: 1, amGain: 0.5 }),
        SR,
        SR * 4,
        RENDER_QUANTUM,
      );
      const metrics = measureEnvelope(left, SR);
      expect(metrics.frequencyHz).toBeCloseTo(MOD, 0);
      expect(Math.abs(metrics.frequencyHz - MOD)).toBeLessThan(0.5);
      expect(metrics.index).toBeGreaterThan(0.9);
    });
  }

  it('produces a flat envelope at depth = 0', () => {
    const { left } = renderOffline(
      params({ ...ENVELOPE_SHAPES.raisedCosine, depth: 0, amGain: 0.5 }),
      SR,
      SR * 4,
      RENDER_QUANTUM,
    );
    expect(measureEnvelope(left, SR).index).toBeLessThan(0.01);
  });

  it('maps commanded depth onto measured modulation index', () => {
    // For the sine shape the envelope is exactly 1 - depth + depth*sin^2,
    // so index = (max - min) / (max + min) = depth / (2 - depth).
    // Only asserted for this shape: the pulse shapes have envelope harmonics
    // above the carrier, which breaks the narrowband analytic-signal
    // assumption that makes the Hilbert envelope exact.
    for (const depth of [0.25, 0.5, 0.75]) {
      const { left } = renderOffline(
        params({ ...ENVELOPE_SHAPES.sine, depth, amGain: 0.5 }),
        SR,
        SR * 4,
        RENDER_QUANTUM,
      );
      const expected = depth / (2 - depth);
      expect(measureEnvelope(left, SR).index).toBeCloseTo(expected, 2);
    }
  });
});

// ---------------------------------------------------------------------------
// Spectral structure. Rendering exactly one second at 48 kHz puts 180, 220 and
// 260 Hz on whole numbers of cycles, so amplitudeAt is exact and leakage-free.
// ---------------------------------------------------------------------------

describe('AM path spectrum', () => {
  const amGain = 0.5;

  it('places sidebands at fc +/- fMod with half the carrier amplitude', () => {
    const { left } = renderOffline(params({ ...ENVELOPE_SHAPES.sine, depth: 1, amGain }), SR, SR);

    const carrier = amplitudeAt(left, SR, CARRIER);
    const lower = amplitudeAt(left, SR, CARRIER - MOD);
    const upper = amplitudeAt(left, SR, CARRIER + MOD);

    // x = g * sin(2*pi*fc*t) * sin^2(pi*fMod*t)
    //   = g * [0.5*sin(fc) - 0.25*sin(fc+fMod) - 0.25*sin(fc-fMod)]
    expect(carrier).toBeCloseTo(0.5 * amGain, 6);
    expect(lower).toBeCloseTo(0.25 * amGain, 6);
    expect(upper).toBeCloseTo(0.25 * amGain, 6);
    expect(lower / carrier).toBeCloseTo(0.5, 6);
  });

  it('puts no energy at fc +/- 2*fMod, confirming a three-component spectrum', () => {
    const { left } = renderOffline(params({ ...ENVELOPE_SHAPES.sine, depth: 1, amGain }), SR, SR);
    expect(amplitudeAt(left, SR, CARRIER - 2 * MOD)).toBeLessThan(1e-6);
    expect(amplitudeAt(left, SR, CARRIER + 2 * MOD)).toBeLessThan(1e-6);
  });

  it('spreads energy into higher sidebands for the square shape', () => {
    // Justifies defaulting to the raised cosine: the square shape scatters
    // energy well outside the notched region, which is what makes it harsh.
    const { left } = renderOffline(params({ ...ENVELOPE_SHAPES.square, depth: 1, amGain }), SR, SR);
    const carrier = amplitudeAt(left, SR, CARRIER);
    expect(amplitudeAt(left, SR, CARRIER + 3 * MOD) / carrier).toBeGreaterThan(0.05);
  });

  it('is diotic — both channels identical', () => {
    const { left, right } = renderOffline(
      params({ ...ENVELOPE_SHAPES.raisedCosine, amGain }),
      SR,
      SR,
    );
    expect(interauralCorrelation(left, right)).toBeCloseTo(1, 10);
  });
});

// ---------------------------------------------------------------------------
// The two-tone path. Same oscillator pair; the routing flag is the only thing
// separating a binaural beat from a monaural one.
// ---------------------------------------------------------------------------

describe('two-tone path — dichotic (binaural beat)', () => {
  const p = params({ amGain: 0, twoToneGain: 0.5, twoToneMode: 'dichotic' });

  it('sends fc to the left ear and fc + fMod to the right', () => {
    const { left, right } = renderOffline(p, SR, SR);
    expect(dominantFrequency(left, SR)).toBeCloseTo(CARRIER, 0);
    expect(dominantFrequency(right, SR)).toBeCloseTo(CARRIER + MOD, 0);
    expect(amplitudeAt(left, SR, CARRIER)).toBeCloseTo(0.5, 6);
    expect(amplitudeAt(left, SR, CARRIER + MOD)).toBeLessThan(1e-9);
    expect(amplitudeAt(right, SR, CARRIER + MOD)).toBeCloseTo(0.5, 6);
    expect(amplitudeAt(right, SR, CARRIER)).toBeLessThan(1e-9);
  });

  it('has decorrelated channels', () => {
    const { left, right } = renderOffline(p, SR, SR);
    expect(Math.abs(interauralCorrelation(left, right))).toBeLessThan(0.01);
  });

  it('yields a 40 Hz envelope only once the channels are combined', () => {
    const { left, right } = renderOffline(p, SR, SR * 4, RENDER_QUANTUM);
    // Neither ear alone carries the beat...
    expect(measureEnvelope(left, SR).index).toBeLessThan(0.01);
    // ...but their sum does. In a listener that summation happens in the
    // superior olivary complex; here it stands in for the same thing, and is
    // also exactly what a downstream mono downmix would do.
    const summed = measureEnvelope(toMono(left, right), SR);
    expect(Math.abs(summed.frequencyHz - MOD)).toBeLessThan(0.5);
    expect(summed.index).toBeGreaterThan(0.9);
  });
});

describe('two-tone path — diotic (monaural beat)', () => {
  const p = params({ amGain: 0, twoToneGain: 0.5, twoToneMode: 'diotic' });

  it('carries the beat physically in each channel', () => {
    const { left, right } = renderOffline(p, SR, SR * 4, RENDER_QUANTUM);
    expect(interauralCorrelation(left, right)).toBeCloseTo(1, 10);
    const metrics = measureEnvelope(left, SR);
    expect(Math.abs(metrics.frequencyHz - MOD)).toBeLessThan(0.5);
    expect(metrics.index).toBeGreaterThan(0.9);
  });

  it('contains only the two carriers, with no component at fc + fMod/2', () => {
    const { left } = renderOffline(p, SR, SR);
    expect(amplitudeAt(left, SR, CARRIER)).toBeCloseTo(0.25, 6);
    expect(amplitudeAt(left, SR, CARRIER + MOD)).toBeCloseTo(0.25, 6);
    expect(amplitudeAt(left, SR, CARRIER + MOD / 2)).toBeLessThan(1e-6);
  });

  it('matches the dichotic peak level, so switching mode does not jump volume', () => {
    const dichotic = renderOffline(
      params({ amGain: 0, twoToneGain: 0.5, twoToneMode: 'dichotic' }),
      SR,
      SR,
    );
    const diotic = renderOffline(p, SR, SR);
    expect(peakLevel(diotic.left)).toBeLessThanOrEqual(peakLevel(dichotic.left) + 1e-6);
  });
});

// ---------------------------------------------------------------------------
// Phase integrity. These are the tests that back the design decision to carry
// phase in a never-reset double accumulator instead of a sample counter.
// ---------------------------------------------------------------------------

describe('phase accumulator', () => {
  it('is independent of render block size', () => {
    // 48000 / 40 = 1200 samples per modulation period, and 1200 / 128 = 9.375,
    // so period boundaries fall inside a render quantum. Chunked and
    // single-shot renders must agree exactly, not approximately.
    const p = params({
      ...ENVELOPE_SHAPES.raisedCosine,
      amGain: 0.5,
      twoToneGain: 0.3,
      twoToneMode: 'dichotic',
    });
    const single = renderOffline(p, SR, SR);
    const chunked = renderOffline(p, SR, SR, RENDER_QUANTUM);
    const odd = renderOffline(p, SR, SR, 333);

    let maxDiff = 0;
    for (let i = 0; i < single.left.length; i++) {
      maxDiff = Math.max(
        maxDiff,
        Math.abs(single.left[i] - chunked.left[i]),
        Math.abs(single.right[i] - chunked.right[i]),
        Math.abs(single.left[i] - odd.left[i]),
        Math.abs(single.right[i] - odd.right[i]),
      );
    }
    expect(maxDiff).toBe(0);
  });

  it('holds phase over a ten-minute session at 44.1 kHz', { timeout: 120000 }, () => {
    // 44100 / 40 = 1102.5 samples — a non-integer modulation period, which is
    // the case a per-block integer counter would drift on.
    const rate = 44100;
    const frames = Math.round(599.37 * rate); // deliberately not a whole second
    const p = params({ ...ENVELOPE_SHAPES.raisedCosine, amGain: 0.5 });

    const state = createState();
    const l = new Float32Array(RENDER_QUANTUM);
    const r = new Float32Array(RENDER_QUANTUM);
    let done = 0;
    while (done < frames) {
      const n = Math.min(RENDER_QUANTUM, frames - done);
      render(p, state, rate, l, r, n);
      done += n;
    }

    // Expected phase computed with exact integer arithmetic, so the
    // expectation is not itself the source of error.
    const expectedMod = ((frames * MOD) % rate) / rate;
    const expectedCarrier = ((frames * CARRIER) % rate) / rate;

    const circular = (a: number, b: number) => {
      const d = Math.abs(a - b) % 1;
      return Math.min(d, 1 - d);
    };

    expect(circular(state.modPhase, expectedMod)).toBeLessThan(1e-9);
    expect(circular(state.carrierPhase, expectedCarrier)).toBeLessThan(1e-9);
  });

  it('keeps every phase inside [0, 1)', () => {
    const p = params({ carrierHz: 7000, twoToneGain: 0.3, twoToneMode: 'dichotic' });
    const { state } = renderOffline(p, SR, SR, RENDER_QUANTUM);
    for (const phase of [
      state.carrierPhase,
      state.modPhase,
      state.toneLoPhase,
      state.toneHiPhase,
    ]) {
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Switching the two tones in.
// ---------------------------------------------------------------------------

describe('switching the two tones in', () => {
  const ON = params({ amGain: 0.5, twoToneGain: 0.5, twoToneMode: 'dichotic' });
  const OFF = params({ amGain: 0.5, twoToneGain: 0.5, twoToneMode: 'off' });

  const clone = (state: EngineState): EngineState => ({ ...state });

  function advance(state: EngineState, p: EntrainmentParams, frames: number): void {
    const l = new Float32Array(frames);
    const r = new Float32Array(frames);
    render(p, state, SR, l, r, frames);
  }

  /**
   * Sound the tones for a while, then switch routing off so they freeze.
   *
   * The frame count is what chooses the frozen phase: the lower tone runs at
   * the carrier, so `frames * CARRIER / SR` cycles land it wherever this asks.
   */
  function frozenAfter(frames: number): EngineState {
    const state = createState();
    advance(state, ON, frames);
    // Routing off — the tones stop sounding and their phases stop advancing.
    advance(state, OFF, 96);
    return state;
  }

  /**
   * What the tones alone contribute, from a given state.
   *
   * Rendering the same state twice and differencing removes the entrainment
   * term — it is bit-identical across routings, which the stop condition for
   * this stage requires and the last test here pins. What is left is the tone
   * pair and nothing else, which is the thing being switched.
   *
   * `amGain` is a parameter because the removal is only exact when there is
   * nothing to remove. Output is `Float32`, and rounding `am + lo` depends on
   * the magnitude of `am`, so differencing two summed buffers leaves a residue
   * that varies with the entrainment term's phase — small, but not zero, and
   * these assertions are exact. Pass 0.5 to ask what the ear would get, and 0
   * to compare two tone pairs bit for bit.
   */
  function toneContribution(state: EngineState, frames: number, amGain: number) {
    const on = params({ ...ON, amGain });
    const off = params({ ...OFF, amGain });
    const withTones = { l: new Float32Array(frames), r: new Float32Array(frames) };
    const without = { l: new Float32Array(frames), r: new Float32Array(frames) };
    render(on, clone(state), SR, withTones.l, withTones.r, frames);
    render(off, clone(state), SR, without.l, without.r, frames);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      left[i] = withTones.l[i] - without.l[i];
      right[i] = withTones.r[i] - without.r[i];
    }
    return { left, right };
  }

  // Chosen to freeze the tones across the phase circle, including the two
  // quarter points where a frozen restart is a full-scale step rather than a
  // small one. 48000 / 220 = 218.18 samples per cycle.
  const HISTORIES = [1000, 1055, 1109, 1164, 2000, 3777];

  it('arrives at zero amplitude, from any phase it froze at', () => {
    for (const frames of HISTORIES) {
      const state = frozenAfter(frames);

      // The control. Without it this test would pass on a build that never
      // froze anything, and the interesting phases are the quarter points —
      // where the old behaviour was a full-amplitude discontinuity.
      expect(state.toneLoPhase).toBeGreaterThan(0);

      // The entrainment term is present, which is the real case: the claim is
      // that nothing is added to it at the boundary, not that the boundary is
      // silent.
      const { left, right } = toneContribution(state, 1, 0.5);
      expect(left[0]).toBe(0);
      expect(right[0]).toBe(0);
    }
  });

  it('sounds the same however it got there', () => {
    // The reproducibility claim: a preset must not depend on when routing was
    // last switched off. Compared against a first-ever activation, so this
    // also pins that resuming and starting fresh are the same thing.
    const reference = toneContribution(createState(), 4096, 0);
    for (const frames of HISTORIES) {
      const { left, right } = toneContribution(frozenAfter(frames), 4096, 0);
      let maxDiff = 0;
      for (let i = 0; i < reference.left.length; i++) {
        maxDiff = Math.max(
          maxDiff,
          Math.abs(reference.left[i] - left[i]),
          Math.abs(reference.right[i] - right[i]),
        );
      }
      expect(maxDiff).toBe(0);
    }
  });

  it('resets once at the edge, not once per block', () => {
    /*
     * The other half of "an edge, not a reset every block".
     *
     * Resetting on every block would hold the two tones together at the start
     * of each one, which is the binaural beat destroyed. Three tests in this
     * file already catch that for continuous playback — both beat tests and
     * "is independent of render block size" — but none of them ever switches
     * routing, so none covers the edge this stage adds. Rendering the same
     * activation whole and in pieces is what does: a per-block reset makes the
     * pieces differ from the whole, and only after an activation.
     */
    const state = frozenAfter(1109);
    const whole = { l: new Float32Array(4096), r: new Float32Array(4096) };
    render(ON, clone(state), SR, whole.l, whole.r, 4096);

    const pieces = { l: new Float32Array(4096), r: new Float32Array(4096) };
    const scratch = clone(state);
    for (let at = 0; at < 4096; at += RENDER_QUANTUM) {
      const l = new Float32Array(RENDER_QUANTUM);
      const r = new Float32Array(RENDER_QUANTUM);
      render(ON, scratch, SR, l, r, RENDER_QUANTUM);
      pieces.l.set(l, at);
      pieces.r.set(r, at);
    }

    let maxDiff = 0;
    for (let i = 0; i < 4096; i++) {
      maxDiff = Math.max(
        maxDiff,
        Math.abs(whole.l[i] - pieces.l[i]),
        Math.abs(whole.r[i] - pieces.r[i]),
      );
    }
    expect(maxDiff).toBe(0);
  });

  it('does not touch the entrainment term, in any routing', () => {
    // The stop condition for this stage. `l = am; r = am` is bit-identical
    // across routings, and everything above rests on that being true.
    const modes = ['off', 'dichotic', 'diotic'] as const;
    const silentTones = modes.map((twoToneMode) =>
      renderOffline(params({ amGain: 0.5, twoToneGain: 0, twoToneMode }), SR, 4096, RENDER_QUANTUM),
    );
    for (const rendered of silentTones) {
      let maxDiff = 0;
      for (let i = 0; i < rendered.left.length; i++) {
        maxDiff = Math.max(
          maxDiff,
          Math.abs(rendered.left[i] - silentTones[0].left[i]),
          Math.abs(rendered.right[i] - silentTones[0].right[i]),
        );
      }
      expect(maxDiff).toBe(0);
    }
  });
});
// ---------------------------------------------------------------------------
// Output hygiene.
// ---------------------------------------------------------------------------

describe('output hygiene', () => {
  it('never produces NaN or values outside [-1, 1]', () => {
    const p = params({
      ...ENVELOPE_SHAPES.square,
      depth: 1,
      amGain: 0.5,
      twoToneGain: 0.5,
      twoToneMode: 'dichotic',
    });
    const { left, right } = renderOffline(p, SR, SR, RENDER_QUANTUM);
    for (let i = 0; i < left.length; i++) {
      expect(Number.isFinite(left[i])).toBe(true);
      expect(Number.isFinite(right[i])).toBe(true);
      expect(Math.abs(left[i])).toBeLessThanOrEqual(1);
      expect(Math.abs(right[i])).toBeLessThanOrEqual(1);
    }
  });

  it('is silent when both paths are muted', () => {
    const { left, right } = renderOffline(
      params({ amGain: 0, twoToneGain: 0, twoToneMode: 'off' }),
      SR,
      SR,
      RENDER_QUANTUM,
    );
    expect(peakLevel(left)).toBe(0);
    expect(peakLevel(right)).toBe(0);
  });
});
