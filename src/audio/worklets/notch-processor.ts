/**
 * The soundscape bed's notch cascade, in the audio thread.
 *
 * This used to be three `BiquadFilterNode`s in the graph, rebuilt whenever the
 * notch moved. That was forced by a real constraint — retuning a biquad that
 * is carrying signal has no peak bound, because it drags state fitted to its
 * old coefficients into its new ones — but building nodes to get a fresh state
 * changes the graph's topology while Chromium is rendering, and that is
 * audible on its own. A listening pass isolated it: rebuilding with *identical*
 * coefficients clicks just as loudly, so nothing about the filters was to
 * blame.
 *
 * Doing it here removes the whole problem rather than working around it. One
 * node exists for the life of the graph, nothing is ever connected or
 * disconnected, and a chain's state is a field that can simply be zeroed. The
 * crossfade between the old cascade and the new one is two sets of state
 * inside one processor.
 *
 * It also closes a gap rather than papering over it. `dsp/biquad.ts` was a
 * *model* of Chromium's `BiquadFilterNode`, and the headroom bound computed
 * from it needed an Electron test to establish that the two agreed. The same
 * file now provides the coefficients that actually run, so the bound is
 * computed from the implementation instead of from a description of it.
 *
 * Written in erasable TypeScript only, so it runs under Node's native type
 * stripping without a build.
 */

import { peakingSection, type BiquadSection } from '../dsp/biquad.ts';

/** Per-channel delay line for one section. */
interface SectionState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

/** One cascade: its coefficients, and one state per section per channel. */
interface Cascade {
  sections: BiquadSection[];
  /** `state[channel][section]`. */
  state: SectionState[][];
  revision: number;
}

export interface NotchMessage {
  type: 'notch' | 'stop';
  carrierHz?: number;
  modulationHz?: number;
  q?: number;
  depthDb?: number;
  /** Frame at which to begin handing over, on the `currentFrame` clock. */
  atFrame?: number;
  /** How long the handover takes. */
  crossfadeFrames?: number;
  revision?: number;
}

export interface NotchProcessorOptions {
  processorOptions?: {
    carrierHz?: number;
    modulationHz?: number;
    q?: number;
    depthDb?: number;
    channels?: number;
  };
}

/** Mirrors `notchFrequencies` in dsp/biquad.ts, including its 20 Hz floor. */
function frequencies(carrierHz: number, modulationHz: number): number[] {
  return [carrierHz - modulationHz, carrierHz, carrierHz + modulationHz].map((f) =>
    Math.max(20, f),
  );
}

function freshState(channels: number, sections: number): SectionState[][] {
  const state: SectionState[][] = [];
  for (let c = 0; c < channels; c++) {
    const perSection: SectionState[] = [];
    for (let s = 0; s < sections; s++) perSection.push({ x1: 0, x2: 0, y1: 0, y2: 0 });
    perSection.length = sections;
    state.push(perSection);
  }
  return state;
}

const MAX_PENDING = 64;

class NotchProcessor extends AudioWorkletProcessor {
  private channels = 2;
  private active: Cascade;
  /** The cascade being faded in, if a handover is under way. */
  private incoming: Cascade | null = null;
  /** Handover progress in frames, and its length. */
  private fadeFrame = 0;
  private fadeFrames = 0;
  private pending: { atFrame: number; cascade: Cascade; crossfadeFrames: number }[] = [];
  private newestRevision = -1;
  private running = true;

  constructor(options?: NotchProcessorOptions) {
    super();
    const initial = options?.processorOptions;
    this.channels = Math.max(1, initial?.channels ?? 2);
    this.active = this.build(
      initial?.carrierHz ?? 220,
      initial?.modulationHz ?? 40,
      initial?.q ?? 8,
      initial?.depthDb ?? 6,
      -1,
    );

    this.port.onmessage = (event: MessageEvent<NotchMessage>) => {
      const message = event.data;
      if (message.type === 'stop') {
        this.running = false;
        return;
      }

      const revision =
        typeof message.revision === 'number' ? message.revision : this.newestRevision + 1;
      // Superseded, or arrived out of order. Same rule as the entrainment
      // processor: a message cannot be recalled, so it has to be discardable.
      if (revision < this.newestRevision) return;
      this.newestRevision = revision;
      this.pending = this.pending.filter((entry) => entry.cascade.revision > revision);

      const cascade = this.build(
        message.carrierHz ?? 220,
        message.modulationHz ?? 40,
        message.q ?? 8,
        message.depthDb ?? 6,
        revision,
      );
      const crossfadeFrames = Math.max(1, Math.floor(message.crossfadeFrames ?? 1));
      const at = message.atFrame;

      if (typeof at === 'number' && Number.isFinite(at) && at > currentFrame) {
        this.pending.push({ atFrame: at, cascade, crossfadeFrames });
        if (this.pending.length > MAX_PENDING) this.pending.shift();
      } else if (this.incoming !== null) {
        // Due now, but something is still handing over. Queue it at the
        // current frame so it starts the moment that finishes.
        this.pending.push({ atFrame: currentFrame, cascade, crossfadeFrames });
        if (this.pending.length > MAX_PENDING) this.pending.shift();
      } else {
        this.begin(cascade, crossfadeFrames);
      }
    };
  }

