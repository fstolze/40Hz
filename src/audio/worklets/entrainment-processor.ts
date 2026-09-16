/**
 * AudioWorkletProcessor shell around the entrainment core.
 *
 * Deliberately thin: all synthesis lives in ../dsp/entrainment-core, which has
 * no Web Audio dependency and is verified offline by the test suite. The only
 * logic here is parameter transport and gain smoothing, so that a bug in the
 * audio thread cannot be a bug in the DSP.
 *
 * Bundled to a single file at build time; AudioWorklet modules cannot resolve
 * bare imports at runtime.
 */

import {
  render,
  createState,
  sanitizeParams,
  CARRIER_GLIDE_MAX_SECONDS,
  CARRIER_GLIDE_SECONDS,
  DEFAULT_PARAMS,
  SOURCE_SMOOTHING_SECONDS,
  SOURCE_SETTLE_SECONDS,
  TONE_SWAP_SECONDS,
  type EntrainmentParams,
  type EngineState,
  type TwoToneMode,
} from '../dsp/entrainment-core.ts';

export interface EntrainmentMessage {
  type: 'params' | 'stop';
  params?: Partial<EntrainmentParams>;
  /** Seconds over which gain changes are smoothed. Defaults to 30 ms. */
  smoothingSeconds?: number;
  /**
   * Frame at which to adopt `params`, on the same clock as `currentFrame`.
   *
   * Omitted means immediately, which is right whenever the change can only
   * make the output quieter. It is *not* right when a change raises the peak
   * the mix can reach: the graph has to attenuate the master bus first, and
   * that attenuation is a ramp. Applying the parameters at a named frame is
   * what lets the graph put the two in the safe order without a timer — the
   * ordering is on the audio clock, where nothing in the event loop can move
   * it.
   *
   * Granularity is one render quantum, and it rounds *late*: parameters are
   * adopted on the first quantum at or after the named frame. Late means the
   * old configuration plays a little longer under the new, lower gain, which
   * is the safe direction to err in.
   */
  applyAtFrame?: number;
  /**
   * Monotonic revision from the graph, so a superseded change cannot win.
   *
   * AudioParam events can be cancelled; a port message cannot be recalled. A
   * change scheduled a few milliseconds out and then superseded by one that
   * applies immediately would otherwise land last, overwriting the newer
   * configuration with the older one. Anything older than the newest revision
   * seen is discarded on arrival, and anything already queued at an older
   * revision is dropped.
   */
  revision?: number;
}

/**
 * Construction-time configuration.
 *
 * Seeding through processorOptions rather than a port message matters: port
 * messages are delivered asynchronously, so a processor configured only by
 * message runs its first render quanta on defaults. Live that is hidden by the
 * master ramp, but under OfflineAudioContext — which renders faster than the
 * message can arrive — it silently produces the wrong signal entirely.
 */
export interface EntrainmentProcessorOptions {
  processorOptions?: {
    params?: Partial<EntrainmentParams>;
    smoothingSeconds?: number;
  };
}

/** A parameter change waiting for its frame. */
interface PendingParams {
  atFrame: number;
  params: Partial<EntrainmentParams>;
  revision: number;
}

/**
 * How many scheduled changes may be outstanding.
 *
 * A drag produces one message per pixel, and each is scheduled a few
 * milliseconds out, so a handful can legitimately be in flight. Far more than
 * that means something upstream is not draining, and growing without bound in
 * the audio thread is worse than dropping the oldest.
 */
const MAX_PENDING = 64;

