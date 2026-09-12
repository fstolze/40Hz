/**
 * User settings: the advisory, the cooldown, and launch at login.
 *
 * Pure and portable like the rest of `src/session/` — no Electron, no Web
 * Audio — so the defaults and the normalization are testable offline and the
 * browser build can hold settings in `localStorage` without a second model.
 *
 * Everything here is **advisory**. The daily threshold warns and never
 * restricts, per the governing decision that this app reminds rather than
 * gates: a session past the threshold is always permitted, and the UI simply
 * says so. Nothing in this module returns a verdict that blocks anything.
 */

import { asNumber, asRecord, clampOr } from '../audio/configuration.ts';

/**
 * Which colour scheme the interface uses.
 *
 * `system` is a *following* state, not a third palette: it resolves to light
 * or dark from the operating system and keeps resolving as that changes. The
 * stored preference stays `system` throughout — resolving it into the file
 * would freeze a choice the user asked to be dynamic.
 */
export type Appearance = 'light' | 'dark' | 'system';

/** Every appearance this version understands. A file may name others. */
export const APPEARANCES: readonly Appearance[] = ['light', 'dark', 'system'];

export interface Settings {
  /**
   * The daily listening advisory, in seconds. 0 turns it off.
   *
   * A number of seconds rather than minutes because every consumer —
   * `listeningSecondsOnDay`, `remainingAdvisorySeconds` — works in seconds,
   * and converting at the edges is where off-by-sixty lives.
   */
  dailyAdvisorySeconds: number;
  /**
   * How long to suggest waiting between sessions, in seconds. 0 turns it off.
   *
   * Off by default: back-to-back sessions are not known to be harmful, and a
   * warning nobody asked for is noise. It exists because someone pacing
   * themselves deliberately has no other way to be reminded.
   */
  cooldownSeconds: number;
  /** Start the app when the user logs in. Ignored where the OS has no such notion. */
  launchAtLogin: boolean;
  /**
   * Whether closing Studio leaves the app running in the tray.
   *
   * On by default, because that is what tray residency is for and because a
   * session may be playing when the window is closed. Turning it off makes
   * closing the window quit the app — which finalizes a running session first,
   * rather than dropping it.
   *
   * Advisory only in one direction: this can ask for hiding, but it cannot
   * make hiding safe. Where there may be no tray to return from,
   * `studioCloseAction` quits regardless.
   */
  closeToTray: boolean;
  /**
   * Light, dark, or follow the operating system.
   *
   * Defaults to `system` because that is what a colour-scheme preference is
   * for: the user has already told their OS what they want, and asking again
   * is asking twice. It does mean an existing profile — which predates this
   * field and therefore ran dark unconditionally — follows the OS after an
   * upgrade rather than staying dark. That is the honest reading of a default
   * that has never been set, and one control changes it.
   */
  appearance: Appearance;
}

/**
 * Two hours a day, advisory only.
 *
 * Above any ordinary day's use — sessions run 45 to 60 minutes, so this is two
 * of them — which is what an advisory should be. Set low enough to be a daily
 * nag and it would be dismissed rather than read, and the one time it mattered
 * it would be invisible among the others. The user can change or disable it.
 */
export const DEFAULT_DAILY_ADVISORY_SECONDS = 2 * 60 * 60;

export const DEFAULT_SETTINGS: Settings = {
  dailyAdvisorySeconds: DEFAULT_DAILY_ADVISORY_SECONDS,
  cooldownSeconds: 0,
  launchAtLogin: false,
  closeToTray: true,
  appearance: 'system',
};

/**
 * Longest advisory or cooldown that can be stored, in seconds.
 *
 * A day, because a threshold longer than the day it applies to can never be
 * reached and would read as "off" while displaying as "on" — worse than
 * either. It also bounds what a hand-edited file can claim.
 */
const MAX_ADVISORY_SECONDS = 24 * 60 * 60;

/**
 * Rebuild settings from untrusted input.
 *
 * Disk and IPC both, for the usual reasons: the file survives across versions,
 * can be hand-edited, and can be left half written by a crash. Every field is
 * rebuilt from the defaults rather than checked in place, so a value this
 * version has never heard of cannot survive into the app.
 *
 * Never returns null. There is no such thing as an unusable settings file —
 * the worst case is the defaults, which are always safe.
 */
export function normalizeSettings(value: unknown): Settings {
  // `asRecord` already answers `{}` for anything that is not an object.
  const raw = asRecord(value);
  return {
    dailyAdvisorySeconds: clampOr(
      asNumber(raw.dailyAdvisorySeconds),
      0,
      MAX_ADVISORY_SECONDS,
      DEFAULT_SETTINGS.dailyAdvisorySeconds,
    ),
    cooldownSeconds: clampOr(
      asNumber(raw.cooldownSeconds),
      0,
      MAX_ADVISORY_SECONDS,
      DEFAULT_SETTINGS.cooldownSeconds,
    ),
    // Anything other than a real `true` is off. A stored string "true" is a
    // sign of a file this version did not write, and starting the app at login
    // because of one would be a surprising thing to guess at.
    launchAtLogin: raw.launchAtLogin === true,
    // The mirror of the line above, because the default is the other way
    // round: only a real `false` turns this off. Anything unrecognised leaves
    // the app in the tray, which is the state a user can always get back from.
    closeToTray: raw.closeToTray !== false,
    // Only a name this version knows survives. A file from a later version
    // could carry an appearance this one cannot render, and adopting it would
    // leave the app with no tokens for the theme it claims to be in.
    appearance: isAppearance(raw.appearance) ? raw.appearance : DEFAULT_SETTINGS.appearance,
  };
}

/**
 * What an appearance preference resolves to, given what the OS says.
 *
 * One rule, used by both processes. Under Electron the main process supplies
 * `systemDark` from `nativeTheme`, because the renderer cannot read it — a
 * measured Electron 43 constraint, not a stylistic choice: `prefers-color-scheme`
 * inside the renderer reports light on a dark Mac whatever `themeSource` is set
 * to. In a plain browser the renderer supplies it from `matchMedia`, where the
 * media query does work.
 *
 * Pure, so the rule itself is testable without either of them.
 */
export function resolveTheme(appearance: Appearance, systemDark: boolean): 'light' | 'dark' {
  if (appearance === 'light') return 'light';
  if (appearance === 'dark') return 'dark';
  return systemDark ? 'dark' : 'light';
}

function isAppearance(value: unknown): value is Appearance {
  return typeof value === 'string' && (APPEARANCES as readonly string[]).includes(value);
}

/** A detached copy, so a stored value cannot be edited through a reference. */
export function snapshotSettings(settings: Settings): Settings {
  return { ...settings };
}