  /**
   * A cascade with zero state.
   *
   * The reason this processor exists: a fresh state costs a field assignment
   * here, where in the graph it cost four nodes and a topology change.
   */
  private build(
    carrierHz: number,
    modulationHz: number,
    q: number,
    depthDb: number,
    revision: number,
  ): Cascade {
    const sections = frequencies(carrierHz, modulationHz).map((f) =>
      peakingSection(f, q, -Math.abs(depthDb), sampleRate),
    );
    return { sections, state: freshState(this.channels, sections.length), revision };
  }

  /**
   * Start handing over to `cascade`.
   *
   * If one is already under way it is completed first, so the outgoing cascade
   * is always whatever is actually sounding rather than something the previous
   * handover had not finished replacing.
   */
  /**
   * Start handing over to `cascade`. Only ever called when none is running.
   *
   * An earlier version completed the fade in progress first, which snapped the
   * output to a cascade it was only part-way toward — a discontinuity, and
   * exactly the splice the crossfade exists to avoid. Callers wait instead.
   */
  private begin(cascade: Cascade, crossfadeFrames: number): void {
    this.incoming = cascade;
    this.fadeFrame = 0;
    this.fadeFrames = crossfadeFrames;
    this.port.postMessage({ type: 'notch-applied', revision: cascade.revision });
  }

  private finish(): void {
    if (this.incoming === null) return;
    this.active = this.incoming;
    this.incoming = null;
    this.port.postMessage({ type: 'notch-settled', revision: this.active.revision });
  }

  private drainPending(): void {
    if (this.pending.length === 0) return;
    // A handover in progress is never interrupted. The entry stays queued and
    // is picked up on the quantum after it finishes.
    if (this.incoming !== null) return;
    let due = 0;
    while (due < this.pending.length && this.pending[due].atFrame <= currentFrame) due++;
    if (due === 0) return;
    // Only the newest due entry; the others were superseded before they landed.
    const newest = this.pending[due - 1];
    this.pending.splice(0, due);
    this.begin(newest.cascade, newest.crossfadeFrames);
  }

  /** One sample through one cascade, for one channel. */
  private step(cascade: Cascade, channel: number, input: number): number {
    let v = input;
    const states = cascade.state[channel];
    for (let i = 0; i < cascade.sections.length; i++) {
      const s = cascade.sections[i];
      const t = states[i];
      const y = s.b0 * v + s.b1 * t.x1 + s.b2 * t.x2 - s.a1 * t.y1 - s.a2 * t.y2;
      t.x2 = t.x1;
      t.x1 = v;
      t.y2 = t.y1;
      t.y1 = y;
      v = y;
    }
    return v;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];
    if (!output) return this.running;

    this.drainPending();

    const frames = output[0]?.length ?? 0;
    for (let c = 0; c < output.length; c++) {
      const source = input?.[c];
      const target = output[c];
      // A disconnected or silent input still has to advance the filter state,
      // or the cascade would carry stale history into the next sound.
      for (let i = 0; i < frames; i++) {
        const x = source ? source[i] : 0;
        const dry = this.step(this.active, c, x);
        if (this.incoming === null) {
          target[i] = dry;
          continue;
        }
        const wet = this.step(this.incoming, c, x);
        // Linear, summing to one: the two cascades carry the same input, so
        // they are correlated and an equal-power pair would overshoot.
        const u = Math.min(1, (this.fadeFrame + i) / this.fadeFrames);
        target[i] = dry * (1 - u) + wet * u;
      }
    }

    if (this.incoming !== null) {
      this.fadeFrame += frames;
      if (this.fadeFrame >= this.fadeFrames) this.finish();
    }

    return this.running;
  }
}

registerProcessor('notch-processor', NotchProcessor);
