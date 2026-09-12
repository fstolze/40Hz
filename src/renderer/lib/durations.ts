/**
 * The durations Session offers.
 *
 * Production values come from `DURATION_CHOICES` and are never modified. A
 * development build additionally honours `?durations=` so a session can be
 * driven to natural completion in seconds — otherwise verifying that path by
 * hand means waiting at least ten minutes, which in practice means it does not
 * get verified.
 *
 * Gated on `import.meta.env.DEV`, so the branch is eliminated from a
 * production bundle and the override cannot be reached in a shipped build.
 */

import { DURATION_CHOICES } from '../../session/session.ts';

/** Minutes, so `?durations=0.1,0.5` gives six and thirty seconds. */
export function durationChoices(): number[] {
  const production = [...DURATION_CHOICES];
  if (!import.meta.env.DEV) return production;

  try {
    const raw = new URL(window.location.href).searchParams.get('durations');
    if (raw === null) return production;
    const parsed = raw
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    return parsed.length > 0 ? parsed : production;
  } catch {
    return production;
  }
}

/** How a duration reads in the picker: whole minutes, or seconds below one. */
export function durationLabel(minutes: number): string {
  return minutes >= 1 ? `${minutes}` : `${Math.round(minutes * 60)}s`;
}
