/**
 * The tray icon.
 *
 * How a tray behaves is genuinely different on each platform, and the
 * differences are not cosmetic:
 *
 * - macOS: setting a context menu makes a left click open that menu, so the
 *   menu is popped up explicitly on right click and the left click is left
 *   free to toggle the popover.
 * - Windows: a context menu and a left click coexist. New tray icons start
 *   hidden behind the overflow chevron, which is a first-run explanation
 *   rather than a bug.
 * - Linux: click events are not delivered at all, so the context menu is the
 *   whole interface, and whether an icon appears depends on the desktop
 *   environment — GNOME needs a StatusNotifierItem extension. Best-effort:
 *   the app must stay usable when there is no tray.
 *
 * The icon's colour is a fourth difference. Only macOS tints a template image,
 * so on Windows and Linux the ink has to be chosen here — see `icon()`.
 */

import { Menu, Tray, nativeImage, nativeTheme } from 'electron';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * How long to keep re-reading after a theme change, and how often.
 *
 * The registry settles a moment after the notification arrives, so a single
 * read when the event fires returns the value being replaced. A short burst
 * covers that without a standing timer: each read spawns `reg`, and a tray app
 * sits in the background for hours, so a continuous poll would be hundreds of
 * process launches an hour to catch something that happens by hand and rarely.
 * This costs nothing at all until the theme actually changes.
 */
const SETTLE_INTERVAL_MS = 500;
const SETTLE_ATTEMPTS = 8;

const PERSONALIZE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';

/**
 * Whether the Windows taskbar is dark, or null if it could not be read.
 *
 * Two Electron properties look like they answer this and neither does.
 * `shouldUseDarkColors` is the *app* theme, which Windows keeps separate from
 * the taskbar's. `shouldUseDarkColorsForSystemIntegratedUI` is documented as
 * the system one, and measured across four switches it reports the *previous*
 * state every time — it lags one transition rather than being wrong once, so it
 * is not usable even as an approximation.
 *
 * The registry reflects the current setting immediately, so it is read
 * directly. It settles slightly after the theme-change notification, though,
 * which is why the poll matters and an event-driven read alone did not work:
 * reading at the moment the event fires returns the value being replaced.
 */
