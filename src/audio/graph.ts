/**
 * Web Audio graph construction.
 *
 *   EntrainmentProcessor (worklet, stereo)
 *       AM path       carrier x envelope     -> diotic
 *       two-tone path fc and fc + fMod       -> dichotic or diotic
 *                                  |
 *                                  +--> entrainmentGain --+
 *                                                         |
 *   NoiseProcessor (worklet) -> notch(fc-fMod, fc, fc+fMod) -> soundscapeGain --+
 *                                                         |
 *                                                   envelopeGain   ramps only
 *                                                         |
 *                                                    masterBus     level only
 *                                                         |
 *                                              DynamicsCompressor
 *                                                         |
 *                                                   AnalyserNode
 *                                                         |
 *                                             AudioContext.destination
 *
 * Deviation from the source specification: rather than wiring several
 * OscillatorNodes and a GainNode VCA driven by parameter automation, both
 * generation paths are synthesised inside one worklet from a single sample
 * counter. Phase is then exact and reproducible, and the whole engine is
 * verifiable offline without a browser.
 *
 * Worklet module URLs are injected rather than imported, so this file has no
 * bundler coupling.
 */

import {
  DEFAULT_PARAMS,
  SOURCE_SETTLE_SECONDS,
  type EntrainmentParams,
} from './dsp/entrainment-core.ts';
import { notchPeakGain, notchSettleSeconds } from './dsp/biquad.ts';
import type { NoiseColor } from './dsp/noise.ts';
import {
  DEFAULT_MASTER_LEVEL,
  DEFAULT_SOUNDSCAPE,
  type SoundscapeOptions,
} from './configuration.ts';
import {
  cancelSessionEnvelope,
  scheduleOpenEnvelope,
  scheduleSessionEnvelope,
} from './session-envelope.ts';
import { TransitionQueue } from './transitions.ts';
import { CaptureTap } from '../integrity/capture-client.ts';
import {
  NEVER_STEADY,
  deferSteady,
  endSteady,
  openSteady,
  sessionSteady,
  type SteadyWindow,
} from './steady-window.ts';

// The soundscape model lives in configuration.ts so the coordinator and the
// main process can reach it without importing this file. Re-exported because
// callers that already hold a graph reasonably expect to find it here.
export { DEFAULT_SOUNDSCAPE, type SoundscapeOptions };

/**
 * 48000 / 40 = 1200 samples exactly; 44100 / 40 = 1102.5. The engine is
 * correct at either rate, but 48 kHz keeps the modulation period aligned to
 * sample boundaries. Verify `context.sampleRate` after construction — the
 * request is a hint, and the OS mixer may resample regardless.
 */
export const PREFERRED_SAMPLE_RATE = 48000;

/**
 * Why the capture rings were emptied.
 *
 * `configuration` is a control moving: a window straddling it would be
 * compared against settings that were not in force while most of it played.
 * `transport` is playback starting or stopping, which whoever owns playback
 * already knows about.
 */
export type EpochReason = 'configuration' | 'transport';

/**
 * How much audio each capture tap keeps.
 *
 * Long enough for every window the checks ask for at ordinary rates — 1.4
 * seconds resolves the spectrum, and continuity wants eight modulation periods,
 * which is under a second above 8 Hz. Not long enough for the slowest the
 * engine permits: eight periods at 0.5 Hz is sixteen seconds, and rounded up to
 * a power of two that is 2,097,152 frames, or 21.8 seconds at 96 kHz. Two
 * stereo rings of that at four bytes a sample is 33.6 MB, in an app whose entire
 * payload is under half a megabyte.
 *
 * So the caller caps its request at `captureCapacityFrames` and the findings
 * degrade honestly — continuity says the window was too short to judge, rather
 * than the request being refused outright and the check reporting nothing at
 * all. `window-too-long` should never reach a caller that respects the cap.
 */
export const CAPTURE_RING_SECONDS = 8;

/** How long the master gain takes to reach new headroom after a change. */
const HEADROOM_RAMP_SECONDS = 0.05;

/**
 * How long the master bus is given to attenuate *before* a change that needs
 * more headroom takes effect.
 *
 * This is also how long the master has to reach its new level, since the
 * attenuation must land before the change it guards. Eight milliseconds was
 * enough to be *correct* and nowhere near enough to be inaudible: a gain step
 * that fast is a click, and it was heard at the start of every press. Fifty is
 * long enough to pass unnoticed and short enough that a control does not feel
 * laggy — the configuration it carries lands at the end of it.
 *
 * The actual landing is rounded up from here to a render quantum, so this is a
 * floor rather than the exact figure.
 */
const GUARD_RAMP_SECONDS = 0.05;

/**
 * How long the master takes to climb back once the guard releases.
 *
 * Longer than the guard, because it has no deadline: a reduction has to land
 * before the change it protects, while an increase can take as long as it
 * likes. Both were the guard's length until a listening pass found the step at
 * each end of a press audible — a level change over a few milliseconds is a
 * click however small it is.
 */
const MASTER_RESTORE_SECONDS = 0.15;

/**
 * The render quantum, in frames.
 *
 * Fixed at 128 by the Web Audio specification, and it matters here rather than
 * as trivia: an AudioParam is sample-accurate while an AudioWorklet can only
 * act on a quantum boundary, so a configuration split across the two lands at
 * two different instants unless the boundary is chosen deliberately.
 */
const RENDER_QUANTUM = 128;

/**
 * A gain ramp is never instant.
 *
 * A ramp ending where it starts is a step, and a step on a gain is a click, so
 * the shortest one is a millisecond. Everything that schedules a ramp *and*
 * reasons about when it finishes has to agree on that figure.
 */
function rampDuration(seconds: number): number {
  return Math.max(0.001, seconds);
}

/**
 * Hard ceiling on master output, independent of the UI control.
 *
 * Sessions run for 45-60 minutes, so the risk is cumulative exposure rather
 * than a single loud moment. This is a ceiling on the *output peak*, not a
 * multiplier on the source sum — see `headroomScale`, which is what makes that
 * true. Keeping the peak below the limiter threshold is what keeps gain
 * reduction from ever imposing its own amplitude modulation on top of the
 * 40 Hz envelope.
 */
export const MAX_MASTER_LEVEL = 0.8;

/**
 * Limiter threshold in dB, set above `MAX_MASTER_LEVEL` (-1.94 dBFS) so it sits
 * strictly above anything the ceiling permits.
 *
 * The limiter is a backstop for a fault, not part of the signal path. If it
 * ever engages, something upstream has broken the headroom guarantee.
 */
const LIMITER_THRESHOLD_DB = -1;

/** Parameters the headroom bound reads. */
type HeadroomParams = Pick<
  EntrainmentParams,
  'amGain' | 'twoToneGain' | 'twoToneMode' | 'carrierHz' | 'modulationHz'
>;
type HeadroomSoundscape = Pick<SoundscapeOptions, 'gain' | 'notchQ' | 'notchDepthDb'>;

