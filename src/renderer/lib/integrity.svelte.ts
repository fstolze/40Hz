/**
 * What the checks say right now, in one place.
 *
 * The single current view. Every producer writes here — the engine self-test,
 * the device observations, and the capture measurements — and everything that
 * needs to know reads the same value: the footer, the detail panel, and the
 * reporter that sends findings to the session coordinator. Building one set of
 * findings for display and a second for reporting would be two answers to one
 * question, and they would drift.
 *
 * **This is the current view and nothing else.** The coordinator keeps the
 * worst checked result seen during a session; this keeps what is true now, so a
 * fault the user has fixed stops being shown while the session's record still
 * remembers it. Those are different questions, deliberately answered
 * differently, and there is no read-back from the coordinator — a channel that
 * merged the two would blur the semantics and still say nothing useful in the
 * state this app spends most of its time in, which is "nothing checked yet".
 *
 * Nothing about *delivery of a report* belongs in here. Whether the coordinator
 * accepted a report changes whether it was recorded, not whether the
 * measurement is true, so a refusal must never edit a finding.
 */

import { CurrentView, type Producer } from '../../integrity/current-view.ts';
import { coverageSummary, type CoverageSummary } from '../../integrity/summary.ts';
import { runSelfTest } from '../../integrity/self-test.ts';
import type { Finding } from '../../integrity/findings.ts';

class IntegrityState {
  /**
   * The assembly rules live in `current-view.ts`, which has no runes in it.
   *
   * What is left here is publishing: the view is a plain object, so each
   * change is pushed into `$state` for the surfaces watching it.
   */
  private readonly view = new CurrentView();

  /** True once the self-test has been run, so it runs once and not per read. */
  private selfTested = false;

  /**
   * Everything the checks currently say, placeholders included.
   *
   * `$state.raw`, not `$state`, and not a matter of taste: a deep-proxied value
   * **cannot cross IPC**. This array is sent to the coordinator as a session
   * report, and structured clone refuses a proxy — "An object could not be
   * cloned", swallowed by a best-effort caller, so the session recorded no
   * coverage at all and nothing anywhere said why. Raw is also the right shape
   * regardless: the whole array is replaced on every change, so there is
   * nothing for deep reactivity to earn.
   */
  findings = $state.raw<Finding[]>(this.view.findings);

  get summary(): CoverageSummary {
    return coverageSummary(this.findings);
  }

  /**
   * Take what a producer says now, in place of whatever it said before.
   *
   * Per producer rather than per finding id: a capture pass emits a different
   * set depending on what it could measure, so replacing by id would leave a
   * refusal standing after every later success that never mentions it.
   */
  record(producer: Producer, findings: readonly Finding[]): void {
    this.view.record(producer, findings);
    this.findings = this.view.findings;
  }

  /**
   * Prove the shipped build's DSP on this machine.
   *
   * Offline arithmetic, so it needs no graph and makes no sound — and it is
   * what CI cannot do: CI proves the checkout, this proves the binary the user
   * is actually running. Roughly 56 ms, once per launch, off the first paint.
   */
  runSelfTest(): void {
    if (this.selfTested) return;
    this.selfTested = true;
    this.record('self-test', runSelfTest());
  }
}

export const integrity = new IntegrityState();

// Deferred rather than run at import: it is tens of milliseconds of arithmetic,
// and the window may as well be on screen first. Anything that reads the
// summary before it lands sees "nothing checked yet", which is true until then.
if (typeof globalThis.setTimeout === 'function') {
  setTimeout(() => {
    integrity.runSelfTest();
  }, 0);
}
