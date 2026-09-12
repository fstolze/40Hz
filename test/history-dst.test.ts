/**
 * Day boundaries across a DST transition.
 *
 * Pinned to a timezone that observes DST, because the assertion only means
 * something where days are not all 24 hours long. CI runs in UTC, where every
 * day is 24 hours and an implementation that simply added 86_400_000 would
 * pass — which is exactly the bug worth catching.
 *
 * Node runs each test file in its own process, so setting TZ here cannot
 * affect the rest of the suite. Nothing in the imported modules reads the
 * clock at import time, so assigning it above the test bodies is enough.
 */

process.env.TZ = 'America/New_York';

import { describe, it, expect } from './helpers/expect.ts';
import { endOfLocalDay, listeningSecondsOnDay, startOfLocalDay } from '../src/session/history.ts';
import { defaultConfiguration } from '../src/audio/configuration.ts';
import type { SessionRecord } from '../src/session/session.ts';

const HOUR_MS = 3_600_000;

/** Length of the local day containing `epochMs`, in hours. */
function dayLengthHours(epochMs: number): number {
  return (endOfLocalDay(epochMs) - startOfLocalDay(epochMs)) / HOUR_MS;
}

const noon = (y: number, m: number, d: number): number => new Date(y, m - 1, d, 12).getTime();

function record(startedAt: number, actualSeconds: number): SessionRecord {
  return {
    id: 'r',
    presetId: 'focus',
    startedAt,
    plannedSeconds: actualSeconds,
    actualSeconds,
    completionReason: 'completed',
    integrityStatus: 'unknown',
    integrityCoverage: [],
    initialConfiguration: defaultConfiguration(),
    finalConfiguration: defaultConfiguration(),
    edited: false,
  };
}

describe('DST day lengths', () => {
  it('runs in the pinned timezone', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/New_York');
  });

  it('is 23 hours on the spring-forward day', () => {
    expect(dayLengthHours(noon(2026, 3, 8))).toBe(23);
  });

  it('is 25 hours on the fall-back day', () => {
    expect(dayLengthHours(noon(2026, 11, 1))).toBe(25);
  });

  it('is 24 hours on an ordinary day', () => {
    expect(dayLengthHours(noon(2026, 8, 21))).toBe(24);
  });

  it('closes each day exactly at the next local midnight', () => {
    for (const day of [noon(2026, 3, 8), noon(2026, 11, 1), noon(2026, 8, 21)]) {
      const end = endOfLocalDay(day);
      expect(startOfLocalDay(end)).toBe(end);
      expect(new Date(end).getHours()).toBe(0);
    }
  });
});

describe('listening time across a DST transition', () => {
  it('splits at the real midnight on the short day', () => {
    // 23:30 on 7 March into the 8th. The clock jumps at 02:00 but midnight is
    // unaffected, so the split is still 30 minutes either side.
    const r = record(new Date(2026, 2, 7, 23, 30).getTime(), 3600);
    expect(listeningSecondsOnDay([r], noon(2026, 3, 7))).toBe(1800);
    expect(listeningSecondsOnDay([r], noon(2026, 3, 8))).toBe(1800);
  });

  it('counts a session running through the repeated hour once', () => {
    // 01:30 EDT on 1 November, an hour long, through the hour that repeats.
    // It is one hour of listening, and it belongs entirely to that day.
    const r = record(new Date(2026, 10, 1, 1, 30).getTime(), 3600);
    expect(listeningSecondsOnDay([r], noon(2026, 11, 1))).toBe(3600);
    expect(listeningSecondsOnDay([r], noon(2026, 11, 2))).toBe(0);
  });
});