/**
 * The terms of a source peak bound, kept apart so each can be maximised
 * separately across configurations.
 */
interface SourceEnvelope {
  amGain: number;
  twoToneGain: number;
  twoToneActive: boolean;
  /** The bed's full contribution: its gain through a notch chain's peak gain. */
  bed: number;
  /**
   * The bed's gain alone, without any notch bound.
   *
   * Kept apart because the two are needed in different places. Bounding a
   * transition between two *configurations* uses `bed`, since each would bring
   * its own chain. Bounding what is sounding uses this, multiplied by the
   * largest bound among the chains actually live — which diverges from the
   * configurations once rebuilds are coalesced.
   */
  bedGain: number;
}

function envelopeOf(configuration: BoundedConfiguration, sampleRate: number): SourceEnvelope {
  return {
    amGain: configuration.params.amGain,
    twoToneGain: configuration.params.twoToneGain,
    twoToneActive: configuration.params.twoToneMode !== 'off',
    bed: bedTerm(configuration, sampleRate),
    bedGain: configuration.soundscape.gain,
  };
}

function mergeEnvelopes(a: SourceEnvelope, b: SourceEnvelope): SourceEnvelope {
  return {
    amGain: Math.max(a.amGain, b.amGain),
    twoToneGain: Math.max(a.twoToneGain, b.twoToneGain),
    twoToneActive: a.twoToneActive || b.twoToneActive,
    bed: Math.max(a.bed, b.bed),
    bedGain: Math.max(a.bedGain, b.bedGain),
  };
}

function envelopePeak(envelope: SourceEnvelope): number {
  return envelope.amGain + (envelope.twoToneActive ? envelope.twoToneGain : 0) + envelope.bed;
}

/** A configuration, for the purposes of bounding a transition between two. */
export interface BoundedConfiguration {
  params: HeadroomParams;
  soundscape: HeadroomSoundscape;
}

/** The bed's contribution: its gain through the notch chain's peak gain. */
function bedTerm(configuration: BoundedConfiguration, sampleRate: number): number {
  return (
    configuration.soundscape.gain *
    notchPeakGain(
      configuration.params.carrierHz,
      configuration.params.modulationHz,
      configuration.soundscape.notchQ,
      configuration.soundscape.notchDepthDb,
      sampleRate,
    )
  );
}

/**
 * Worst-case source peak at *any* instant while moving between two
 * configurations.
 *
 * Both endpoints being under the ceiling does not put the path between them
 * under it, and that is not hypothetical. Three mechanisms carry a
 * configuration change and none is simultaneous with the others: the notches
 * and bed gain are AudioParams and land exactly; the worklet's frequencies and
 * routing land on a render-quantum boundary; and its `amGain` and
 * `twoToneGain` then approach their targets through a one-pole smoother. So a
 * change that lowers `amGain` while the master rises to the level the new
 * configuration permits multiplies a still-loud source by an already-raised
 * gain. Rendered: a source bound falling 2 -> 1 against a master rising
 * 0.4 -> 0.8 reaches 0.95 at 50 ms, with both endpoints at exactly 0.8.
 *
 * Each term is therefore taken at its worst across the transition. The
 * two-tone term counts whenever *either* end has the path on, because the
 * routing flag switches instantly while its gain is still smoothing.
 */
export function transitionPeakBound(
  configurations: readonly BoundedConfiguration[],
  sampleRate: number,
): number {
  if (configurations.length === 0) return 0;
  let envelope = envelopeOf(configurations[0], sampleRate);
  for (let i = 1; i < configurations.length; i++) {
    envelope = mergeEnvelopes(envelope, envelopeOf(configurations[i], sampleRate));
  }
  return envelopePeak(envelope);
}

/**
 * Worst-case peak of the summed sources, before the master bus.
 *
 * The AM path peaks at `amGain`. The two-tone path adds at most `twoToneGain`
 * per channel in either routing — dichotic sends one tone to each ear, diotic
 * sends both at half amplitude.
 *
 * The bed used to be counted as `soundscape.gain` alone, on the grounds that
 * every generator is bounded by unity and "the notches only cut". The second
 * half of that was wrong, and it was wrong for the procedural bed as well as
 * for an imported one. "Only cuts" describes the *magnitude response*; it says
 * nothing about peak amplitude, because a cut biquad still rings and a ringing
 * filter can push an individual sample above its input. Measured on the real
 * chain, white noise reaches 1.82x and a full-scale square 2.10x — so the
 * ceiling was reachable in a build that claimed otherwise.
 *
 * The bed term is therefore multiplied by the L1 norm of the notch cascade's
 * impulse response, which is the worst-case peak gain of a fixed, zero-state
 * LTI filter for any input bounded by one. It is computed for the *current*
 * configuration rather than taken as one global constant: the worst chain in
 * the whole parameter space bounds at 3.54x, which would cost 11 dB
 * everywhere, while the configurations people actually run cost between
 * nothing and 2.6 dB. Five of the six offered presets are unaffected.
 *
 * These bounds are summed rather than measured on purpose: this is the value
 * that must never be exceeded, not the value a given moment actually reaches.
 */
export function worstCaseSourcePeak(
  params: HeadroomParams,
  soundscape: HeadroomSoundscape,
  sampleRate: number,
): number {
  const twoTone = params.twoToneMode === 'off' ? 0 : params.twoToneGain;
  const bedGain = notchPeakGain(
    params.carrierHz,
    params.modulationHz,
    soundscape.notchQ,
    soundscape.notchDepthDb,
    sampleRate,
  );
  return params.amGain + twoTone + soundscape.gain * bedGain;
}

/**
 * Attenuation that turns `MAX_MASTER_LEVEL` into a true peak ceiling.
 *
 * Only mixes that would otherwise exceed unity are scaled, so ordinary preset
 * combinations are untouched; a mix loud enough to clip is brought back to the
 * ceiling instead of being handed to the limiter.
 */
export function headroomScale(
  params: HeadroomParams,
  soundscape: HeadroomSoundscape,
  sampleRate: number,
): number {
  return 1 / Math.max(1, worstCaseSourcePeak(params, soundscape, sampleRate));
}

/** Seconds of ramp when starting a session. Never begin at level. */
export const DEFAULT_RAMP_IN = 3;

/** Relative durations for a timed session. */
export interface SessionTiming {
  plannedSeconds: number;
  rampInSeconds: number;
  rampOutSeconds: number;
}

export interface GraphOptions {
  entrainmentWorkletUrl: string;
  noiseWorkletUrl: string;
  notchWorkletUrl: string;
  /**
   * The capture tap, for the integrity checks.
   *
   * Optional: without it the graph is exactly what it was, and the taps are
   * absent rather than silently broken. A surface that asks for a window then
   * gets `null` knows it cannot check anything, which is a better failure than
   * a tap that exists and records nothing.
   */
  captureWorkletUrl?: string;
  context?: AudioContext;
}

