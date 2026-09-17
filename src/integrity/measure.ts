/**
 * Turning a captured window into findings.
 *
 * Pure: buffers in, findings out. No Web Audio, no Electron, no clock — so
 * every threshold and every piece of copy is asserted offline.
 *
 * **What the oracle can and cannot cover.** `renderOffline` takes
 * `EntrainmentParams` and nothing else. It models the synthesis core, not the
 * bed, the playback envelope, the headroom scaling, or the compressor. So it
 * is an oracle for the entrainment tap and is not one for the master bus.
 * Rather than building an offline mirror of `graph.ts` — which would duplicate
 * the thing under test and fail in the same direction as it — the master tap
 * is checked against bounds alone.
 *
 * **Why these metrics.** Everything compared here is scale-invariant:
 * modulation index, envelope frequency, interaural correlation, and
 * sideband-to-carrier ratio. `entrainmentGain` sits between the source and the
 * tap, so absolute levels need not match the offline render at all, and a
 * check that expected them to would fail on a correct graph at a different
 * volume. They are also phase-invariant, which matters because a captured
 * window starts wherever the ring happened to be while the oracle starts at
 * phase zero. Invariant to where the window starts is not invariant to where
 * the carrier sits under its envelope, though, so the reference is first turned
 * to the capture's alignment — see `carrierAlignments` — and every reading is
 * compared against that.
 *
 * **Why against the oracle rather than the commanded numbers.** `depth` is not
 * the modulation index except for the sine shape, where
 * `index = depth / (2 - depth)` — `test/entrainment.test.ts` asserts that
 * mapping for that shape alone, because the pulse shapes carry envelope
 * harmonics that break the narrowband assumption the Hilbert envelope depends
 * on. Comparing measured against measured, through the same functions, is what
 * makes the comparison valid for every shape and for AM and two-tone at once.
 */

import {
  measureEnvelope,
  interauralCorrelation,
  peakLevel,
  rms,
  type EnvelopeMetrics,
} from '../audio/analysis/metrics.ts';
import { amplitudeAt, fft, hann, ifft, prevPowerOfTwo } from '../audio/analysis/fft.ts';
import { renderOffline } from '../audio/dsp/render-offline.ts';
import { createState, type EntrainmentParams } from '../audio/dsp/entrainment-core.ts';
import { checkedFinding, type Finding } from './findings.ts';

export interface Capture {
  left: Float32Array | Float64Array;
  right: Float32Array | Float64Array;
  sampleRate: number;
}

/**
 * Thresholds, all deliberately loose.
 *
 * A wrong warning is worse than no warning: it teaches the user to ignore the
 * one surface that exists to be believed. These start wide enough that only a
 * real fault trips them, and tighten only once the values have been read on
 * real machines — which has not happened yet.
 */
export const TOLERANCE = {
  /** Envelope frequency, as a fraction of the commanded rate. */
  envelopeFrequency: 0.1,
  /** ...with a floor, since a short window's spectrum is coarse. */
  envelopeFrequencyHz: 2,
  /** Modulation index, absolute. */
  modulationIndex: 0.2,
  /** Interaural correlation, absolute. */
  correlation: 0.3,
  /** Side-to-mid energy, in dB. */
  stereoDifferenceDb: 6,
  /**
   * Right against left, in dB.
   *
   * Tighter than the rest because this one should be exact. The graph decides
   * both channels itself, so any real imbalance before `destination` is a
   * fault rather than a variation — and a 3 dB slip is already half the power
   * gone from one ear.
   */
  channelBalanceDb: 3,
  /**
   * Worst per-band difference between a channel and its reference, in dB.
   *
   * Measured rather than chosen. Across eight carriers, three modulation rates,
   * 400 capture offsets and a trip through Float32, a healthy render never
   * exceeded 2.8 dB — once the carrier's alignment under its envelope is taken
   * as a free parameter, which `carrierAlignments` explains — and that worst case is at 0.5 Hz, where a two-second
   * window holds a single period and its shape genuinely depends on where it
   * started. The subtlest fault this has to catch, a right-ear tone one hertz
   * out, reads 12.8 dB. Eight sits between them with room on both sides.
   */
  spectrumDb: 8,
  /**
   * Widest band, in Hz, at which a clean spectrum comparison means anything.
   *
   * Resolution follows window length, and short windows silently stop being
   * able to see small faults: eight modulation periods at 40 Hz is 9,600
   * frames, which after rounding down to a power of two gives bands 11.7 Hz
   * wide. A right-ear tone moved by a hertz cannot show up in that, and
   * reporting `ok` would be claiming a check that could not have failed. Two
   * seconds gives 1.46 Hz at every sample rate the app is likely to see.
   */
  spectrumBandHz: 2,
  /** Sideband-to-carrier ratio, in dB. */
  sidebandDb: 6,
  /** How far above the ceiling counts as overshoot rather than arithmetic. */
  ceilingOvershoot: 1.02,
} as const;

/**
 * Shortest window worth an opinion.
 *
 * Eight modulation periods, and never fewer than 4096 samples: the envelope is
 * found by transforming the window, so a short one has a spectrum too coarse to
 * distinguish 40 Hz from its neighbours and would produce a confident number
 * from noise.
 */
const MIN_PERIODS = 8;
const MIN_FRAMES = 4096;

/** Below this the tap recorded nothing, and nothing can be concluded from it. */
const SILENCE_FLOOR = 1e-4;

/**
 * Whether the output kept going, rather than merely having happened once.
 *
 * Peak level cannot answer this, and using it for both questions was a hole:
 * two seconds of silence containing a single 0.5 impulse has a peak of 0.5 and
 * passed as healthy output. A graph that emitted one click and died reported
 * clean. Nor does plain RMS separate them — that impulse still averages above
 * the silence floor.
 *
 * So the window is cut into blocks and the ones carrying signal are counted,
 * against a floor relative to the window's own peak, which keeps the measure
 * scale-invariant.
 *
 * **The block length has to come from the modulation rate.** A fixed 1024
 * frames was 21 ms at 48 kHz and 11 ms at 96 kHz, while the engine permits
 * rates down to 0.5 Hz and duty cycles down to 2% — so correct output could be
 * silent for far longer than a block and report itself intermittent. Two
 * periods per block guarantees a whole pulse inside each one however the
 * boundaries fall, at any rate and any duty.
 *
 * That also means continuity cannot always be judged. At 0.5 Hz a period is two
 * seconds, and a window that holds only a couple of them carries no evidence of
 * repetition at all: a correct 2% duty cycle and a graph that died look
 * identical. Below `MIN_BLOCKS` this says so rather than guessing, because
 * there is genuinely nothing to distinguish them.
 */
