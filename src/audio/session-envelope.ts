/**
 * Playback envelope scheduling.
 *
 * Kept out of `graph.ts` and expressed against a minimal parameter interface,
 * so the scheduling can be driven in Node against a fake `AudioParam` that
 * records what was asked of it. `tools/verify.ts` and the offline renderer
 * exercise the DSP core, not a Web Audio graph, so they cannot prove anything
 * about automation — this is how that gap is closed without a browser.
 *
 * Everything here is scheduled on the AudioContext timeline, in one call at
 * the start of playback. Timers plus IPC cannot define an acoustic boundary:
 * event-loop and message latency would start a fade late, and a finalize timer
 * could then silence the graph before that late fade had finished.
 */

/** The slice of `AudioParam` this needs. `cancelAndHoldAtTime` is optional. */
export interface EnvelopeParam {
  value: number;
  setValueAtTime(value: number, startTime: number): void;
  linearRampToValueAtTime(value: number, endTime: number): void;
  cancelScheduledValues(cancelTime: number): void;
  cancelAndHoldAtTime?(cancelTime: number): void;
}

/**
 * Shortest ramp worth scheduling.
 *
 * A linear ramp whose end time equals its start time is a step, and a step on
 * a gain is a click. Anything faster than a millisecond is inaudible as a
 * gesture anyway.
 */
export const MIN_RAMP_SECONDS = 0.001;

export interface SessionEnvelope {
  /** AudioContext time at which the ramp-in begins. */
  startAt: number;
  rampInSeconds: number;
  /** AudioContext time at which the fade-out begins. */
  fadeStartAt: number;
  fadeOutSeconds: number;
}

function rampSeconds(seconds: number): number {
  return Math.max(MIN_RAMP_SECONDS, seconds);
}

/**
 * Schedule a whole session: silence, up, hold, down, silence.
 *
 * The fade is scheduled to *land* on `fadeStartAt + fadeOutSeconds`, which the
 * caller sets to the session's planned end. Starting the fade at the planned
 * end instead would leave the session audible past its own duration.
 *
 * Never schedules a value above 1, so the headroom guarantee upstream is
 * untouched: this node can only attenuate what reaches the master bus.
 */
export function scheduleSessionEnvelope(param: EnvelopeParam, envelope: SessionEnvelope): void {
  const { startAt, rampInSeconds, fadeStartAt, fadeOutSeconds } = envelope;
  const fadeEndsAt = Math.max(fadeStartAt, startAt) + rampSeconds(fadeOutSeconds);

  param.cancelScheduledValues(startAt);
  param.setValueAtTime(0, startAt);

  if (fadeStartAt <= startAt) {
    // No room to rise at all. Stay silent rather than clicking up and down.
    param.linearRampToValueAtTime(0, fadeEndsAt);
    return;
  }

  const rampInEndsAt = startAt + rampSeconds(rampInSeconds);

  if (fadeStartAt < rampInEndsAt) {
    // The session is shorter than its own ramps. Rise only as far as it gets
    // to by the time the fade is due, then fall from there — rather than
    // pretending it reached full level.
    const reached = (fadeStartAt - startAt) / rampSeconds(rampInSeconds);
    param.linearRampToValueAtTime(reached, fadeStartAt);
    param.linearRampToValueAtTime(0, fadeEndsAt);
    return;
  }

  param.linearRampToValueAtTime(1, rampInEndsAt);
  // Anchor the hold: without a value at the fade's start, the ramp to zero
  // would interpolate from the end of the ramp-in and begin falling during
  // what should be the steady part of the session.
  param.setValueAtTime(1, fadeStartAt);
  param.linearRampToValueAtTime(0, fadeEndsAt);
}

/**
 * Freeze the automation at wherever it currently is.
 *
 * `cancelScheduledValues` alone reverts to the last value that was explicitly
 * set, which mid-ramp is not where the gain actually is — cancelling during a
 * ramp-in would jump the level up before fading it back down.
 */
function holdAt(param: EnvelopeParam, time: number): void {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(time);
    return;
  }
  // Fallback for implementations without it. `value` reflects the running
  // automation, so re-anchoring to it is close enough to hold the level; it is
  // read at call time rather than at `time`, so it is only exact when
  // cancelling at the current instant, which is how playback stops.
  const current = param.value;
  param.cancelScheduledValues(time);
  param.setValueAtTime(current, time);
}

export interface CancelOptions {
  /** AudioContext time at which the stop was requested. */
  at: number;
  fadeOutSeconds: number;
}

/**
 * Stop early, from wherever the envelope has got to.
 *
 * Used for a user stop at any point — during the ramp-in, during the steady
 * part, or during a fade already under way. Fading from a fade simply steepens
 * it; it never jumps.
 */
export function cancelSessionEnvelope(param: EnvelopeParam, options: CancelOptions): void {
  holdAt(param, options.at);
  param.linearRampToValueAtTime(0, options.at + rampSeconds(options.fadeOutSeconds));
}

/**
 * Ramp up and hold, for untimed playback with no scheduled end.
 *
 * Holds before rising for the same reason stopping does: starting Preview
 * while a fade is still running must continue from the level the fade has
 * reached. Reading the value *after* cancelling would read the pre-cancel
 * anchor instead — a jump to whatever the interrupted automation started from.
 */
export function scheduleOpenEnvelope(
  param: EnvelopeParam,
  at: number,
  rampInSeconds: number,
): void {
  holdAt(param, at);
  param.linearRampToValueAtTime(1, at + rampSeconds(rampInSeconds));
}
