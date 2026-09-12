/**
 * The engine, checked in the build the user is actually running.
 *
 * `tools/verify.ts` measures the same things and prints them, but it runs in
 * CI, against a checkout, on a machine nobody listens to. This asks the same
 * questions of the code inside the shipped bundle, on the machine playing the
 * audio — where the worklets were fetched from an asar, the arithmetic is
 * whatever this CPU does, and the sample rate is whatever the OS chose.
 *
 * Everything here is offline: it renders its own signal and never touches the
 * graph. So it works before anything has played, it cannot disturb playback,
 * and its findings are `engine`-scoped — they say the DSP is right, and nothing
 * whatever about what left the machine.
 *
 * **The checks are invariants, not remembered numbers.** A stored expectation
 * would have to be revised whenever a default moved, and revising an
 * expectation to match new behaviour is how a self-test comes to certify
 * whatever the engine currently does. These are properties that hold for any
 * correct implementation at any sample rate: an envelope runs at the rate it
 * was asked for; sinusoidal AM is symmetric about its carrier and has no
 * second-order sidebands; dichotic routing leaves the ears uncorrelated and
 * diotic routing does not; and rendering in chunks gives bit-identical output
 * to rendering in one go, because the phase accumulators do not reset.
 */

import { renderOffline } from '../audio/dsp/render-offline.ts';
import { render, DEFAULT_PARAMS, type EntrainmentParams } from '../audio/dsp/entrainment-core.ts';
import { ENVELOPE_SHAPES } from '../audio/dsp/envelope.ts';
import { measureEnvelope, interauralCorrelation, toMono } from '../audio/analysis/metrics.ts';
import { amplitudeAt } from '../audio/analysis/fft.ts';
import { checkedFinding, type Finding } from './findings.ts';

/** The render quantum, so chunked rendering is checked the way it happens. */
const QUANTUM = 128;

/**
 * The largest difference between two buffers, sample by sample.
 *
 * Used where the two ears are supposed to be the same signal — the AM path and
 * diotic two-tone are both specified as identical in both ears, and they are,
 * to the sample. Measuring each ear separately and comparing the numbers would
 * accept a channel that is merely *similar*; this accepts nothing but equality,
 * which is what the specification actually says.
 */
function channelDifference(left: Float64Array, right: Float64Array): number {
  let worst = 0;
  for (let i = 0; i < left.length; i += 1) {
    const l = left[i];
    const r = right[i];
    // Explicitly, and not as a subtraction. `Math.abs(NaN - x)` is NaN, and
    // every comparison with NaN is false — so a channel of NaN beside a healthy
    // one compared as *identical* and this reported "both ears identical: true"
    // about output that was not audio. The same trap `peakLevel` has, in a
    // helper written after that one was fixed.
    if (!Number.isFinite(l) || !Number.isFinite(r)) return Infinity;
    const difference = Math.abs(l - r);
    if (difference > worst) worst = difference;
  }
  return worst;
}

/**
 * A second of audio per case.
 *
 * Enough for the envelope's spectrum to resolve the rate and for the exact-bin
 * probes to separate the carrier from its sidebands, and short enough that the
 * whole suite is a blink rather than a pause — this runs in a window someone is
 * looking at.
 */
const SECONDS = 1;

/** How long a run to check phase drift over. */
const DRIFT_SECONDS = 60;

export interface SelfTestOptions {
  /**
   * The rate to render at. Defaults to the app's preference rather than the
   * device's, because this is asking about arithmetic, not about the device.
   */
  sampleRate?: number;
  /**
   * The renderer under test.
   *
   * Injectable so the checks can be proved to fail: a self-test nobody has ever
   * seen fail is a self-test nobody should believe.
   */
  render?: typeof renderOffline;
  /**
   * The per-block renderer, for the drift check.
   *
   * A second injection point rather than a tidier one, because drift is the one
   * property that cannot be seen in a buffer — it is a state accumulator
   * wandering, and observing it means driving the core directly. Left out, this
   * check would be the only one no test could ever make fail.
   */
  advance?: typeof render;
}

const params = (over: Partial<EntrainmentParams>): EntrainmentParams => ({
  ...DEFAULT_PARAMS,
  ...over,
});

function finding(
  id: string,
  title: string,
  passed: boolean,
  detail: string,
  failure: 'failed' | 'warning' = 'failed',
): Finding {
  return checkedFinding({
    id,
    scope: 'engine',
    status: passed ? 'ok' : failure,
    title,
    detail,
  });
}

/**
 * Run the whole suite.
 *
 * Returns findings rather than throwing, and each check is isolated, so one
 * broken invariant cannot hide the state of the others — including when the
 * breakage is an exception rather than a wrong number. An engine faulty enough
 * to throw is exactly when a structured report matters most, and evaluating the
 * checks in one expression meant a single throw produced no findings at all.
 */
