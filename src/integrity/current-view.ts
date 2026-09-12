/**
 * What the checks say now, assembled from what each producer last said.
 *
 * Per **producer**, not per finding id, and the difference is the whole reason
 * this module exists. A capture pass does not emit a fixed set of findings: a
 * successful one produces `graph-envelope-*`, `graph-spectrum`, `graph-master-signal`
 * and their neighbours, while a refused one produces a single
 * `graph-master-window` saying why there was no audio to judge. Merging those
 * by id — which is right for the session aggregate, and was what this did —
 * leaves the refusal standing forever, because nothing a later pass emits
 * shares its id. One timeout, one configuration change mid-window, one ramp
 * overlap, and the panel says the output was never measured for the rest of
 * the run, however many clean passes follow.
 *
 * So a producer replaces its own answer wholesale. What it does not say this
 * time, it is no longer saying.
 *
 * This is the current view and only that. The coordinator keeps the worst
 * checked result seen during a session, by id, and must go on doing so — a
 * fault that has been fixed is history rather than a current fault, and the
 * two answers are allowed to differ.
 */

import { replaceFindings, snapshotFinding, type Finding } from './findings.ts';
import { missingScopeFindings } from './rules.ts';

/**
 * Who reported. Not a fixed union: the point is that a producer owns its own
 * set, and a new one should need nothing here.
 */
export type Producer = string;

export class CurrentView {
  /** Insertion-ordered, so the panel does not reshuffle between passes. */
  private readonly byProducer = new Map<Producer, Finding[]>();

  /**
   * Take what a producer says now, in place of whatever it said before.
   *
   * An empty report withdraws it entirely rather than being ignored: a
   * producer with nothing to say should leave its scope looking unreported,
   * not leave its last answer standing as though it were still true.
   */
  record(producer: Producer, findings: readonly Finding[]): void {
    if (findings.length === 0) {
      this.byProducer.delete(producer);
      return;
    }
    // Copies, so a producer that keeps its array and mutates it cannot rewrite
    // what the panel is showing.
    this.byProducer.set(producer, findings.map(snapshotFinding));
  }

  /**
   * Everything reported, in the order the producers first reported.
   *
   * Copies, because this hands out what the map is holding: the array was new
   * but the findings in it were the stored objects, so a caller could edit one
   * and change what every later view showed. `findings` is safe by a different
   * route — `replaceFindings` copies what it keeps — but a getter that is safe
   * only because of what its one caller happens to do is a getter waiting to
   * be called from somewhere else.
   */
  get reported(): Finding[] {
    return this.stored.map(snapshotFinding);
  }

  /** The stored objects themselves. Never leaves this class. */
  private get stored(): Finding[] {
    return [...this.byProducer.values()].flat();
  }

  /**
   * The reported findings, with a placeholder for every scope still silent.
   *
   * A scope with nothing in it reads exactly like a scope with nothing wrong,
   * so the placeholders are not decoration — and which scopes need one follows
   * from what has been reported, so a scope stops needing one the moment a
   * producer covers it.
   */
  get findings(): Finding[] {
    // From `stored` rather than `reported`: `replaceFindings` copies what it
    // keeps, so a snapshot on the way in would be a second copy of everything
    // for nothing.
    const reported = this.stored;
    return replaceFindings(missingScopeFindings(reported), reported);
  }
}
