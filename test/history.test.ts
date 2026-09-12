/**
 * Session history.
 *
 * Two things worth pinning: day grouping is local-time, so "today" means the
 * user's today rather than UTC's, and the safety helpers stay opt-in — an
 * unconfigured cap or cooldown must restrict nothing.
 */

import { describe, it, expect } from './helpers/expect.ts';
import {
  cooldownRemainingSeconds,
  dayKey,
  advisoryExceeded,
  endOfLocalDay,
  remainingAdvisorySeconds,
  startOfLocalDay,
  listeningSecondsOnDay,
  recentPresetIds,
  recentSessions,
  recordsOnDay,
  totalListeningSeconds,
  withoutRecord,
} from '../src/session/history.ts';
import type { SessionRecord } from '../src/session/session.ts';
import { defaultConfiguration } from '../src/audio/configuration.ts';

/** Local noon on a given date, so a day's records cannot straddle midnight. */
function localNoon(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 12, 0, 0, 0).getTime();
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'a',
    presetId: 'focus',
    startedAt: localNoon(2026, 8, 21),
    plannedSeconds: 1800,
    actualSeconds: 1800,
    completionReason: 'completed',
    integrityStatus: 'unknown',
    integrityCoverage: [],
    initialConfiguration: defaultConfiguration(),
    finalConfiguration: defaultConfiguration(),
    edited: false,
    ...overrides,
  };
}

describe('day grouping', () => {
  it('keys by the local calendar date', () => {
    expect(dayKey(localNoon(2026, 8, 21))).toBe('2026-08-21');
    expect(dayKey(localNoon(2026, 1, 5))).toBe('2026-01-05');
  });

  it('keeps a local day together regardless of the hour', () => {
    const early = new Date(2026, 7, 21, 0, 30).getTime();
    const late = new Date(2026, 7, 21, 23, 30).getTime();
    expect(dayKey(early)).toBe(dayKey(late));
  });

  it('separates adjacent days', () => {
    expect(dayKey(localNoon(2026, 8, 21))).toBe('2026-08-21');
    expect(dayKey(localNoon(2026, 8, 22))).toBe('2026-08-22');
  });

  it('returns a day’s records oldest first', () => {
    const morning = record({ id: 'm', startedAt: new Date(2026, 7, 21, 9).getTime() });
    const evening = record({ id: 'e', startedAt: new Date(2026, 7, 21, 19).getTime() });
    const ids = recordsOnDay([evening, morning], localNoon(2026, 8, 21)).map((r) => r.id);
    expect(ids.join(',')).toBe('m,e');
  });

  it('excludes other days', () => {
    const today = record({ id: 't' });
    const yesterday = record({ id: 'y', startedAt: localNoon(2026, 8, 20) });
    expect(recordsOnDay([today, yesterday], localNoon(2026, 8, 21)).length).toBe(1);
  });
});

describe('listening time', () => {
  it('sums what was actually heard, not what was planned', () => {
    const short = record({ id: 's', actualSeconds: 420, plannedSeconds: 1800 });
    expect(listeningSecondsOnDay([short], localNoon(2026, 8, 21))).toBe(420);
  });

  it('sums only the day asked for', () => {
    const today = record({ id: 't', actualSeconds: 600 });
    const yesterday = record({ id: 'y', startedAt: localNoon(2026, 8, 20), actualSeconds: 900 });
    expect(listeningSecondsOnDay([today, yesterday], localNoon(2026, 8, 21))).toBe(600);
    expect(totalListeningSeconds([today, yesterday])).toBe(1500);
  });

  it('is zero for a day with no records', () => {
    expect(listeningSecondsOnDay([], localNoon(2026, 8, 21))).toBe(0);
  });
});

describe('day boundaries', () => {
  it('closes a day at the start of the next', () => {
    // Exact day lengths across a DST transition are asserted in
    // history-dst.test.ts, which pins a timezone that has one. On a UTC runner
    // every day is 24 hours, so a range check here would prove nothing.
    const end = endOfLocalDay(localNoon(2026, 8, 21));
    expect(startOfLocalDay(end)).toBe(end);
    expect(new Date(end).getHours()).toBe(0);
  });

  it('handles month rollover', () => {
    expect(dayKey(endOfLocalDay(localNoon(2026, 8, 31)))).toBe('2026-09-01');
  });

  it('splits a session running past midnight across both days', () => {
    // 23:30 to 00:30 is half an hour of each day, not an hour of the first.
    const r = record({
      startedAt: new Date(2026, 7, 21, 23, 30).getTime(),
      actualSeconds: 3600,
    });
    expect(listeningSecondsOnDay([r], localNoon(2026, 8, 21))).toBe(1800);
    expect(listeningSecondsOnDay([r], localNoon(2026, 8, 22))).toBe(1800);
  });

  it('lists a midnight-spanning session on both days', () => {
    const r = record({
      startedAt: new Date(2026, 7, 21, 23, 30).getTime(),
      actualSeconds: 3600,
    });
    expect(recordsOnDay([r], localNoon(2026, 8, 21)).length).toBe(1);
    expect(recordsOnDay([r], localNoon(2026, 8, 22)).length).toBe(1);
  });

  it('still lists a zero-length session on the day it started', () => {
    const r = record({ actualSeconds: 0 });
    expect(recordsOnDay([r], localNoon(2026, 8, 21)).length).toBe(1);
  });
});