const PERIODS_PER_BLOCK = 2;
const MIN_BLOCKS = 4;
/**
 * What makes a block count as carrying signal: whether anything in it reaches a
 * hundredth of the window's peak.
 *
 * Peak, not energy and not a count of loud samples. Both of those were tried
 * and both warned about correct output, for the same underlying reason: they
 * measure how much of the *time* carries signal, and correct output can carry
 * signal for very little of it. A 2% duty cycle is silent for 98% of every
 * period by design; a pulse shorter than one cycle of its own carrier comes out
 * near-silent depending on where the carrier was; and at four samples per
 * carrier cycle — 8 kHz at 32 kHz sample rate — half the samples of a perfectly
 * healthy tone sit at zero crossings. Each of those produced a warning about a
 * correct render, and each was patched with a threshold that the next
 * configuration slipped under.
 *
 * Asking whether the block contains *anything* removes the whole class.
 * Measured across 10,368 legal combinations of sample rate, modulation, carrier,
 * duty, taper and depth — including 22.05 and 32 kHz — correct output covers
 * 100% of blocks, with no configuration anywhere near the threshold. There is
 * no calibration left to get wrong.
 *
 * **What this gives up, deliberately: click trains pass.** A single impulse per
 * block reaches the peak just as a pulse does. That is not a threshold that
 * could be tightened — at 40 Hz and 2% duty a legal pulse is exactly 24 samples,
 * so a burst of the same length is the same signal, and the only thing that
 * distinguishes them is how many arrive per period. Detecting that needs pulse
 * cadence measured through an envelope, which is a different check from this
 * one. This check answers what it was asked for: is the output silent, and did
 * it stop partway.
 */
const BLOCK_PEAK_FLOOR = 0.01;

/** How much of the window must carry signal. Correct output covers all of it. */
const MIN_ACTIVE_FRACTION = 0.95;

/** The fraction of blocks carrying signal, or null when there are too few to judge. */
function activeFraction(
  left: Float64Array,
  right: Float64Array,
  peak: number,
  sampleRate: number,
  modulationHz: number,
): number | null {
  const n = Math.min(left.length, right.length);
  if (n === 0 || peak <= 0) return 0;

  const rate = modulationHz > 0 ? modulationHz : 1;
  const blockFrames = Math.max(1, Math.ceil((PERIODS_PER_BLOCK * sampleRate) / rate));
  if (n < MIN_BLOCKS * blockFrames) return null;

  const threshold = peak * BLOCK_PEAK_FLOOR;
  let blocks = 0;
  let active = 0;
  for (let start = 0; start + blockFrames <= n; start += blockFrames) {
    let loudest = 0;
    for (let i = start; i < start + blockFrames; i += 1) {
      const sample = Math.max(Math.abs(left[i]), Math.abs(right[i]));
      if (sample > loudest) loudest = sample;
    }
    blocks += 1;
    if (loudest >= threshold) active += 1;
  }
  return blocks === 0 ? null : active / blocks;
}

/**
 * Shallowest modulation whose *rate* can be believed.
 *
 * The envelope frequency is the dominant peak of the envelope's own spectrum.
 * When there is barely an envelope, that peak is whatever numerical residue
 * and edge effects leave behind — at a depth of 0.0005 a perfectly healthy
 * capture reports 220 Hz against the reference's 40 Hz, purely because two
 * different piles of noise had different maxima. Comparing those is not a
 * measurement, and warning on it is the wrong warning this module says it
 * would rather not give.
 *
 * Two percent is far below anything audible as pulsing, so nothing worth
 * hearing is excluded by refusing to judge the rate below it.
 */
const MIN_MODULATION_INDEX = 0.02;

/**
 * How far down a ratio has to be before it counts as simply absent.
 *
 * Every ratio here is compared in dB, and the logarithm of a component that is
 * not there runs off toward negative infinity. Clamping at a bare numerical
 * epsilon and then applying the ordinary tolerance turned inaudible arithmetic
 * residue into warnings: a −169 dB stereo difference read as 11 dB of error
 * against a reference clamped to −180, and a sideband at −108 dBc warned for a
 * signal whose modulation depth was zero. Both are far below hearing, and
 * below this module's own silence floor.
 *
 * −80 dB is the floor for anything expressed as a ratio: two components that
 * are both under it are both absent, and absent equals absent.
 */
const RATIO_FLOOR_DB = -80;

/** A ratio in dB, floored so that "not there" compares equal to "not there". */
function ratioDb(value: number): number {
  return Math.max(RATIO_FLOOR_DB, 20 * Math.log10(Math.max(value, 1e-12)));
}

/**
 * How long a window to ask the tap for, given what is playing.
 *
 * A constant would be wrong at both ends. Two of the findings degrade to
 * `unknown` on a window too short to support them, and both floors move with
 * the configuration:
 *
 * - **Spectral resolution.** Bands must come under `TOLERANCE.spectrumBandHz`
 *   or a component moved by a hertz cannot show, and a short window does not
 *   merely miss that — it manufactures deviations from where the capture
 *   started. That floor is fixed in Hz, so in frames it scales with the sample
 *   rate: 65,536 at 48 kHz, about 1.4 seconds.
 * - **Continuity.** Blocks are two modulation periods and at least
 *   `MIN_BLOCKS` are needed, so this floor is eight periods — a fifth of a
 *   second at 40 Hz, and sixteen seconds at 0.5 Hz.
 *
 * Rounded up to a power of two because the analysis truncates to one anyway;
 * asking for 9,600 frames and having 8,192 of them used is how a window ends up
 * coarser than the caller believed.
 *
 * The caller still has to cap this at whatever the ring holds. Asking for more
 * is refused rather than answered short, and the findings then say which checks
 * the window could not support — which is the honest outcome, but a fixable one
 * at the call site.
 */
export function captureFramesFor(params: EntrainmentParams, sampleRate: number): number {
  const rate = params.modulationHz > 0 ? params.modulationHz : 1;

  const forSpectrum = (BINS_PER_BAND * sampleRate) / TOLERANCE.spectrumBandHz;
  const forContinuity = (MIN_BLOCKS * PERIODS_PER_BLOCK * sampleRate) / rate;
  const forEnvelope = Math.max(MIN_FRAMES, (MIN_PERIODS * sampleRate) / rate);

  const needed = Math.max(forSpectrum, forContinuity, forEnvelope);
  let frames = 1;
  while (frames < needed) frames *= 2;
  return frames;
}

function toFloat64(signal: Float32Array | Float64Array): Float64Array {
  return signal instanceof Float64Array ? signal : Float64Array.from(signal);
}

/** The index of the first sample that is not a real number, or -1. */
function firstNonFinite(signal: Float64Array): number {
  for (let i = 0; i < signal.length; i += 1) {
    if (!Number.isFinite(signal[i])) return i;
  }
  return -1;
}

/**
 * A definite failure when the capture contains anything that is not a number.
 *
 * Every metric here is built on comparisons, and comparisons with `NaN` are
 * false — so `peakLevel` skips over them silently. An entire channel of `NaN`
 * beside a healthy one therefore measured as the healthy one's peak and passed
 * both bounds: a clean report for output that is not audio at all. Invalid
 * samples reach the listener as silence or a click, and they mean the graph is
 * broken, so this is `failed` rather than something softer.
 */
function nonFiniteFinding(id: string, left: Float64Array, right: Float64Array): Finding | null {
  const inLeft = firstNonFinite(left);
  const inRight = firstNonFinite(right);
  if (inLeft < 0 && inRight < 0) return null;

  const where =
    inLeft >= 0 ? `left channel at sample ${inLeft}` : `right channel at sample ${inRight}`;
  return checkedFinding({
    id,
    scope: 'graph',
    status: 'failed',
    title: 'Output validity',
    detail: `The capture contains values that are not numbers — ${where}. The graph is producing invalid output.`,
  });
}

/** A finding that ran and could not conclude, which is not the same as a pass. */
function inconclusive(id: string, title: string, detail: string): Finding {
  return checkedFinding({ id, scope: 'graph', status: 'unknown', title, detail });
}

