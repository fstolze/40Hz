/**
 * What to tell the user before they start another session.
 *
 * Shared by Studio and the popover so the wording cannot drift between them,
 * and pure so the wording can be asserted. The phrasing is the substance here:
 * these are **reminders, not limits**, and a sentence with a limit's shape
 * will be read as one however the setting is labelled. So every message says
 * what was asked for and leaves the decision where it belongs.
 *
 * Nothing here gates anything. There is deliberately no boolean a caller could
 * mistake for permission — the return value is something to display or
 * nothing to display.
 */

import { advisoryExceeded, cooldownRemainingSeconds, listeningSecondsOnDay } from './history.ts';
import type { SessionRecord } from './session.ts';
import type { Settings } from './settings.ts';

export interface Advice {
  /** Which reminder this is, so a surface can style or order them. */
  kind: 'advisory' | 'cooldown';
  message: string;
}

/** Whole minutes, in the plainest words that fit. Local to keep this portable. */
function duration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * The one thing worth saying right now, or null.
 *
 * At most one: two reminders at once is a wall of text nobody reads, and the
 * day's total is the larger signal, so it wins over the pause between
 * sessions.
 */
export function sessionAdvice(
  records: readonly SessionRecord[],
  settings: Settings,
  nowMs: number,
): Advice | null {
  if (advisoryExceeded(records, settings.dailyAdvisorySeconds, nowMs)) {
    const today = listeningSecondsOnDay(records, nowMs);
    return {
      kind: 'advisory',
      // Says what happened and what was asked for, and then stops. No verb
      // telling the user what to do, because this is their call.
      message: `${duration(today)} today, past the ${duration(settings.dailyAdvisorySeconds)} you asked to be reminded at.`,
    };
  }

  const waiting = cooldownRemainingSeconds(records, settings.cooldownSeconds, nowMs);
  if (waiting > 0) {
    return {
      kind: 'cooldown',
      message: `${duration(waiting)} left of the pause you asked for between sessions.`,
    };
  }

  return null;
}