export function runSelfTest(options: SelfTestOptions = {}): Finding[] {
  const sampleRate = options.sampleRate ?? 48000;
  const renderer = options.render ?? renderOffline;
  const advance = options.advance ?? render;
  const frames = sampleRate * SECONDS;

  return [
    ...Object.entries(ENVELOPE_SHAPES).map(([name, shape]) =>
      attempt(`engine-envelope-${name}`, `Envelope, ${name}`, (id, title) =>
        envelopeFinding(id, title, renderer, sampleRate, frames, shape),
      ),
    ),
    attempt('engine-spectrum', 'AM spectrum', (id, title) =>
      spectrumFinding(id, title, renderer, sampleRate, frames),
    ),
    attempt('engine-routing-dichotic', 'Dichotic routing', (id, title) =>
      dichoticFinding(id, title, renderer, sampleRate, frames),
    ),
    attempt('engine-routing-diotic', 'Diotic routing', (id, title) =>
      dioticFinding(id, title, renderer, sampleRate, frames),
    ),
    attempt('engine-chunking', 'Block independence', (id, title) =>
      chunkingFinding(id, title, renderer, sampleRate),
    ),
    attempt('engine-phase', 'Phase integrity', (id, title) => driftFinding(id, title, advance)),
  ];
}

/** Run one check, turning a thrown error into that check's own failure. */
function attempt(id: string, title: string, run: (id: string, title: string) => Finding): Finding {
  try {
    return run(id, title);
  } catch (error) {
    return finding(
      id,
      title,
      false,
      `The check could not run: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * An envelope at the rate it was asked for, and as deep as it was asked to be.
 *
 * Both, because judging only the rate certifies a materially weakened stimulus:
 * an engine that quietly rendered every configuration at a quarter depth
 * produced a perfectly timed 40 Hz envelope and passed. Full depth means the
 * envelope reaches zero, so the index reaches one — for the raised cosine it
 * lands at 0.99, its trough being a point rather than an interval.
 */
function envelopeFinding(
  id: string,
  title: string,
  renderer: typeof renderOffline,
  sampleRate: number,
  frames: number,
  shape: { duty: number; edge: number },
): Finding {
  const modulationHz = 40;
  const { left, right } = renderer(
    params({ ...shape, modulationHz, depth: 1, amGain: 0.5 }),
    sampleRate,
    frames,
    QUANTUM,
  );
  const measured = measureEnvelope(left, sampleRate);

  const onRate = Math.abs(measured.frequencyHz - modulationHz) <= 0.5;
  const fullyGated = measured.index >= 0.98;
  // The AM path is diotic by specification. Inspecting the left channel alone
  // certified an engine playing correct modulation into one ear and silence
  // into the other.
  const bothEars = channelDifference(left, right) === 0;

  return finding(
    id,
    title,
    onRate && fullyGated && bothEars,
    `${measured.frequencyHz.toFixed(2)} Hz against ${modulationHz} Hz commanded, index ${measured.index.toFixed(3)} at full depth, both ears identical: ${bothEars}.`,
  );
}

/**
 * Sinusoidal AM has exactly three components, in a fixed proportion.
 *
 * The textbook relation: sidebands sit at half the modulation index relative to
 * the carrier, and the index for this shape is `depth / (2 - depth)`. Checking
 * only that sidebands *exist* accepts an engine modulating at a fraction of the
 * depth it was given — they are still there, still symmetric, and the stimulus
 * is not the one that was asked for.
 *
 * Still an invariant rather than a remembered number: it is derived from the
 * depth in force, so it moves when the parameters do.
 */
function spectrumFinding(
  id: string,
  title: string,
  renderer: typeof renderOffline,
  sampleRate: number,
  frames: number,
): Finding {
  const carrierHz = 220;
  const modulationHz = 40;
  const depth = 1;
  const { left, right } = renderer(
    params({ ...ENVELOPE_SHAPES.sine, carrierHz, modulationHz, depth, amGain: 0.5 }),
    sampleRate,
    frames,
  );

  const at = (hz: number): number => amplitudeAt(left, sampleRate, hz);
  const carrier = at(carrierHz);
  const lower = at(carrierHz - modulationHz);
  const upper = at(carrierHz + modulationHz);
  const second = Math.max(at(carrierHz - 2 * modulationHz), at(carrierHz + 2 * modulationHz));

  const expectedRatio = depth / (2 - depth) / 2;
  const ratio = carrier > 0 ? (lower + upper) / 2 / carrier : 0;

  const symmetric = Math.abs(lower - upper) <= 0.02 * Math.max(lower, upper);
  const proportionate = Math.abs(ratio - expectedRatio) <= 0.05 * expectedRatio;
  const bothEars = channelDifference(left, right) === 0;
  // Sixty decibels below the real sidebands is the difference between "not
  // there" and "there but small", with room for arithmetic.
  const clean = second < 1e-3 * Math.max(lower, upper);

  return finding(
    id,
    title,
    symmetric && proportionate && clean && bothEars,
    `Sidebands ${(ratio * 100).toFixed(1)}% of the carrier against ${(expectedRatio * 100).toFixed(1)}% expected at depth ${depth}; second order ${second.toExponential(2)}; both ears identical: ${bothEars}.`,
  );
}

/**
 * Dichotic: one tone per ear, and neither ear carrying the other's.
 *
 * Correlation alone does not say this. Two uncorrelated signals that are not
 * the requested pair — quadrature copies of a single frequency, say — measure
 * exactly as well, while the 40 Hz difference the brainstem is supposed to
 * compute is not there at all. So this asks where the energy actually is, and
 * that neither ear beats on its own, which is what makes the beat binaural.
 */
function dichoticFinding(
  id: string,
  title: string,
  renderer: typeof renderOffline,
  sampleRate: number,
  frames: number,
): Finding {
  const carrierHz = 220;
  const modulationHz = 40;
  const { left, right } = renderer(
    params({ amGain: 0, twoToneGain: 0.5, twoToneMode: 'dichotic', carrierHz, modulationHz }),
    sampleRate,
    frames,
    QUANTUM,
  );

  const leftLow = amplitudeAt(left, sampleRate, carrierHz);
  const leftHigh = amplitudeAt(left, sampleRate, carrierHz + modulationHz);
  const rightLow = amplitudeAt(right, sampleRate, carrierHz);
  const rightHigh = amplitudeAt(right, sampleRate, carrierHz + modulationHz);

  const placed = leftLow > 0.1 && rightHigh > 0.1;
  // Equal in level, not merely both present. Neither correlation, crosstalk nor
  // the beat frequency constrains the ratio between the ears, so a right-hand
  // tone at a quarter of the left passed — a lopsided pair the listener would
  // hear as coming from one side.
  const matched = Math.abs(leftLow - rightHigh) <= 0.02 * Math.max(leftLow, rightHigh);
  // Each ear carries its own tone and effectively nothing of the other.
  const separated = leftHigh < 1e-4 * leftLow && rightLow < 1e-4 * rightHigh;
  const uncorrelated = Math.abs(interauralCorrelation(left, right)) < 0.1;
  // Flat in one ear, beating once the two are summed: the definition of a
  // binaural beat rather than an acoustic one.
  const flatAlone = measureEnvelope(left, sampleRate).index < 0.05;
  const beat = measureEnvelope(toMono(left, right), sampleRate);
  const beats = Math.abs(beat.frequencyHz - modulationHz) <= 0.5;

  return finding(
    id,
    title,
    placed && matched && separated && uncorrelated && flatAlone && beats,
    `${carrierHz} Hz left at ${leftLow.toExponential(2)} and ${carrierHz + modulationHz} Hz right at ${rightHigh.toExponential(2)}, crosstalk ${Math.max(leftHigh / leftLow, rightLow / rightHigh).toExponential(1)}; each ear flat, summed they beat at ${beat.frequencyHz.toFixed(2)} Hz.`,
  );
}

/**
 * Diotic: both tones to both ears, so the beat is in the air rather than in the
 * listener.
 *
 * Correlation of one is necessary and nowhere near sufficient — a single tone
 * copied to both ears satisfies it while carrying no beat whatsoever. What
 * distinguishes this mode is that each ear on its own is fully modulated at the
 * difference frequency.
 */
function dioticFinding(
  id: string,
  title: string,
  renderer: typeof renderOffline,
  sampleRate: number,
  frames: number,
): Finding {
  const carrierHz = 220;
  const modulationHz = 40;
  const { left, right } = renderer(
    params({ amGain: 0, twoToneGain: 0.5, twoToneMode: 'diotic', carrierHz, modulationHz }),
    sampleRate,
    frames,
    QUANTUM,
  );

  const low = amplitudeAt(left, sampleRate, carrierHz);
  const high = amplitudeAt(left, sampleRate, carrierHz + modulationHz);
  const rightLow = amplitudeAt(right, sampleRate, carrierHz);
  const rightHigh = amplitudeAt(right, sampleRate, carrierHz + modulationHz);

  const bothTones = low > 0.1 && high > 0.1 && rightLow > 0.1 && rightHigh > 0.1;
  const balanced = Math.abs(low - high) <= 0.05 * Math.max(low, high);
  const correlated = interauralCorrelation(left, right) > 0.99;
  // Correlation is blind to a scaled channel: halving the right ear leaves it
  // at exactly 1. Diotic means the same signal in both ears, so that is what is
  // asked for.
  const bothEars = channelDifference(left, right) === 0;
  // The physical beat, present in a single ear — which is the whole difference
  // from the dichotic case.
  const perEar = measureEnvelope(left, sampleRate);
  const beats = perEar.index > 0.95 && Math.abs(perEar.frequencyHz - modulationHz) <= 0.5;

  return finding(
    id,
    title,
    bothTones && balanced && correlated && beats && bothEars,
    `Both tones in each ear at ${low.toExponential(2)} and ${high.toExponential(2)}; one ear alone beats at ${perEar.frequencyHz.toFixed(2)} Hz, index ${perEar.index.toFixed(3)}; ears identical: ${bothEars}.`,
  );
}

/**
 * Rendering in quanta must equal rendering in one go, exactly, in both ears and
 * on every path.
 *
 * The reason the accumulators are double-precision and never reset. Checking a
 * single AM configuration's left channel leaves three of the four accumulators
 * unexercised — the two-tone oscillators keep their own phase, and a fault in
 * either, or in the right channel, passed unseen.
 */
function chunkingFinding(
  id: string,
  title: string,
  renderer: typeof renderOffline,
  sampleRate: number,
): Finding {
  const cases: [string, EntrainmentParams][] = [
    ['AM', params({ amGain: 0.5, modulationHz: 40 })],
    ['dichotic', params({ amGain: 0, twoToneGain: 0.5, twoToneMode: 'dichotic' })],
    ['diotic', params({ amGain: 0, twoToneGain: 0.5, twoToneMode: 'diotic' })],
    // Both paths at once, which is what a preset may well ask for.
    ['both', params({ amGain: 0.3, twoToneGain: 0.3, twoToneMode: 'dichotic' })],
  ];

  let worst = 0;
  let where = '';
  for (const [name, p] of cases) {
    const single = renderer(p, sampleRate, sampleRate, 0);
    const chunked = renderer(p, sampleRate, sampleRate, QUANTUM);
    for (const channel of ['left', 'right'] as const) {
      for (let i = 0; i < single[channel].length; i += 1) {
        const a = single[channel][i];
        const b = chunked[channel][i];
        // Finiteness first, and not left to the subtraction. A NaN difference
        // is never greater than anything, so a chunked render full of them
        // scanned as identical to a clean one — the third time this same trap
        // has been walked into in this subsystem, and the second in this file.
        if (!Number.isFinite(a) || !Number.isFinite(b)) {
          worst = Infinity;
          where = `${name}, ${channel}, not a number`;
          break;
        }
        const difference = Math.abs(a - b);
        if (difference > worst) {
          worst = difference;
          where = `${name}, ${channel}`;
        }
      }
    }
  }

  return finding(
    id,
    title,
    worst === 0,
    worst === 0
      ? `Identical to the sample in both ears across AM, dichotic, diotic and both together, in ${QUANTUM}-frame blocks.`
      : `Rendering in ${QUANTUM}-frame blocks differs from one pass by ${worst.toExponential(2)} (${where}).`,
  );
}

/**
 * The modulator's phase after a long run, against where arithmetic says it
 * should be.
 *
 * Deliberately at 44.1 kHz, where 44100 / 40 is 1102.5 samples and the period
 * does not land on a sample boundary — the case an integer counter gets wrong
 * and a double-precision accumulator does not. No audio is kept; only the state
 * is advanced.
 */
function driftFinding(id: string, title: string, advance: typeof render): Finding {
  const rate = 44100;
  const modulationHz = 40;
  const total = Math.round(DRIFT_SECONDS * rate);
  const p = params({ amGain: 0.5, modulationHz });

  const state = renderOffline(p, rate, 0, QUANTUM).state;
  const left = new Float32Array(QUANTUM);
  const right = new Float32Array(QUANTUM);
  let done = 0;
  while (done < total) {
    const n = Math.min(QUANTUM, total - done);
    advance(p, state, rate, left, right, n);
    done += n;
  }

  const expected = ((total * modulationHz) % rate) / rate;
  const difference = Math.abs(state.modPhase - expected) % 1;
  const error = Math.min(difference, 1 - difference);

  return finding(
    id,
    title,
    error < 1e-6,
    `After ${DRIFT_SECONDS} s at ${rate} Hz, ${error.toExponential(2)} cycles of drift — ${((error / modulationHz) * 1e12).toFixed(1)} ps.`,
    // Slow drift is a fault worth reporting and not a reason to distrust the
    // rest, so unlike the others it is a warning rather than a failure. Nothing
    // about a session of ordinary length would be audibly wrong.
    'warning',
  );
}