function compare(
  id: string,
  title: string,
  measured: number,
  expected: number,
  tolerance: number,
  unit: string,
): Finding {
  const off = Math.abs(measured - expected);
  const within = off <= tolerance;
  return checkedFinding({
    id,
    scope: 'graph',
    status: within ? 'ok' : 'warning',
    title,
    detail: within
      ? `${measured.toFixed(3)}${unit}, against ${expected.toFixed(3)}${unit} from the reference render`
      : `${measured.toFixed(3)}${unit}, against ${expected.toFixed(3)}${unit} from the reference render — off by ${off.toFixed(3)}${unit}, past the ${tolerance}${unit} tolerance`,
  });
}

/**
 * Compare the entrainment tap against a reference render of the same
 * parameters.
 *
 * The window is taken before the bed, so what reaches here is the synthesis
 * core's output and the oracle applies. Both sides run through the *same*
 * analysis functions: a discrepancy is then a difference in the signal rather
 * than a difference in how it was measured.
 */
export function measureEntrainment(capture: Capture, params: EntrainmentParams): Finding[] {
  const left = toFloat64(capture.left);
  const right = toFloat64(capture.right);
  const frames = Math.min(left.length, right.length);
  const { sampleRate } = capture;

  // Before anything is measured: every metric below would quietly absorb these.
  const invalid = nonFiniteFinding('graph-entrainment-validity', left, right);
  if (invalid !== null) return [invalid];

  const needed = Math.max(MIN_FRAMES, Math.ceil((MIN_PERIODS * sampleRate) / params.modulationHz));
  if (frames < needed) {
    return [
      inconclusive(
        'graph-window',
        'Capture window',
        `${frames} frames is too short to measure ${params.modulationHz} Hz; ${needed} are needed.`,
      ),
    ];
  }

  if (peakLevel(left) < SILENCE_FLOOR && peakLevel(right) < SILENCE_FLOOR) {
    // Silence is not a fault here. The entrainment path can legitimately be
    // turned down to nothing, and the master tap is where a silent output is
    // worth remarking on.
    return [
      inconclusive(
        'graph-entrainment-signal',
        'Entrainment level',
        'The entrainment tap recorded silence, so nothing about its shape can be measured.',
      ),
    ];
  }

  /*
   * The reference at the capture's own carrier alignment, not at zero.
   *
   * Against phase zero, only the spectrum was protected: an 80 Hz carrier
   * hard-gated at 5%, captured at 32 kHz with the carrier at 0.4423 of a cycle,
   * timed its envelope at 80 Hz against 40 and warned, while the spectrum
   * beside it passed. A narrow pulse has a flat comb of envelope harmonics, and
   * which is tallest is decided by where the carrier sits under it.
   *
   * The alignment comes from the waveform, not from the spectrum comparison.
   * Magnitudes cannot always tell alignments apart — under shallow modulation
   * several are identical to the last decimal — and the spectrum's search then
   * picked one by rounding, which timed a 60 Hz envelope against a 180 Hz
   * reference. The same fit finds where in its period the window started, and
   * the reference is read from there too: some readings move with the start
   * alone. A shallow 10% pulse on a 120 Hz carrier read its envelope at 40 Hz
   * from one start and 120 Hz from another, and sidebands 40 dB down read
   * differently by leakage — none of which any alignment could have answered.
   * The spectrum is judged there too, and not against the best turn the
   * reference could take: see `spectralDeviationDb`.
   *
   * Swept over healthy captures through Float32 at window offsets 0 and 613:
   * 2,560 AM recipes (carriers 80 Hz to 8 kHz, duty 2% to 50%, hard and tapered
   * edges, 22.05 to 96 kHz, four alignments, every preset), 2,304 shallow ones
   * (depth 2% to 30%, rates 20 to 60 Hz, carriers 80 Hz to 1 kHz), and 192
   * mixed ones running both paths; and 600 at 2% duty (22.05 to 48 kHz, carriers
   * 80 Hz to 1 kHz, hard and tapered edges). Against phase zero the first two
   * warned 71 and 426 times, and the mixed ones 114 while the tones restarted at
   * zero; against a reference fitted only to the whole sample, 57 of the 2%-duty
   * captures warned. Here none of the four sweeps warns, and the worst 2%-duty
   * spectrum reads 0.8 dB — see `fractionalReference`.
   *
   * Seeded faults, counted only where the healthy capture passes: detection
   * matches the whole-sample reference for every recipe but one, the corner
   * `waveformAlignment` records, where a shallow pulse running 2 Hz fast — inside
   * the rate tolerance — is now matched by a reference as well.
   */
  let reference: { left: Float64Array; right: Float64Array };
  let spectrumDb: number;
  if (frames > ALIGNMENT_MAX_FRAMES) {
    reference = renderOffline(params, sampleRate, frames);
    spectrumDb = spectralDeviationDb([left, right], [reference.left, reference.right]);
  } else {
    const lead = Math.min(Math.ceil(sampleRate / params.modulationHz), Math.floor(frames / 2));
    const aligned = carrierAlignments(
      params,
      sampleRate,
      frames + lead,
      renderOffline(params, sampleRate, frames + lead),
    );
    const found = waveformAlignment([left, right], aligned, frames, lead, params);
    reference =
      params.amGain > 0
        ? fractionalReference([left, right], params, sampleRate, frames, found)
        : referenceAt(
            aligned.map((part) => windowOf(part, found.offset, frames)),
            found.angle,
          );
    spectrumDb = spectralDeviationDb([left, right], [reference.left, reference.right]);
  }

  const findings: Finding[] = [];

  const measured = measureEnvelope(left, sampleRate);
  const expected = measureEnvelope(reference.left, sampleRate);

  findings.push(envelopeRateFinding(measured, expected, params));

  findings.push(
    compare(
      'graph-envelope-index',
      'Modulation depth',
      measured.index,
      expected.index,
      TOLERANCE.modulationIndex,
      '',
    ),
  );

  findings.push(
    compare(
      'graph-interaural',
      'Interaural correlation',
      interauralCorrelation(left, right),
      interauralCorrelation(reference.left, reference.right),
      TOLERANCE.correlation,
      '',
    ),
  );

  findings.push(
    compare(
      'graph-stereo-difference',
      'Stereo difference',
      sideToMidDb(left, right),
      sideToMidDb(reference.left, reference.right),
      TOLERANCE.stereoDifferenceDb,
      ' dB',
    ),
  );

  findings.push(
    compare(
      'graph-channel-balance',
      'Channel balance',
      channelBalanceDb(left, right),
      channelBalanceDb(reference.left, reference.right),
      TOLERANCE.channelBalanceDb,
      ' dB',
    ),
  );

  findings.push(spectrumFinding(spectrumDb, bandWidthHz(frames, sampleRate)));

  findings.push(sidebandFinding(left, reference.left, sampleRate, params));

  return findings;
}

/**
 * How much of the signal is the difference between the ears, against how much
 * is common to both, in dB.
 *
 * Correlation alone is not enough, and the case it misses is the one that
 * matters. A configuration running AM and two-tone together shares the AM
 * component between the channels; that shared part can dominate the
 * correlation enough that collapsing the dichotic component to mono still
 * measures as barely changed — four clean findings for a signal whose binaural
 * beat has been destroyed. The side channel is where that collapse actually
 * shows: mono has none at all.
 *
 * Scale-invariant because it is a ratio of the two, so the gain between the
 * source and the tap cancels.
 */
