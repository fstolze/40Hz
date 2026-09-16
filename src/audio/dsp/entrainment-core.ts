/**
 * Deterministic synthesis core for the 40 Hz entrainment engine.
 *
 * This module contains no Web Audio types and no side effects: given a
 * parameter set and a mutable phase state, it fills sample buffers. That makes
 * it directly testable in Node (see test/entrainment.test.ts) and lets the
 * AudioWorkletProcessor be a thin shell around it.
 *
 * Two generation paths:
 *
 *   AM path       carrier x envelope(duty, edge, depth)
 *                 Spectrum: fc, fc +/- fMod. Diotic (identical in both ears).
 *
 *   Two-tone path fc and fc + fMod presented together
 *                 'dichotic' -> binaural beat (one tone per ear; the 40 Hz beat
 *                               is computed in the superior olivary complex)
 *                 'diotic'   -> monaural beat (both tones to both ears; the
 *                               beat exists physically in the waveform)
 *
 * The distinction is a routing flag, not a different oscillator bank.
 */

import { modulatorGain } from './envelope.ts';

const TAU = Math.PI * 2;

/** Runtime list, so untrusted input can be checked against it. */
export const TWO_TONE_MODES = ['off', 'dichotic', 'diotic'] as const;

export type TwoToneMode = (typeof TWO_TONE_MODES)[number];

export interface EntrainmentParams {
  /** Entrainment rate in Hz. 40 for gamma. */
  modulationHz: number;
  /** Carrier frequency in Hz. 220 (A3) by default. */
  carrierHz: number;
  /** Pulse width as a fraction of the modulation period, in (0, 1]. */
  duty: number;
  /** Tukey taper fraction, in [0, 1]. */
  edge: number;
  /** Modulation depth, in [0, 1]. */
  depth: number;
  /** Linear gain of the AM path. */
  amGain: number;
  /** Linear gain of the two-tone path. */
  twoToneGain: number;
  /** Routing for the two-tone path. */
  twoToneMode: TwoToneMode;
}

/**
 * Time constant of the worklet's gain smoother.
 *
 * Shared rather than duplicated because the graph has to reason about it: the
 * worklet approaches a new `amGain` or `twoToneGain` exponentially, so those
 * gains are *between* the old and new values for a while after a change. A
 * master gain that rises to the level the new configuration permits while the
 * old, louder gains are still decaying multiplies out above the ceiling even
 * though both endpoints are under it.
 */
export const SOURCE_SMOOTHING_SECONDS = 0.03;

/**
 * How long the carrier takes to reach a new value.
 *
 * A pointer event is a discrete sample of a gesture that was continuous, and on
 * the Carrier slider one pixel is 2.6 Hz — twenty cents at 220 Hz, a fifth of a
 * semitone. Applying those samples as steps is audible, and audible in exactly
 * the way that was reported: a hand hovering jitters a pixel either way and
 * every one of those is a step. Interpolating between the samples is the
 * reconstruction of the gesture, not a smoothing-over of a defect.
 *
 * 25 ms: long enough that a twenty-cent step becomes a glide rather than a
 * jump, short enough to stay well inside `SOURCE_SETTLE_SECONDS` so the carrier
 * has landed long before the graph is told the configuration settled, and short
 * enough that a deliberate move still feels immediate.
 *
 * The carrier only. `modulationHz` is the beat and is applied at once, as it
 * always has been.
 */
export const CARRIER_GLIDE_SECONDS = 0.025;

/**
 * The longest the carrier will take, however long the hand paused.
 *
 * The glide spans the gap between pointer events, because that is what
 * reconstructing a sampled gesture means: the interpolation interval has to
 * match the sampling interval, or the parameter arrives early and then sits
 * still until the next sample. A fixed 25 ms did exactly that — at events 80 ms
 * apart the carrier was stationary 67% of the time and at 150 ms apart 83%,
 * which is a stepped glissando and is what "choppy when hesitant" was.
 *
 * Capped, because the gap before the *first* move of a drag can be minutes, and
 * a glide that long is not interpolation. 120 ms is beyond any pointer cadence
 * a hand produces while actually dragging, and well inside the 210 ms
 * settlement that snaps the value home regardless.
 */
