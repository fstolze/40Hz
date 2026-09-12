/**
 * When to do something later, injected so the boundary is testable.
 *
 * One pending callback at a time by construction: `after` replaces whatever
 * was scheduled, and `cancel` drops it. Two things in this app need exactly
 * that — the delayed re-read of output latency, and the trailing capture pass
 * that coalesces a run of configuration changes — and both have a guard that
 * only means something if a test can fire the timer by hand.
 */

/** The contract: one pending callback, replaced by `after`, dropped by `cancel`. */
export interface Schedule {
  after(delayMs: number, fire: () => void): void;
  cancel(): void;
}

/** The real one. A handle rather than a closure, so a cancel can find it. */
export function timerSchedule(): Schedule {
  let handle: ReturnType<typeof setTimeout> | null = null;
  return {
    after(delayMs, fire) {
      if (handle !== null) clearTimeout(handle);
      handle = setTimeout(() => {
        handle = null;
        fire();
      }, delayMs);
    },
    cancel() {
      if (handle !== null) clearTimeout(handle);
      handle = null;
    },
  };
}