/**
 * Energy per narrow band, normalised by the signal's own level.
 *
 * Bands rather than bins, and this is the correction that matters. A component
 * that does not land exactly on a bin spreads across its neighbours, and how it
 * spreads depends on where the captured window happened to start — so comparing
 * single bins made a healthy capture at, say, an 81 Hz carrier disagree with
 * its own reference by double-digit decibels, purely from where the ring was
 * when it was read. Summing neighbouring bins collects that skirt back
 * together.
 *
 * **Two bins, not four.** Four hid a real fault: with an AM bed playing over a
 * dichotic pair, moving the right ear's tone from 260 Hz to 262 Hz — a 42 Hz
 * beat rather than 40 — kept the displaced energy inside its own band and read
 * 7.3 dB, under the tolerance. At two bins the same fault reads 38 dB, and
 * healthy captures are no noisier for it: 1.65 dB against 1.60, measured over
 * five carriers, four rates and 120 offsets through Float32.
 *
 * Normalising by the signal's own level is what keeps it scale-invariant.
 */
const BINS_PER_BAND = 2;

function bandEnergies(signal: Float64Array, frames: number): Float64Array {
  // `hann` returns a fresh buffer, so it is transformed in place without a copy.
  const re = hann(signal.subarray(0, frames));
  const im = new Float64Array(frames);
  fft(re, im);

  const energy = Math.max(rms(signal.subarray(0, frames)), 1e-12);
  const bands = Math.floor(frames / 2 / BINS_PER_BAND);
  const out = new Float64Array(bands);
  for (let k = 0; k < bands; k += 1) {
    let sum = 0;
    for (let i = k * BINS_PER_BAND; i < (k + 1) * BINS_PER_BAND; i += 1) {
      sum += (Math.hypot(re[i], im[i]) / frames / energy) ** 2;
    }
    out[k] = Math.sqrt(sum);
  }
  return out;
}

/**
 * The reference, with the carrier's alignment under its envelope left open.
 *
 * `renderOffline` starts the carrier and the modulator together at phase zero.
 * The live engine does that only until the carrier first moves: a glide is
 * phase-continuous by design, so it leaves the carrier at whatever alignment it
 * ended on, and that alignment then holds for as long as neither frequency
 * changes. Offsetting the window cannot recover it, since both phases advance
 * together — which is why the capture-offset sweeps behind `TOLERANCE` never
 * saw it.
 *
 * For most carriers a magnitude spectrum cannot see the alignment either. It
 * can when the carrier is a whole or half multiple of the modulation rate,
 * because the envelope's lower sidebands then fold below zero onto the same
 * frequencies as the upper ones, and the two add or cancel by an amount the
 * alignment decides. 220 Hz under 40 is 5.5 periods and folds onto 20, 60 and
 * 100 Hz; 8 kHz is 200 and folds onto every multiple of 40. Swept over 32
 * alignments at five sample rates, a healthy Balanced pulse read up to 15.1 dB
 * and the GENUS-inspired preset 16.0 — warnings about correct output, reached
 * by doing nothing more than switching presets while playing.
 *
 * Every alignment is a pair of renders, exactly and without a search. The
 * output is `sin(carrier + φ)` times whatever multiplies it, which is `cos φ`
 * times its render at phase zero plus `sin φ` times its render a quarter cycle
 * on. `waveformAlignment` then reads φ off the capture itself.
 *
 * **The tones turn with it.** The engine starts them from the carrier's own
 * phase, and the upper one from the carrier's plus the modulator's, so a recipe
 * running both paths has one alignment rather than two and the quarter-cycle
 * render carries the tones a quarter cycle on as well. While they restarted at
 * zero wherever the carrier was, that relation was a second unknown, and it
 * moved the envelope, level and sideband readings as far as this one — which is
 * why it was fixed in the engine rather than modelled here. Across 192 healthy
 * mixed captures it was 114 warnings; it is none.
 *
 * With no AM path there is nothing to turn: the tones alone put nothing below
 * zero to fold, so the reference is held as rendered.
 */
interface AlignedReference {
  /** What does not turn: the whole reference when there is nothing to align, else silence. */
  held: Float64Array;
  /** The reference at its own alignment. */
  inPhase: Float64Array;
  /** The reference a quarter carrier cycle on. */
  quadrature: Float64Array;
}

function carrierAlignments(
  params: EntrainmentParams,
  sampleRate: number,
  frames: number,
  reference: { left: Float64Array; right: Float64Array },
): AlignedReference[] {
  const silence = new Float64Array(frames);
  // With no AM path there is nothing to align, and the reference is the answer.
  if (params.amGain <= 0) {
    return [reference.left, reference.right].map((channel) => ({
      held: channel,
      inPhase: silence,
      quadrature: silence,
    }));
  }

  // The whole reference turns, tones included: the engine starts them from the
  // carrier's own phase, so a recipe running both paths has one alignment.
  const turned = createState();
  turned.carrierPhase = 0.25;
  const quadrature = renderOffline(params, sampleRate, frames, 0, turned);

  return (['left', 'right'] as const).map((side) => ({
    held: silence,
    inPhase: reference[side],
    quadrature: quadrature[side],
  }));
}

function isSilent(signal: Float64Array, n: number): boolean {
  for (let i = 0; i < n; i += 1) if (signal[i] !== 0) return false;
  return true;
}

/** The worst squared ratio between two sets of squared band levels. */
function worstBandRatioSquared(measured: Float64Array, reference: Float64Array): number {
  let peak = 0;
  for (const value of reference) if (value > peak) peak = value;
  // Bands more than 40 dB below the loudest are where quantisation and window
  // skirts live; both sides clamp there, so absent compares equal to absent.
  const floor = peak * 1e-4;

  let worst = 1;
  for (let k = 0; k < reference.length; k += 1) {
    const a = Math.max(measured[k], floor);
    const b = Math.max(reference[k], floor);
    const ratio = a > b ? a / b : b / a;
    if (ratio > worst) worst = ratio;
  }
  return worst;
}

/**
 * The worst disagreement between the capture and its reference, across the
 * spectrum, in dB.
 *
 * The check that notices content in the wrong *place*. Everything else here
 * asks about levels and shapes, and a tone at the wrong frequency satisfies all
 * of them: in a dichotic pair the right ear's tone can move from 260 Hz to
 * 440 Hz at exactly the same level, leaving correlation, balance, side-to-mid
 * and the left channel's own metrics untouched — while the beat the listener
 * came for is no longer 40 Hz, or no longer exists.
 *
 * Against the reference as turned, never against the best of all the turns it
 * could take. Searching for the closest alignment is what let a displaced tone
 * hide: with AM and a dichotic pair together, the right ear's tone moved onto an
 * AM harmonic — 260 to 300 Hz, an 80 Hz beat — and turning the carrier absorbed
 * it, from 9.7 dB against the render to 7.0 dB against the closest turn, under
 * the tolerance. Which alignment is playing is not the spectrum's to choose:
 * the waveform says, and this asks what that one implies.
 */
