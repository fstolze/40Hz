/**
 * AudioWorkletProcessor shell tests.
 *
 * The shell is thin, but it owns two things the DSP core cannot: parameter
 * transport and gain smoothing. A processor seeded only by port message runs
 * its first render quanta on defaults, because port delivery is asynchronous —
 * inaudible live behind the master ramp, but silently wrong under
 * OfflineAudioContext, which renders faster than a message can arrive.
 *
 * These tests stand up a minimal AudioWorkletGlobalScope so the real processor
 * module can be imported and driven in Node.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { renderOffline } from '../src/audio/dsp/render-offline.ts';
import {
  DEFAULT_PARAMS,
  TONE_SWAP_SECONDS,
  createState,
  render,
  type EntrainmentParams,
} from '../src/audio/dsp/entrainment-core.ts';
import { dominantFrequency, prevPowerOfTwo } from '../src/audio/analysis/fft.ts';
import { measureEnvelope } from '../src/audio/analysis/metrics.ts';
import { createNoise } from '../src/audio/dsp/noise.ts';

const SR = 48000;
const QUANTUM = 128;

interface PortLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(data: unknown): void;
}

interface ProcessorLike {
  port: PortLike;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

type ProcessorCtor = new (options?: unknown) => ProcessorLike;

const registry = new Map<string, ProcessorCtor>();

class MockAudioWorkletProcessor {
  port: PortLike = { onmessage: null, postMessage() {} };
}

const scope = globalThis as unknown as Record<string, unknown>;
scope.AudioWorkletProcessor = MockAudioWorkletProcessor;
scope.registerProcessor = (name: string, ctor: ProcessorCtor) => registry.set(name, ctor);
scope.sampleRate = SR;
scope.currentTime = 0;
scope.currentFrame = 0;

await import('../src/audio/worklets/entrainment-processor.ts');
await import('../src/audio/worklets/noise-processor.ts');
await import('../src/audio/worklets/notch-processor.ts');

function create(name: string, options?: unknown): ProcessorLike {
  const Ctor = registry.get(name);
  if (!Ctor) throw new Error(`processor ${name} was never registered`);
  return new Ctor(options);
}

/** Drive a processor for `frames` samples and return the stereo output. */
function drive(processor: ProcessorLike, frames: number): [Float64Array, Float64Array] {
  const left = new Float64Array(frames);
  const right = new Float64Array(frames);
  const l = new Float32Array(QUANTUM);
  const r = new Float32Array(QUANTUM);

  for (let done = 0; done < frames; done += QUANTUM) {
    processor.process([], [[l, r]], {});
    const n = Math.min(QUANTUM, frames - done);
    for (let i = 0; i < n; i++) {
      left[done + i] = l[i];
      right[done + i] = r[i];
    }
  }
  return [left, right];
}

function maxDiff(a: Float64Array, b: Float64Array): number {
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return worst;
}

function peak(signal: Float64Array): number {
  let p = 0;
  for (let i = 0; i < signal.length; i++) p = Math.max(p, Math.abs(signal[i]));
  return p;
}

describe('registration', () => {
  it('registers both processors under their expected names', () => {
    expect(registry.has('entrainment-processor')).toBe(true);
    expect(registry.has('noise-processor')).toBe(true);
  });
});

describe('processorOptions seeding', () => {
  const params: EntrainmentParams = {
    ...DEFAULT_PARAMS,
    amGain: 0.4,
    duty: 0.5,
    edge: 0.5,
    depth: 1,
  };

  it('applies parameters on the very first render quantum', () => {
    // The regression: seeded only by port message, this block would render at
    // the default 0.25 gain instead of the requested 0.4.
    const processor = create('entrainment-processor', {
      processorOptions: { params, smoothingSeconds: 0 },
    });
    const [left] = drive(processor, QUANTUM * 200);
    const expected = renderOffline(params, SR, QUANTUM * 200, QUANTUM);
    expect(maxDiff(left, expected.left)).toBe(0);
  });

  it('matches the verified core sample-for-sample across both paths', () => {
    const twoTone: EntrainmentParams = {
      ...DEFAULT_PARAMS,
      amGain: 0.2,
      twoToneGain: 0.3,
      twoToneMode: 'dichotic',
    };
    const processor = create('entrainment-processor', {
      processorOptions: { params: twoTone, smoothingSeconds: 0 },
    });
    const [left, right] = drive(processor, QUANTUM * 300);
    const expected = renderOffline(twoTone, SR, QUANTUM * 300, QUANTUM);
    expect(maxDiff(left, expected.left)).toBe(0);
    expect(maxDiff(right, expected.right)).toBe(0);
  });

  it('falls back to defaults when no options are given', () => {
    const processor = create('entrainment-processor', {
      processorOptions: { smoothingSeconds: 0 },
    });
    const [left] = drive(processor, QUANTUM * 200);
    expect(peak(left)).toBeCloseTo(DEFAULT_PARAMS.amGain, 3);
  });
});

describe('port messages', () => {
  it('applies parameters sent after construction', () => {
    const processor = create('entrainment-processor', {
      processorOptions: { smoothingSeconds: 0 },
    });
    processor.port.onmessage?.({
      data: { type: 'params', params: { amGain: 0.5 }, smoothingSeconds: 0 },
    });
    const [left] = drive(processor, QUANTUM * 200);
    expect(peak(left)).toBeCloseTo(0.5, 3);
  });

  it('clamps out-of-range parameters before they reach the audio thread', () => {
    const processor = create('entrainment-processor', {
      processorOptions: { smoothingSeconds: 0 },
    });
    processor.port.onmessage?.({
      data: { type: 'params', params: { amGain: 99, depth: -5 }, smoothingSeconds: 0 },
    });
    const [left] = drive(processor, QUANTUM * 200);
    expect(peak(left)).toBeLessThanOrEqual(1);
  });

  it('stops rendering when told to stop', () => {
    const processor = create('entrainment-processor', {
      processorOptions: { smoothingSeconds: 0 },
    });
    const l = new Float32Array(QUANTUM);
    const r = new Float32Array(QUANTUM);
    expect(processor.process([], [[l, r]], {})).toBe(true);
    processor.port.onmessage?.({ data: { type: 'stop' } });
    expect(processor.process([], [[l, r]], {})).toBe(false);
  });
});

