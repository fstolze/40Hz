/**
 * What a surface says about the running session.
 *
 * One function, because there are two surfaces. Studio's strip and the tray
 * popover both describe the same session, and each used to derive its own
 * wording inline — which is exactly how they came to disagree: the strip was
 * taught to trust the coordinator's `session-ending` state, the popover was
 * not, and for the second and a half after an early stop Studio said "Fading
 * out" while the tray still said "Ramping in". Two copies of a rule are two
 * rules.
 *
 * Pure, so the disagreement that actually happened is testable without either
 * renderer.
 */

import {
  STABILIZATION_SECONDS,
  isStabilized,
  type ActiveSession,
  type SessionPhase,
} from '../../session/session.ts';
import { clock } from './format.ts';
import type { ArbiterState } from '../../session/coordinator.ts';

export interface SessionPhaseView {
  /** The phase, in the words both surfaces show. */
  label: string;
  /** The fade is landing — the clock turns, and nothing claims completion. */
  ending: boolean;
  /** Past the five minute threshold. */
  stabilized: boolean;
  /** What the threshold indicator says beside the phase. */
  thresholdNote: string;
}

/**
 * Describe the session from the coordinator's state and its own schedule.
 *
 * `state` comes first on purpose. `phaseAt` reads the session's *planned*
 * schedule, so it reports `ending` only inside the ramp-out window before the
 * planned finish — which a user stopping at 25 minutes remaining is nowhere
 * near. `session-ending` is published for precisely the interval in which the
 * envelope is landing and the record is being written. That interval must stay
 * visible so the UI does not claim the session is idle before finalization.
 *
 * `elapsedSeconds` is passed rather than derived from `now` because each
 * surface advances it on its own monotonic clock between publications; taking
 * it from the wall clock here would reintroduce the drift that anchoring
 * exists to prevent.
 */
export function sessionPhase(
  state: ArbiterState,
  session: ActiveSession | null,
  now: number,
  elapsedSeconds: number,
  plannedPhase: SessionPhase | null,
): SessionPhaseView {
  if (session === null) {
    return {
      label: 'Idle — ready to start',
      ending: false,
      stabilized: false,
      thresholdNote: '',
    };
  }

  const stabilized = isStabilized(session, now);
  const tooShort = session.plannedSeconds <= STABILIZATION_SECONDS;
  const thresholdNote = stabilized
    ? 'Past the 5 minute threshold'
    : tooShort
      ? 'Shorter than the 5 minute threshold'
      : 'Not yet stabilized';

  if (state === 'session-ending' || plannedPhase === 'ending') {
    return { label: 'Fading out', ending: true, stabilized, thresholdNote };
  }
  if (plannedPhase === 'ramping-in') {
    return { label: 'Ramping in', ending: false, stabilized, thresholdNote };
  }
  if (stabilized) {
    return { label: 'Stabilized', ending: false, stabilized, thresholdNote };
  }
  if (tooShort) {
    // Too short to reach the threshold, so promising it would be a lie.
    return { label: 'Running', ending: false, stabilized, thresholdNote };
  }
  return {
    label: `Stabilizing — about ${clock(STABILIZATION_SECONDS - elapsedSeconds)} to go`,
    ending: false,
    stabilized,
    thresholdNote,
  };
}
