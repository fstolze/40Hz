/**
 * When a capture pass is worth taking, and what to do with a run of changes.
 *
 * Event-driven, never periodic. A pass costs an offline render of the
 * reference to compare against, and this app is meant to be ambient — so it
 * measures at the moments the answer can have changed (playback starting, the
 * configuration moving) and otherwise leaves the CPU alone.
 *
 * Three rules, and each exists because of a specific way the naive version is
 * wrong:
 *
 * - **The last change wins, and is not dropped.** Dragging a slider is dozens
 *   of changes; an in-flight guard that simply refused the ones arriving during
 *   a pass would discard the final position, which is the only one that
 *   matters. A change during a pass is remembered and re-run after it.
 * - **A pass is scheduled a whole window past steadiness**, because a tap
 *   answers with the most recent audio: asking any earlier reaches back through
 *   the ramp and the result is refused. `passDelaySeconds` owns that.
 * - **What was measured stops being current when the configuration moves.**
 *   The findings describe settings that are no longer in force, and the ring
 *   itself is epoched at that moment, so they are withdrawn rather than left
 *   standing until the next pass lands. Playback merely stopping is different:
 *   nothing about the audio that played became untrue, so those findings stay.
 */

import { passDelaySeconds, runCaptureChecks, windowFramesFor } from './capture-run.ts';
import type { MeasurableOutput } from './capture-run.ts';
import type { Finding } from './findings.ts';
import type { Schedule } from '../lib/schedule.ts';
import type { EntrainmentParams } from '../audio/dsp/entrainment-core.ts';

/** What the schedule needs from whoever owns the graph. */
export interface CaptureHost {
  /** What to measure, or null when there is no graph to measure. */
  output(): MeasurableOutput | null;
  params(): EntrainmentParams;
  /** The context clock, in seconds — the same one steadiness is expressed in. */
  now(): number;
  /** Take the pass's findings, or withdraw the producer with an empty list. */
  record(findings: Finding[]): void;
  /** A failure nobody is awaiting. */
  onError(error: unknown): void;
}

export class CaptureSchedule {
  private readonly host: CaptureHost;
  private readonly schedule: Schedule;

  /** A pass is running; anything arriving now waits for it. */
  private running = false;
  /**
   * A *change* arrived during a pass, and has not been acted on yet.
   *
   * Kept apart from `pendingRun` on purpose. A change means what was measured
   * is stale and must be withdrawn; a scheduled pass colliding with a running
   * one means nothing of the sort. Sharing one flag made a timer that happened
   * to fire during a manual check withdraw the result that check had just
   * produced, bump the generation, and schedule a third pass — all because
   * something else was already running.
   */
  private pendingChange = false;
  /** A scheduled pass arrived while another was running. Nothing is stale. */
  private pendingRun = false;
  /**
   * The pass currently measuring, for anyone who needs to wait for it.
   *
   * Only the manual check does. It has a caller — a button showing "Checking…"
   * — and returning while a pass is still in flight clears that state having
   * measured nothing, which reads as a button that does not work.
   */
  private inFlight: Promise<void> | null = null;
  /**
   * Bumped by every change and every stop.
   *
   * Claimed before the pass and rechecked after it: a pass that lands after
   * the configuration moved describes audio recorded under settings no longer
   * in force, and recording it would put back exactly what the change withdrew.
   */
  private generation = 0;

  constructor(host: CaptureHost, schedule: Schedule) {
    this.host = host;
    this.schedule = schedule;
  }

  /**
   * Something changed that makes the last pass stale: playback started, or the
   * configuration moved.
   *
   * Coalescing is the whole point — each call replaces the pending pass, so a
   * drag of fifty changes costs one measurement rather than fifty.
   */
  changed(): void {
    this.generation += 1;
    this.host.record([]);
    this.schedule.cancel();

    if (this.running) {
      // Remembered rather than refused. The pass in flight is about to be
      // discarded for being from an older generation, and dropping this would
      // leave the newest configuration unmeasured until something else moved.
      this.pendingChange = true;
      return;
    }

    const delay = this.delaySeconds();
    if (delay === null) return;
    this.schedule.after(delay * 1000, () => {
      void this.run();
    });
  }

  /** Playback stopped: nothing more to measure, and nothing to unsay. */
  stopped(): void {
    this.generation += 1;
    this.pendingChange = false;
    this.pendingRun = false;
    this.schedule.cancel();
  }

  /**
   * Measure now, whatever the schedule had planned.
   *
   * What the manual action calls, and it means *now*: the wait for a judgeable
   * window is skipped rather than honoured, because a button that returns
   * having quietly rescheduled is a button that did nothing. If the window
   * overlaps a ramp the pass says exactly that, which is an answer.
   *
   * The pending automatic pass is left alone. Cancelling it would trade a
   * measurement the user asked for against the one that was coming anyway,
   * and the second is the one that will have a judgeable window.
   */
  async runNow(): Promise<void> {
    const running = this.inFlight;
    if (running === null) {
      await this.run({ immediately: true });
      return;
    }

    // A pass is already measuring. Joining it answers the same question
    // without capturing a second window, and — the reason this is not simply
    // "return" — keeps the caller waiting until there is an answer to show.
    const generation = this.generation;
    await running;

    // Unless it was discarded for being from an older generation, in which
    // case nobody has answered the question the user asked.
    if (generation !== this.generation) await this.run({ immediately: true });
  }

  /** How long until a pass could produce a judgeable window, or null. */
  private delaySeconds(): number | null {
    const output = this.host.output();
    if (output === null) return null;
    const frames = windowFramesFor(this.host.params(), output);
    return passDelaySeconds(output.steadyPlayback(), this.host.now(), frames / output.sampleRate);
  }

  private async run({ immediately = false } = {}): Promise<void> {
    const output = this.host.output();
    if (output === null) return;
    if (this.running) {
      // Another pass is mid-flight — a manual check, most likely, since that
      // is the only one that runs without waiting. This is not a change:
      // remember to run again afterwards, and leave what was measured alone.
      this.pendingRun = true;
      return;
    }

    // The timer runs on the wall clock; `steady.from` is on the audio clock,
    // and the two drift — a context does not advance its clock while it is
    // suspended or resuming, so a wall-clock delay can land early. Measured on
    // a real graph, a pass aimed at the boundary arrived with the window
    // starting 98 ms before it, which the steadiness check then correctly
    // refused. So the answer is asked for again on waking rather than assumed
    // to still hold, and a pass that is still early reschedules itself.
    //
    // Except when a person asked. Then the pass runs and reports what it
    // found, ramp and all.
    if (!immediately) {
      const remaining = this.delaySeconds();
      if (remaining !== null && remaining > 0) {
        this.schedule.after(remaining * 1000, () => {
          void this.run();
        });
        return;
      }
    }

    const generation = this.generation;
    this.running = true;
    const task = (async () => {
      const findings = await runCaptureChecks(output, this.host.params());
      // Rechecked after the await, not merely before it: a configuration
      // change during the pass makes this a report about settings that are no
      // longer in force.
      if (generation === this.generation) this.host.record(findings);
    })();
    this.inFlight = task;

    try {
      await task;
    } catch (error) {
      this.host.onError(error);
    } finally {
      this.inFlight = null;
      this.running = false;
      if (this.pendingChange) {
        this.pendingChange = false;
        this.pendingRun = false;
        this.changed();
      } else if (this.pendingRun) {
        this.pendingRun = false;
        // A plain re-run: it re-checks the delay and either measures or waits.
        // Nothing is withdrawn, because nothing became stale.
        void this.run();
      }
    }
  }
}