export const CARRIER_GLIDE_MAX_SECONDS = 0.12;

/**
 * How long the tones take to fade out of, or back into, a routing change.
 *
 * Starting the tone phases from zero makes *switch-on* silent, and nothing
 * else. Measured through the shipped processor with the level up, the worst
 * step at each transition, against a tone amplitude of 0.5:
 *
 *   off -> binaural   0.0000     binaural -> off        0.4999
 *   off -> monaural   0.0000     monaural -> off        0.4344
 *                                binaural <-> monaural  0.4842
 *
 * Phase zero cannot help the other four: switching *off* cuts the tones at
 * whatever they had reached, and swapping between two active routings changes
 * which ear gets which tone — dichotic sends `lo` to the left, diotic sends
 * `(lo + hi) / 2` to both, so it steps by `(hi - lo) / 2` and the two tones are
 * a beat apart by construction. All four are full-scale discontinuities, and
 * they are what "slight clicks during switch" was.
 *
 * So a routing change fades the tones out, swaps while they are silent, and
 * fades back in — and the fade-in starts from phase zero, so the two fixes
 * compose rather than one replacing the other. 15 ms each way: short enough
 * that a deliberate switch still feels immediate, and a swap costing both
 * halves is 30 ms, well inside the 210 ms settlement that snaps it home.
 */
export const TONE_SWAP_SECONDS = 0.015;

/**
 * When the worklet stops smoothing and snaps its gains to their targets.
 *
 * A one-pole never truly arrives, and "close enough" is not good enough here:
 * `BOUND_MARGIN` covers the notch chain's bed term, not `amGain` or
 * `twoToneGain`, so a residual on those is not covered by anything. A source
 * bound of exactly 1 plus any positive residual exceeds 1, and the master is
 * restored on the assumption that it does not.
 *
 * So the worklet snaps rather than approaching asymptotically, and reports
 * that it has. Seven time constants leaves 0.09% of the step to remove, which
 * is inaudible as a step and makes the state exact instead of nearly exact.
 */
export const SOURCE_SETTLE_SECONDS = SOURCE_SMOOTHING_SECONDS * 7;

export const DEFAULT_PARAMS: EntrainmentParams = {
  modulationHz: 40,
  carrierHz: 220,
  duty: 0.5,
  edge: 0.5,
  depth: 1,
  amGain: 0.25,
  twoToneGain: 0,
  twoToneMode: 'off',
};

/**
 * Oscillator phases, each in [0, 1).
 *
 * Phase is carried in double-precision accumulators that are never reset.
 * 44100 / 40 = 1102.5 samples, so the modulation period is not an integer
 * number of samples; a per-block or per-period integer counter would drift
 * over a long session. Accumulated rounding error over an hour at 48 kHz is
 * on the order of 1e-12 cycles, which test/entrainment.test.ts asserts.
 */
export interface EngineState {
  carrierPhase: number;
  modPhase: number;
  toneLoPhase: number;
  toneHiPhase: number;
  /**
   * Whether the two tones were sounding at the end of the last block.
   *
   * The only piece of state here that is not a phase, and it exists because
   * `render` cannot otherwise see an *edge*. The tones are switched by a routing
   * mode that applies immediately while their level is smoothed, so they can
   * begin at full amplitude — at whatever phase they froze at when routing was
   * last turned off. This records the previous answer so that the transition
   * into sounding can be recognised.
   */
  toneActive: boolean;
}

export function createState(): EngineState {
  return { carrierPhase: 0, modPhase: 0, toneLoPhase: 0, toneHiPhase: 0, toneActive: false };
}

function wrap(phase: number): number {
  // Math.floor rather than a single subtraction, so the accumulator stays
  // correct even if a frequency ever exceeds the sample rate.
  return phase - Math.floor(phase);
}

