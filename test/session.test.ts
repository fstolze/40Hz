/**
 * Session timing.
 *
 * The phase machine is clock-injected, so these assert it exactly at chosen
 * instants rather than waiting on a real timer. The boundaries are what
 * matter: a listener sees the stabilization indicator flip once, and a
 * half-open comparison in the wrong direction would flip it a tick early or
 * leave it stuck.
 */

import { describe, it, expect } from './helpers/expect.ts';
import {
  STABILIZATION_SECONDS,
  beginSession,
  completeSession,
  elapsedSeconds,
  endMs,
  fadeStartMs,
  hasCompleted,
  isStabilized,
  phaseAt,
  progress,
  remainingSeconds,
  snapshotRecord,
  type ActiveSession,
} from '../src/session/session.ts';
import type { CheckableScope } from '../src/integrity/findings.ts';
import {
  DEFAULT_MASTER_LEVEL,
  DEFAULT_SOUNDSCAPE,
  defaultConfiguration,
} from '../src/audio/configuration.ts';
import { DEFAULT_PARAMS } from '../src/audio/dsp/entrainment-core.ts';

const START = 1_700_000_000_000;

/** A 30-minute session with the graph's real ramp durations. */
function session(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    id: 'session-1',
    presetId: 'focus',
    startedAt: START,
    plannedSeconds: 30 * 60,
    rampInSeconds: 3,
    rampOutSeconds: 1.5,
    initialConfiguration: defaultConfiguration(),
    ...overrides,
  };
}

/** Epoch ms `s` seconds into the session. */
const at = (s: number): number => START + s * 1000;

describe('elapsed and remaining', () => {
  it('reads zero at the moment of starting', () => {
    const s = session();
    expect(elapsedSeconds(s, at(0))).toBe(0);
    expect(remainingSeconds(s, at(0))).toBe(30 * 60);
  });

  it('never reports negative elapsed time before the start instant', () => {
    // A clock correction stepping backwards must not read as a future session.
    expect(elapsedSeconds(session(), START - 5000)).toBe(0);
  });

  it('clamps remaining at zero once overrun', () => {
    expect(remainingSeconds(session(), at(30 * 60 + 90))).toBe(0);
  });

  it('reports progress from 0 to 1 and no further', () => {
    const s = session();
    expect(progress(s, at(0))).toBe(0);
    expect(progress(s, at(15 * 60))).toBeCloseTo(0.5, 10);
    expect(progress(s, at(30 * 60))).toBe(1);
    expect(progress(s, at(60 * 60))).toBe(1);
  });
});

describe('phases', () => {
  it('ramps in for the ramp duration, then stabilizes', () => {
    const s = session();
    expect(phaseAt(s, at(0))).toBe('ramping-in');
    expect(phaseAt(s, at(2.99))).toBe('ramping-in');
    expect(phaseAt(s, at(3))).toBe('stabilizing');
  });

  it('flips to stabilized exactly at the threshold', () => {
    const s = session();
    expect(phaseAt(s, at(STABILIZATION_SECONDS - 0.01))).toBe('stabilizing');
    expect(phaseAt(s, at(STABILIZATION_SECONDS))).toBe('stabilized');
    expect(isStabilized(s, at(STABILIZATION_SECONDS - 0.01))).toBe(false);
    expect(isStabilized(s, at(STABILIZATION_SECONDS))).toBe(true);
  });

  it('ends and then completes', () => {
    const s = session();
    const planned = 30 * 60;
    expect(phaseAt(s, at(planned - 1.51))).toBe('stabilized');
    expect(phaseAt(s, at(planned - 1.5))).toBe('ending');
    expect(phaseAt(s, at(planned - 0.01))).toBe('ending');
    expect(phaseAt(s, at(planned))).toBe('complete');
  });

  it('lets ending win over ramping-in where the two overlap', () => {
    // 2 s planned against a 3 s ramp-in and 1.5 s ramp-out: the two windows
    // overlap from 0.5 s, and what comes next matters more than what just was.
    const s = session({ plannedSeconds: 2 });
    expect(phaseAt(s, at(0))).toBe('ramping-in');
    expect(phaseAt(s, at(0.49))).toBe('ramping-in');
    expect(phaseAt(s, at(0.5))).toBe('ending');
    expect(phaseAt(s, at(1.99))).toBe('ending');
    expect(phaseAt(s, at(2))).toBe('complete');
  });

  it('reports completion independently of phase', () => {
    const s = session();
    expect(hasCompleted(s, at(30 * 60 - 0.01))).toBe(false);
    expect(hasCompleted(s, at(30 * 60))).toBe(true);
  });
});

