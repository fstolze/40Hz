/**
 * When output is at its intended level, and when it is deliberately not.
 *
 * Pure arithmetic over context time, kept out of `graph.ts` for the same reason
 * as `session-envelope.ts`: the graph needs an `AudioContext` to exist at all,
 * and these boundaries are the part that can be wrong in ways no listener would
 * notice — a window accepted while the gain was still climbing measures the
 * ramp and reports the graph attenuating its own output.
 *
 * Every measurement of the master bus depends on this. Its bounds are absolute
 * — a peak, a coverage — so unlike the entrainment checks it cannot shrug off a
 * level that was on its way somewhere. Epochs do not help either: emptying the
 * ring says nothing about what the gain is doing, and a session fade is not a
 * configuration change.
 */

export interface SteadyWindow {
  /** Context time from which output is at its intended level. */
  readonly from: number;
  /** Context time at which it stops being, or `Infinity` while open-ended. */
  readonly until: number;
}

/**
 * Nothing is steady before anything has started.
 *
 * Frozen as well as `readonly`, because it is a shared singleton: a caller that
 * cast the type away and set `from` to zero would not just corrupt one graph's
 * idea of steadiness, it would make "never steady" pass `isSteady` for every
 * graph the process ever creates. The type stops the honest mistake and the
 * freeze stops the rest.
 */
export const NEVER_STEADY: SteadyWindow = Object.freeze({ from: Infinity, until: Infinity });

/**
 * Untimed playback: steady once the ramp-in finishes, open-ended after that.
 *
 * Preview has no scheduled end, so nothing here can say when it stops — only a
 * stop can.
 */
export function openSteady(at: number, rampInSeconds: number): SteadyWindow {
  return { from: at + Math.max(0, rampInSeconds), until: Infinity };
}

/**
 * A timed session, whose whole envelope is known when it starts.
 *
 * `fadeStartAt` rather than the planned end: the fade *lands* on the end, so
 * the last seconds of a session are a deliberate attenuation and measuring
 * them would report the graph failing at exactly the moment it is behaving.
 */
export function sessionSteady(
  startAt: number,
  rampInSeconds: number,
  fadeStartAt: number,
): SteadyWindow {
  return {
    from: startAt + Math.max(0, rampInSeconds),
    // A session shorter than its own ramps has no steady part at all, and
    // saying so beats claiming a window that ends before it begins.
    until: Math.max(fadeStartAt, startAt + Math.max(0, rampInSeconds)),
  };
}

/**
 * Push the start of steadiness past a gain ramp that has just been scheduled.
 *
 * A configuration change re-applies headroom, which ramps the master gain — so
 * the audio immediately afterwards is a transition, even though nothing about
 * the session changed. Emptying the capture ring at the same moment is not
 * enough on its own: the first window recorded after it would contain the ramp
 * while the boundary still pointed at the original ramp-in.
 *
 * Only ever moves the boundary later, so two changes in quick succession leave
 * the later one deciding.
 */
export function deferSteady(current: SteadyWindow, at: number, rampSeconds: number): SteadyWindow {
  return {
    from: Math.max(current.from, at + Math.max(0, rampSeconds)),
    until: current.until,
  };
}

/**
 * Steadiness ends here — a stop, or a fade beginning early.
 *
 * Only ever moves the end earlier: a stop cannot extend a session's own fade
 * boundary, and the earliest deliberate attenuation is the one that matters.
 */
export function endSteady(current: SteadyWindow, at: number): SteadyWindow {
  return { from: current.from, until: Math.min(current.until, at) };
}

/**
 * Whether a captured window lies wholly inside steady playback.
 *
 * Wholly, not mostly. A window that clips a ramp at either end carries the
 * attenuation into whatever is measured from it, and the whole point of
 * carrying a window's start time is to be able to refuse it.
 */
export function isSteady(window: SteadyWindow, startedAt: number, seconds: number): boolean {
  return startedAt >= window.from && startedAt + seconds <= window.until;
}