function spectralDeviationDb(measured: Float64Array[], reference: Float64Array[]): number {
  const n = Math.min(
    ...measured.map((m, i) => prevPowerOfTwo(Math.min(m.length, reference[i].length))),
  );
  if (n < 2 * BINS_PER_BAND) return 0;
  const squared = (signal: Float64Array) => bandEnergies(signal, n).map((v) => v * v);
  let worst = 1;
  for (const [i, m] of measured.entries()) {
    worst = Math.max(worst, worstBandRatioSquared(squared(m), squared(reference[i])));
  }
  // Squared ratios, so ten rather than twenty.
  return 10 * Math.log10(worst);
}

/**
 * The longest window the alignment work is done for.
 *
 * Every rate the Modulation slider reaches, 20 to 60 Hz, asks for 2^16 frames
 * at 44.1 and 48 kHz and 2^17 at 96 kHz, so nothing the controls can make is
 * past this. Beyond it are recipes only a hand-edited preset holds, down to
 * 1 Hz — below that the capture ring's eight seconds cannot hold eight periods
 * and the window is refused before anything is rendered. There the alignment
 * costs a pass 0.14 s and 55 MB against 0.25 s and 106 MB at 48 kHz, and 0.26 s
 * and 96 MB against 0.47 s and 193 MB at 96 kHz, on the renderer's thread —
 * measured with the cap lifted. Past the cap those windows
 * are compared against the phase-zero render, as they were before alignment
 * existed, with the false warnings on folded carriers that implies; a recipe
 * that slow was never offered.
 */
export const ALIGNMENT_MAX_FRAMES = 1 << 17;

/** One reference part's window, starting `offset` frames in. */
function windowOf(part: AlignedReference, offset: number, frames: number): AlignedReference {
  return {
    held: part.held.subarray(offset, offset + frames),
    inPhase: part.inPhase.subarray(offset, offset + frames),
    quadrature: part.quadrature.subarray(offset, offset + frames),
  };
}

/**
 * The carrier alignment the capture actually has, and where it started, read
 * from its waveform.
 *
 * Magnitude spectra cannot always say. A capture is the reference turned to
 * some alignment and started somewhere in its modulation period, so it should
 * be `a·inPhase + b·quadrature` (with the tones alongside) read from some
 * offset into the reference. For each offset in one period, least squares
 * gives `a` and `b` and how much of the capture they explain; the offset that
 * explains most is where the window started, and `atan2(b, a)` is the
 * alignment. Offsets beyond one period add nothing: a whole period later the
 * envelope is where it was and only the carrier has moved, which is the
 * alignment's to absorb.
 *
 * Every offset at once, by cross-correlation through the transform: the
 * capture against each reference part, and the parts against each other by
 * running sums. The two ears carry the same AM path, so their sum is fitted.
 * The fit is over all but the last `lead` frames of the capture, so every
 * offset has reference to read from.
 *
 * Only the angle and the offset are taken from it, never the amplitudes. A
 * fitted amplitude would scale the reference towards whatever the capture
 * holds — a tone that lost its level included — and the readings compare
 * shapes precisely so that level cannot hide a fault.
 *
 * With no AM path there is no angle to find, and the tones alone still place
 * the window.
 *
 * A fractional start is left at the nearest sample, which is not exact: where
 * the modulation period is not a whole number of samples, a hard-gated edge can
 * land half a sample from where the capture has it, and a 5% square on 80 Hz at
 * 22.05 kHz leaves 4.9% of its energy unexplained that way. It moves no reading
 * past its tolerance — the sweeps recorded in `measureEntrainment` include that
 * case — but it is why the fit's residual cannot double as a verdict: some
 * faults leave less than that.
 *
 * **What it gives up.** A capture that matches no alignment is still compared
 * at the one that explains it best, and a less modulated reference is the one
 * that explains an unmodulated capture best. So in the corner where alignment
 * alone swings the readings by more than a fault does — shallow modulation on
 * a carrier at a whole multiple of the rate — some faults read as a legitimate
 * alignment: a 10% pulse on 120 Hz at 60 Hz with its modulation removed passes,
 * where the phase-zero reference flagged it on the sidebands. That reference
 * also flagged half of the healthy captures there, and the readings of the
 * unmodulated capture fall inside the range the healthy alignments produce, so
 * no reference built from correct output could have told them apart at these
 * tolerances. At 40% depth, or with a hard 5% pulse, detection is unchanged.
 */
function waveformAlignment(
  measured: Float64Array[],
  aligned: AlignedReference[],
  frames: number,
  lead: number,
  params: EntrainmentParams,
): { angle: number; offset: number } {
  const period = lead;
  const span = frames - period;

  // The fit reads only the first `frames` of each part: the capture's span plus
  // the furthest offset. The extra period rendered past that is for the window
  // cut afterwards, and keeping it out keeps the transform at the capture's size.
  const sum = (pick: (channel: number) => Float64Array, length = frames) => {
    const out = new Float64Array(length);
    for (let c = 0; c < measured.length; c += 1) {
      const from = pick(c);
      for (let i = 0; i < length; i += 1) out[i] += from[i];
    }
    return out;
  };
  const capture = sum((c) => measured[c]);
  const hasAm = params.amGain > 0;
  const parts = [
    ...(hasAm ? [sum((c) => aligned[c].inPhase), sum((c) => aligned[c].quadrature)] : []),
    sum((c) => aligned[c].held),
  ].filter((part) => !isSilent(part, frames));
  if (parts.length === 0 || period < 1) return { angle: 0, offset: 0 };

  let size = 1;
  while (size < frames) size *= 2;
  const transform = (signal: Float64Array, length: number) => {
    const re = new Float64Array(size);
    re.set(signal.subarray(0, length));
    const im = new Float64Array(size);
    fft(re, im);
    return { re, im };
  };

  // Σ capture[i]·part[i + offset] over the span, for every offset.
  const x = transform(capture, span);
  const correlations = parts.map((part) => {
    const z = transform(part, frames);
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let k = 0; k < size; k += 1) {
      re[k] = x.re[k] * z.re[k] + x.im[k] * z.im[k];
      im[k] = x.re[k] * z.im[k] - x.im[k] * z.re[k];
    }
    ifft(re, im);
    return re;
  });

  // Σ part_j·part_k over the span starting at each offset, from running sums.
  const running = (a: Float64Array, b: Float64Array) => {
    const out = new Float64Array(frames + 1);
    for (let i = 0; i < frames; i += 1) out[i + 1] = out[i] + a[i] * b[i];
    return out;
  };
  const r = parts.length;
  const gram: Float64Array[][] = parts.map((a, j) =>
    parts.map((b, k) => (k >= j ? running(a, b) : new Float64Array(0))),
  );

  let bestExplained = -Infinity;
  let best = { angle: 0, offset: 0 };
  const g = new Float64Array(r * r);
  const v = new Float64Array(r);
  for (let offset = 0; offset <= period; offset += 1) {
    for (let j = 0; j < r; j += 1) {
      v[j] = correlations[j][offset];
      for (let k = j; k < r; k += 1) {
        const value = gram[j][k][offset + span] - gram[j][k][offset];
        g[j * r + k] = value;
        g[k * r + j] = value;
      }
    }
    const solved = solveSymmetric(g, v, r);
    if (solved === null) continue;
    let explained = 0;
    for (let j = 0; j < r; j += 1) explained += solved[j] * v[j];
    if (explained > bestExplained) {
      bestExplained = explained;
      best = { angle: hasAm ? Math.atan2(solved[1], solved[0]) : 0, offset };
    }
  }
  return best;
}