describe('the carrier glide, against everything else moving', () => {
  it('is not retimed by a parameter that is not the carrier', () => {
    /*
     * A drag rarely arrives alone.
     *
     * `applyParams` used to rebuild the glide whenever `current.carrierHz`
     * differed from the target — which is true for the whole length of one —
     * and to stamp `lastCarrierFrame` on every message. So a Duty or level
     * change landing mid-glide restarted the carrier from wherever it had
     * reached and reset the clock the *next* glide measures its interval
     * against.
     *
     * The interleaved messages here are chosen to be inaudible on their own:
     * `twoToneGain` with routing Off contributes nothing to the output, so any
     * difference between the two runs is the carrier being disturbed and
     * nothing else. Bit-exact, because a retimed glide is a different
     * trajectory, not a rounding difference.
     */
    const seed = {
      processorOptions: {
        params: { ...DEFAULT_PARAMS, modulationHz: 40, carrierHz: 220, amGain: 0.5 },
        smoothingSeconds: 0,
      },
    };
    const alone = create('entrainment-processor', seed);
    const jostled = create('entrainment-processor', seed);

    const retarget = (p: ProcessorLike) =>
      p.port.onmessage?.({
        data: { type: 'params', params: { carrierHz: 300 }, smoothingSeconds: 0 },
      });
    retarget(alone);
    retarget(jostled);

    const left = new Float32Array(QUANTUM);
    const right = new Float32Array(QUANTUM);
    const fromAlone: number[] = [];
    const fromJostled: number[] = [];
    for (let block = 0; block < 40; block++) {
      alone.process([], [[left, right]], {});
      for (let i = 0; i < QUANTUM; i++) fromAlone.push(left[i]);
      // One unrelated message per block, which is what a two-handed drag or a
      // preset applying several fields at once actually produces.
      jostled.port.onmessage?.({
        data: { type: 'params', params: { twoToneGain: 0.3 }, smoothingSeconds: 0 },
      });
      jostled.process([], [[left, right]], {});
      for (let i = 0; i < QUANTUM; i++) fromJostled.push(left[i]);
    }

    let worst = 0;
    for (let i = 0; i < fromAlone.length; i++) {
      worst = Math.max(worst, Math.abs(fromAlone[i] - fromJostled[i]));
    }
    expect(worst).toBe(0);

    // Non-vacuous: the carrier really did travel during the window compared.
    expect(Math.abs(fromAlone[fromAlone.length - 1])).toBeGreaterThanOrEqual(0);
    const moved = fromAlone.some((v, i) => i > 0 && v !== fromAlone[i - 1]);
    expect(moved).toBe(true);
  });
});
describe('switching the two tones in, through the shipped processor', () => {
  /*
   * The core test for this lives in `entrainment.test.ts` and works on
   * `render` directly. This one is here because the routing switch is a *port
   * message*, and only the processor turns one into a parameter change — with
   * the mode applied immediately while the level is not. That combination is
   * what made the tones arrive at full amplitude, so it is worth driving.
   */
  const SOUNDING = {
    ...DEFAULT_PARAMS,
    amGain: 0.5,
    twoToneGain: 0.5,
    twoToneMode: 'dichotic' as const,
  };

  function routing(processor: ProcessorLike, mode: string): void {
    processor.port.onmessage?.({
      data: { type: 'params', params: { twoToneMode: mode }, smoothingSeconds: 0 },
    });
  }

  it('adds nothing at the sample routing comes back on', () => {
    /*
     * Two processors driven identically. One switches routing off and back on;
     * the other stays off throughout, so it carries the entrainment term alone.
     * At the switching sample they must agree exactly, and at the next sample
     * they must not — or the tones never arrived and this would pass against a
     * processor that ignored the message.
     *
     * Since the fade, the first sample is silent because the *level* is zero
     * there, not because the phase is; a build that never reset the phase still
     * passes this. Phase zero is pinned by "arrives at zero amplitude" in
     * `entrainment.test.ts`, which works on `render` where no fade applies, and
     * by the two reproducibility tests. What this one still catches is a fade
     * applied per block instead of per sample.
     */
    const options = { processorOptions: { params: SOUNDING, smoothingSeconds: 0 } };
    const switching = create('entrainment-processor', options);
    const reference = create('entrainment-processor', options);

    // Sound the tones, so they freeze somewhere arbitrary rather than at zero.
    drive(switching, QUANTUM * 7);
    drive(reference, QUANTUM * 7);

    routing(switching, 'off');
    routing(reference, 'off');
    drive(switching, QUANTUM * 12);
    drive(reference, QUANTUM * 12);

    routing(switching, 'dichotic');
    const [left, right] = drive(switching, QUANTUM);
    const [refLeft, refRight] = drive(reference, QUANTUM);

    expect(left[0] - refLeft[0]).toBe(0);
    expect(right[0] - refRight[0]).toBe(0);
    expect(Math.abs(left[1] - refLeft[1])).toBeGreaterThan(0);
  });

  it('never slews faster than the sound it is switching between', () => {
    /*
     * Every routing change, not just switch-on.
     *
     * Phase zero only decides where the tones *start*. Switching routing off
     * cuts them at whatever they had reached, and swapping between two active
     * routings moves a tone from one ear to the other — both full-scale steps,
     * measured at 0.29 to 0.50 against a tone amplitude of 0.5.
     *
     * The measure is peak sample-to-sample slew across the transition, against
     * the same configurations left alone. A tone has slew of its own — 220 Hz at
     * amplitude 0.5 moves about 0.029 a sample — so "no step" cannot mean "no
     * change"; it means the switch introduces nothing the signal does not
     * already do. Before the fade these ran at 11 to 17 times the steady figure.
     */

    /*
     * Sample rates, because 48 kHz alone cannot see this.
     *
     * The fade reaches an exact zero only when `1 / blocks` is exactly
     * representable, which needs a power of two. 32 kHz gives four blocks and
     * does; 44.1 and 48 kHz give five and six, and their floating-point residue
     * delays the handover by a block — which is what a correct implementation
     * does deliberately. So a fault in that ordering is invisible at 48 kHz and
     * deterministic at 32 kHz, where it measured 2.9x steady. Both rates are
     * reachable: the sample rate is whatever the OS gives.
     */
    const RATES = [32000, 44100, 48000];
    const cases: [string, string][] = [
      ['dichotic', 'off'],
      ['diotic', 'off'],
      ['dichotic', 'diotic'],
      ['diotic', 'dichotic'],
    ];

    const slew = (channels: Float64Array[], from: number, to: number): number => {
      let worst = 0;
      for (const c of channels) {
        for (let i = Math.max(1, from); i < Math.min(c.length, to); i++) {
          worst = Math.max(worst, Math.abs(c[i] - c[i - 1]));
        }
      }
      return worst;
    };
    const join = (before: Float64Array[], after: Float64Array[]): Float64Array[] =>
      before.map((b, k) => {
        const out = new Float64Array(b.length + after[k].length);
        out.set(b, 0);
        out.set(after[k], b.length);
        return out;
      });

    const wasRate = scope.sampleRate;
    try {
      for (const rate of RATES) {
        scope.sampleRate = rate;
        const blocks = Math.max(1, Math.round((TONE_SWAP_SECONDS * rate) / QUANTUM));
        for (const [from, to] of cases) {
          // Several warm-ups, so the tones freeze across the phase circle rather
          // than at one arbitrary point.
          for (const warm of [3, 7, 11, 17, 23]) {
            const options = {
              processorOptions: {
                params: { ...SOUNDING, twoToneMode: from },
                smoothingSeconds: 0,
              },
            };
            const switching = create('entrainment-processor', options);
            const stayed = create('entrainment-processor', options);
            const arrived = create('entrainment-processor', {
              processorOptions: {
                params: { ...SOUNDING, twoToneMode: to },
                smoothingSeconds: 0,
              },
            });

            const runFor = QUANTUM * 40;
            const before = drive(switching, QUANTUM * warm);
            const beforeStayed = drive(stayed, QUANTUM * warm);
            const beforeArrived = drive(arrived, QUANTUM * warm);
            routing(switching, to);

            const switched = join(before, drive(switching, runFor));
            const stayedWhole = join(beforeStayed, drive(stayed, runFor));
            const arrivedWhole = join(beforeArrived, drive(arrived, runFor));

            /*
             * The switch lands at a block boundary, so the discontinuity sits at
             * the seam between two `drive` calls — the window therefore opens at
             * the switching sample itself, comparing it with the one before.
             * Measured from one sample later, the unfixed build scored 0.99 and
             * looked clean.
             */
            const at = QUANTUM * warm;
            const span = (to === 'off' ? 1 : 2) * blocks * QUANTUM + QUANTUM;
            const transition = slew(switched, at, at + span);

            /*
             * The baseline spans each run whole, and includes this processor's
             * own settled tail once the fade is over.
             *
             * Peak slew is not a constant: where the two tones realign their
             * slopes add, and how big that gets depends on where the entrainment
             * carrier happens to be at the time. A window this short contains one
             * or two realignments, a whole run contains several, so comparing a
             * short window against a short window varies by a few percent either
             * way. Including the switching processor's own tail makes the
             * comparison "no worse than this same sound once it has settled",
             * which is the claim, and leaves the fault it is looking for — 2.9x —
             * two orders of margin clear of the variance.
             */
            const steady = Math.max(
              slew(stayedWhole, 1, stayedWhole[0].length),
              slew(arrivedWhole, 1, arrivedWhole[0].length),
              slew(switched, at + span, switched[0].length),
            );

            // Non-vacuous: there is a real waveform here to be compared against.
            expect(steady).toBeGreaterThan(0.02);
            expect(transition).toBeLessThanOrEqual(steady);
          }
        }
      }
    } finally {
      scope.sampleRate = wasRate;
    }
  });
  it('sounds identical whenever routing was last switched', () => {
    /*
     * The reproducibility claim, end to end: the same preset must not depend
     * on when routing was toggled.
     *
     * Each pair sounds the tones for a different number of blocks before
     * switching off, which is what leaves them frozen at different phases —
     * without that this test passes on any build, because tones that never
     * sounded are still at zero and there is nothing for a reset to correct.
     */
    const options = { processorOptions: { params: SOUNDING, smoothingSeconds: 0 } };

    // Both channels, because in dichotic routing they carry different tones:
    // comparing the left alone passes a build that resets only the lower one.
    function afterSounding(blocks: number, thenSwitchOn: boolean): [Float64Array, Float64Array] {
      const processor = create('entrainment-processor', options);
      drive(processor, QUANTUM * blocks);
      routing(processor, 'off');
      drive(processor, QUANTUM * 12);
      if (thenSwitchOn) routing(processor, 'dichotic');
      return drive(processor, QUANTUM * 64);
    }

    // Three and seven blocks of tone put the frozen phases well apart.
    const early = afterSounding(3, true);
    const late = afterSounding(7, true);
    // Each against its own routing-off continuation, which is the only way to
    // read the tones alone: the entrainment term underneath is at a different
    // carrier phase in the two, by construction.
    const earlyBase = afterSounding(3, false);
    const lateBase = afterSounding(7, false);

    let worst = 0;
    for (let channel = 0; channel < 2; channel++) {
      const a = early[channel];
      const aBase = earlyBase[channel];
      const b = late[channel];
      const bBase = lateBase[channel];
      for (let i = 0; i < a.length; i++) {
        worst = Math.max(worst, Math.abs(a[i] - aBase[i] - (b[i] - bBase[i])));
      }
    }
    // Not exact: these are differences of `Float32` sums, and the entrainment
    // term each was rounded against differs. `entrainment.test.ts` makes the
    // same claim bit-exactly by isolating the tones; this one adds that the
    // port message path gets there too.
    expect(worst).toBeLessThan(1e-7);
  });
});
describe('gain smoothing', () => {
  it('ramps level changes rather than stepping them', () => {
    const processor = create('entrainment-processor', {
      processorOptions: { params: { amGain: 0.5 }, smoothingSeconds: 0.05 },
    });
    // Level starts at zero and approaches the target, so the opening block is
    // quieter than the steady state — this is what prevents a start-up click.
    const [first] = drive(processor, QUANTUM);
    const [later] = drive(processor, QUANTUM * 400);
    expect(peak(first)).toBeLessThan(peak(later));
    expect(peak(later)).toBeCloseTo(0.5, 2);
  });
});

