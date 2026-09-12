/**
 * The `dev:web` history, and the one place that knows how it is stored.
 *
 * Two modules used to read and write this key with their own copies of the
 * parsing — the session storage the coordinator writes through, and the store
 * the UI reads. Two copies of a format is a format that drifts, and it drifted
 * the moment the records gained a meaning that had to be corrected.
 *
 * **The key carries the version**, as it always has: `fortyhz.history.v1` was
 * written before session records had integrity coverage at all, and everything
 * up to `HISTORY_VERSION` 2 recorded `graph` coverage from a device property
 * that was later withdrawn as a check. Those records claim this app's output
 * was verified when nothing measured it, and — the worse half — would be
 * indistinguishable from the ones real capture measurements will produce. So
 * the key moves with the record shape, and what was under the old one is
 * corrected on the way across rather than trusted or thrown away.
 *
 * At the next boundary, add the old key to `SUPERSEDED_KEYS` and correct on
 * read the same way. Deleting it instead is also a defensible answer for
 * development data — but it has to be a decision, not an omission.
 */

import { normalizeSessionRecord, withoutWithdrawnCoverage } from '../../session/normalize.ts';
import type { SessionRecord } from '../../session/session.ts';

/** The slice of `localStorage` this needs, so the migration is testable. */
export interface WebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Named for the record shape it holds, matching the disk store's
 * `HISTORY_VERSION`. Not derived from it: that constant lives beside `node:fs`
 * imports and has no business in a browser bundle.
 */
export const HISTORY_KEY = 'fortyhz.history.v3';

/** Older keys, newest first, each holding records that need correcting. */
const SUPERSEDED_KEYS = ['fortyhz.history.v1'] as const;

function storage(): WebStorage | undefined {
  return globalThis.localStorage as WebStorage | undefined;
}

function parseRecords(raw: string | null): SessionRecord[] | null {
  if (raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.map(normalizeSessionRecord).filter((r): r is SessionRecord => r !== null);
  } catch {
    return null;
  }
}

/**
 * Read the history, moving anything under a superseded key across first.
 *
 * The move happens once: the corrected records are written under the current
 * key and the old one is removed, so a later read is an ordinary read and the
 * correction cannot outlive the records it was for.
 */
export function readHistory(from: WebStorage | undefined = storage()): SessionRecord[] {
  if (from === undefined) return [];

  const current = parseRecords(from.getItem(HISTORY_KEY));
  if (current !== null) return current;

  for (const key of SUPERSEDED_KEYS) {
    const older = parseRecords(from.getItem(key));
    if (older === null) continue;

    const corrected = older.map(withoutWithdrawnCoverage);
    writeHistory(corrected, from);
    from.removeItem(key);
    return corrected;
  }

  return [];
}

export function writeHistory(
  records: readonly SessionRecord[],
  to: WebStorage | undefined = storage(),
): void {
  try {
    to?.setItem(HISTORY_KEY, JSON.stringify(records));
  } catch {
    // Storage unavailable — private mode, or quota. History stays in memory,
    // which is the same degradation the previous writers accepted.
  }
}