class EntrainmentProcessor extends AudioWorkletProcessor {
  private state: EngineState = createState();
  private target: EntrainmentParams = { ...DEFAULT_PARAMS };
  private current: EntrainmentParams = { ...DEFAULT_PARAMS, amGain: 0, twoToneGain: 0 };
  private smoothingSeconds = SOURCE_SMOOTHING_SECONDS;
  /**
   * The carrier glide, when one is running.
   *
   * `perBlock` is precomputed at the start so the approach is linear and the
   * final block lands exactly on the target, which a one-pole never would.
   * Retargeting mid-glide starts a new one from wherever the carrier has
   * reached, because `current.carrierHz` is advanced to each block's end as it
   * goes — so a stream of pointer events chains into one continuous movement.
   */
  private carrierGlide: { to: number; perBlock: number; blocksLeft: number } | null = null;
  /**
   * When the carrier last moved, so the next glide can span the gap.
   *
   * `-1` until the first change, which then takes the minimum: there is no
   * previous event to measure against, and the interval before a drag begins is
   * not a pointer cadence.
   */
  private lastCarrierFrame = -1;
  private running = true;
  private pending: PendingParams[] = [];
  /** Highest revision seen. Anything below it is superseded. */
  private newestRevision = -1;
  /**
   * The revision whose gains are still smoothing, and when to snap them.
   *
   * Adoption and settlement are different events and the graph needs both.
   * Adopting a target says the frequencies and routing have changed; it says
   * nothing about `amGain`, which is still somewhere between the old value and
   * the new one. Reporting only adoption let the graph treat the target as
   * what was sounding, and compute its next guard from gains that had not
   * arrived.
   */
  private settling: { revision: number; atFrame: number } | null = null;
  /**
   * How much of the two-tone level is currently let through, 0 to 1.
   *
   * Routing is applied to `current` only while this is zero, so the tones are
   * always silent at the instant the mode changes. Everything a routing switch
   * used to step — the tones cut off, or moved to the other ear — happens where
   * there is nothing to hear.
   */
  private toneFade = 1;
  /** Per block, signed: negative while fading out, positive while fading back. */
  private toneFadeStep = 0;
  /** The routing waiting for the fade to reach zero, if any. */
  private pendingToneMode: TwoToneMode | null = null;
  /** Whether a block has been rendered yet, which is the one start that needs no fade. */
  private rendered = false;
  /**
   * Reused so a fade allocates nothing on the audio thread.
   *
   * `render` needs the block's starting level as well as where it is going, and
   * `current.twoToneGain` has to stay the smoother's own accumulator — writing
   * the faded value back into it would make the one-pole chase its own output.
   */
  private readonly faded: EntrainmentParams = { ...DEFAULT_PARAMS };

  constructor(options?: EntrainmentProcessorOptions) {
    super();

    const initial = options?.processorOptions;
    if (initial?.smoothingSeconds !== undefined) {
      this.smoothingSeconds = Math.max(0, initial.smoothingSeconds);
    }
    if (initial?.params) {
      this.applyParams(initial.params);
      /*
       * Construction is not a routing change.
       *
       * `applyParams` starts a fade whenever the mode moves, which is right for
       * a message and wrong for the seed: there is no previous routing to leave,
       * and the first block must match the core exactly — which
       * `matches the verified core sample-for-sample` pins.
       */
      this.current.twoToneMode = this.target.twoToneMode;
      this.pendingToneMode = null;
      this.toneFade = 1;
      this.toneFadeStep = 0;
    }

    this.port.onmessage = (event: MessageEvent<EntrainmentMessage>) => {
      const msg = event.data;
      if (msg.type === 'stop') {
        this.running = false;
        return;
      }
      if (msg.smoothingSeconds !== undefined) {
        this.smoothingSeconds = Math.max(0, msg.smoothingSeconds);
      }
      if (msg.params) {
        const revision = typeof msg.revision === 'number' ? msg.revision : this.newestRevision + 1;
        // Arrived out of order, or belongs to a request already superseded.
        if (revision < this.newestRevision) return;
        this.newestRevision = revision;
        // Whatever is queued from an older request no longer describes what
        // was asked for, whenever it was due to land.
        this.pending = this.pending.filter((entry) => entry.revision > revision);

        const at = msg.applyAtFrame;
        if (typeof at === 'number' && Number.isFinite(at) && at > currentFrame) {
          this.pending.push({ atFrame: at, params: msg.params, revision });
          // Oldest first, so a dropped entry is the one most likely to have
          // been superseded anyway.
          if (this.pending.length > MAX_PENDING) this.pending.shift();
        } else {
          this.applyParams(msg.params, revision);
        }
      }
    };
  }