function windowsTaskbarIsDark(): boolean | null {
  const result = spawnSync('reg', ['query', PERSONALIZE, '/v', 'SystemUsesLightTheme'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  const match = /SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(result.stdout);
  if (!match) return null;
  return Number.parseInt(match[1], 16) === 0;
}

export interface TrayHooks {
  /** Show or dismiss the Session popover, anchored to the tray. */
  togglePopover(tray: Tray): void;
  showPopover(tray: Tray): void;
  showStudio(): void;
  stopSession(): void;
  quit(): void;
}

/** What the menu needs to know about the session to describe it. */
export interface TraySessionState {
  /** Whether there is anything to stop. */
  playing: boolean;
  /** Names what stopping would actually stop — a session and a preview differ. */
  stopLabel: string;
  /** The tooltip, so hovering says what the app is doing. */
  summary: string;
}

export interface TrayHandle {
  readonly tray: Tray;
  update(state: TraySessionState): void;
  destroy(): void;
}

/** Whether the icon needs white ink to be visible where it is about to sit. */
function needsLightInk(): boolean {
  // macOS is handed the black template and tints it itself, both ways.
  if (process.platform === 'darwin') return false;
  if (process.platform === 'win32') {
    const dark = windowsTaskbarIsDark();
    // Where the registry cannot be read at all, fall back to the app theme
    // rather than the system-integrated property: the app theme is at least
    // current, and the two settings move together unless the user has split
    // them deliberately. The system-integrated one is a transition behind.
    return dark ?? nativeTheme.shouldUseDarkColors;
  }
  // Linux has no system/app split to read; the GTK theme is the best signal
  // available, and a wrong guess is a cosmetic miss on a best-effort tray.
  return nativeTheme.shouldUseDarkColors;
}

function icon(): Electron.NativeImage {
  const light = needsLightInk();
  // Windows draws the tray at a size that follows display scaling — 20px at
  // 125%, 24px at 150% — and stretches a 16px PNG to get there, which looks
  // soft. The .ico carries those sizes so the shell picks instead of resamples.
  // Elsewhere createFromPath picks up the neighbouring @2x file for HiDPI.
  const extension = process.platform === 'win32' ? 'ico' : 'png';
  const file = `tray-icon${light ? '-light' : ''}.${extension}`;
  const image = nativeImage.createFromPath(join(__dirname, 'assets', file));
  // Only meaningful on macOS, and only correct for the black ink.
  image.setTemplateImage(process.platform === 'darwin');
  return image;
}

/**
 * Create the tray icon, or report that this system has nowhere to put one.
 *
 * Returns null rather than throwing: on Linux a missing tray host is an
 * ordinary configuration, not a failure to start. Every action the tray offers
 * is reachable from Studio and the global hotkey, so the app remains complete
 * without it.
 */
export function createTray(hooks: TrayHooks): TrayHandle | null {
  let tray: Tray;
  try {
    tray = new Tray(icon());
  } catch (error) {
    console.warn(
      '[main] no tray icon on this system; use the Studio window or the global hotkey:',
      error,
    );
    return null;
  }

  const isMac = process.platform === 'darwin';
  let menu = Menu.buildFromTemplate([]);

  let light = needsLightInk();
  let settling: ReturnType<typeof setInterval> | null = null;

  const stopSettling = (): void => {
    if (!settling) return;
    clearInterval(settling);
    settling = null;
  };

  /** Returns whether the ink changed, which is also when there is no more to wait for. */
  const applyInk = (): boolean => {
    const next = needsLightInk();
    if (next === light) return false;
    light = next;
    tray.setImage(icon());
    return true;
  };

  // Chromium reports the app theme changing, which is a reliable signal that
  // something happened even though it is not the setting this reads. What it
  // cannot say is when the registry has caught up, hence the short burst.
  //
  // Known gap: Windows can theme the taskbar and applications separately, and
  // changing only the taskbar fires nothing here. The icon is then correct from
  // the next launch. Catching that needs a standing poll, which is not worth
  // what it costs for a setting almost nobody splits and then changes.
  const followTheme = (): void => {
    stopSettling();
    let remaining = SETTLE_ATTEMPTS;
    settling = setInterval(() => {
      remaining -= 1;
      if (applyInk() || remaining <= 0) stopSettling();
    }, SETTLE_INTERVAL_MS);
    // Nothing should stay alive for a cosmetic timer.
    settling.unref();
  };
  nativeTheme.on('updated', followTheme);

  const update = (state: TraySessionState): void => {
    menu = Menu.buildFromTemplate([
      {
        label: 'Session…',
        // On Linux this is the only way in, so it opens rather than toggles:
        // a menu item that sometimes closes the window it names is a puzzle.
        click: () => hooks.showPopover(tray),
      },
      { label: 'Open Studio', click: () => hooks.showStudio() },
      { type: 'separator' },
      {
        label: state.stopLabel,
        enabled: state.playing,
        click: () => hooks.stopSession(),
      },
      { type: 'separator' },
      { label: 'Quit 40 Hz', click: () => hooks.quit() },
    ]);

    // Only macOS pops the menu up on demand; elsewhere the tray owns it and
    // setting it is what makes right click work at all.
    if (!isMac) tray.setContextMenu(menu);

    tray.setToolTip(state.summary);
  };

  update({ playing: false, stopLabel: 'Stop session', summary: '40 Hz' });

  if (isMac) {
    tray.on('right-click', () => tray.popUpContextMenu(menu));
  }
  // Not delivered on Linux, which is why the context menu carries everything.
  tray.on('click', () => hooks.togglePopover(tray));

  return {
    tray,
    update,
    destroy: () => {
      stopSettling();
      nativeTheme.off('updated', followTheme);
      tray.destroy();
    },
  };
}