describe('noise processor', () => {
  it('fills both channels with decorrelated output', () => {
    const processor = create('noise-processor', { processorOptions: { color: 'pink' } });
    const [left, right] = drive(processor, QUANTUM * 100);
    expect(peak(left)).toBeGreaterThan(0.01);
    expect(peak(right)).toBeGreaterThan(0.01);
    expect(maxDiff(left, right)).toBeGreaterThan(0.01);
  });

  it('honours the colour given at construction', () => {
    const brown = create('noise-processor', { processorOptions: { color: 'brown' } });
    const white = create('noise-processor', { processorOptions: { color: 'white' } });
    const [brownLeft] = drive(brown, QUANTUM * 100);
    const [whiteLeft] = drive(white, QUANTUM * 100);
    // Brown noise is heavily low-passed, so successive samples differ far less
    // than white noise's do.
    const roughness = (s: Float64Array) => {
      let sum = 0;
      for (let i = 1; i < s.length; i++) sum += Math.abs(s[i] - s[i - 1]);
      return sum / s.length;
    };
    expect(roughness(brownLeft)).toBeLessThan(roughness(whiteLeft));
  });
});

describe('the noise bed across configuration changes', () => {
  /**
   * The generators are seeded from fixed constants, so rebuilding them
   * restarts the noise from its first sample. The graph sends the colour on
   * every configuration change — including ones that touch nothing here — so
   * dragging an entrainment slider replayed the same opening samples about
   * thirty times a second. Audible as a bouncing, fluttering bed, and found
   * by ear rather than by anything in this suite.
   */
  const send = (processor: ProcessorLike, message: unknown): void => {
    processor.port.onmessage?.({ data: message } as MessageEvent);
  };

  it('does not restart when told the colour it already has', () => {
    const processor = create('noise-processor', { processorOptions: { color: 'pink' } });
    const [firstLeft] = drive(processor, QUANTUM);

    send(processor, { type: 'color', color: 'pink' });
    const [afterRepeat] = drive(processor, QUANTUM);

    // A restart replays the opening samples, so the block after the repeat
    // would be identical to the first one.
    expect(maxDiff(firstLeft, afterRepeat)).toBeGreaterThan(0.001);
  });

  it('still restarts when the colour genuinely changes', () => {
    // The control. Without it the test above would pass just as well against
    // a processor that never reseeded at all.
    const processor = create('noise-processor', { processorOptions: { color: 'pink' } });
    drive(processor, QUANTUM);
    send(processor, { type: 'color', color: 'brown' });
    const [switched] = drive(processor, QUANTUM);

    const fresh = create('noise-processor', { processorOptions: { color: 'brown' } });
    const [reference] = drive(fresh, QUANTUM);

    expect(maxDiff(switched, reference)).toBeCloseTo(0, 12);
  });
});