  /**
   * Adopt a configuration, and say so.
   *
   * The acknowledgement is the point. The graph schedules a change and cannot
   * otherwise know when — or whether — it arrived: nothing bounds port message
   * delivery, so treating the scheduled instant as proof of application lets a
   * later change compute its guard from a configuration that is not sounding.
   * The revision comes back, and the graph relaxes its attenuation only then.
   */
  private applyParams(params: Partial<EntrainmentParams>, revision?: number): void {
    // Read before the assignment, so "did the carrier move?" is a question about
    // the target and not about how far a glide in flight has got.
    const wasAiming = this.target.carrierHz;
    Object.assign(this.target, sanitizeParams(params));
    // Frequencies and envelope shape apply immediately; only levels and depth
    // are smoothed, since ramping a frequency would detune the beat.
    this.current.modulationHz = this.target.modulationHz;
    /*
     * The carrier glides; the modulation does not.
     *
     * The rule this file already stated — "ramping a frequency would detune the
     * beat" — is about `modulationHz`, which *is* the beat, and that still
     * applies at once. The carrier is the tone being modulated, and gliding it
     * is what turns a twenty-cent pointer step back into the continuous gesture
     * it was a sample of.
     */
    /*
     * Only a carrier change touches the carrier.
     *
     * This ran on every message, and the test was `current !== target` — which is
     * true for the whole length of a glide, because `current` is what is being
     * moved. So a Duty, level or routing change arriving mid-drag rebuilt the
     * glide from wherever the carrier had reached, and reset `lastCarrierFrame`
     * with it, which is the clock the next glide measures its interval against.
     * A drag that changed two things at once therefore retimed the carrier
     * against events that were not carrier events.
     *
     * The question that belongs here is whether the *target* moved, which is
     * what a pointer event on this control actually reports.
     */
    if (this.target.carrierHz !== wasAiming) {
      /*
       * Span the gap since the last carrier event, not a fixed interval.
       *
       * A pointer stream samples the hand, and its rate is whatever the hand
       * and the platform produced — 8 ms during a sweep, 150 ms when
       * hesitating. Interpolating each sample over a fixed 25 ms reconstructs
       * the fast case and leaves the slow one a series of lurches with the
       * carrier standing still between them: at 80 ms apart it was stationary
       * 67% of the time, at 150 ms apart 83%. Matching the interval means the
       * carrier is still arriving as the next sample lands, so a drag of any
       * cadence is one continuous movement.
       */
      const since =
        this.lastCarrierFrame < 0 ? 0 : (currentFrame - this.lastCarrierFrame) / sampleRate;
      const seconds = Math.min(CARRIER_GLIDE_MAX_SECONDS, Math.max(CARRIER_GLIDE_SECONDS, since));
      const blocks = Math.max(1, Math.round((seconds * sampleRate) / 128));
      this.carrierGlide = {
        to: this.target.carrierHz,
        perBlock: (this.target.carrierHz - this.current.carrierHz) / blocks,
        blocksLeft: blocks,
      };
      this.lastCarrierFrame = currentFrame;
    } else if (this.current.carrierHz === this.target.carrierHz) {
      // Arrived, and nothing new is asked for: there is nothing left to glide.
      this.carrierGlide = null;
    }
    this.current.duty = this.target.duty;
    this.current.edge = this.target.edge;
    /*
     * Routing waits for silence.
     *
     * It used to be applied here, immediately, alongside the frequencies — and
     * that is what made a routing switch a full-scale step. Turning the tones
     * off cut them at whatever they had reached; swapping between two active
     * routings moved a tone from one ear to the other. Both were measured at
     * about 0.48 against a tone amplitude of 0.5. Phase zero cannot reach either
     * of them: it only decides where the tones *start*.
     *
     * So the mode is held here and taken up by `advanceToneSwap` once the fade
     * has reached zero. When routing is already Off there is nothing to fade out
     * of, so the swap begins at zero and only fades in.
     */
    const blocks = Math.max(1, Math.round((TONE_SWAP_SECONDS * sampleRate) / 128));
    if (this.target.twoToneMode !== this.current.twoToneMode) {
      if (this.current.twoToneMode === 'off') {
        // Nothing to fade out of, so the new routing is taken up now — silently,
        // because the level it is taken up at is zero — and only faded in.
        this.current.twoToneMode = this.target.twoToneMode;
        this.pendingToneMode = null;
        this.toneFade = 0;
        this.toneFadeStep = 1 / blocks;
      } else {
        // Fade out from wherever the level currently is, which may already be
        // part way down: a mode arriving mid-swap retargets the swap rather
        // than starting a second one.
        this.pendingToneMode = this.target.twoToneMode;
        this.toneFadeStep = -1 / blocks;
      }
    } else if (this.pendingToneMode !== null) {
      /*
       * Back to the routing that is already in force, mid-swap.
       *
       * The fade is on its way down to hand over to `pendingToneMode`, and that
       * destination is now stale — leaving it would apply a routing the target
       * no longer asks for, silently, several blocks later. Abandon it and
       * bring the level back up.
       */
      this.pendingToneMode = null;
      this.toneFadeStep = 1 / blocks;
    }
    if (revision !== undefined) {
      this.port.postMessage({ type: 'applied', revision });
      this.settling = {
        revision,
        atFrame: currentFrame + Math.ceil(SOURCE_SETTLE_SECONDS * sampleRate),
      };
    }
  }