/** `g·x = v` for a small symmetric `g`, or null when it is singular. */
function solveSymmetric(g: Float64Array, v: Float64Array, r: number): Float64Array | null {
  const a = Float64Array.from(g);
  const x = Float64Array.from(v);
  for (let col = 0; col < r; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < r; row += 1) {
      if (Math.abs(a[row * r + col]) > Math.abs(a[pivot * r + col])) pivot = row;
    }
    const scale = Math.abs(a[pivot * r + pivot]);
    if (!(scale > 1e-12 * Math.max(1, Math.abs(a[0])))) return null;
    if (pivot !== col) {
      for (let k = 0; k < r; k += 1) {
        [a[col * r + k], a[pivot * r + k]] = [a[pivot * r + k], a[col * r + k]];
      }
      [x[col], x[pivot]] = [x[pivot], x[col]];
    }
    for (let row = 0; row < r; row += 1) {
      if (row === col) continue;
      const factor = a[row * r + col] / a[col * r + col];
      for (let k = col; k < r; k += 1) a[row * r + k] -= factor * a[col * r + k];
      x[row] -= factor * x[col];
    }
  }
  for (let j = 0; j < r; j += 1) x[j] /= a[j * r + j];
  return x;
}

/**
 * The reference rendered where the capture actually started, to a fraction of a
 * sample.
 *
 * `waveformAlignment` places the window to the nearest sample, and for most
 * recipes that is exact enough. It is not for a hard-gated pulse a few samples
 * wide. The engine decides which samples a pulse covers from where its
 * modulator's phase falls between them, and a live capture's modulator starts
 * at any real phase — so a reference started a whole sample away can gate a
 * different set of samples on every edge. At 2% duty, which `sanitizeParams`
 * admits whatever the Duty slider's floor, 57 of 600 healthy captures across
 * 22.05 to 48 kHz read their spectrum past the tolerance, up to 15 dB, against
 * a whole-sample reference.
 *
 * So the reference is rendered from a state rather than cut from a render. The
 * modulator's phase is tried across a sample either side of where the fit put
 * it, each candidate rendered as a quarter-cycle pair and scored by how much of
 * a short stretch of the capture that pair explains at its own best angle. The
 * fitted carrier is only where the pairs start, not what they are judged at: a
 * low carrier under a narrow pulse carries too little energy to pin it, and one
 * capture's came out 37 degrees from the truth — enough, judged there, for the
 * wrong candidate to win and the spectrum to read 6.8 dB. The best candidate is
 * rendered in full, and the angle read again over the whole window.
 *
 * Judged on the waveform, like the alignment it refines — never on the
 * spectrum it will be compared by. A shift of under a sample moves where a
 * pulse's edges fall; it cannot move a tone to another frequency, so it has
 * nothing to hide a displaced tone with.
 *
 * The tones need nothing of their own here: the engine starts them from the
 * carrier's and the modulator's phases, so a render from this state starts
 * them where the capture has them.
 */
function fractionalReference(
  measured: Float64Array[],
  params: EntrainmentParams,
  sampleRate: number,
  frames: number,
  found: { angle: number; offset: number },
): { left: Float64Array; right: Float64Array } {
  const wrap = (phase: number) => phase - Math.floor(phase);
  const carrierPhase = wrap(
    (found.offset * params.carrierHz) / sampleRate + found.angle / (2 * Math.PI),
  );
  const modulatorPhase = (found.offset * params.modulationHz) / sampleRate;
  const perSample = params.modulationHz / sampleRate;

  // At least two modulation periods, so every candidate is judged on whole pulses.
  const probe = Math.min(
    frames,
    Math.max(FRACTIONAL_PROBE_FRAMES, Math.ceil((2 * sampleRate) / params.modulationHz)),
  );
  const sum = (a: Float64Array, b: Float64Array, length: number) => {
    const out = new Float64Array(length);
    for (let i = 0; i < length; i += 1) out[i] = a[i] + b[i];
    return out;
  };
  const capture = sum(measured[0], measured[1], frames);

  const pair = (render: { left: Float64Array; right: Float64Array }) =>
    [render.left, render.right] as const;
  const renderFrom = (carrier: number, modulator: number, length: number) => {
    const state = createState();
    state.carrierPhase = wrap(carrier);
    state.modPhase = wrap(modulator);
    return renderOffline(params, sampleRate, length, 0, state);
  };

  let bestModulator = modulatorPhase;
  let bestScore = -Infinity;
  for (let k = 0; k < FRACTIONAL_STEPS; k += 1) {
    const shift = (2 * k) / FRACTIONAL_STEPS - 1;
    const modulator = modulatorPhase + shift * perSample;
    // Each candidate gets its own angle, from a quarter-cycle pair: the fitted
    // carrier is least reliable exactly where this matters, a low carrier under
    // a narrow pulse, and a candidate judged at the wrong angle can lose to a
    // wrong one judged at a luckier one.
    const y = sum(...pair(renderFrom(carrierPhase, modulator, probe)), probe);
    const z = sum(...pair(renderFrom(carrierPhase + 0.25, modulator, probe)), probe);
    const score = explained(capture, y, z, probe).energy;
    if (score > bestScore) [bestScore, bestModulator] = [score, modulator];
  }

  // The angle again, against the chosen edges and over the whole window.
  const inPhase = renderFrom(carrierPhase, bestModulator, frames);
  const quadrature = renderFrom(carrierPhase + 0.25, bestModulator, frames);
  const { angle } = explained(
    capture,
    sum(inPhase.left, inPhase.right, frames),
    sum(quadrature.left, quadrature.right, frames),
    frames,
  );
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const turn = (x: Float64Array, y: Float64Array) => {
    const out = new Float64Array(frames);
    for (let i = 0; i < frames; i += 1) out[i] = c * x[i] + s * y[i];
    return out;
  };
  return {
    left: turn(inPhase.left, quadrature.left),
    right: turn(inPhase.right, quadrature.right),
  };
}

/**
 * How much of `x` the pair `p`, `q` explains at their best combination, and the
 * angle of that combination: `x ≈ a·p + b·q`, energy `v·g⁻¹·v`, angle `atan2(b, a)`.
 * Energy rather than residual, so the capture's level cannot choose.
 */
function explained(
  x: Float64Array,
  p: Float64Array,
  q: Float64Array,
  length: number,
): { energy: number; angle: number } {
  let pp = 0;
  let qq = 0;
  let pq = 0;
  let xp = 0;
  let xq = 0;
  for (let i = 0; i < length; i += 1) {
    pp += p[i] * p[i];
    qq += q[i] * q[i];
    pq += p[i] * q[i];
    xp += x[i] * p[i];
    xq += x[i] * q[i];
  }
  const determinant = pp * qq - pq * pq;
  if (!(determinant > 0)) return { energy: -Infinity, angle: 0 };
  const a = (xp * qq - xq * pq) / determinant;
  const b = (xq * pp - xp * pq) / determinant;
  return { energy: a * xp + b * xq, angle: Math.atan2(b, a) };
}