/**
 * Render `frames` samples into `left` and `right`, advancing `state`.
 *
 * Buffers are overwritten, not summed into.
 */
export function render(
  params: EntrainmentParams,
  state: EngineState,
  sampleRate: number,
  left: Float32Array,
  right: Float32Array,
  frames: number = left.length,
  /**
   * Where the carrier should be by the end of this block, if it is moving.
   *
   * A pointer event is a discrete sample of a gesture that was continuous, and
   * the Carrier slider is 2.6 Hz — twenty cents — per pixel, so applying those
   * samples as steps is audible. Interpolating between them is the
   * reconstruction, not a smoothing-over: the same argument the gains already
   * rely on.
   *
   * Only the carrier, and deliberately: `modulationHz` sets the beat and is
   * applied immediately, as it always was. Both two-tone oscillators take this
   * same base, so their instantaneous frequencies stay `c(t)` and
   * `c(t) + modulationHz` and the dichotic separation is exact at every sample.
   *
   * Omitted, or equal to `carrierHz`, and this is the block it always was.
   */
  carrierToHz?: number,
  /**
   * Where the two-tone level should be by the end of this block, if it is moving.
   *
   * The same treatment as `carrierToHz` and for the same reason: a fade applied
   * once per block is a staircase of 2.7 ms steps, and a step in a gain is the
   * click being removed, only smaller. Interpolating per sample makes the fade
   * continuous.
   *
   * Omitted, or equal to `twoToneGain`, and this is the block it always was.
   */
  twoToneGainTo?: number,
): void {
  const { modulationHz, carrierHz, duty, edge, depth, amGain, twoToneGain, twoToneMode } = params;

  const modInc = modulationHz / sampleRate;
  // Per sample only while the carrier is actually moving; a still carrier keeps
  // the hoisted increments it always had.
  const gliding = carrierToHz !== undefined && carrierToHz !== carrierHz && frames > 0;
  const carrierSlope = gliding ? (carrierToHz - carrierHz) / frames : 0;
  const carrierInc = carrierHz / sampleRate;
  const toneLoInc = carrierHz / sampleRate;
  const toneHiInc = (carrierHz + modulationHz) / sampleRate;

  // A fade is in progress when the level it should reach differs from the one
  // it starts at; the tones then sound for the whole block even if one end is
  // zero, because they are on their way to or from it.
  const fading = twoToneGainTo !== undefined && twoToneGainTo !== twoToneGain && frames > 0;
  const toneGainSlope = fading ? (twoToneGainTo - twoToneGain) / frames : 0;
  const twoToneActive = twoToneMode !== 'off' && (twoToneGain > 0 || (fading && twoToneGainTo > 0));
  // In diotic mode both tones reach both ears, so each channel would peak at
  // 2x the per-tone amplitude. Halving keeps peak level matched to dichotic.
  const dioticScale = 0.5;

  let { carrierPhase, modPhase, toneLoPhase, toneHiPhase } = state;

  /*
   * The tones start where the carrier and the modulator already are.
   *
   * `toneLoPhase` and `toneHiPhase` advance only while the tones sound, so they
   * freeze when routing goes to Off and would otherwise resume from wherever they
   * stopped. `toneLoInc` is `carrierHz / sampleRate` — the lower tone runs at
   * *exactly* the entrainment carrier — so once sounding its phase against the
   * carrier is constant, and so is the upper tone's against carrier plus
   * modulator. A steady tone summed with an amplitude-modulated one at the same
   * frequency fills the modulation troughs by an amount that relation decides,
   * anywhere from reinforcing to partly cancelling. Left to wherever the tones
   * froze, the same recipe sounded different depending on when routing was
   * switched, and a recipe that does not reproduce is not a recipe.
   *
   * Resetting to zero was the first answer, and it only fixed the relation when
   * the carrier and modulator happened to be at zero too. They free-run, and a
   * glide leaves the carrier anywhere, so switching the tones on mid-playback
   * still set an arbitrary relation — and the integrity checks, whose reference
   * render starts every phase at zero, warned about correct output: at 48 kHz a
   * mixed recipe read an 80 Hz envelope against 40, and sidebands 30 dB out.
   *
   * So the tones take their phase *from* the carrier and modulator: `lo` equals
   * the carrier, and `hi` the carrier plus the modulator, which is what the
   * reference render has at every sample. The relation is then fixed whenever
   * they start, and it survives everything afterwards: all three advance by the
   * same carrier step during a glide, and the modulator and `hi` by the same
   * `modulationHz` when the rate changes, so the differences never move.
   *
   * What this gives up is a silent first sample. `sin(TAU * carrierPhase)` is
   * anything, so the tones must never arrive here at full level — which is the
   * processor's job, since only it sees the level over more than one block: it
   * fades them in from zero on every start (see `advanceToneSwap`).
   *
   * An edge and not a reset every block, deliberately — once sounding the tones
   * must free-run, or the beat between them is what would be destroyed.
   */
  if (twoToneActive && !state.toneActive) {
    toneLoPhase = carrierPhase;
    toneHiPhase = wrap(carrierPhase + modPhase);
  }

  for (let i = 0; i < frames; i++) {
    // Phase only ever advances, so a moving increment is still continuous in
    // phase — the waveform bends rather than stepping.
    const here = gliding ? carrierHz + carrierSlope * i : carrierHz;
    const carrierStep = gliding ? here / sampleRate : carrierInc;
    const toneLoStep = gliding ? here / sampleRate : toneLoInc;
    const toneHiStep = gliding ? (here + modulationHz) / sampleRate : toneHiInc;

    const am = Math.sin(TAU * carrierPhase) * modulatorGain(modPhase, duty, edge, depth) * amGain;

    let l = am;
    let r = am;

    if (twoToneActive) {
      const toneGain = fading ? twoToneGain + toneGainSlope * i : twoToneGain;
      const lo = Math.sin(TAU * toneLoPhase) * toneGain;
      const hi = Math.sin(TAU * toneHiPhase) * toneGain;
      if (twoToneMode === 'dichotic') {
        l += lo;
        r += hi;
      } else {
        const both = (lo + hi) * dioticScale;
        l += both;
        r += both;
      }
      toneLoPhase = wrap(toneLoPhase + toneLoStep);
      toneHiPhase = wrap(toneHiPhase + toneHiStep);
    }

    left[i] = l;
    right[i] = r;

    carrierPhase = wrap(carrierPhase + carrierStep);
    modPhase = wrap(modPhase + modInc);
  }

  state.carrierPhase = carrierPhase;
  state.modPhase = modPhase;
  state.toneLoPhase = toneLoPhase;
  state.toneHiPhase = toneHiPhase;
  state.toneActive = twoToneActive;
}

/** Clamp incoming parameters into safe ranges before they reach the audio thread. */
export function sanitizeParams(p: Partial<EntrainmentParams>): Partial<EntrainmentParams> {
  const out: Partial<EntrainmentParams> = {};
  if (p.modulationHz !== undefined) out.modulationHz = clamp(p.modulationHz, 0.5, 200);
  if (p.carrierHz !== undefined) out.carrierHz = clamp(p.carrierHz, 20, 8000);
  if (p.duty !== undefined) out.duty = clamp(p.duty, 0.02, 1);
  if (p.edge !== undefined) out.edge = clamp(p.edge, 0, 1);
  if (p.depth !== undefined) out.depth = clamp(p.depth, 0, 1);
  if (p.amGain !== undefined) out.amGain = clamp(p.amGain, 0, 1);
  if (p.twoToneGain !== undefined) out.twoToneGain = clamp(p.twoToneGain, 0, 1);
  // Checked against the runtime list rather than trusted: an unrecognised mode
  // would otherwise fall through render()'s dichotic test and play as diotic.
  if (p.twoToneMode !== undefined && TWO_TONE_MODES.includes(p.twoToneMode)) {
    out.twoToneMode = p.twoToneMode;
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}