  /**
   * Adopt any scheduled change whose frame has arrived.
   *
   * Applied in the order they were scheduled, so a later change cannot be
   * overwritten by an earlier one that was merely due at the same quantum.
   */
  private drainPending(): void {
    if (this.pending.length === 0) return;
    let due = 0;
    while (due < this.pending.length && this.pending[due].atFrame <= currentFrame) due++;
    if (due === 0) return;
    // Only the newest due entry is applied. Replaying the older ones first
    // would be visible for a quantum and, worse, would leave whichever
    // happened to be last in the array as the surviving configuration.
    const newest = this.pending[due - 1];
    this.applyParams(newest.params, newest.revision);
    this.pending.splice(0, due);
  }

  /**
   * Snap the smoothed gains to their targets once the smoother has effectively
   * arrived, and say so.
   *
   * The snap is what makes "settled" mean something exact. Without it the
   * graph would be restoring the master on the strength of a gain that is
   * merely close, and nothing in the headroom bound has margin for the
   * difference.
   */
  private settleIfDue(): void {
    if (this.settling === null || currentFrame < this.settling.atFrame) return;
    // The glide is far shorter than the settle window, so this is belt and
    // braces — but "settled" has to mean exactly the target, for the carrier as
    // much as for the gains.
    this.current.carrierHz = this.target.carrierHz;
    this.carrierGlide = null;
    this.current.amGain = this.target.amGain;
    this.current.twoToneGain = this.target.twoToneGain;
    this.current.depth = this.target.depth;
    // As for the carrier: belt and braces, since a 30 ms swap finishes long
    // before a 210 ms settlement. "Settled" has to mean the routing is in force
    // and the tones are at full level, not merely on their way there.
    if (this.pendingToneMode !== null) {
      this.current.twoToneMode = this.pendingToneMode;
      this.pendingToneMode = null;
    }
    this.toneFade = 1;
    this.toneFadeStep = 0;
    this.port.postMessage({ type: 'settled', revision: this.settling.revision });
    this.settling = null;
  }