/**
 * Candidates across a whole sample either side of the fitted start, and how
 * much of the capture scores them.
 *
 * A whole sample, not half: the whole-sample fit can itself be most of a sample
 * out — 0.68 in one capture, where a half-sample search left it reading 8.3 dB.
 * Over 600 healthy 2%-duty captures (22.05 to 48 kHz, carriers 80 Hz to 1 kHz,
 * hard and tapered edges, five alignments, three window starts) the worst
 * spectrum reading is 0.8 dB with 64 candidates on 4,096 frames, the same as on
 * 8,192, and 1.0 dB with 32. Against a whole-sample reference it was 15 dB, and
 * 57 of them warned.
 */
const FRACTIONAL_STEPS = 64;
const FRACTIONAL_PROBE_FRAMES = 4096;

/**
 * Both channels of the reference, turned to `angle`.
 *
 * Exact over the whole window, not only the power-of-two span the spectrum
 * read: the combination is sample by sample, the same one the spectrum's
 * quadratic forms describe.
 */
function referenceAt(
  aligned: AlignedReference[],
  angle: number,
): { left: Float64Array; right: Float64Array } {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const [left, right] = aligned.map(({ held, inPhase, quadrature }) => {
    const out = new Float64Array(held.length);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = held[i] + c * inPhase[i] + s * quadrature[i];
    }
    return out;
  });
  return { left, right };
}

/**
 * How loud the right channel is against the left, in dB.
 *
 * The check that catches a dichotic pair losing an ear, which nothing else
 * here does. Two tones one per ear are orthogonal, so their correlation is
 * near zero whatever their levels; and side-to-mid stays at 0 dB for
 * orthogonal content however lopsided it is, because halving one channel
 * scales the sum and the difference by the same amount. Silencing the right
 * channel therefore left every other metric untouched while destroying the
 * beat entirely — the graph declared healthy for a signal that no longer had
 * anything for the second ear.
 *
 * Scale-invariant to overall gain, since it is a ratio between the channels.
 */
function channelBalanceDb(left: Float64Array, right: Float64Array): number {
  const leftEnergy = rms(left);
  const rightEnergy = rms(right);
  // Both silent is a question for the entrainment-level check above, not here.
  if (leftEnergy < SILENCE_FLOOR && rightEnergy < SILENCE_FLOOR) return 0;
  if (leftEnergy < SILENCE_FLOOR) return -RATIO_FLOOR_DB;
  return ratioDb(rightEnergy / leftEnergy);
}

function sideToMidDb(left: Float64Array, right: Float64Array): number {
  const n = Math.min(left.length, right.length);
  const side = new Float64Array(n);
  const mid = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    side[i] = (left[i] - right[i]) / 2;
    mid[i] = (left[i] + right[i]) / 2;
  }
  const midEnergy = rms(mid);
  if (midEnergy < SILENCE_FLOOR) return 0;
  return ratioDb(rms(side) / midEnergy);
}

/**
 * Whether the envelope is running at the rate it was asked to.
 *
 * Only meaningful when there is an envelope to time. Below
 * `MIN_MODULATION_INDEX` the dominant peak of the envelope's spectrum is
 * whichever pile of numerical residue happened to be largest, and comparing
 * two of those is not a measurement.
 *
 * The three cases are genuinely different, and collapsing them was a bug worth
 * recording. **Neither side has an envelope** — which is what the Binaural
 * preset asks for, since a dichotic pair carries its beat in the difference
 * between the ears and neither ear is modulated at all — is a *match*, and
 * passes. Reporting it as inconclusive made every healthy binaural session
 * record `unknown`, because one unknown among checked findings is what
 * `recordedStatus` reports.
 *
 * **One side has one and the other does not** is a real disagreement, but the
 * depth comparison beside this one already states it; timing a flat signal
 * would add a frequency read off noise to a warning that is already correct.
 */
function envelopeRateFinding(
  measured: EnvelopeMetrics,
  expected: EnvelopeMetrics,
  params: EntrainmentParams,
): Finding {
  const flatMeasured = measured.index < MIN_MODULATION_INDEX;
  const flatExpected = expected.index < MIN_MODULATION_INDEX;

  if (flatMeasured && flatExpected) {
    return checkedFinding({
      id: 'graph-envelope-frequency',
      scope: 'graph',
      status: 'ok',
      title: 'Envelope rate',
      // Neutral about what was looked at, because only one channel's envelope
      // was measured, and about what was found: a very shallow modulation does
      // have an envelope, it is simply not deep enough to time. The routing
      // note is added only where it is true.
      detail:
        `No measurable envelope in the analysed channel, and none in the reference either.` +
        (params.twoToneMode === 'dichotic'
          ? ' A dichotic pair carries its beat between the ears rather than within one.'
          : ''),
    });
  }

  if (flatMeasured || flatExpected) {
    return inconclusive(
      'graph-envelope-frequency',
      'Envelope rate',
      `One of the two has an envelope and the other does not, so there is no shared rate to compare. The depth reading beside this says which.`,
    );
  }

  return compare(
    'graph-envelope-frequency',
    'Envelope rate',
    measured.frequencyHz,
    expected.frequencyHz,
    Math.max(TOLERANCE.envelopeFrequencyHz, params.modulationHz * TOLERANCE.envelopeFrequency),
    ' Hz',
  );
}

/** How wide each comparison band is, given the window this analysis will use. */
function bandWidthHz(frames: number, sampleRate: number): number {
  const n = prevPowerOfTwo(frames);
  return n < 2 ? Infinity : (BINS_PER_BAND * sampleRate) / n;
}

/**
 * The spectrum finding, which has to say what it could have seen.
 *
 * Resolution decides everything, and it is checked first. A coarse window is
 * not merely blind to small faults, it invents large ones — a healthy 81 Hz
 * carrier at the shortest accepted length reads over 12 dB from window phase
 * alone. So below the resolution this needs, nothing is claimed in either
 * direction: not a warning, which would be about correct output, and not an
 * `ok`, which would be a check that could not have failed.
 */
function spectrumFinding(deviationDb: number, bandHz: number): Finding {
  // Resolution first. A coarse window does not merely miss small faults, it
  // manufactures large deviations: a healthy 81 Hz carrier captured at the
  // shortest accepted length reads 12.2 dB from window phase alone, past the
  // tolerance. Judging the deviation before knowing whether it can be trusted
  // turned that into a warning about correct output.
  if (bandHz > TOLERANCE.spectrumBandHz) {
    return inconclusive(
      'graph-spectrum',
      'Spectral match',
      `This window only resolves ${bandHz.toFixed(1)} Hz bands, which is too coarse to tell a real difference from where the capture happened to start. A longer capture would settle it.`,
    );
  }

  if (deviationDb > TOLERANCE.spectrumDb) {
    return checkedFinding({
      id: 'graph-spectrum',
      scope: 'graph',
      status: 'warning',
      title: 'Spectral match',
      detail: `Worst band differs from the reference render by ${deviationDb.toFixed(1)} dB, past the ${TOLERANCE.spectrumDb} dB tolerance.`,
    });
  }

  return checkedFinding({
    id: 'graph-spectrum',
    scope: 'graph',
    status: 'ok',
    title: 'Spectral match',
    detail: `Matches the reference render to within ${deviationDb.toFixed(1)} dB, across ${bandHz.toFixed(1)} Hz bands.`,
  });
}

