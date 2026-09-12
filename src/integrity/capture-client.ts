/**
 * Asking a capture tap for a window, from the side that is not the audio
 * thread.
 *
 * Expressed against a minimal port interface rather than `AudioWorkletNode`, so
 * the correlation, the timeouts and the epoch handling can be driven in Node
 * against a fake — the same reason `session-envelope.ts` takes an `AudioParam`
 * slice instead of the real thing. Nothing here touches Web Audio.
 *
 * The tap answers a request when a whole window has accumulated since the last
 * epoch, which may be immediately or may be seconds away. So every request is a
 * promise, several can be outstanding, and each reply is matched to its
 * question by id.
 */

import type {
  CaptureReply,
  CaptureRefusal,
  CaptureWindow,
} from '../audio/worklets/capture-processor.ts';

/** The slice of `MessagePort` this needs. */
export interface CapturePort {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
}

export interface CaptureResult {
  ok: boolean;
}

export interface CaptureFailure extends CaptureResult {
  ok: false;
  /** `'timeout'` is this side's; the rest come from the tap. */
  reason: CaptureRefusal | 'timeout' | 'closed';
}

export type CaptureOutcome = CaptureWindow | CaptureFailure;

/**
 * How long to wait for a window before giving up, beyond the time the window
 * itself takes to fill.
 *
 * A request that can be satisfied is answered the moment enough audio has been
 * written, so this only ever fires when audio stopped arriving — a suspended
 * context, a node that was never connected, a worklet that failed to load.
 * Those are exactly the cases where waiting forever would leave a caller
 * holding a promise nobody will ever settle, and the integrity report would
 * simply never arrive rather than saying it could not be gathered.
 */
const GRACE_MS = 2000;

interface Pending {
  resolve(outcome: CaptureOutcome): void;
  timer: ReturnType<typeof setTimeout>;
}

export class CaptureTap {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  /**
   * Which epoch this side believes it is in.
   *
   * Bumped before the message goes out, so it is already ahead of any reply
   * still crossing from the tap. A window carries the epoch it was recorded in,
   * and one that does not match this is audio from a configuration that has
   * been replaced.
   */
  private epochId = 0;

  private readonly port: CapturePort;
  private readonly sampleRate: number;
  private readonly graceMs: number;

  // Assigned in the body rather than as parameter properties: the repo compiles
  // with `erasableSyntaxOnly`, which rules those out.
  constructor(port: CapturePort, sampleRate: number, graceMs = GRACE_MS) {
    this.port = port;
    this.sampleRate = sampleRate;
    this.graceMs = graceMs;
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      const reply = event.data as CaptureReply | undefined;
      if (reply === undefined || reply.type !== 'capture') return;
      this.settle(reply);
    };
  }

  /**
   * Discard whatever the tap has recorded.
   *
   * Sent on every configuration change and at session start: audio from before
   * one of those belongs to a different question.
   *
   * Both sides track this, and both have to. The tap refuses what is still
   * queued there; this side refuses what it is still waiting for, because a
   * window can already have been recorded and posted before the change and the
   * tap has nothing left to refuse by then.
   */
  epoch(): void {
    if (this.closed) return;

    // Settled here and not only at the tap. Messages cross a thread boundary,
    // so a window recorded under the old configuration can already be in
    // flight when this is called — the tap has nothing left to refuse, and the
    // reply would otherwise be resolved as a perfectly good window of audio
    // the configuration no longer describes. Which is the whole failure epochs
    // exist to prevent, arriving through the one door they did not cover.
    this.epochId += 1;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, reason: 'epoch-changed' });
      this.pending.delete(id);
    }

    this.port.postMessage({ type: 'epoch' });
  }

  /** Ask for the most recent `frames`, answered when that much exists. */
  capture(frames: number): Promise<CaptureOutcome> {
    if (this.closed) return Promise.resolve({ ok: false, reason: 'closed' });

    const id = this.nextId;
    this.nextId += 1;

    return new Promise<CaptureOutcome>((resolve) => {
      // The window cannot arrive faster than it takes to play, so the deadline
      // is that plus a grace, not a constant. A 16-second window at 0.5 Hz
      // would otherwise time out every time.
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          // Withdrawn at the tap as well. Left there it keeps counting against
          // the tap's queue, so a run of timeouts ends up refusing live
          // requests, and it still allocates and transfers a whole window if
          // the audio it waits for ever arrives.
          this.port.postMessage({ type: 'cancel', id });
          resolve({ ok: false, reason: 'timeout' });
        },
        (frames / this.sampleRate) * 1000 + this.graceMs,
      );

      this.pending.set(id, { resolve, timer });
      this.port.postMessage({ type: 'capture', id, frames });
    });
  }

  /**
   * Stop recording and settle everything outstanding.
   *
   * The tap settles its own queue when told to stop, but a reply cannot arrive
   * after the port is gone — so anything still here is resolved from this side
   * rather than left pending for the lifetime of the page.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.port.postMessage({ type: 'stop' });
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, reason: 'closed' });
      this.pending.delete(id);
    }
  }

  private settle(reply: CaptureReply): void {
    const pending = this.pending.get(reply.id);
    // A reply with no question is not an error: a request that timed out, or
    // was abandoned at an epoch, can still be answered by the tap afterwards.
    // Dropping it is the correct handling rather than a case to report.
    if (pending === undefined) return;

    // Belt and braces against the same race the epoch bump above closes: a
    // window stamped with an epoch this side has moved past is audio from a
    // configuration that no longer applies, whatever the queue says.
    if (reply.ok && reply.epoch !== this.epochId) return;

    this.pending.delete(reply.id);
    clearTimeout(pending.timer);
    pending.resolve(reply.ok ? reply : { ok: false, reason: reply.reason });
  }
}