export class EntrainmentGraph {
  readonly context: AudioContext;
  /** Master bus tap — everything that reaches the destination. */
  readonly analyser: AnalyserNode;
  /**
   * Entrainment path tap, before the soundscape is summed in.
   *
   * The master tap answers "what is going out"; this one answers "what is the
   * entrainment signal doing". Measuring envelope depth on the master bus with
   * a noise bed mixed in would report the bed, not the modulation.
   */
  readonly entrainmentAnalyser: AnalyserNode;

  /**
   * The integrity taps, or null where no capture worklet was supplied.
   *
   * Two, for the same reason there are two analysers: the entrainment tap
   * answers what the synthesis produced, before the bed is summed in and before
   * the playback envelope touches it, which is the only place the offline
   * reference applies. The master tap answers what actually left, which no
   * reference can predict because it carries the bed, the envelope and the
   * compressor as well.
   */
  /** Told when a captured window stops describing what is playing. */
  private epochListener: ((reason: EpochReason) => void) | null = null;

  entrainmentCapture: CaptureTap | null = null;
  masterCapture: CaptureTap | null = null;

  /**
   * The window of context time in which output is at its intended level.
   *
   * Master-tap bounds are absolute — a peak, a coverage — so a window
   * overlapping the ramp-in or the fade-out shows attenuation the graph applied
   * on purpose. Epochs do not help: a session fade is not a configuration
   * change. The caller compares a window's own `startedAt` against this, which
   * is why the tap reports one.
   */
  private steady: SteadyWindow = NEVER_STEADY;

  private entrainment!: AudioWorkletNode;
  private noise!: AudioWorkletNode;
  private entrainmentGain!: GainNode;
  private soundscapeGain!: GainNode;
  /**
   * The playback envelope — everything that ramps audio in and out.
   *
   * Deliberately separate from the master bus. `rampMaster` cancels scheduled
   * values, and headroom is re-applied on every parameter and soundscape
   * change, so an envelope living on the master bus would be wiped the moment
   * the user touched a control — which, since Studio stays editable during a
   * session, is a certainty rather than a risk.
   */
  private envelopeGain!: GainNode;
  private masterBus!: GainNode;
  private compressor!: DynamicsCompressorNode;
  /** Notches at fc - fMod, fc, fc + fMod — the AM path's full spectrum. */
  /**
   * The bed's notch cascade, as one worklet rather than a rebuilt node chain.
   *
   * Retuning a biquad that is carrying signal has no peak bound, so a change
   * needs a cascade with fresh state. Getting that from `BiquadFilterNode`
   * meant building nodes mid-playback, and changing the graph's topology under
   * a running renderer is audible on its own — a listening pass isolated it by
   * rebuilding with *identical* coefficients, which clicked just as loudly.
   *
   * Inside a worklet a fresh state is a field assignment, the node count never
   * changes, and the crossfade is two sets of state in one processor.
   */
  private notch!: AudioWorkletNode;
  /**
   * Peak-gain bounds of the cascades that could be sounding.
   *
   * One entry once settled, two while a handover is under way. The largest
   * bounds their sum, since the crossfade's gains never total more than one.
   */
  private notchBounds: { revision: number; bound: number }[] = [];
  /** Where the master was last told to go, or null before anything scheduled it. */
  private lastMasterTarget: number | null = null;

  /** The coefficients the live chain was built for, so a repeat builds nothing. */
  private bedChainKey = '';
  /**
   * Whether the worklet is mid-handover.
   *
   * Set when a cascade is sent and cleared only when the worklet reports it
   * settled, never on a predicted time. Predicting it was wrong twice over: a
   * handover that outlived the estimate could be interrupted by the next one,
   * and a request deferred against the estimate had nothing to retry it, so
   * the last change of a drag could simply never be applied.
   */
  private notchHandover = false;

  /**
   * Orders and serializes start and stop.
   *
   * Both await the context, so without this a stop could suspend playback that
   * restarted while it waited, and a start could outrank a stop the user
   * issued later. See transitions.ts.
   */
  private readonly transitions = new TransitionQueue();

  private params: EntrainmentParams = { ...DEFAULT_PARAMS };
  private soundscape: SoundscapeOptions = { ...DEFAULT_SOUNDSCAPE };

  /**
   * The configuration that is actually sounding, which is not always the one
   * that was last requested.
   *
   * A change that needs more attenuation is scheduled a few milliseconds out,
   * so between the request and its landing the audible configuration is the
   * previous one. Deciding the guard from the *requested* configuration rather
   * than this one gets the second of two rapid changes wrong: it compares
   * against a level that is not in force yet, and can take the immediate
   * branch while the gain is still above what the new configuration permits.
   */
  private audibleParams: EntrainmentParams = { ...DEFAULT_PARAMS };
  private audibleSoundscape: SoundscapeOptions = { ...DEFAULT_SOUNDSCAPE };
  /** A scheduled change that has not landed yet, and when it will. */
  private pendingChange: {
    revision: number;
    params: EntrainmentParams;
    soundscape: SoundscapeOptions;
  } | null = null;
  /**
   * Everything the smoother may still be carrying, as a componentwise maximum.
   *
   * Not merely the latest request. `pendingChange` is replaced on every
   * commit, so a configuration that was adopted and is still smoothing when
   * the next one supersedes it would vanish from the bound while its gains
   * were still in the output: 0 -> 0.6 -> 0 leaves the source near 0.6 while a
   * bound taken over only the first and last sees zero at both ends.
   *
   * Kept as a running maximum rather than a list, because a slider drag
   * produces a commit per pixel and an unbounded list of them is a leak rather
   * than a bound. Cleared only when the newest revision settles, which is the
   * one moment the smoother is known to be carrying nothing else.
   */
  private inFlight: SourceEnvelope | null = null;
  /**
   * Monotonic configuration revision.
   *
   * AudioParam events are applied in *time* order, not the order they were
   * queued, and the worklet's own queue is no better on its own. So a change
   * scheduled 8 ms out and then superseded 2 ms later by one that applies
   * immediately would land last and win — the older configuration overwriting
   * the newer. Scheduled AudioParam events are cancelled outright; the worklet
   * cannot be cancelled, so its messages carry this and it discards anything
   * older than the newest it has seen.
   */
  private revision = 0;

  /** The colour the noise worklet was last told, so a repeat is not sent. */
  private lastSentColor: NoiseColor | null = null;
  private requestedMasterLevel = DEFAULT_MASTER_LEVEL;
  private isRunning = false;

  private constructor(context: AudioContext) {
    this.context = context;
    // 16384 samples is 341 ms at 48 kHz — about 13 cycles of the 40 Hz
    // envelope, enough for the scope to show a stable shape, and 2.9 Hz
    // spectral resolution, enough to separate fc from fc +/- 40.
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 16384;
    this.analyser.smoothingTimeConstant = 0.7;

    this.entrainmentAnalyser = context.createAnalyser();
    this.entrainmentAnalyser.fftSize = 16384;
    this.entrainmentAnalyser.smoothingTimeConstant = 0;
  }

