/**
 * The main process's wiring for the session coordinator.
 *
 * The coordinator itself knows nothing about Electron. These are the two
 * adapters that give it a real store and real audio: the same machine runs
 * under `dev:web` against `localStorage` and the local engine.
 */

import { performance } from 'node:perf_hooks';
import type { Store } from './store.ts';
import type {
  AudioExecutor,
  Checkpoint,
  Clock,
  Scheduler,
  SessionStorage,
  StartAudioRequest,
} from '../src/session/coordinator.ts';
import type { SessionRecord } from '../src/session/session.ts';
import type { SessionConfiguration } from '../src/audio/configuration.ts';
import type { ExecutorLink } from '../src/session/executor-link.ts';

/**
 * Wall time for records, monotonic for elapsed runtime.
 *
 * `performance.now()` does not move when the system clock is corrected, which
 * is the whole point: a session already running must not stretch or shrink
 * because NTP stepped the clock.
 */
export const systemClock: Clock = {
  wallNow: () => Date.now(),
  monotonicNow: () => performance.now(),
};

export const systemScheduler: Scheduler = {
  setTimer: (delayMs, fire) => setTimeout(fire, delayMs),
  clearTimer: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export function storeSessionStorage(store: Store): SessionStorage {
  return {
    appendHistory: async (record: SessionRecord) => {
      await store.appendHistory(record);
    },
    readCheckpoint: () => store.readCheckpoint(),
    writeCheckpoint: (checkpoint: Checkpoint) => store.writeCheckpoint(checkpoint),
    clearCheckpoint: () => store.clearCheckpoint(),
  };
}

/**
 * Drives audio in whichever renderer registered as the executor.
 *
 * The graph lives in Studio, so every one of these is a command over the
 * link — carrying a correlation id, timing out rather than hanging, and
 * withdrawable through the signal when the coordinator changes its mind.
 */
export function linkAudioExecutor(link: ExecutorLink): AudioExecutor {
  return {
    async startSession(request: StartAudioRequest, signal: AbortSignal): Promise<number | null> {
      const result = await link.send('startSession', request, { signal, timeoutMs: 10_000 });
      // The renderer answers with the instant audio actually began. Anything
      // else means it could not start, and no session should be recorded.
      return typeof result === 'number' ? result : null;
    },
    async startPreview(configuration: SessionConfiguration): Promise<void> {
      await link.send('startPreview', configuration);
    },
    async stop(fadeOutSeconds: number): Promise<void> {
      await link.send('stop', { fadeOutSeconds });
    },
  };
}
