/**
 * Serialized playback transitions.
 *
 * `AudioContext.resume()` and `suspend()` are asynchronous, so start and stop
 * can interleave in ways a plain flag cannot express:
 *
 * - A stop that has already decided to suspend can complete *after* a new
 *   start, silencing playback the user just asked for.
 * - A start that claims its place only after awaiting `resume()` can end up
 *   looking newer than a stop the user issued later, so the stop stands down
 *   and the audio keeps running.
 *
 * The second is the worse of the two: the user's most recent intent loses.
 *
 * Two mechanisms together fix it. A generation token is claimed *before* any
 * awaiting, so ordering reflects when an operation was requested rather than
 * when its first await happened to resolve. And every context transition runs
 * through one queue, so a resume and a suspend can never be in flight at once.
 *
 * No Web Audio here, so the ordering can be tested directly.
 */

import { Serial } from '../lib/serial.ts';

export class TransitionQueue {
  private readonly serial = new Serial();
  private latest = 0;

  /**
   * Take the next generation.
   *
   * Call this synchronously at the top of an operation, before any `await`.
   */
  claim(): number {
    return ++this.latest;
  }

  /** False once a later operation has claimed its own generation. */
  isCurrent(generation: number): boolean {
    return generation === this.latest;
  }

  /** The generation most recently claimed. */
  get current(): number {
    return this.latest;
  }

  /** Run `work` after everything already queued, and never alongside it. */
  run<T>(work: () => Promise<T>): Promise<T> {
    return this.serial.run(work);
  }
}