  /**
   * Move the routing fade on by one block, returning the levels that block spans.
   *
   * Linear and counted in blocks, like the carrier glide, so a fade lands
   * exactly on 0 or 1 — a one-pole would leave the tones fractionally audible at
   * the moment the mode changes, which is the step being avoided.
   *
   * **The handover is at the top of the block after the one that reached zero,
   * not at the bottom of that block.** Reaching zero is a decision about where
   * the *next* block starts; the block that carries the level down to it still
   * has to render the routing it is leaving. Swapping first made that block
   * render the new routing from the old routing's last level, which is the step
   * the whole fade exists to remove — at 32 kHz, where the fade is exactly four
   * blocks, dichotic to Off stepped 0.125 and dichotic to monaural 0.102.
   *
   * That it only showed at 32 kHz is worth keeping: the fade reaches an exact
   * zero only when `1 / blocks` is exactly representable, which needs a power of
   * two. 32 kHz gives four blocks and does; 44.1 and 48 kHz give five and six,
   * whose residue deferred the handover by a block and hid the fault. Tests that
   * only ran at 48 kHz passed on that residue rather than on the code.
   */
  private advanceToneSwap(): { from: number; to: number } {
    /*
     * Tones that were silent last block start from zero, however they come back.
     *
     * `render` starts them at the carrier's phase, not at zero, so their first
     * sample is `sin(TAU * carrierPhase)` at whatever level this block hands it.
     * A routing switch already arrives here at zero, but the level can bring them
     * back too: with routing on, a Two-tone level dragged to nothing settles at
     * exactly zero, and raising it again started the tones at the smoother's
     * first step — a full-scale step with smoothing off, and still a step with it
     * on. So whenever the tones are not sounding, the fade is held at zero and set
     * to rise, and nothing that switches them on can skip it.
     *
     * Not on the very first block. The phases are all zero there, so the tones
     * start at `sin(0)` anyway, and a seeded processor must match the core sample
     * for sample.
     */
    if (this.rendered && !this.state.toneActive && this.current.twoToneMode !== 'off') {
      this.toneFade = 0;
      if (this.pendingToneMode === null) {
        this.toneFadeStep = 1 / Math.max(1, Math.round((TONE_SWAP_SECONDS * sampleRate) / 128));
      }
    }

    if (this.toneFade === 0 && this.pendingToneMode !== null) {
      this.current.twoToneMode = this.pendingToneMode;
      this.pendingToneMode = null;
      /*
       * The tones are at exactly zero here, so this is where they restart — and
       * it is done by marking them silent rather than by writing the phases, so
       * `render` performs it through its own edge and there is one place that
       * decides what "starting up" means.
       *
       * For a swap between two active routings this re-anchors phases that were
       * already anchored: the tones kept sounding all the way down the fade, so
       * their relation to the carrier never moved. It is kept so that a swap and
       * a switch-on are the same event, not because the swap needs it.
       */
      this.state.toneActive = false;
      if (this.current.twoToneMode === 'off') {
        // Nothing to fade back into; the tones are silent from here whatever
        // this holds, so it returns to rest and this block spans nothing.
        this.toneFade = 1;
        this.toneFadeStep = 0;
      } else {
        this.toneFadeStep = Math.abs(this.toneFadeStep);
      }
    }

    const from = this.toneFade;
    if (this.toneFadeStep !== 0) {
      this.toneFade = Math.min(1, Math.max(0, this.toneFade + this.toneFadeStep));
      if (this.toneFade === 1) this.toneFadeStep = 0;
    }
    return { from, to: this.toneFade };
  }

  /** One-pole approach toward the target, per render quantum. */
  private smooth(frames: number): void {
    const tau = this.smoothingSeconds;
    const alpha = tau > 0 ? 1 - Math.exp(-frames / (tau * sampleRate)) : 1;
    this.current.amGain += (this.target.amGain - this.current.amGain) * alpha;
    this.current.twoToneGain += (this.target.twoToneGain - this.current.twoToneGain) * alpha;
    this.current.depth += (this.target.depth - this.current.depth) * alpha;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || output.length < 2) return this.running;

    const left = output[0];
    const right = output[1];
    const frames = left.length;

    this.drainPending();
    this.smooth(frames);
    // Before settlement, so a swap that has just reached its end is in force
    // when settlement asks whether everything has arrived.
    const fade = this.advanceToneSwap();
    this.settleIfDue();

    /*
     * Where the carrier reaches by the end of this block.
     *
     * `render` interpolates from `current.carrierHz` to this across the block,
     * per sample, so the glide is continuous rather than a staircase of
     * quantum-sized steps — 128 frames is 2.7 ms, and a twenty-cent step split
     * into nine of those is still nine steps.
     */
    let carrierTo: number | undefined;
    const glide = this.carrierGlide;
    if (glide !== null) {
      glide.blocksLeft -= 1;
      const last = glide.blocksLeft <= 0;
      carrierTo = last ? glide.to : this.current.carrierHz + glide.perBlock;
      if (last) this.carrierGlide = null;
    }

    /*
     * The block's own two ends, when the fade is moving.
     *
     * `render` interpolates between them per sample, for the reason the carrier
     * does: applied once per block a fade is a staircase of 2.7 ms steps, and a
     * step in a gain is the click being removed, only smaller.
     */
    let params = this.current;
    if (fade.from !== 1 || fade.to !== 1) {
      Object.assign(this.faded, this.current);
      this.faded.twoToneGain = this.current.twoToneGain * fade.from;
      params = this.faded;
    }
    const toneGainTo = params === this.faded ? this.current.twoToneGain * fade.to : undefined;

    render(params, this.state, sampleRate, left, right, frames, carrierTo, toneGainTo);
    if (carrierTo !== undefined) this.current.carrierHz = carrierTo;
    this.rendered = true;

    return this.running;
  }
}

registerProcessor('entrainment-processor', EntrainmentProcessor);