describe('completing a session', () => {
  it('records a full-length session at its planned duration', () => {
    const record = completeSession(session(), at(30 * 60), 'completed');
    expect(record.actualSeconds).toBe(30 * 60);
    expect(record.plannedSeconds).toBe(30 * 60);
    expect(record.completionReason).toBe('completed');
  });

  it('records a session stopped early at what was actually heard', () => {
    const record = completeSession(session(), at(7 * 60), 'stopped');
    expect(record.actualSeconds).toBe(7 * 60);
    expect(record.completionReason).toBe('stopped');
  });

  it('caps actual duration at planned when the stopping tick arrives late', () => {
    const record = completeSession(session(), at(30 * 60 + 12), 'completed');
    expect(record.actualSeconds).toBe(30 * 60);
  });

  it('defaults integrity to unknown, with nothing checked', () => {
    // The two halves of the same fact: no verdict, and no scope it could be a
    // verdict about. A session nothing reported on says so both ways.
    const record = completeSession(session(), at(60), 'stopped');
    expect(record.integrityStatus).toBe('unknown');
    expect(record.integrityCoverage.length).toBe(0);
  });

  it('carries the integrity status when one is supplied', () => {
    expect(
      completeSession(session(), at(60), 'stopped', { integrityStatus: 'warning' }).integrityStatus,
    ).toBe('warning');
  });

  it('carries which scopes were checked, in an array of its own', () => {
    // The caller keeps its aggregate and goes on merging into it, so a shared
    // array would let a later report rewrite a record already written.
    const coverage: CheckableScope[] = ['engine'];
    const record = completeSession(session(), at(60), 'stopped', {
      integrityStatus: 'ok',
      integrityCoverage: coverage,
    });
    expect(record.integrityCoverage.join(',')).toBe('engine');

    coverage.push('graph');
    expect(record.integrityCoverage.join(',')).toBe('engine');
  });

  it('omits scheduledFor entirely for a manually started session', () => {
    expect('scheduledFor' in completeSession(session(), at(60), 'stopped')).toBe(false);
  });

  it('carries scheduledFor when the session came from a reminder', () => {
    const s = session({ scheduledFor: START - 60_000 });
    expect(completeSession(s, at(60), 'completed').scheduledFor).toBe(START - 60_000);
  });
});

describe('fade scheduling', () => {
  it('starts the fade so silence lands at the planned end', () => {
    const s = session();
    expect(fadeStartMs(s)).toBe(at(30 * 60 - 1.5));
    expect(endMs(s)).toBe(at(30 * 60));
    // The whole point: the fade finishes exactly where the session ends,
    // rather than starting there and running past it.
    expect(fadeStartMs(s) + s.rampOutSeconds * 1000).toBe(endMs(s));
  });

  it('agrees with the phase machine', () => {
    const s = session();
    expect(phaseAt(s, fadeStartMs(s) - 1)).toBe('stabilized');
    expect(phaseAt(s, fadeStartMs(s))).toBe('ending');
  });

  it('never schedules a fade before the session starts', () => {
    // 1 s planned against a 1.5 s ramp-out: fade from the start, not earlier.
    const s = session({ plannedSeconds: 1 });
    expect(fadeStartMs(s)).toBe(s.startedAt);
  });
});

describe('recorded configuration', () => {
  it('uses the starting configuration for both endpoints by default', () => {
    const r = completeSession(session(), at(60), 'stopped');
    expect(r.edited).toBe(false);
    expect(r.finalConfiguration.masterLevel).toBe(r.initialConfiguration.masterLevel);
  });

  it('keeps both endpoints when the configuration changed mid-session', () => {
    const final = { ...defaultConfiguration(), masterLevel: 0.42 };
    const r = completeSession(session(), at(60), 'stopped', {
      finalConfiguration: final,
      edited: true,
    });
    expect(r.edited).toBe(true);
    expect(r.initialConfiguration.masterLevel).toBe(DEFAULT_MASTER_LEVEL);
    expect(r.finalConfiguration.masterLevel).toBe(0.42);
  });
});

describe('configuration snapshots', () => {
  it('detaches the configuration when the session begins', () => {
    const configuration = defaultConfiguration();
    const s = beginSession({
      id: 'x',
      presetId: 'focus',
      startedAt: START,
      plannedSeconds: 600,
      rampInSeconds: 3,
      rampOutSeconds: 1.5,
      configuration,
    });
    // Studio stays editable during a session, so a live reference would make
    // the "initial" configuration quietly track the edits.
    configuration.params.amGain = 0.99;
    configuration.soundscape.gain = 0.99;
    configuration.masterLevel = 0.99;
    expect(s.initialConfiguration.params.amGain).toBe(DEFAULT_PARAMS.amGain);
    expect(s.initialConfiguration.soundscape.gain).toBe(DEFAULT_SOUNDSCAPE.gain);
    expect(s.initialConfiguration.masterLevel).toBe(DEFAULT_MASTER_LEVEL);
  });

  it('detaches both endpoints when the record is written', () => {
    const s = session();
    const final = defaultConfiguration();
    const r = completeSession(s, at(60), 'stopped', { finalConfiguration: final, edited: true });
    s.initialConfiguration.params.amGain = 0.11;
    final.params.amGain = 0.22;
    expect(r.initialConfiguration.params.amGain).toBe(DEFAULT_PARAMS.amGain);
    expect(r.finalConfiguration.params.amGain).toBe(DEFAULT_PARAMS.amGain);
  });

  it('detaches the coverage array when a record is handed out', () => {
    // A spread copies the record and shares its array. Coverage crosses the
    // same boundaries the configurations do — published to windows, handed to
    // the store — so a reader could otherwise rewrite what the session
    // verified.
    const record = completeSession(session(), at(60), 'stopped', {
      integrityStatus: 'ok',
      integrityCoverage: ['engine'],
    });
    const handed = snapshotRecord(record);
    handed.integrityCoverage.push('graph');
    expect(record.integrityCoverage.join(',')).toBe('engine');
  });

  it('does not alias the two endpoints to one object', () => {
    // With no final configuration supplied both default to the starting one.
    // Sharing the object would make an edit to either appear on both.
    const r = completeSession(session(), at(60), 'stopped');
    r.finalConfiguration.params.amGain = 0.77;
    expect(r.initialConfiguration.params.amGain).toBe(DEFAULT_PARAMS.amGain);
    r.finalConfiguration.soundscape.gain = 0.77;
    expect(r.initialConfiguration.soundscape.gain).toBe(DEFAULT_SOUNDSCAPE.gain);
  });
});
