/**
 * The reminders, and above all their wording.
 *
 * These are advisory by decision — the app reminds and never gates — and the
 * wording is the whole of that promise at the point the user reads it. A
 * sentence that tells them to stop is a limit however the setting is labelled,
 * so the copy is asserted rather than left to drift.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { sessionAdvice } from '../src/session/advice.ts';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/session/settings.ts';
import type { SessionRecord } from '../src/session/session.ts';

const NOON = new Date(2026, 0, 15, 12, 0, 0).getTime();

const record = (startedAt: number, seconds: number): SessionRecord =>
  ({ id: `r${startedAt}`, startedAt, actualSeconds: seconds }) as SessionRecord;

describe('when nothing is worth saying', () => {
  it('says nothing', () => {
    expect(sessionAdvice([], DEFAULT_SETTINGS, NOON)).toBe(null);
  });

  it('stays quiet below the threshold', () => {
    const records = [record(NOON - 3600_000, 3600)];
    expect(sessionAdvice(records, normalizeSettings({ dailyAdvisorySeconds: 7200 }), NOON)).toBe(
      null,
    );
  });

  it('stays quiet when the advisory is off, however long the day', () => {
    // Off has to mean off. An advisory that still fired at zero would be a
    // limit, which is the one thing this must never be.
    const records = [record(NOON - 8 * 3600_000, 8 * 3600)];
    const off = normalizeSettings({ dailyAdvisorySeconds: 0, cooldownSeconds: 0 });
    expect(sessionAdvice(records, off, NOON)).toBe(null);
  });
});

describe('the daily advisory', () => {
  const records = [record(NOON - 5400_000, 5400)];
  const settings = normalizeSettings({ dailyAdvisorySeconds: 3600 });

  it('reports the day and the threshold that was asked for', () => {
    const advice = sessionAdvice(records, settings, NOON);
    expect(advice?.kind).toBe('advisory');
    expect(advice?.message).toBe('1 h 30 min today, past the 1 h you asked to be reminded at.');
  });

  it('does not tell the user to do anything', () => {
    // The property that matters, asserted rather than trusted to review: no
    // instruction, and nothing claiming something has been prevented.
    const message = sessionAdvice(records, settings, NOON)?.message ?? '';
    for (const forbidden of ['stop', 'must', 'cannot', 'limit', 'blocked', 'not allowed']) {
      expect(message.toLowerCase().includes(forbidden)).toBe(false);
    }
  });
});

describe('the pause between sessions', () => {
  it('reports what is left of it', () => {
    // Ended 10 minutes ago, 30 minutes asked for.
    const records = [record(NOON - 40 * 60_000, 30 * 60)];
    const settings = normalizeSettings({ dailyAdvisorySeconds: 0, cooldownSeconds: 30 * 60 });
    const advice = sessionAdvice(records, settings, NOON);
    expect(advice?.kind).toBe('cooldown');
    expect(advice?.message).toBe('20 min left of the pause you asked for between sessions.');
  });

  it('gives way to the daily advisory', () => {
    // Both apply. Two reminders at once is a wall of text nobody reads, and
    // the day's total is the larger signal.
    const records = [record(NOON - 40 * 60_000, 2 * 3600)];
    const settings = normalizeSettings({ dailyAdvisorySeconds: 3600, cooldownSeconds: 30 * 60 });
    expect(sessionAdvice(records, settings, NOON)?.kind).toBe('advisory');
  });
});