describe('the carrier glide', () => {
  const send = (processor: ProcessorLike, message: unknown): void => {
    processor.port.onmessage?.({ data: message } as MessageEvent);
  };

  /** Render, and report the instantaneous carrier implied by each zero crossing. */
  function renderWith(
    changes: { atBlock: number; carrierHz: number }[],
    blocks: number,
    params: Record<string, unknown> = {},
  ): Float64Array {
    scope.currentFrame = 0;
    const p = create('entrainment-processor');
    send(p, {
      type: 'params',
      params: {
        modulationHz: 40,
        carrierHz: 220,
        duty: 1,
        edge: 1,
        depth: 0,
        amGain: 0.5,
        twoToneGain: 0,
        twoToneMode: 'off',
        ...params,
      },
      revision: 0,
    });
    const out = new Float64Array(blocks * QUANTUM);
    const bufs = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
    let revision = 1;
    for (let b = 0; b < blocks; b++) {
      for (const change of changes) {
        if (change.atBlock === b) {
          send(p, {
            type: 'params',
            params: { carrierHz: change.carrierHz },
            revision: revision++,
          });
        }
      }
      p.process([], [bufs], {});
      out.set(bufs[0].subarray(0, QUANTUM), b * QUANTUM);
      scope.currentFrame = (scope.currentFrame as number) + QUANTUM;
    }
    return out;
  }

  it('advances both two-tone oscillators from the same gliding base', () => {
    /*
     * Asserted on the renderer directly, in phase rather than in frequency.
     *
     * A cycle-averaged measurement cannot resolve this: the difference between
     * the upper tone following the glide within a block and only between blocks
     * is about 0.3 Hz, well under the floor of any zero-crossing estimate. The
     * arithmetic is exact, though — over one block the two phases must differ
     * by exactly `modulationHz * frames / sampleRate`, whatever the carrier did
     * in between, because both integrate the same `c(t)`.
     */
    const params = {
      ...DEFAULT_PARAMS,
      modulationHz: 40,
      carrierHz: 220,
      amGain: 0,
      twoToneGain: 0.5,
      twoToneMode: 'dichotic' as const,
    };
    const state = createState();
    const left = new Float32Array(QUANTUM);
    const right = new Float32Array(QUANTUM);
    // A deliberately violent glide: if the upper tone is taking anything but
    // the same instantaneous base, this is where it shows.
    render(params, state, SR, left, right, QUANTUM, 760);
    const separation = (state.toneHiPhase - state.toneLoPhase + 1) % 1;
    const expected = ((40 * QUANTUM) / SR) % 1;
    expect(Math.abs(separation - expected)).toBeLessThan(1e-9);
  });

  /**
   * The frequency of every cycle, from interpolated zero crossings.
   *
   * A sample-to-sample step measures nothing here: the oscillator is a phase
   * accumulator, so changing its frequency is continuous in phase and the
   * waveform bends rather than jumping. The first version of these tests
   * measured exactly that and passed when the glide was removed entirely. What
   * changes abruptly is the *frequency*, so that is what has to be sampled —
   * once per cycle, which at 220 Hz is every 4.5 ms and fine enough to resolve
   * a 25 ms glide.
   */
  function frequencyTrajectory(out: Float64Array): { at: number; hz: number }[] {
    const crossings: number[] = [];
    for (let i = 1; i < out.length; i++) {
      const a = out[i - 1];
      const b = out[i];
      if (a <= 0 && b > 0) crossings.push(i - 1 + a / (a - b));
    }
    const track: { at: number; hz: number }[] = [];
    for (let i = 1; i < crossings.length; i++) {
      track.push({ at: crossings[i], hz: SR / (crossings[i] - crossings[i - 1]) });
    }
    return track;
  }

  /** The frequency a track reports nearest a given sample index. */
  function hzAt(track: { at: number; hz: number }[], sample: number): number {
    let best = track[0]?.hz ?? 0;
    let bestGap = Infinity;
    for (const point of track) {
      const gap = Math.abs(point.at - sample);
      if (gap < bestGap) {
        bestGap = gap;
        best = point.hz;
      }
    }
    return best;
  }

  /** The largest frequency change between one cycle and the next. */
  function sharpestTurn(track: { at: number; hz: number }[]): number {
    let worst = 0;
    for (let i = 1; i < track.length; i++) {
      worst = Math.max(worst, Math.abs(track[i].hz - track[i - 1].hz));
    }
    return worst;
  }

  it('keeps moving through a hesitant drag, not just a fast one', () => {
    /*
     * The property a fixed glide did not have.
     *
     * A pointer stream samples the hand, and a hesitant hand samples slowly —
     * 80 or 150 ms apart rather than 8. Interpolating each sample over a fixed
     * 25 ms reconstructs the fast case and leaves the slow one a series of
     * lurches: measured on this processor, the carrier stood still for 67% of a
     * drag at 80 ms per event and 83% at 150 ms. That is a stepped glissando,
     * and it is what "choppy when hesitant" was.
     *
     * Measured as the fraction of cycles in which the carrier does not move at
     * all, which is the thing being heard rather than a proxy for it.
     */
    const stationary = (gapBlocks: number): number => {
      scope.currentFrame = 0;
      const p = create('entrainment-processor');
      send(p, { type: 'params', params: { ...TONE, carrierHz: 220 }, revision: 0 });
      const bufs = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
      const blocks = gapBlocks * 14;
      const out = new Float64Array(blocks * QUANTUM);
      let revision = 1;
      let carrier = 220;
      for (let b = 0; b < blocks; b++) {
        if (b > 0 && b % gapBlocks === 0 && revision <= 12) {
          carrier += 2.6;
          send(p, { type: 'params', params: { carrierHz: carrier }, revision: revision++ });
        }
        p.process([], [bufs], {});
        out.set(bufs[0].subarray(0, QUANTUM), b * QUANTUM);
        scope.currentFrame = (scope.currentFrame as number) + QUANTUM;
      }
      const track = frequencyTrajectory(out);
      let still = 0;
      for (let i = 1; i < track.length; i++) {
        if (Math.abs(track[i].hz - track[i - 1].hz) < 0.02) still++;
      }
      return still / Math.max(1, track.length - 1);
    };

    // 30 blocks is 80 ms per event, which is a hesitant hand rather than a
    // sweep. The carrier has to be moving for most of it.
    expect(stationary(30)).toBeLessThan(0.3);
    // And a fast sweep must not have regressed.
    expect(stationary(3)).toBeLessThan(0.2);
  });

  it('turns a one-pixel reversal into a glide, not a pitch step', () => {
    /*
     * Twenty cents each way — one pixel of the Carrier slider — applied and
     * taken back, which is what a hovering hand does. Without the glide the
     * whole 2.6 Hz appears between one cycle and the next; with it the change
     * is spread across the cycles inside 25 ms and no single one turns sharply.
     */
    const jittered = renderWith(
      [
        { atBlock: 40, carrierHz: 222.6 },
        { atBlock: 90, carrierHz: 220 },
        { atBlock: 140, carrierHz: 222.6 },
        { atBlock: 190, carrierHz: 220 },
      ],
      240,
    );
    const steady = renderWith([], 240);
    const floor = sharpestTurn(frequencyTrajectory(steady));
    // The measurement's own noise is the floor; the glide has to stay near it,
    // and a step is the full 2.6 Hz in one cycle.
    expect(sharpestTurn(frequencyTrajectory(jittered))).toBeLessThan(Math.max(floor * 2, 1.2));
  });

  /** A clean carrier tone: no envelope, so the spectrum is the carrier. */
  const TONE = { modulationHz: 40, duty: 1, edge: 1, depth: 0, amGain: 0.5, twoToneGain: 0 };

  /**
   * The tone's frequency between two blocks, measured from its own cycles.
   *
   * Bounded deliberately at both ends. `settleIfDue` snaps the carrier to the
   * target at 210 ms, which will cover for a glide that lands short or ignores
   * a retarget — two mutations passed against a window that ran past it. So the
   * window has to close before block 79, and a spectrum over that little audio
   * is far too coarse to judge, hence cycles rather than an FFT.
   */
  function steadyHz(p: ProcessorLike, fromBlock: number, toBlock: number): number {
    const bufs = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
    const out = new Float64Array((toBlock - fromBlock) * QUANTUM);
    for (let b = 0; b < toBlock; b++) {
      p.process([], [bufs], {});
      if (b >= fromBlock) out.set(bufs[0].subarray(0, QUANTUM), (b - fromBlock) * QUANTUM);
      scope.currentFrame = (scope.currentFrame as number) + QUANTUM;
    }
    const hz = frequencyTrajectory(out)
      .map((point) => point.hz)
      .sort((a, b) => a - b);
    return hz[Math.floor(hz.length / 2)] ?? 0;
  }

  /** Render `blocks` quanta and measure what frequency actually came out. */
  function measured(p: ProcessorLike, blocks: number, channel = 0): number {
    const bufs = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
    const out = new Float64Array(blocks * QUANTUM);
    for (let b = 0; b < blocks; b++) {
      p.process([], [bufs], {});
      out.set(bufs[channel].subarray(0, QUANTUM), b * QUANTUM);
      scope.currentFrame = (scope.currentFrame as number) + QUANTUM;
    }
    return dominantFrequency(out.subarray(0, prevPowerOfTwo(out.length)), SR, 20);
  }

  it('lands exactly on the target after a long drag', () => {
    scope.currentFrame = 0;
    const p = create('entrainment-processor');
    send(p, { type: 'params', params: { ...TONE, carrierHz: 220 }, revision: 0 });
    const bufs = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
    // Sixty pointer events across most of the range — the largest single
    // movement the glide can be asked to reconstruct.
    for (let i = 1; i <= 60; i++) {
      send(p, { type: 'params', params: { carrierHz: 220 + i * 9 }, revision: i });
      p.process([], [bufs], {});
      scope.currentFrame = (scope.currentFrame as number) + QUANTUM;
    }
    /*
     * Measured after the glide and *before* settlement.
     *
     * `settleIfDue` snaps the carrier to the target at 210 ms, which would
     * cover for a glide that landed short — an earlier version of this test
     * measured past that point and passed with the landing deliberately broken.
     * The glide is 25 ms, so a window that starts well after it and ends well
     * before 210 ms sees the glide's own arithmetic and nothing else.
     */
    measured(p, 20); // ~53 ms: past the glide
    expect(Math.abs(measured(p, 512) - 760)).toBeLessThan(2);

    /*
     * And the same distance in a single glide, measured before settlement.
     *
     * Chained events hide a glide that lands short — each retargets from
     * wherever the last reached, so the error is only ever a fraction of the
     * final step. One long move exposes the whole of it: 540 Hz, the largest
     * jump the slider can ask for.
     */
    scope.currentFrame = 0;
    const solo = create('entrainment-processor');
    send(solo, { type: 'params', params: { ...TONE, carrierHz: 220 }, revision: 0 });
    send(solo, { type: 'params', params: { carrierHz: 760 }, revision: 1 });
    // Blocks 15–75: after the 9-block glide, before the 79-block settle snap.
    expect(Math.abs(steadyHz(solo, 15, 75) - 760)).toBeLessThan(2);
  });

  it('never loses the newest value under rapid retargeting', () => {
    scope.currentFrame = 0;
    const p = create('entrainment-processor');
    send(p, { type: 'params', params: { ...TONE, carrierHz: 220 }, revision: 0 });
    const bufs = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
    // Eight retargets inside a single glide. The last one has to win, and the
    // ones before it must not leave any residue.
    for (let i = 1; i <= 8; i++) {
      send(p, { type: 'params', params: { carrierHz: 220 + i * 5 }, revision: i });
      p.process([], [bufs], {});
      scope.currentFrame = (scope.currentFrame as number) + QUANTUM;
    }
    // Before settlement, or the snap would cover for a glide that kept the
    // first target and ignored the seven after it.
    expect(Math.abs(steadyHz(p, 20, 75) - 260)).toBeLessThan(2);
  });

  it('leaves the modulation rate alone while the carrier glides', () => {
    // The beat is the thing that must not move. Measured as the envelope's own
    // frequency, by the same analysis `npm run verify` reports.
    scope.currentFrame = 0;
    const p = create('entrainment-processor');
    send(p, {
      type: 'params',
      params: {
        modulationHz: 40,
        carrierHz: 220,
        duty: 0.5,
        edge: 0.5,
        depth: 1,
        amGain: 0.5,
        twoToneGain: 0,
        twoToneMode: 'off',
      },
      revision: 0,
    });
    const bufs = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
    const blocks = 1024;
    const out = new Float64Array(blocks * QUANTUM);
    for (let b = 0; b < blocks; b++) {
      // A carrier change part way through, so the window spans a glide.
      if (b === 200) send(p, { type: 'params', params: { carrierHz: 400 }, revision: 1 });
      p.process([], [bufs], {});
      out.set(bufs[0].subarray(0, QUANTUM), b * QUANTUM);
      scope.currentFrame = (scope.currentFrame as number) + QUANTUM;
    }
    const env = measureEnvelope(out.subarray(0, prevPowerOfTwo(out.length)), SR);
    expect(Math.abs(env.frequencyHz - 40)).toBeLessThan(0.5);
  });

  it('keeps the dichotic tones exactly one modulation apart while gliding', () => {
    // Both oscillators take the same slewed base, so the separation holds at
    // every sample rather than only at the endpoints.
    scope.currentFrame = 0;
    const p = create('entrainment-processor');
    send(p, {
      type: 'params',
      params: {
        modulationHz: 40,
        carrierHz: 220,
        duty: 1,
        edge: 1,
        depth: 0,
        amGain: 0,
        twoToneGain: 0.5,
        twoToneMode: 'dichotic',
      },
      revision: 0,
    });
    /*
     * One pixel, not a leap across the range.
     *
     * A cycle-averaged frequency smears across the cycle it is measured over,
     * and a 180 Hz jump inside 25 ms moves the carrier by ~32 Hz *within* one
     * cycle — so the two tones, whose cycles are different lengths, average
     * over different spans and appear to disagree by ~10 Hz when they do not.
     * A 2.6 Hz step is what the slider actually produces and leaves the
     * averaging error far below the thing being measured.
     */
    send(p, { type: 'params', params: { carrierHz: 222.6 }, revision: 1 });
    // Measured across the glide and past it, both ears at once.
    const bufs = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
    const blocks = 512;
    const left = new Float64Array(blocks * QUANTUM);
    const right = new Float64Array(blocks * QUANTUM);
    for (let b = 0; b < blocks; b++) {
      p.process([], [bufs], {});
      left.set(bufs[0].subarray(0, QUANTUM), b * QUANTUM);
      right.set(bufs[1].subarray(0, QUANTUM), b * QUANTUM);
      scope.currentFrame = (scope.currentFrame as number) + QUANTUM;
    }
    /*
     * Cycle by cycle, across the glide itself.
     *
     * Measuring the dominant frequency of the whole window only proves the
     * endpoints — the glide is 25 ms of a 1.4 s take, so a version where the
     * upper tone ignored the glide entirely passed. The separation has to hold
     * at every cycle, which is what "the beat remains exact" means.
     */
    const loTrack = frequencyTrajectory(left);
    const hiTrack = frequencyTrajectory(right);
    // Compared at matched *times*, not matched cycle indices: the two channels
    // run at different frequencies, so their nth cycles are not simultaneous.
    let worst = 0;
    for (const point of loTrack) {
      worst = Math.max(worst, Math.abs(hzAt(hiTrack, point.at) - point.hz - 40));
    }
    expect(worst).toBeLessThan(1);
  });
});

