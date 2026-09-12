/**
 * Session history.
 *
 * A private, local, user-deletable log and nothing more. It may drive
 * user-configured safety behaviour, and deliberately supports none of streaks,
 * "optimal dose" recommendations, adaptive session lengths, or effectiveness
 * scores. There is no validated individual dose-response model in this
 * project, and those features would invite unsupported health inferences while
 * gamifying prolonged exposure.
 *
 * The daily limit is advisory: everything here reports, and nothing gates. A
 * caller that wants to show a notice asks and decides for itself.
 *
 * Called listening time, never dose, here and in the UI.
 *
 * Pure functions over an array. Where the array is persisted is the caller's
 * problem, which keeps this testable and keeps the main process, Studio, and
 * the Session popover all able to use it.
 */

import type { SessionRecord } from './session.ts';

/**
 * Local-time day key, `YYYY-MM-DD`.
 *
 * Local rather than UTC because "today's listening time" means the user's
 * today.
 */
export function dayKey(epochMs: number): string {
  const d = new Date(epochMs);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Local midnight opening the day containing `epochMs`.
 *
 * Built from the calendar date rather than by subtracting a fixed offset, so a
 * 23- or 25-hour day across a DST boundary still starts and ends correctly.
 */
export function startOfLocalDay(epochMs: number): number {
  const d = new Date(epochMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Local midnight closing that day — exclusive. Handles month and year rollover. */
export function endOfLocalDay(epochMs: number): number {
  const d = new Date(epochMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/** Milliseconds of a record's listening that fall inside `[from, to)`. */
function overlapMs(record: SessionRecord, from: number, to: number): number {
  const start = record.startedAt;
  const end = start + record.actualSeconds * 1000;
  return Math.max(0, Math.min(end, to) - Math.max(start, from));
}

/**
 * Records touching the local day containing `epochMs`, oldest first.
 *
 * A session running 23:30 to 00:30 appears on both days, because it genuinely
 * happened on both. A zero-length record is listed on the day it started.
 */
export function recordsOnDay(records: readonly SessionRecord[], epochMs: number): SessionRecord[] {
  const from = startOfLocalDay(epochMs);
  const to = endOfLocalDay(epochMs);
  return records
    .filter((r) => overlapMs(r, from, to) > 0 || (r.startedAt >= from && r.startedAt < to))
    .sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Seconds actually listened during the local day containing `epochMs`.
 *
 * Intervals are clipped at the day boundary rather than attributed whole to
 * the day a session started on. A session from 23:30 to 00:30 contributes 30
 * minutes to each day, not 60 to the first — which is what the number has to
 * mean for a daily figure to be honest.
 */
export function listeningSecondsOnDay(records: readonly SessionRecord[], epochMs: number): number {
  const from = startOfLocalDay(epochMs);
  const to = endOfLocalDay(epochMs);
  return records.reduce((total, r) => total + overlapMs(r, from, to), 0) / 1000;
}

/** Total seconds actually listened across every record held. */
export function totalListeningSeconds(records: readonly SessionRecord[]): number {
  return records.reduce((total, r) => total + r.actualSeconds, 0);
}

/**
 * Seconds left before the day's advisory threshold, or `Infinity` when unset.
 *
 * Reports only. The daily limit warns and never restricts, so this gates
 * nothing — a session longer than what remains is permitted, and the caller
 * decides whether to say so.
 */
export function remainingAdvisorySeconds(
  records: readonly SessionRecord[],
  thresholdSeconds: number,
  nowMs: number,
): number {
  if (thresholdSeconds <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, thresholdSeconds - listeningSecondsOnDay(records, nowMs));
}

/** Whether the day's listening has reached the advisory threshold. */
export function advisoryExceeded(
  records: readonly SessionRecord[],
  thresholdSeconds: number,
  nowMs: number,
): boolean {
  if (thresholdSeconds <= 0) return false;
  return listeningSecondsOnDay(records, nowMs) >= thresholdSeconds;
}

/**
 * Seconds remaining before a user-configured cooldown expires, or 0.
 *
 * Measured from the end of the most recent session, so back-to-back sessions
 * can be discouraged without affecting a session hours later. Advisory like
 * the rest of this module.
 */
export function cooldownRemainingSeconds(
  records: readonly SessionRecord[],
  cooldownSeconds: number,
  nowMs: number,
): number {
  if (cooldownSeconds <= 0 || records.length === 0) return 0;
  const lastEnded = records.reduce((latest, r) => {
    const endedAt = r.startedAt + r.actualSeconds * 1000;
    return endedAt > latest ? endedAt : latest;
  }, 0);
  const elapsed = (nowMs - lastEnded) / 1000;
  return Math.max(0, cooldownSeconds - elapsed);
}

/** The most recent sessions, newest first. */
export function recentSessions(records: readonly SessionRecord[], limit = 5): SessionRecord[] {
  return [...records].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}

/**
 * The preset ids used most recently, newest first and each appearing once.
 *
 * This is what "recent-session recall" offers in the tray: the last few things
 * the user actually ran, not a frequency ranking, which would edge toward
 * recommending.
 */
export function recentPresetIds(records: readonly SessionRecord[], limit = 3): string[] {
  const seen: string[] = [];
  for (const record of recentSessions(records, records.length)) {
    if (!seen.includes(record.presetId)) seen.push(record.presetId);
    if (seen.length >= limit) break;
  }
  return seen;
}

/** History with one record removed. History is the user's to delete. */
export function withoutRecord(records: readonly SessionRecord[], id: string): SessionRecord[] {
  return records.filter((r) => r.id !== id);
}
