/**
 * Session storage for `dev:web`, where there is no main process.
 *
 * Deliberately the same interface the disk store satisfies, so the coordinator
 * cannot tell the difference. It is not as durable — `localStorage` is
 * synchronous and unversioned — but it is enough to exercise the whole session
 * lifecycle in a browser, which is what keeps the UI verifiable without
 * launching Electron.
 */

import type { Checkpoint, SessionStorage } from '../../session/coordinator.ts';
import { normalizeCheckpoint } from '../../session/normalize.ts';
import { readHistory, writeHistory } from './browser-history.ts';
import { noteBrowserHistoryChanged } from './stores.ts';
import type { SessionRecord } from '../../session/session.ts';

const CHECKPOINT_KEY = 'fortyhz.checkpoint.v1';

/** How the history is stored is `browser-history.ts`'s business, not this one's. */
export function readBrowserHistory(): SessionRecord[] {
  return readHistory();
}

export function browserSessionStorage(): SessionStorage {
  return {
    async appendHistory(record: SessionRecord): Promise<void> {
      const held = readBrowserHistory();
      // Idempotent by id, as the disk store is: recovery re-appends a record
      // it cannot know already landed.
      if (held.some((r) => r.id === record.id)) return;
      const next = [...held, record];
      writeHistory(next);
      // Every surface reading listening time, the advisory or recall is
      // watching the store, and this write does not go through it.
      noteBrowserHistoryChanged(next);
    },

    async readCheckpoint(): Promise<Checkpoint | null> {
      const raw = globalThis.localStorage?.getItem(CHECKPOINT_KEY);
      if (!raw) return null;
      try {
        // Normalized, not cast. A half-written checkpoint would otherwise
        // throw inside recovery, which fails open — leaving the coordinator
        // settled and free to start a session that clears the old one.
        return normalizeCheckpoint(JSON.parse(raw));
      } catch {
        return null;
      }
    },

    async writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
      globalThis.localStorage?.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    },

    async clearCheckpoint(): Promise<void> {
      globalThis.localStorage?.removeItem(CHECKPOINT_KEY);
    },
  };
}