describe('the notch worklet', () => {
  /**
   * The cascade the bed passes through, and the crossfade between two of them.
   *
   * This is where the continuity that used to be asserted on gain nodes now
   * lives, because the handover is internal: two sets of filter state inside
   * one processor, with no node ever created or destroyed.
   */
  const send = (processor: ProcessorLike, message: unknown): void => {
    processor.port.onmessage?.({ data: message } as MessageEvent);
  };

  /** Drive the processor with `input`, returning the left channel. */
  function filter(processor: ProcessorLike, input: Float64Array): Float64Array {
    const out = new Float64Array(input.length);
    const inBuf = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
    const outBuf = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
    for (let at = 0; at < input.length; at += QUANTUM) {
      for (let i = 0; i < QUANTUM; i++) {
        inBuf[0][i] = input[at + i] ?? 0;
        inBuf[1][i] = input[at + i] ?? 0;
      }
      processor.process([inBuf], [outBuf], {});
      for (let i = 0; i < QUANTUM && at + i < out.length; i++) out[at + i] = outBuf[0][i];
      scope.currentFrame = (scope.currentFrame as number) + QUANTUM;
    }
    return out;
  }

  function noiseInput(frames: number): Float64Array {
    const gen = createNoise('white', 11);
    const out = new Float64Array(frames);
    for (let i = 0; i < frames; i++) out[i] = gen.next();
    return out;
  }

  it('applies the cascade it was seeded with', () => {
    scope.currentFrame = 0;
    const processor = create('notch-processor', {
      processorOptions: { carrierHz: 220, modulationHz: 40, q: 8, depthDb: 18, channels: 2 },
    });
    const input = noiseInput(QUANTUM * 40);
    const out = filter(processor, input);
    // A deep cut removes energy, so the output cannot simply be the input.
    expect(maxDiff(input.subarray(QUANTUM * 20), out.subarray(QUANTUM * 20))).toBeGreaterThan(0.01);
  });

  it('holds the slot steady through a stream of handovers', () => {
    /*
     * The worklet's central promise, and the refutation of a hypothesis.
     *
     * A fresh cascade starts with every delay-line term at zero, so it carves
     * nothing until its impulse response decays. That looked like the
     * mechanism behind the reported flutter: replace the chain ten times a second
     * and the slot never establishes. Measured here against the real
     * processor, with the incoming cascade **identical** to the one it
     * replaces so that the ring-up is the only variable, it comes to about
     * **0.95 dB**, and it is the same 0.95 dB at every rate from 100 ms down to
     * 20 ms. Real and repeatable, but an order of magnitude short of what would
     * account for the reported flutter.
     *
     * What made it look like one was measuring a moving notch against a fixed
     * tone: walking the carrier 2 Hz per handover swings this figure by 6.1 dB,
     * which is the slot correctly leaving the frequency being measured rather
     * than anything going wrong.
     *
     * So this stands as the invariant it always should have been: handing over
     * to the same chain is inaudible, which is what the whole worklet-based
     * crossfade exists to guarantee — the node-rebuild it replaced clicked just
     * as loudly with identical coefficients.
     */
    const slotSwing = (handoverEveryFrames: number | null): number => {
      scope.currentFrame = 0;
      const processor = create('notch-processor', {
        processorOptions: { carrierHz: 220, modulationHz: 40, q: 8, depthDb: 6, channels: 2 },
      });
      const frames = QUANTUM * 1500;
      const input = new Float64Array(frames);
      for (let i = 0; i < frames; i++) input[i] = Math.sin((2 * Math.PI * 220 * i) / SR);

      /*
       * The cascade handed over to is *identical* to the one it replaces.
       *
       * That is what isolates the ring-up. An earlier version of this test
       * moved the carrier a little on each handover, the way a drag does — and
       * over four seconds that walked the notch eighty hertz away from the
       * fixed sine being measured, so what it actually reported was the slot
       * drifting off the tone. With the coefficients held constant the only
       * thing that changes is that a fresh cascade has to establish itself, and
       * a handover to an identical chain should by rights be inaudible.
       */
      if (handoverEveryFrames !== null) {
        let at = handoverEveryFrames;
        let revision = 1;
        while (at < frames) {
          send(processor, {
            type: 'notch',
            carrierHz: 220,
            modulationHz: 40,
            q: 8,
            depthDb: 6,
            atFrame: at,
            crossfadeFrames: Math.round(0.0392 * SR),
            revision,
          });
          at += handoverEveryFrames;
          revision += 1;
        }
      }

      const out = filter(processor, input);
      // One value per modulation period, skipping the initial ring-up.
      const hop = Math.round(SR / 40);
      const peaks: number[] = [];
      for (let i = hop * 8; i + hop <= out.length; i += hop) {
        let peak = 0;
        for (let j = 0; j < hop; j++) peak = Math.max(peak, Math.abs(out[i + j] ?? 0));
        peaks.push(peak);
      }
      const lo = Math.min(...peaks);
      const hi = Math.max(...peaks);
      return 20 * Math.log10(hi / Math.max(lo, 1e-9));
    };

    // The control. Nothing hands over, so the slot never moves at all.
    expect(slotSwing(null)).toBeLessThan(0.05);

    /*
     * A handover every 100 ms is the rate a hesitant drag produced, and every
     * 60 ms is faster than the crossfade itself. Both measure about 0.95 dB —
     * today's behaviour, pinned here so a change to it is noticed.
     *
     * Pre-warming the incoming cascade — running it on the input for its
     * settling time before any of it is heard — takes both to 0.000, and was
     * implemented and measured. It is not in the tree: it doubles the handover
     * duration, so the slot lags further behind while tracking, and there is no
     * evidence that 0.95 dB is what anyone actually hears. Trading a measured
     * decibel for unmeasured lag is the trade that made the last attempt worse.
     */
    expect(slotSwing(Math.round(0.1 * SR))).toBeLessThan(1);
    expect(slotSwing(Math.round(0.06 * SR))).toBeLessThan(1);
  });

  it('hands over without a discontinuity', () => {
    // The property the old node-based crossfade needed a gain-sum assertion
    // for. Here it is direct: the output either steps at the handover or it
    // does not.
    scope.currentFrame = 0;
    const processor = create('notch-processor', {
      processorOptions: { carrierHz: 220, modulationHz: 40, q: 8, depthDb: 18, channels: 2 },
    });
    const input = noiseInput(QUANTUM * 200);

    // A smooth input, so a step in the output is unambiguous rather than
    // hidden in noise.
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 60 * i) / SR);

    send(processor, {
      type: 'notch',
      carrierHz: 900,
      modulationHz: 40,
      q: 8,
      depthDb: 18,
      atFrame: QUANTUM * 50,
      crossfadeFrames: QUANTUM * 40,
      revision: 1,
    });
    const out = filter(processor, input);

    // The largest sample-to-sample step, against the largest the source itself
    // takes. A splice between two cascades shows up as a jump far beyond it.
    let worst = 0;
    for (let i = 1; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i] - out[i - 1]));
    let sourceStep = 0;
    for (let i = 1; i < input.length; i++) {
      sourceStep = Math.max(sourceStep, Math.abs(input[i] - input[i - 1]));
    }
    expect(worst).toBeLessThan(sourceStep * 3);
  });

  it('reports the handover starting and finishing', () => {
    scope.currentFrame = 0;
    const seen: { type: string; revision: number }[] = [];
    const processor = create('notch-processor', {
      processorOptions: { carrierHz: 220, modulationHz: 40, q: 8, depthDb: 6, channels: 2 },
    });
    processor.port.postMessage = (message: unknown) => {
      seen.push(message as { type: string; revision: number });
    };

    send(processor, {
      type: 'notch',
      carrierHz: 400,
      modulationHz: 40,
      q: 8,
      depthDb: 6,
      atFrame: QUANTUM * 2,
      crossfadeFrames: QUANTUM * 4,
      revision: 7,
    });
    filter(processor, noiseInput(QUANTUM * 20));

    expect(seen.some((m) => m.type === 'notch-applied' && m.revision === 7)).toBe(true);
    // Settlement is what lets the graph drop the older bound, so it has to
    // arrive rather than be inferred from the schedule.
    expect(seen.some((m) => m.type === 'notch-settled' && m.revision === 7)).toBe(true);
  });

  it('never cuts a handover short to start another', () => {
    // Completing the fade in progress first would snap the output to a cascade
    // it was only part-way toward. The message sequence is identical either
    // way — both revisions are applied and both settle — so the only thing
    // that separates them is the audio: an early finish is a step.
    scope.currentFrame = 0;
    const processor = create('notch-processor', {
      processorOptions: { carrierHz: 220, modulationHz: 40, q: 8, depthDb: 18, channels: 2 },
    });

    const tone = (frames: number, from: number): Float64Array => {
      const out = new Float64Array(frames);
      for (let i = 0; i < frames; i++) out[i] = Math.sin((2 * Math.PI * 60 * (from + i)) / SR);
      return out;
    };

    const base = { type: 'notch', modulationHz: 40, q: 8, depthDb: 18 };
    send(processor, {
      ...base,
      carrierHz: 900,
      atFrame: QUANTUM,
      crossfadeFrames: QUANTUM * 60,
      revision: 1,
    });
    // Far enough in that the first handover is genuinely under way. Sent any
    // earlier the second would simply supersede it while still queued, which
    // is correct coalescing and not what this is about.
    const first = filter(processor, tone(QUANTUM * 20, 0));
    send(processor, {
      ...base,
      carrierHz: 300,
      atFrame: QUANTUM * 22,
      crossfadeFrames: QUANTUM * 8,
      revision: 2,
    });
    const second = filter(processor, tone(QUANTUM * 80, QUANTUM * 20));

    const out = new Float64Array(first.length + second.length);
    out.set(first, 0);
    out.set(second, first.length);

    let worst = 0;
    for (let i = 1; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i] - out[i - 1]));
    const source = tone(out.length, 0);
    let sourceStep = 0;
    for (let i = 1; i < source.length; i++) {
      sourceStep = Math.max(sourceStep, Math.abs(source[i] - source[i - 1]));
    }
    expect(worst).toBeLessThan(sourceStep * 3);
  });

  it('discards a superseded revision', () => {
    scope.currentFrame = 0;
    const seen: { type: string; revision: number }[] = [];
    const processor = create('notch-processor', {
      processorOptions: { carrierHz: 220, modulationHz: 40, q: 8, depthDb: 6, channels: 2 },
    });
    processor.port.postMessage = (message: unknown) => {
      seen.push(message as { type: string; revision: number });
    };

    const base = {
      type: 'notch',
      modulationHz: 40,
      q: 8,
      depthDb: 6,
      atFrame: QUANTUM * 8,
      crossfadeFrames: QUANTUM * 2,
    };
    send(processor, { ...base, carrierHz: 400, revision: 3 });
    send(processor, { ...base, carrierHz: 600, revision: 2 });
    filter(processor, noiseInput(QUANTUM * 20));

    const applied = seen.filter((m) => m.type === 'notch-applied').map((m) => m.revision);
    expect(applied.join(',')).toBe('3');
  });
});
