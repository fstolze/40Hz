/** Tray availability is runtime state, not a preference or proof from new Tray(). */
export class TrayAvailability {
  #available: boolean | null = null;
  #listeners = new Set<(available: boolean) => void>();

  get current(): boolean | null {
    return this.#available;
  }

  set(available: boolean): void {
    if (available === this.#available) return;
    this.#available = available;
    for (const listener of [...this.#listeners]) listener(available);
  }

  subscribe(listener: (available: boolean) => void): {
    initial: boolean | null;
    unsubscribe(): void;
  } {
    this.#listeners.add(listener);
    return { initial: this.current, unsubscribe: () => this.#listeners.delete(listener) };
  }
}

export interface TrayProbe {
  read(): Promise<boolean>;
  watch(changed: () => void, failed: () => void): () => void;
}

export interface TrayRetryScheduler {
  later(task: () => void, milliseconds: number): () => void;
}

const retryScheduler: TrayRetryScheduler = {
  later(task, milliseconds) {
    const timer = setTimeout(task, milliseconds);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** Ignore stale reads, including one that finishes after the monitor has failed. */
export function monitorTray(
  probe: TrayProbe,
  availability: TrayAvailability,
  scheduler: TrayRetryScheduler = retryScheduler,
): () => void {
  let stopped = false;
  let revision = 0;
  let reading = false;
  let failures = 0;
  let cancelRetry = () => {};
  const refresh = (): void => {
    if (stopped) return;
    cancelRetry();
    cancelRetry = () => {};
    revision += 1;
    if (reading) return;
    reading = true;
    void (async () => {
      try {
        while (!stopped) {
          const requested = revision;
          let available: boolean;
          try {
            available = await probe.read();
          } catch {
            if (stopped) return;
            if (requested !== revision) continue;
            failures += 1;
            // One timeout is uncertainty, not evidence that the icon vanished.
            // Keep the last answer through the first retry; persistent errors
            // withdraw it, but keep retrying without requiring another signal.
            if (failures >= 2) availability.set(false);
            const delay = Math.min(250 * 2 ** Math.min(failures - 1, 5), 5000);
            cancelRetry = scheduler.later(refresh, delay);
            break;
          }
          if (stopped) return;
          if (requested !== revision) continue;
          failures = 0;
          availability.set(available);
          break;
        }
      } finally {
        reading = false;
      }
    })();
  };
  const fail = (): void => {
    stopped = true;
    cancelRetry();
    revision += 1;
    availability.set(false);
  };
  const stopWatching = probe.watch(refresh, fail);
  refresh();
  return () => {
    fail();
    stopWatching();
  };
}