describe('daily advisory', () => {
  it('is unlimited when unconfigured', () => {
    const heavy = record({ actualSeconds: 40_000 });
    const now = localNoon(2026, 8, 21);
    expect(remainingAdvisorySeconds([heavy], 0, now)).toBe(Number.POSITIVE_INFINITY);
    expect(advisoryExceeded([heavy], 0, now)).toBe(false);
    expect(advisoryExceeded([heavy], -1, now)).toBe(false);
  });

  it('reports exceeded at the threshold, not only past it', () => {
    const r = record({ actualSeconds: 3600 });
    expect(advisoryExceeded([r], 3600, localNoon(2026, 8, 21))).toBe(true);
    expect(advisoryExceeded([r], 3601, localNoon(2026, 8, 21))).toBe(false);
  });

  it('reports what remains without restricting a longer session', () => {
    // 50 minutes used against a 60 minute threshold. A 30 minute session is
    // still permitted: the advisory reports, it never gates.
    const r = record({ actualSeconds: 3000 });
    expect(remainingAdvisorySeconds([r], 3600, localNoon(2026, 8, 21))).toBe(600);
    expect(advisoryExceeded([r], 3600, localNoon(2026, 8, 21))).toBe(false);
  });

  it('floors what remains at zero once past the threshold', () => {
    const r = record({ actualSeconds: 7200 });
    expect(remainingAdvisorySeconds([r], 3600, localNoon(2026, 8, 21))).toBe(0);
  });

  it('counts only the current day', () => {
    const yesterday = record({ startedAt: localNoon(2026, 8, 20), actualSeconds: 7200 });
    expect(advisoryExceeded([yesterday], 3600, localNoon(2026, 8, 21))).toBe(false);
  });
});

describe('cooldown', () => {
  const start = localNoon(2026, 8, 21);

  it('does not restrict anything when unconfigured', () => {
    expect(cooldownRemainingSeconds([record()], 0, start)).toBe(0);
  });

  it('is zero with no history', () => {
    expect(cooldownRemainingSeconds([], 600, start)).toBe(0);
  });

  it('counts down from the end of the last session, not its start', () => {
    const r = record({ startedAt: start, actualSeconds: 600 });
    // 300 s after the session ended, with a 600 s cooldown: 300 s left.
    expect(cooldownRemainingSeconds([r], 600, start + 900_000)).toBeCloseTo(300, 6);
  });

  it('expires', () => {
    const r = record({ startedAt: start, actualSeconds: 600 });
    expect(cooldownRemainingSeconds([r], 600, start + 3_600_000)).toBe(0);
  });

  it('uses the most recent session when history is out of order', () => {
    const older = record({ id: 'o', startedAt: start, actualSeconds: 600 });
    const newer = record({ id: 'n', startedAt: start + 3_600_000, actualSeconds: 600 });
    // Newest ended at start + 4200 s; asking 60 s later leaves 540 s of 600.
    expect(cooldownRemainingSeconds([newer, older], 600, start + 4_260_000)).toBeCloseTo(540, 6);
  });
});

describe('recall', () => {
  const start = localNoon(2026, 8, 21);

  it('returns recent sessions newest first', () => {
    const a = record({ id: 'a', startedAt: start });
    const b = record({ id: 'b', startedAt: start + 1000 });
    expect(
      recentSessions([a, b])
        .map((r) => r.id)
        .join(','),
    ).toBe('b,a');
  });

  it('honours the limit', () => {
    const many = [0, 1, 2, 3, 4, 5].map((i) =>
      record({ id: `r${i}`, startedAt: start + i * 1000 }),
    );
    expect(recentSessions(many, 3).length).toBe(3);
  });

  it('lists recent presets once each, newest first', () => {
    const rows = [
      record({ id: '1', presetId: 'focus', startedAt: start }),
      record({ id: '2', presetId: 'masked', startedAt: start + 1000 }),
      record({ id: '3', presetId: 'focus', startedAt: start + 2000 }),
    ];
    expect(recentPresetIds(rows).join(',')).toBe('focus,masked');
  });

  it('is not a frequency ranking', () => {
    // `masked` ran three times, `focus` once and most recently. Recency wins.
    const rows = [
      record({ id: '1', presetId: 'masked', startedAt: start }),
      record({ id: '2', presetId: 'masked', startedAt: start + 1000 }),
      record({ id: '3', presetId: 'masked', startedAt: start + 2000 }),
      record({ id: '4', presetId: 'focus', startedAt: start + 3000 }),
    ];
    expect(recentPresetIds(rows)[0]).toBe('focus');
  });
});

describe('deletion', () => {
  it('removes the named record and leaves the rest', () => {
    const a = record({ id: 'a' });
    const b = record({ id: 'b' });
    const left = withoutRecord([a, b], 'a');
    expect(left.length).toBe(1);
    expect(left[0].id).toBe('b');
  });

  it('is a no-op for an unknown id', () => {
    expect(withoutRecord([record({ id: 'a' })], 'nope').length).toBe(1);
  });
});