/**
 * Sideband-to-carrier ratio at `carrierHz ± modulationHz`.
 *
 * Read from the configuration rather than assuming 40 Hz on 220: the carrier is
 * a slider and the rate is a parameter, so a probe at a fixed frequency would
 * measure the wrong bins the moment either moved — and would then report a
 * confident absence of sidebands that are present exactly where they should be.
 *
 * Expressed as a ratio to the carrier because it is the modulation this is
 * asking about, and a ratio survives the gain between the source and the tap.
 */
function sidebandFinding(
  measured: Float64Array,
  reference: Float64Array,
  sampleRate: number,
  params: EntrainmentParams,
): Finding {
  const db = ratioDb;
  const lowerHz = params.carrierHz - params.modulationHz;
  const upperHz = params.carrierHz + params.modulationHz;

  const referenceCarrier = amplitudeAt(reference, sampleRate, params.carrierHz);
  if (referenceCarrier < SILENCE_FLOOR) {
    // The parameters themselves put nothing at the carrier — the AM path is
    // turned down, say — so there is nothing to hold the capture against.
    return inconclusive(
      'graph-sidebands',
      'Sidebands',
      `These parameters put no carrier at ${params.carrierHz} Hz, so the sidebands cannot be judged.`,
    );
  }

  const measuredCarrier = amplitudeAt(measured, sampleRate, params.carrierHz);
  if (measuredCarrier < SILENCE_FLOOR) {
    // Affirmative evidence, not an absence of it. The reference has a carrier
    // here and the capture is not silent — something is playing, and it is not
    // what the configuration describes. Reporting that as inconclusive let a
    // graph running an entirely different carrier read as three passes and a
    // shrug.
    return checkedFinding({
      id: 'graph-sidebands',
      scope: 'graph',
      status: 'warning',
      title: 'Sidebands',
      detail: `Nothing at the configured carrier of ${params.carrierHz} Hz, though the output is not silent.`,
    });
  }

  /** Each sideband against the carrier, in dB. Judged apart, see below. */
  const ratios = (signal: Float64Array, carrier: number) => ({
    lower: db(amplitudeAt(signal, sampleRate, lowerHz) / carrier),
    upper: db(amplitudeAt(signal, sampleRate, upperHz) / carrier),
  });

  const expected = ratios(reference, referenceCarrier);
  const actual = ratios(measured, measuredCarrier);

  // Compared separately and judged on the worse of the two. Averaging them
  // first — which this did — lets one sideband vanish while the other doubles
  // and leaves the mean untouched: a spectrum that is audibly and structurally
  // wrong, passing.
  //
  // `fc - modulationHz` can fall at or below zero for a very low carrier,
  // where there is no such bin to read; the upper one then carries the finding
  // alone rather than the whole check reporting nothing.
  const upperOff = Math.abs(actual.upper - expected.upper);
  const lowerOff = lowerHz > 0 ? Math.abs(actual.lower - expected.lower) : 0;
  const off = Math.max(upperOff, lowerOff);
  const within = off <= TOLERANCE.sidebandDb;

  const describe = (side: 'lower' | 'upper', hz: number): string =>
    `${hz.toFixed(0)} Hz at ${actual[side].toFixed(1)} dB against ${expected[side].toFixed(1)} dB`;
  const both =
    lowerHz > 0
      ? `${describe('lower', lowerHz)}, ${describe('upper', upperHz)}`
      : describe('upper', upperHz);

  return checkedFinding({
    id: 'graph-sidebands',
    scope: 'graph',
    status: within ? 'ok' : 'warning',
    title: 'Sidebands',
    detail: within
      ? `${both}, both within the reference render.`
      : `${both} — off by ${off.toFixed(1)} dB, past the ${TOLERANCE.sidebandDb} dB tolerance.`,
  });
}

export interface MasterOptions {
  /**
   * The peak the graph guarantees it will not exceed.
   *
   * Passed in rather than imported: the constant lives in `graph.ts`, which
   * owns an AudioContext, and this module is meant to run anywhere.
   */
  ceiling: number;
  /**
   * The configured modulation rate, in Hz.
   *
   * Blocks are two periods long, so this sets how finely a stall is located —
   * and at 0.5 Hz a two-second window holds too few of them to say anything.
   */
  modulationHz: number;
}

/**
 * Bounds on the master tap. No oracle, by necessity.
 *
 * **Precondition: the window must lie wholly within steady playback.** The tap
 * sits after the playback envelope, so ramp-in, ramp-out and stopping all
 * attenuate it legitimately — a window overlapping one would show a low peak
 * or silence from a graph doing exactly what it was asked. Epochs do not help,
 * because a session fade is not a configuration change. Deciding that is the
 * caller's job, since only it knows the envelope's schedule.
 */
export function measureMaster(capture: Capture, options: MasterOptions): Finding[] {
  const left = toFloat64(capture.left);
  const right = toFloat64(capture.right);

  const invalid = nonFiniteFinding('graph-master-validity', left, right);
  if (invalid !== null) return [invalid];

  const peak = Math.max(peakLevel(left), peakLevel(right));

  const findings: Finding[] = [];

  // Peak answers the headroom question below; block coverage answers this one.
  const active = activeFraction(left, right, peak, capture.sampleRate, options.modulationHz);
  const silent = peak < SILENCE_FLOOR;
  const intermittent = !silent && active !== null && active < MIN_ACTIVE_FRACTION;
  // Too short to judge is inconclusive, not a pass. Saying `ok` while the
  // detail admitted it could not tell continuous output from a single burst
  // was the model's own distinction, broken in the one place it matters most.
  // The caller can avoid this entirely by sizing the window from the rate:
  // `MIN_BLOCKS * PERIODS_PER_BLOCK` periods is enough at any rate.
  const inconclusiveContinuity = !silent && active === null;
  findings.push(
    checkedFinding({
      id: 'graph-master-signal',
      scope: 'graph',
      status: silent || intermittent ? 'warning' : inconclusiveContinuity ? 'unknown' : 'ok',
      title: 'Output level',
      detail: silent
        ? 'The master bus was silent while the session was playing.'
        : intermittent
          ? `Only ${(active * 100).toFixed(0)}% of the window carried signal, at a peak of ${peak.toFixed(3)} — the output is not playing continuously.`
          : active === null
            ? `Peak ${peak.toFixed(3)} at the master bus. The window is too short at ${options.modulationHz} Hz to tell continuous output from a single burst.`
            : `Peak ${peak.toFixed(3)} at the master bus, across ${(active * 100).toFixed(0)}% of the window.`,
    }),
  );

  const overshoot = options.ceiling * TOLERANCE.ceilingOvershoot;
  const clipping = peak >= 1;
  findings.push(
    checkedFinding({
      id: 'graph-master-headroom',
      scope: 'graph',
      // Clipping is a fault the listener can hear; merely passing the app's own
      // ceiling is a broken guarantee that may still sound fine.
      status: clipping ? 'failed' : peak > overshoot ? 'warning' : 'ok',
      title: 'Headroom',
      detail: clipping
        ? `Peak ${peak.toFixed(3)} reached full scale, so the output is clipping.`
        : peak > overshoot
          ? `Peak ${peak.toFixed(3)} is above the ${options.ceiling} ceiling the graph guarantees.`
          : `Peak ${peak.toFixed(3)}, within the ${options.ceiling} ceiling.`,
    }),
  );

  return findings;
}
