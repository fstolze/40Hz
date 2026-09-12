/**
 * Settings, and what survives a file this version did not write.
 *
 * The settings file is untrusted input like every other: it outlives the
 * version that wrote it, it can be hand-edited, and a crash can leave it half
 * written. What matters is that nothing unusable can reach the app — the
 * advisory in particular, since it is the one safety-adjacent number here.
 */

import { describe, it, expect } from './helpers/expect.ts';
import {
  APPEARANCES,
  DEFAULT_SETTINGS,
  normalizeSettings,
  resolveTheme,
  snapshotSettings,
  type Settings,
} from '../src/session/settings.ts';
import { advisoryExceeded, remainingAdvisorySeconds } from '../src/session/history.ts';
import type { SessionRecord } from '../src/session/session.ts';

describe('reading settings that are not settings', () => {
  it('falls back to the defaults for anything unusable', () => {
    // Never null: there is no such thing as an unusable settings file, only
    // one that contributes nothing.
    // The shim has no deep-equality matcher, and comparing serialised forms
    // would pass on a value that merely stringifies the same.
    for (const value of [null, undefined, 42, 'settings', [], true]) {
      const settings = normalizeSettings(value);
      expect(settings.dailyAdvisorySeconds).toBe(DEFAULT_SETTINGS.dailyAdvisorySeconds);
      expect(settings.cooldownSeconds).toBe(DEFAULT_SETTINGS.cooldownSeconds);
      expect(settings.launchAtLogin).toBe(DEFAULT_SETTINGS.launchAtLogin);
      expect(settings.appearance).toBe(DEFAULT_SETTINGS.appearance);
    }
  });

  it('keeps the fields it recognises and defaults the rest', () => {
    const settings = normalizeSettings({ dailyAdvisorySeconds: 3600, nonsense: 'ignored' });
    expect(settings.dailyAdvisorySeconds).toBe(3600);
    expect(settings.cooldownSeconds).toBe(DEFAULT_SETTINGS.cooldownSeconds);
    expect(settings.launchAtLogin).toBe(false);
  });

  it('rejects NaN and infinity rather than storing them', () => {
    // A NaN threshold compares false against everything, so the advisory
    // would silently never fire while the UI showed it as on.
    expect(normalizeSettings({ dailyAdvisorySeconds: Number.NaN }).dailyAdvisorySeconds).toBe(
      DEFAULT_SETTINGS.dailyAdvisorySeconds,
    );
    expect(
      normalizeSettings({ dailyAdvisorySeconds: Number.POSITIVE_INFINITY }).dailyAdvisorySeconds,
    ).toBe(DEFAULT_SETTINGS.dailyAdvisorySeconds);
  });

  it('clamps a negative threshold to off rather than to a default', () => {
    // -1 is a corrupt value, but 0 is a real setting the user can choose, and
    // clamping to it is closer to what a negative number was trying to say
    // than quietly restoring a two-hour advisory they had turned off.
    expect(normalizeSettings({ dailyAdvisorySeconds: -1 }).dailyAdvisorySeconds).toBe(0);
  });

  it('clamps a threshold longer than the day it applies to', () => {
    // A daily advisory of 30 hours can never be reached, so it would read as
    // off while displaying as on.
    expect(normalizeSettings({ dailyAdvisorySeconds: 30 * 3600 }).dailyAdvisorySeconds).toBe(
      24 * 3600,
    );
  });

  it('only a real boolean turns launch at login on', () => {
    // Starting the app at login is a visible change to the user's machine.
    // Guessing it from a truthy string is not a guess worth making.
    for (const value of ['true', 1, {}]) {
      expect(normalizeSettings({ launchAtLogin: value }).launchAtLogin).toBe(false);
    }
    expect(normalizeSettings({ launchAtLogin: true }).launchAtLogin).toBe(true);
  });

  it('keeps tray residency unless a real false turns it off', () => {
    // The mirror of launch at login, because the default is the other way
    // round. Anything unrecognised has to leave the app in the tray: that is
    // the state a user can always get back from, and a file written by another
    // version must not quietly make closing the window end a running session.
    for (const value of [undefined, null, 0, '', 'false', 'no']) {
      expect(normalizeSettings({ closeToTray: value }).closeToTray).toBe(true);
    }
    expect(normalizeSettings({ closeToTray: false }).closeToTray).toBe(false);
  });
});

describe('the appearance preference', () => {
  it('keeps only a scheme this version can render', () => {
    // A file from a later version could name a theme with no tokens behind it.
    // Adopting it would leave the app claiming to be in a theme it cannot
    // draw, which is worse than falling back to one it can.
    for (const value of ['solarized', '', 'Dark', 0, null, {}, ['dark']]) {
      expect(normalizeSettings({ appearance: value }).appearance).toBe(DEFAULT_SETTINGS.appearance);
    }
  });

  it('accepts each scheme it does understand', () => {
    for (const value of APPEARANCES) {
      expect(normalizeSettings({ appearance: value }).appearance).toBe(value);
    }
  });

  it('follows the system for a profile written before the field existed', () => {
    // The upgrade path, and a deliberate product decision rather than an
    // accident of defaulting: an absent preference has never been set, so the
    // honest reading is the one the user already gave their OS.
    const beforeTheField = {
      dailyAdvisorySeconds: 3600,
      cooldownSeconds: 0,
      launchAtLogin: false,
      closeToTray: true,
    };
    expect(normalizeSettings(beforeTheField).appearance).toBe('system');
    // And nothing else about that profile moves.
    expect(normalizeSettings(beforeTheField).dailyAdvisorySeconds).toBe(3600);
    expect(normalizeSettings(beforeTheField).closeToTray).toBe(true);
  });
});

describe('resolving a preference against the operating system', () => {
  it('ignores the system for an explicit choice', () => {
    // Both directions: an explicit theme is a decision, and an OS that
    // disagrees with it does not get a vote.
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
  });

  it('follows the system only when asked to', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('a settings snapshot', () => {
  it('does not share state with what it was taken from', () => {
    const original: Settings = { ...DEFAULT_SETTINGS };
    const copy = snapshotSettings(original);
    copy.dailyAdvisorySeconds = 1;
    expect(original.dailyAdvisorySeconds).toBe(DEFAULT_SETTINGS.dailyAdvisorySeconds);
  });
});

const record = (startedAt: number, seconds: number): SessionRecord =>
  ({ id: `r${startedAt}`, startedAt, actualSeconds: seconds }) as SessionRecord;

describe('the advisory the settings drive', () => {
  const noon = new Date(2026, 0, 15, 12, 0, 0).getTime();

  it('reports nothing left once the threshold is passed', () => {
    const records = [record(noon - 3600_000, 3600), record(noon - 1800_000, 1800)];
    const settings = normalizeSettings({ dailyAdvisorySeconds: 5400 });
    expect(remainingAdvisorySeconds(records, settings.dailyAdvisorySeconds, noon)).toBe(0);
    expect(advisoryExceeded(records, settings.dailyAdvisorySeconds, noon)).toBe(true);
  });

  it('never fires when the user has turned it off', () => {
    // 0 is off, and off has to mean off — an advisory that still fired at zero
    // would be a limit, which is the one thing this must never be.
    const records = [record(noon - 3600_000, 3600)];
    const off = normalizeSettings({ dailyAdvisorySeconds: 0 });
    expect(advisoryExceeded(records, off.dailyAdvisorySeconds, noon)).toBe(false);
    expect(remainingAdvisorySeconds(records, off.dailyAdvisorySeconds, noon)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});