  static async create(options: GraphOptions): Promise<EntrainmentGraph> {
    const context =
      options.context ??
      new AudioContext({ sampleRate: PREFERRED_SAMPLE_RATE, latencyHint: 'playback' });

    const graph = new EntrainmentGraph(context);

    await context.audioWorklet.addModule(options.entrainmentWorkletUrl);
    await context.audioWorklet.addModule(options.noiseWorkletUrl);
    await context.audioWorklet.addModule(options.notchWorkletUrl);
    if (options.captureWorkletUrl !== undefined) {
      await context.audioWorklet.addModule(options.captureWorkletUrl);
    }

    graph.build(options.captureWorkletUrl !== undefined);
    return graph;
  }

  private build(withCapture: boolean): void {
    const ctx = this.context;

    // Seed both processors at construction. processorOptions is delivered
    // synchronously; a port message is not, and would leave the first render
    // quanta running on defaults.
    this.entrainment = new AudioWorkletNode(ctx, 'entrainment-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { params: this.params },
    });
    this.entrainment.port.onmessage = (
      event: MessageEvent<{ type?: string; revision?: number }>,
    ) => {
      const message = event.data;
      if (message?.type === 'settled' && typeof message.revision === 'number') {
        this.onWorkletSettled(message.revision);
      }
    };
    this.noise = new AudioWorkletNode(ctx, 'noise-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { color: this.soundscape.color },
    });

    this.entrainmentGain = ctx.createGain();
    this.soundscapeGain = ctx.createGain();
    this.envelopeGain = ctx.createGain();
    this.masterBus = ctx.createGain();
    // Silent before anything is connected. The worklets render from the moment
    // they are constructed, so an envelope left at its default of 1 would pass
    // an unramped first block whenever the context is already running — which
    // it is in Electron, where no gesture is required to resume it.
    this.envelopeGain.gain.value = 0;
    this.masterBus.gain.value = this.effectiveMasterLevel;

    this.compressor = ctx.createDynamicsCompressor();
    // A safety limiter, not a sound-shaping compressor. Gain reduction is
    // applied identically to both channels, so it does not disturb the
    // interaural phase the binaural path depends on — but the headroom
    // guarantee in `headroomScale` is what keeps it from engaging at all. The
    // threshold sits above every level that guarantee permits, and the ratio is
    // steep enough to brickwall a fault rather than compress it.
    this.compressor.threshold.value = LIMITER_THRESHOLD_DB;
    this.compressor.knee.value = 0;
    this.compressor.ratio.value = 20;
    this.compressor.attack.value = 0.005;
    this.compressor.release.value = 0.25;

    // Entrainment path: worklet straight to the master bus. No panner, no
    // reverb, no crossfeed — anything that mixes channels destroys the
    // dichotic separation the binaural mode requires.
    this.entrainment.connect(this.entrainmentGain).connect(this.envelopeGain);
    // Analyser taps are terminal branches; they do not feed the destination,
    // so this adds no audio to the output.
    this.entrainmentGain.connect(this.entrainmentAnalyser);

    // Soundscape path: notched to carve a spectral slot for the carrier and
    // its sidebands, so the carrier stays audible at a lower absolute level.
    // The cascade lives in the notch worklet, seeded at construction.
    const { carrierHz, modulationHz } = this.params;
    const { notchQ, notchDepthDb } = this.soundscape;
    this.notch = new AudioWorkletNode(ctx, 'notch-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      // Seeded at construction rather than by message, for the reason the
      // other processors are: a port message is not delivered synchronously,
      // and an OfflineAudioContext can finish rendering before it arrives.
      processorOptions: { carrierHz, modulationHz, q: notchQ, depthDb: notchDepthDb, channels: 2 },
    });
    this.notch.port.onmessage = (event: MessageEvent<{ type?: string; revision?: number }>) => {
      const message = event.data;
      if (message?.type === 'notch-settled' && typeof message.revision === 'number') {
        this.onNotchSettled(message.revision);
      }
    };
    this.noise.connect(this.notch).connect(this.soundscapeGain).connect(this.envelopeGain);

    this.bedChainKey = `${carrierHz}|${modulationHz}|${notchQ}|${notchDepthDb}`;
    this.notchBounds = [
      {
        revision: -1,
        bound: notchPeakGain(carrierHz, modulationHz, notchQ, notchDepthDb, ctx.sampleRate),
      },
    ];

    // Envelope first, then level. Both only attenuate, so the headroom
    // guarantee measured at the sources still holds at the destination.
    this.envelopeGain.connect(this.masterBus);
    this.masterBus.connect(this.compressor).connect(this.analyser);
    this.analyser.connect(ctx.destination);

    if (withCapture) this.buildCaptureTaps();

    // At construction there is nothing to guard: the envelope is closed, so
    // no gain the master carries reaches the destination yet.
    const at = ctx.currentTime;
    this.applyParams(at, Math.ceil(at * ctx.sampleRate));
    this.applySoundscape(at);
    this.masterBus.gain.value = this.effectiveMasterLevel;
  }

  /**
   * Terminal branches, like the analysers: an input and no outputs at all.
   *
   * `numberOfOutputs: 0` is what makes them incapable of colouring the sound,
   * and also the thing worth testing rather than assuming — a node with nothing
   * connected downstream is exactly the kind an implementation could decide not
   * to run.
   */
  private buildCaptureTaps(): void {
    const ctx = this.context;
    const make = (): AudioWorkletNode =>
      new AudioWorkletNode(ctx, 'capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 2,
        channelCountMode: 'explicit',
        processorOptions: { seconds: CAPTURE_RING_SECONDS },
      });

    const entrainmentNode = make();
    const masterNode = make();
    this.entrainmentGain.connect(entrainmentNode);
    // Post-compressor: the last thing before the destination, so it is what
    // leaves rather than what the master bus was asked for.
    this.compressor.connect(masterNode);

    this.entrainmentCapture = new CaptureTap(entrainmentNode.port, ctx.sampleRate);
    this.masterCapture = new CaptureTap(masterNode.port, ctx.sampleRate);
  }

  /**
   * Discard what both taps have recorded.
   *
   * Every configuration change, because a window straddling one would be
   * compared against settings that were not in force while most of it played.
   */
  private epochCaptures(reason: EpochReason): void {
    this.entrainmentCapture?.epoch();
    this.masterCapture?.epoch();
    this.epochListener?.(reason);
  }

  /**
   * Watch for the moments a measurement's premises change.
   *
   * One listener, and this is the whole reason it exists: every path that
   * invalidates a captured window already funnels through `epochCaptures`, so
   * anything measuring the output can learn about all of them here instead of
   * being wired into each of the five places a configuration can move. A call
   * site that is added later is covered by construction rather than by
   * remembering.
   *
   * The reason is carried because the two kinds are not the same to a caller:
   * a configuration change means what was measured is stale, while starting or
   * stopping is a transport event whose owner is deciding what to do anyway.
   */
  onEpoch(listener: ((reason: EpochReason) => void) | null): void {
    this.epochListener = listener;
  }

  /**
   * When output is at its intended level, in context time.
   *
   * A copy. Handing out the live object lets a caller edit the boundary the
   * graph is deciding by — the aliasing mistake this project keeps making, here
   * in a place where it would quietly turn "do not measure this" into "measure
   * it".
   */
  get steadyPlayback(): SteadyWindow {
    // No window at all while anything is unacknowledged.
    //
    // The stored boundary is a prediction, and a finite prediction expires on
    // its own even when the change it was made for has not arrived: nothing
    // bounds port delivery, and the retry path makes the gap deterministic
    // rather than unlikely — a settlement pushes the boundary by the master
    // ramp and then schedules a handover whose fade can run for twice that.
    // A capture completed in between would be accepted as steady while the bed
    // was still moving.
    //
    // Closing it fails the right way: a measurement is skipped rather than
    // taken of a transition, and the acknowledgement reopens the window once
    // the ramp it starts has cleared.
    if (this.pendingChange !== null || this.notchHandover) return NEVER_STEADY;
    return { from: this.steady.from, until: this.steady.until };
  }

  /** The longest window either tap can be asked for. Callers cap at this. */
  get captureCapacityFrames(): number {
    return Math.floor(CAPTURE_RING_SECONDS * this.context.sampleRate);
  }

  /**
   * Push the steady boundary past a gain ramp that has just been scheduled.
   *
   * Emptying the ring is not enough on its own. A configuration change ramps
   * the master gain to its new headroom, so the audio immediately after the
   * change *is* a deliberate transition — and the first window recorded after
   * an epoch would contain it while `steadyFrom` still pointed at the old
   * ramp-in, letting the caller accept it as steady.
   */
  private pushSteady(rampSeconds: number): void {
    if (!this.isRunning) return;
    this.steady = deferSteady(this.steady, this.context.currentTime, rampSeconds);
  }

  private applyParams(at: number, atFrame: number): void {
    this.entrainment.port.postMessage({
      type: 'params',
      params: this.params,
      applyAtFrame: atFrame,
      revision: this.revision,
    });
  }

  /**
   * Replace the notch chain when its coefficients have actually moved.
   *
   * Guarded on the coefficients rather than run on every commit: a level drag
   * changes nothing here, and building thirty chains a second to hold the same
   * filter would be pure churn.
   */
  /**
   * Build the chain the current configuration asks for, if it differs.
   *
   * Called from settlement and nowhere else, which is the whole design. A
   * fresh chain has to settle before it carves its notch, so a rebuild per
   * change hands over faster than the filter can form and the slot is never
   * established — audible as a continuously fluttering or choppy bed for as
   * long as a control is moving.
   *
   * Rate-limiting is not enough: the interval between rebuilds would be the
   * fade length, which is 28 to 47 ms, so a drag would still produce twenty or
   * more handovers a second.
   *
   * **Settlement is not the same thing as the controls going quiet, and this
   * comment used to claim it was** — that "every change while they are moving
   * supersedes the last and never settles, so a drag of any length produces
   * exactly one rebuild". That holds only for a *continuous* drag. Whether a
   * change settles is governed by whether the next one outpaces it, which is a
   * fact about cadence rather than about the control having stopped: a slow or
   * hesitant hand leaves each change time to settle, and every one of them
   * rebuilds. Measured in `test/graph-taps.test.ts` — twenty changes 180 ms
   * apart produce nineteen handovers, twenty changes 33 ms apart produce none.
   * Both cases are tested there now; the fast one alone is what let the false
   * generalisation stand.
   *
   * A trailing quiet window was tried as the fix and made things audibly worse,
   * because the cascade is static between handovers: one rebuild per drag means
   * the slot stays where the drag began. A bed-silenced control later refuted
   * this mechanism as the cause of what was being heard.
   *
   * The cost of the current trigger is that the notch trails the carrier while
   * a control is moving and catches up about a quarter of a second after it
   * stops. The bound is unaffected: it is taken from the chains that are live,
   * so a stale chain is covered by its own bound rather than by the
   * configuration that replaced it.
   */
  private refreshBedChain(at: number): void {
    const { carrierHz, modulationHz } = this.params;
    const { notchQ, notchDepthDb } = this.soundscape;
    const key = `${carrierHz}|${modulationHz}|${notchQ}|${notchDepthDb}`;
    if (key === this.bedChainKey) return;

    // Deferred, not dropped. `bedChainKey` is deliberately left on the last
    // cascade actually sent, so the difference survives and `onNotchSettled`
    // picks it up — which is the only thing that retries. Coalescing against a
    // predicted finish time had nothing behind it: if no further settlement
    // arrived, the last request of a drag was lost.
    if (this.notchHandover) return;

    const fade = notchSettleSeconds(
      carrierHz,
      modulationHz,
      notchQ,
      notchDepthDb,
      this.context.sampleRate,
    );
    this.bedChainKey = key;
    this.notchHandover = true;
    this.sendNotch(at, fade);
  }

  /**
   * The first render-quantum boundary at or after `earliest`.
   *
   * `currentFrame` advances a quantum at a time from zero, so a worklet can
   * only adopt a change on a multiple of 128. Scheduling the AudioParams at an
   * arbitrary instant and the worklet at "the first boundary after it" makes
   * them land up to a quantum apart — 5.8 ms at 22.05 kHz — and in that window
   * the new bed and notches run against the *old* entrainment gains. That
   * hybrid is not bounded by either endpoint: a change that lowers `amGain`
   * while raising the bed produces a sum higher than both.
   *
   * Choosing the boundary up front and using the same frame for both makes the
   * two land together.
   */
  private landingFrame(earliest: number): number {
    const frame = earliest * this.context.sampleRate;
    return Math.ceil(frame / RENDER_QUANTUM) * RENDER_QUANTUM;
  }

  /**
   * Hand the notch cascade over to the current configuration.
   *
   * The worklet builds the new cascade with zero state and crossfades to it,
   * so nothing is created or connected here. Both bounds are held until it
   * reports the handover complete: until then either cascade could be
   * contributing, and the larger of the two bounds their sum.
   */
  private sendNotch(at: number, fadeSeconds: number): void {
    const { carrierHz, modulationHz } = this.params;
    const { notchQ, notchDepthDb } = this.soundscape;
    const sampleRate = this.context.sampleRate;

    this.notchBounds.push({
      revision: this.revision,
      bound: notchPeakGain(carrierHz, modulationHz, notchQ, notchDepthDb, sampleRate),
    });
    this.notch.port.postMessage({
      type: 'notch',
      carrierHz,
      modulationHz,
      q: notchQ,
      depthDb: notchDepthDb,
      atFrame: Math.ceil(at * sampleRate),
      crossfadeFrames: Math.max(1, Math.round(fadeSeconds * sampleRate)),
      revision: this.revision,
    });
  }

  /**
   * The worklet has finished handing over, so the older cascade is gone.
   *
   * Reported rather than inferred from the schedule, for the same reason the
   * entrainment settlement is: nothing bounds message delivery, and dropping
   * the old bound early would let the master rise while the old cascade was
   * still sounding.
   */
  /**
   * Tell anything measuring that the window has reopened.
   *
   * Closing it while an acknowledgement is outstanding is only half of the
   * change: `passDelaySeconds` treats a window with no finite start as *no
   * measurement at all* rather than one to wait for, so a pass scheduled
   * during a transition is cancelled outright. Something has to say when it is
   * worth asking again, and settlement is that moment. The epoch also empties
   * the rings, which is right — the audio before it was the transition.
   */
  private reopenIfSettled(): void {
    if (this.pendingChange !== null || this.notchHandover) return;
    this.epochCaptures('configuration');
  }

  private onNotchSettled(revision: number): void {
    const settled = this.notchBounds.findIndex((entry) => entry.revision === revision);
    if (settled <= 0) return;
    this.notchBounds = this.notchBounds.slice(settled);
    this.notchHandover = false;

    const now = this.context.currentTime;
    const at = this.landingFrame(now + GUARD_RAMP_SECONDS) / this.context.sampleRate;

    // The deferred cascade is registered *before* the level is read, and the
    // order is the point. Whatever was asked for while the handover ran has
    // been waiting for this — nothing else retries it, since entrainment
    // settlement has been and gone by the time a notch fade completes — and
    // its bound can be larger than the one just dropped. Ramping first would
    // set the master for the cascade that is ending and start the next
    // handover underneath it, with nothing to correct that until it settled.
    this.refreshBedChain(at);

    // Now the level covers both what is still fading out and what is about to
    // fade in, and it lands before that handover begins.
    this.rampMasterToward(this.effectiveMasterLevel, at - now);
    // The handover has been changing the bed for as long as its crossfade ran,
    // and this starts a master ramp on top of it. Both are deliberate
    // transitions, so the boundary has to clear them.
    this.pushSteady(at - now + MASTER_RESTORE_SECONDS);
    this.reopenIfSettled();
  }

  private applySoundscape(at: number): void {
    // Only when it actually changes. The worklet ignores a repeat anyway, but
    // a message per commit during a drag is churn worth not creating.
    if (this.soundscape.color !== this.lastSentColor) {
      this.lastSentColor = this.soundscape.color;
      this.noise.port.postMessage({ type: 'color', color: this.soundscape.color });
    }
    this.soundscapeGain.gain.setValueAtTime(this.soundscape.gain, at);
  }

  /** Master level a given worst-case source peak permits. */
  private levelForBound(bound: number): number {
    return (this.requestedMasterLevel * MAX_MASTER_LEVEL) / Math.max(1, bound);
  }

  /**
   * Drop every automation event a superseded change scheduled.
   *
   * `cancelScheduledValues(now)` removes events at or after `now`, which is
   * every event a commit can have queued, since they are all scheduled at or
   * after the moment of their call. The parameter keeps whatever value the
   * last *applied* event gave it — the audible configuration — until the new
   * one arrives.
   */
  private cancelScheduledConfiguration(now: number): void {
    // Chain coefficients are never scheduled, so there is nothing to cancel
    // there, and the worklet's own handover is not an AudioParam at all.
    this.soundscapeGain.gain.cancelScheduledValues(now);
  }

  /** Master level that a given configuration permits, at the current request. */
  private levelFor(params: EntrainmentParams, soundscape: SoundscapeOptions): number {
    return (
      this.requestedMasterLevel *
      MAX_MASTER_LEVEL *
      headroomScale(params, soundscape, this.context.sampleRate)
    );
  }

  /**
   * The worklet has adopted a configuration and said so.
   *
   * This is the only thing that makes a requested configuration *audible*, and
   * the only thing that permits the master to return to the level that
   * configuration alone would allow. Scheduled time is not proof: nothing
   * bounds port message delivery, so a change believed applied on schedule can
   * still be in flight, and a later change computing its guard from it would
   * relax the attenuation that was covering the difference.
   *
   * A stale revision is ignored — it belongs to a request already superseded.
   */
  private onWorkletSettled(revision: number): void {
    // Exactly the pending revision. Accepting anything at or above it lets a
    // malformed or future reply promote a configuration and release the
    // attenuation without anything having proved that configuration settled.
    // Every other revision fails closed: the guard simply stays on.
    if (this.pendingChange === null || revision !== this.pendingChange.revision) return;

    // Settled, not merely adopted. Adoption says the frequencies and routing
    // changed; the gains are still between the old and new values for a while
    // after it, and promoting on adoption would let the next change compute
    // its envelope from gains that had not arrived. The worklet snaps them and
    // reports separately, so this is exact.
    this.audibleParams = this.pendingChange.params;
    this.audibleSoundscape = this.pendingChange.soundscape;
    this.pendingChange = null;
    // The newest revision has settled, so the smoother carries nothing but
    // this configuration. That is the only moment it is safe to forget what
    // came before it.
    this.inFlight = null;

    // The trailing edge of a drag.
    //
    // Rebuilds are coalesced, so a change that arrived while a crossfade was
    // running never built its chain and the notch is still trailing the
    // carrier. Settlement is the moment that stops being temporary: it is the
    // first thing that happens after the controls go quiet, so the deferred
    // rebuild belongs here. Nothing further arrives to carry it otherwise.
    const now = this.context.currentTime;
    const atFrame = this.landingFrame(now + GUARD_RAMP_SECONDS);
    const at = atFrame / this.context.sampleRate;
    this.refreshBedChain(at);

    // Read after that, for the same reason as in `commitConfiguration`.
    this.rampMasterToward(this.effectiveMasterLevel, at - now);
    // Measured from when the acknowledgement actually arrived. The prediction
    // made at commit time assumed a prompt reply, and nothing bounds delivery
    // — a late one would otherwise let a measurement start inside the restore.
    this.pushSteady(at - now + HEADROOM_RAMP_SECONDS);
    this.reopenIfSettled();
  }

  /**
   * Change the configuration without ever leaving the ceiling unenforced.
   *
   * One path, not two. An earlier version branched on whether the change
   * needed more or less attenuation and applied the "less" case immediately,
   * which is what let a rising master meet a still-decaying source. Bounding
   * the whole transition removes the distinction: the master moves to a level
   * safe for *every* state between the two configurations, the configuration
   * lands on a quantised frame so its AudioParam and worklet halves arrive
   * together, and the master returns to the level the new configuration alone
   * permits only once the worklet has acknowledged it and its gains have
   * settled.
   *
   * Failing to hear back leaves the master at the transition level, which is
   * safe for both configurations. That is the right way for this to fail.
   */
  private commitConfiguration(mutate: () => void): void {
    const now = this.context.currentTime;
    const sampleRate = this.context.sampleRate;

    // Measured from what is *sounding*. While a change is in flight that is
    // not what was last requested, and guarding against the request would
    // compare with a state that is not in force.
    mutate();
    this.revision++;

    // Anything still queued belongs to a superseded request. Cancelling it is
    // what stops an older configuration landing after a newer one.
    this.cancelScheduledConfiguration(now);

    const atFrame = this.landingFrame(now + GUARD_RAMP_SECONDS);
    const at = atFrame / sampleRate;

    this.pendingChange = {
      revision: this.revision,
      params: { ...this.params },
      soundscape: { ...this.soundscape },
    };
    // Folded in rather than replacing: a configuration that was adopted and is
    // still smoothing when this one supersedes it is still in the output.
    const requested = envelopeOf({ params: this.params, soundscape: this.soundscape }, sampleRate);
    this.inFlight = this.inFlight === null ? requested : mergeEnvelopes(this.inFlight, requested);
    // The chain is built *before* the master is ramped, because the level is
    // derived from the bounds of the chains that are live. Ramping first would
    // read a bound that did not yet include the chain about to sound.
    this.applyParams(at, atFrame);
    this.applySoundscape(at);
    // No chain is built here, deliberately. See `refreshBedChain`.
    // Read after all of it, so the level covers the settled configuration,
    // everything still on its way, and every chain now carrying the bed.
    this.rampMasterToward(this.effectiveMasterLevel, at - now);

    // A floor, not a prediction: the transition is not over until the worklet
    // reports settlement, and `onWorkletSettled` pushes the boundary again
    // from whenever that actually happens.
    this.pushSteady(at - now + SOURCE_SETTLE_SECONDS + HEADROOM_RAMP_SECONDS);
    this.epochCaptures('configuration');
  }

  setParams(next: Partial<EntrainmentParams>): void {
    this.commitConfiguration(() => Object.assign(this.params, next));
  }

  setSoundscape(next: Partial<SoundscapeOptions>): void {
    this.commitConfiguration(() => Object.assign(this.soundscape, next));
  }

  getParams(): Readonly<EntrainmentParams> {
    return this.params;
  }

  /**
   * Ramp the master toward `target`, taking longer when it is safe to.
   *
   * A reduction has a deadline — it must land before the change it guards, so
   * it gets `byDeadline`. An increase has none, so it takes the slower
   * `MASTER_RESTORE_SECONDS`. Using the deadline for both made the release at
   * the end of a press as abrupt as the attenuation at the start, and a gain
   * step over a few milliseconds is a click whatever its size.
   */
  private rampMasterToward(target: number, byDeadline: number): void {
    /*
     * Only when the level actually moves.
     *
     * This runs on every commit, so a drag scheduled a ramp per input event —
     * measured at **227 in four seconds, every one of them to an identical
     * target**. `rampMaster` cancels whatever is in flight and starts again
     * from wherever the gain has got to, so each of those restarted the last,
     * sixty times a second, all aiming at the value it already had. The held
     * value was seen half a unit away from the target — the master collapsing
     * about 19 dB and being pulled back — which is the dropout being heard.
     *
     * This guard covers only the degenerate half. A drag whose target really
     * does move reschedules just as often and passes straight through; that
     * moving-target case is fixed in `rampMaster` itself.
     *
     * Bisected to here: with this call removed the master bus records zero dips
     * across three takes where the unmodified build records dozens, and
     * removing any other per-event work — the capture epoch, the soundscape
     * write, the automation cancel, the steady push — changes nothing.
     *
     * Skipping is safe precisely because the target is unchanged: the ramp
     * already in flight is heading to the same place, so the level the guard
     * depends on is the one that arrives. It is the same "only when it actually
     * changes" rule `applySoundscape` and `refreshBedChain` already follow, and
     * for the same reason.
     */
    if (this.lastMasterTarget !== null && Math.abs(target - this.lastMasterTarget) <= 1e-9) return;
    const current = this.masterBus.gain.value;
    this.rampMaster(target, target < current ? byDeadline : MASTER_RESTORE_SECONDS);
  }

  /**
   * Ramp the master bus to `target` over `seconds`.
   *
   * Level only. This cancels scheduled values, so it must never carry the
   * playback envelope — that lives on `envelopeGain`, where a control change
   * cannot wipe it.
   */
  rampMaster(target: number, seconds: number): void {
    // Every path that schedules the master records where it aimed, so
    // `rampMasterToward` can tell whether anything has moved since.
    this.lastMasterTarget = target;
    const now = this.context.currentTime;
    const gain = this.masterBus.gain;
    /*
     * Held, not cancelled — but held by hand.
     *
     * The rule is the bed crossfade's: `cancelScheduledValues(now)` alone
     * strips an in-flight ramp's endpoint, so the value reverts to the event
     * before it and steps, and reading `gain.value` afterwards pins the
     * already-jumped figure rather than repairing it. This runs on every
     * commit and the restore after settlement is a 50 ms ramp, so an ordinary
     * sequence of key presses lands inside one — a click per press.
     *
     * `cancelAndHoldAtTime(now)` expresses exactly that and was used here until
     * the moving-target fix. Under a drag it does not deliver it. Sweeping Master
     * across the same travel over the same six seconds, varying only how
     * often the input event fires, the output dips 0, 0, 5, 14, 18 times at
     * 5, 10, 20, 40 and 60 events a second, against a still take of 0 in
     * every launch; Soundscape level goes 0, 0, 0, 7, 10. Distance and
     * duration are held constant, so the residue follows the rescheduling,
     * not the level moving. Replacing this one call — the level still
     * travelling the same distance at the same rate — takes both to 0 across
     * three takes each. What the engine does with a hold cancelled every 16 ms
     * is not measured here; that it is not what a correct hold does, is.
     *
     * So: read the curve, pin it, then clear. Pinning before cancelling
     * matters — the reverse leaves an instant where the timeline has reverted
     * to the event before the ramp, which is the step this exists to avoid.
     */
    const held = gain.value;
    gain.setValueAtTime(held, now);
    // Just past the pin, so the clear takes the stale endpoint and not it.
    gain.cancelScheduledValues(now + 1e-6);
    // Linear rather than exponential, so a target of exactly 0 is reachable.
    gain.linearRampToValueAtTime(target, now + rampDuration(seconds));
  }

  /** Requested master level, before the safety ceiling is applied. */
  get masterLevel(): number {
    return this.requestedMasterLevel;
  }

  setMasterLevel(level: number, rampSeconds = 0.05): void {
    this.requestedMasterLevel = Math.min(1, Math.max(0, level));
    // Normalised once, so the boundary cannot claim steadiness while the gain
    // is still moving: `rampMaster` floors a zero-length ramp at a millisecond,
    // and passing the raw figure here marked the graph steady immediately.
    const ramp = rampDuration(rampSeconds);
    this.rampMaster(this.effectiveMasterLevel, ramp);
    // The entrainment checks are scale-invariant and would not care, but the
    // master bounds are absolute: a window spanning a level change has no
    // single peak to be judged against.
    this.pushSteady(ramp);
    this.epochCaptures('configuration');
  }

  /**
   * Master gain actually applied: the requested level against the ceiling,
   * divided down by whatever headroom the current mix needs.
   *
   * Output peak is therefore at most `requestedMasterLevel * MAX_MASTER_LEVEL`
   * for any combination of parameters, which is what makes the ceiling real.
   */
  /**
   * Every configuration that could be sounding right now.
   *
   * The settled one always, and anything scheduled but not yet reported
   * settled. While a change is in flight the source gains are somewhere
   * between the two, so both have to be bounded.
   */
  /**
   * Worst-case source peak for everything that could be sounding right now.
   *
   * The bed term comes from the chains that are actually **live**, not from the
   * configurations. Those diverge once rebuilds are coalesced: a chain built
   * for an earlier configuration keeps sounding while the request has moved on,
   * and a bound derived from the configurations would stop covering it. Each
   * chain carries the bound it was built with, and the largest of them bounds
   * their sum because their gains never total more than one.
   */
  private activeSourceBound(): number {
    const settled = envelopeOf(
      { params: this.audibleParams, soundscape: this.audibleSoundscape },
      this.context.sampleRate,
    );
    const envelope = this.inFlight === null ? settled : mergeEnvelopes(settled, this.inFlight);

    let chainBound = 1;
    for (const entry of this.notchBounds) chainBound = Math.max(chainBound, entry.bound);
    return (
      envelope.amGain +
      (envelope.twoToneActive ? envelope.twoToneGain : 0) +
      envelope.bedGain * chainBound
    );
  }

  /**
   * Master gain actually applied.
   *
   * Defined from the *transition* bound rather than from the requested
   * configuration, and that is the whole point: every path that moves the
   * master reads this, so none of them can undo the attenuation a change in
   * flight is relying on. `setMasterLevel` used to compute the endpoint level
   * directly and could raise the gain straight past a pending transition;
   * `start` and `startSession` had the same hole.
   *
   * With nothing pending this is exactly the old definition, since the only
   * active configuration is the settled one.
   */
  private get effectiveMasterLevel(): number {
    return this.levelForBound(this.activeSourceBound());
  }

  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Begin untimed playback, ramping in and holding.
   *
   * This is Preview: no scheduled end, nothing recorded. A timed session uses
   * `startSession`, which schedules its whole envelope up front.
   */
  async start(rampSeconds = DEFAULT_RAMP_IN): Promise<void> {
    // Claimed before any await, so ordering follows when the user asked.
    const generation = this.transitions.claim();
    await this.transitions.run(async () => {
      if (!this.transitions.isCurrent(generation)) return;
      await this.resumeContext();
      // Rechecked after the only await, so nothing is scheduled on behalf of
      // an operation that has since been superseded.
      if (!this.transitions.isCurrent(generation)) return;
      this.rampMaster(this.effectiveMasterLevel, 0.001);
      this.isRunning = true;
      const at = this.context.currentTime;
      scheduleOpenEnvelope(this.envelopeGain.gain, at, rampSeconds);
      // Preview has no scheduled end, so it is steady from the top of the ramp
      // until something stops it.
      this.steady = openSteady(at, rampSeconds);
      this.epochCaptures('transport');
    });
  }

  /**
   * Schedule a complete timed session on the audio clock, in one call.
   *
   * Durations are relative, not absolute AudioContext times. The caller cannot
   * know the start instant in advance: resuming a suspended context — the
   * normal state after Preview stops — advances the clock by an unpredictable
   * amount, so an absolute fade boundary computed beforehand would land early,
   * or in the past. The boundary is derived here, after the clock is known.
   *
   * Returns the AudioContext time playback actually began.
   */
  async startSession(timing: SessionTiming): Promise<number | null> {
    const generation = this.transitions.claim();
    let startAt: number | null = null;
    await this.transitions.run(async () => {
      if (!this.transitions.isCurrent(generation)) return;
      await this.resumeContext();
      if (!this.transitions.isCurrent(generation)) return;
      this.rampMaster(this.effectiveMasterLevel, 0.001);
      this.isRunning = true;
      startAt = this.context.currentTime;
      const fadeStartAt = startAt + Math.max(0, timing.plannedSeconds - timing.rampOutSeconds);
      scheduleSessionEnvelope(this.envelopeGain.gain, {
        startAt,
        rampInSeconds: timing.rampInSeconds,
        // Mirrors fadeStartMs() in the session core: the fade *lands* on the
        // planned end rather than starting there.
        fadeStartAt,
        fadeOutSeconds: timing.rampOutSeconds,
      });
      // The whole envelope is known here, so both ends of the steady window
      // are too. A capture outside it would measure the ramp.
      this.steady = sessionSteady(startAt, timing.rampInSeconds, fadeStartAt);
      this.epochCaptures('transport');
    });
    return startAt;
  }

  /**
   * Stop playback from wherever the envelope has reached.
   *
   * Holds at the current value before fading, so stopping mid-ramp does not
   * jump the level before bringing it down.
   */
  async stop(rampSeconds = 1.5): Promise<void> {
    const generation = this.transitions.claim();
    this.isRunning = false;
    // Fade immediately rather than from inside the queue: a stop should be
    // audible at once, not behind whatever transition is in flight.
    const at = this.context.currentTime;
    cancelSessionEnvelope(this.envelopeGain.gain, {
      at,
      fadeOutSeconds: rampSeconds,
    });
    // Steady playback ends here, and anything still waiting for a window is
    // waiting for audio that will be a fade. Refusing it is the point: a
    // measurement spanning a deliberate attenuation reads as a fault.
    this.steady = endSteady(this.steady, at);
    this.epochCaptures('transport');
    await new Promise((r) => setTimeout(r, rampSeconds * 1000 + 100));
    await this.transitions.run(async () => {
      // Superseded while the fade ran: that operation owns the context now.
      if (!this.transitions.isCurrent(generation)) return;
      if (this.context.state === 'running') await this.context.suspend();
    });
  }

  private async resumeContext(): Promise<void> {
    if (this.context.state === 'suspended') await this.context.resume();
  }

  async close(): Promise<void> {
    this.entrainment.port.postMessage({ type: 'stop' });
    this.noise.port.postMessage({ type: 'stop' });
    this.notch.port.postMessage({ type: 'stop' });
    // Settles anything still waiting for a window, which would otherwise be
    // waiting on a context that is about to stop rendering entirely.
    this.entrainmentCapture?.close();
    this.masterCapture?.close();
    await this.context.close();
  }

  /**
   * What the graph is currently rendering.
   *
   * A copy, and the authority for anything measuring the output: the checks
   * compare a captured window against an offline render of *these* parameters,
   * and reading them from a UI store instead would compare against whatever
   * the user has since dragged the slider to.
   */
  get currentParams(): EntrainmentParams {
    return { ...this.params };
  }

  /** True if the context is running at the rate we asked for. */
  get sampleRateMatchesPreference(): boolean {
    return this.context.sampleRate === PREFERRED_SAMPLE_RATE;
  }
}
