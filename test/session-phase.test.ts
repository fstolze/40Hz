/**
 * What Studio and the tray say about the same session.
 *
 * This exists because they disagreed. Studio was taught to trust the
 * coordinator's `session-ending` state and the popover was not, so after an
 * early stop one surface said "Fading out" while the other said "Ramping in"
 * — for the second and a half in which the fade is landing and the record is
 * being written. The tests below are the two surfaces' shared rule.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { sessionPhase } from '../src/renderer/lib/session-phase.ts';
import { STABILIZATION_SECONDS, type ActiveSession } from '../src/session/session.ts';

const START = 1_700_000_000_000;

function session(plannedSeconds: number): ActiveSession {
  return {
    id: 's1',
    presetId: 'focus',
    startedAt: START,
    plannedSeconds,
    rampInSeconds: 30,
    rampOutSeconds: 30,
  } as ActiveSession;
}

describe('an early stop', () => {
  /**
   * The case that was wrong. A 30 minute session stopped after ten seconds is
   * nowhere near its planned ramp-out, so the schedule still says `ramping-in`
   * — and only the coordinator knows the session is ending.
   */
  const view = sessionPhase('session-ending', session(1800), START + 10_000, 10, 'ramping-in');

  it('says the fade is landing, whatever the schedule thinks', () => {
    expect(view.label).toBe('Fading out');
  });

  it('marks it as ending, so the clock can change with it', () => {
    expect(view.ending).toBe(true);
  });

  it('does not claim the threshold was reached', () => {
    expect(view.stabilized).toBe(false);
    expect(view.thresholdNote).toBe('Not yet stabilized');
  });
});

describe('a natural finish', () => {
  it('still reports the fade from the planned schedule', () => {
    // The coordinator has not moved to `session-ending` yet, but the session's
    // own ramp-out has begun. Both routes have to reach the same words.
    const view = sessionPhase('session-active', session(1800), START + 1_790_000, 1790, 'ending');
    expect(view.label).toBe('Fading out');
    expect(view.ending).toBe(true);
  });
});

describe('the ordinary run of a session', () => {
  it('ramps in first', () => {
    const view = sessionPhase('session-active', session(1800), START + 5_000, 5, 'ramping-in');
    expect(view.label).toBe('Ramping in');
  });

  it('counts down to the threshold while stabilizing', () => {
    const view = sessionPhase('session-active', session(1800), START + 60_000, 60, 'stabilizing');
    expect(view.label.startsWith('Stabilizing — about ')).toBe(true);
    expect(view.label.endsWith(' to go')).toBe(true);
    expect(view.stabilized).toBe(false);
  });

  it('reports stabilized once the threshold is passed', () => {
    const past = START + (STABILIZATION_SECONDS + 10) * 1000;
    const view = sessionPhase(
      'session-active',
      session(1800),
      past,
      STABILIZATION_SECONDS + 10,
      'stabilizing',
    );
    expect(view.label).toBe('Stabilized');
    expect(view.stabilized).toBe(true);
    expect(view.thresholdNote).toBe('Past the 5 minute threshold');
  });

  it('refuses to promise a threshold a short session cannot reach', () => {
    // Two seconds is reachable through the bridge, and a session that short
    // will never stabilize — so it says "Running" rather than counting down to
    // something that will not happen.
    const view = sessionPhase('session-active', session(2), START + 1000, 1, 'stabilizing');
    expect(view.label).toBe('Running');
    expect(view.thresholdNote).toBe('Shorter than the 5 minute threshold');
  });
});

describe('no session', () => {
  it('is idle, and says nothing about thresholds', () => {
    const view = sessionPhase('idle', null, START, 0, null);
    expect(view.label).toBe('Idle — ready to start');
    expect(view.ending).toBe(false);
    expect(view.thresholdNote).toBe('');
  });
});
