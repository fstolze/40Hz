/**
 * Window creation and lifecycle.
 *
 * Two windows with very different jobs: Studio, which owns the audio graph and
 * therefore has to keep running whether or not anyone is looking at it, and the
 * Session popover, which is transient and appears next to the tray icon.
 *
 * Both are created here so their security settings cannot drift apart —
 * context isolation, the sandbox, and the navigation rules are one decision,
 * not two.
 */

import { app, BrowserWindow, nativeTheme, screen, shell, type Tray } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isSafeExternalUrl, isSameOrigin } from './url-policy.ts';
import { POPOVER_MARGIN, popoverPosition, type Rect } from './popover-position.ts';
import { studioBounds, STUDIO_MINIMUM } from './window-policy.ts';
import { studioCloseAction } from './window-policy.ts';
import { resolveTheme, type Appearance } from '../src/session/settings.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The window icon, which Windows and Linux show in the taskbar and the window
 * frame. macOS takes it from the bundle and ignores this.
 *
 * `build/icon.png` is a build resource and does not ship, so an unpackaged run
 * had no icon to give and the taskbar fell back to Electron's own. This one is
 * in `electron/assets` and travels with the app.
 */
const WINDOW_ICON = join(__dirname, 'assets', 'app-icon.png');

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

/**
 * Sized to its content rather than to a round number: the idle state is a
 * picker, a duration, and a button, and the running state is shorter still.
 * A window with a third of its height empty reads as something failing to
 * load.
 */
/**
 * The popover's width, and the height it opens at before its content reports.
 *
 * Only a starting point: the renderer measures itself and asks for the height
 * it needs, because this window's content genuinely varies — a countdown, a
 * picker, a set of recall chips, an advisory that may or may not be there.
 * A fixed height either pads the short states with dead space or clips the
 * long ones, and the message it clips is the safety one.
 */
export const POPOVER_SIZE = { width: 340, height: 320 };

/** What a self-reported height is clamped to, before the work area applies. */
export const POPOVER_MIN_HEIGHT = 200;
export const POPOVER_MAX_HEIGHT = 620;

/**
 * Whether the app is on its way out.
 *
 * Closing Studio hides it, because the app lives in the tray and a session may
 * be playing. That has to stop being true once the user actually quits, or the
 * window would refuse to close and the app would never exit.
 */
let quitting = false;

export function beginQuit(): void {
  quitting = true;
}

export function isQuitting(): boolean {
  return quitting;
}

function preloadPreferences() {
  return {
    preload: join(__dirname, 'preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    // A sandboxed preload has no `app`, and some settings only mean anything
    // in an installed build. Passed as a flag rather than over IPC so it is
    // available before the first message.
    additionalArguments: app.isPackaged ? ['--fortyhz-packaged'] : [],
  };
}

/** Where a renderer entry lives, in dev and in the build alike. */
function entry(page: string): { url: string } | { file: string } {
  if (DEV_SERVER_URL) return { url: new URL(page, DEV_SERVER_URL).href };
  return { file: join(__dirname, '../renderer', page) };
}

function load(win: BrowserWindow, page: string): void {
  const target = entry(page);
  if ('url' in target) void win.loadURL(target.url);
  else void win.loadFile(target.file);
}

/**
 * Refuse to navigate away, and hand external links to the browser.
 *
 * Each window shows one document for its whole life, so anything that tries to
 * navigate it is a fault rather than a redirect — except a same-origin reload,
 * which is how Vite delivers a full HMR refresh in dev.
 *
 * Handing a URL to the OS runs whatever is registered for its scheme, so only
 * https: is forwarded. Anything else — file:, and the assorted app-launching
 * schemes a compromised renderer or a stray link could reach for — is dropped.
 */
function confineNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isSameOrigin(url, win.webContents.getURL())) return;
    event.preventDefault();
    console.warn(`[main] blocked navigation to ${url}`);
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  });
}

function forwardRendererLogs(win: BrowserWindow, label: string): void {
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[main] ${label} failed to load (${code} ${description}): ${url}`);
  });

  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') {
      console.error(`[${label}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
}

export interface StudioHooks {
  /** Trust this renderer with the store, and nominate it as the executor. */
  adopt(win: BrowserWindow): void;
  /**
   * The audio graph is certainly gone: the renderer navigated, reloaded, or
   * was lost. Whatever was playing is not playing any more.
   */
  audioLost(why: string): void;
  /**
   * Whether a tray icon was constructed.
   *
   * Read at close time rather than at creation: the tray is established after
   * this window exists. What it means for hiding is `studioCloseAction`'s
   * decision, not this window's.
   */
  trayConstructed(): boolean;
  /**
   * The user's "keep running in the tray" setting.
   *
   * Read at close time, like `trayConstructed`, so changing it in Settings
   * applies to the next close rather than the next launch.
   */
  closeToTray(): boolean;
  /**
   * Closing Studio should end the app.
   *
   * Raised instead of letting the window close, so the session can be
   * finalized while this renderer is still alive to stop the audio.
   */
  quitRequested(): void;
}

/**
 * The window background, chosen before the renderer exists.
 *
 * This is the colour the OS paints while the page is still loading, so it has
 * to match the theme the renderer is about to select or the window opens as a
 * bright rectangle and then turns dark. Main already knows the answer — the
 * settings file is loaded before any window is created — and resolving it here
 * keeps theme ownership out of the renderer, which cannot be asked before it
 * exists.
 *
 * `system` is resolved against `nativeTheme`, the same OS truth the tray icon
 * follows. These two values are the `--bg` token of each theme; they are
 * duplicated from `app.css` because a `BrowserWindow` option cannot read CSS,
 * and they are the one pair of literals that has to be kept in step by hand.
 */
export function windowBackground(appearance: Appearance): string {
  // The same rule the renderer applies, so the paint behind the page and the
  // page cannot disagree. `shouldUseDarkColors` is read as the OS's answer and
  // nothing writes `themeSource`, so it stays that — see main.ts.
  return resolveTheme(appearance, nativeTheme.shouldUseDarkColors) === 'dark'
    ? '#07111a'
    : '#f3f6f7';
}

export function createStudioWindow(hooks: StudioHooks, appearance: Appearance): BrowserWindow {
  const opening = studioBounds(screen.getPrimaryDisplay().workArea);
  const win = new BrowserWindow({
    /*
     * Wide enough that the header opens on one line.
     *
     * The header's two groups are sized to their real min-content widths, so
     * they share a row only when both genuinely fit — 600 + 590 + a 20px gap +
     * 36px of padding. Measured by sweeping the window in 10px steps, the row
     * breaks at 1240 and holds at 1250, and the app used to open at 1180: every
     * launch started with Preview and Master wrapped onto a second line for no
     * reason but the default. 1280 clears the threshold with 30px in hand.
     *
     * This number is coupled to those flex bases in `AppHeader.svelte`. Widen a
     * header group and this has to move with it; `npm run check:layout` asserts
     * the single row at this size so the pair cannot drift apart quietly.
     *
     * It is a *preference*, not the size: `studioBounds` fits it to the display
     * this window is about to open on, which is why the literals moved out of
     * this call.
     */
    ...opening,
    minWidth: STUDIO_MINIMUM.width,
    minHeight: STUDIO_MINIMUM.height,
    show: false,
    icon: WINDOW_ICON,
    backgroundColor: windowBackground(appearance),
    title: '40 Hz — Studio',
    webPreferences: {
      ...preloadPreferences(),
      // A session runs for the best part of an hour with the window behind
      // whatever the user is actually doing, and Studio holds the graph.
      backgroundThrottling: false,
    },
  });

  hooks.adopt(win);

  // Any navigation of the main frame tears down the audio graph — a reload
  // included, and a reload that then stalls or crashes would otherwise leave a
  // session counting against a graph that no longer exists. Waiting for the
  // replacement executor to register is not enough, because it may never come.
  win.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) hooks.audioLost('the renderer navigated');
  });
  win.webContents.on('render-process-gone', () => {
    hooks.audioLost('the renderer was lost');
  });

  // Closing Studio normally puts the app in the tray rather than ending it: a
  // session may well be playing, and destroying this window would take the
  // audio graph with it. See `studioCloseAction` for when that is not safe.
  win.on('close', (event) => {
    const action = studioCloseAction({
      quitting: isQuitting(),
      trayConstructed: hooks.trayConstructed(),
      closeToTray: hooks.closeToTray(),
      platform: process.platform,
    });
    if (action === 'close') return;
    event.preventDefault();
    if (action === 'hide') win.hide();
    // Not `win.close()`: quitting has to finalize the session first, and doing
    // that needs this window's renderer. It closes again once quitting is
    // under way, and `studioCloseAction` returns 'close' by then.
    else hooks.quitRequested();
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => {
    console.log('[main] renderer loaded');
  });

  forwardRendererLogs(win, 'renderer');
  confineNavigation(win);
  load(win, 'index.html');

  return win;
}

/**
 * Bring Studio back, recreating it only if it was genuinely destroyed.
 *
 * Testing `getAllWindows().length === 0` is the usual macOS `activate` idiom
 * and is wrong here: Studio is hidden, not closed, so the count is never zero
 * and a Dock click would do nothing.
 */
export function revealStudio(
  win: BrowserWindow | null,
  create: () => BrowserWindow,
): BrowserWindow {
  if (win === null || win.isDestroyed()) return create();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

export interface PopoverHooks {
  adopt(win: BrowserWindow): void;
}

/**
 * The Session popover: shown next to the tray icon, dismissed by clicking away.
 */
export interface Popover {
  readonly window: BrowserWindow;
  show(tray: Tray | null): void;
  hide(): void;
  /** For the tray click, which has to undo a show as well as cause one. */
  toggle(tray: Tray | null): void;
  /** Resize to the content height the renderer reports. Clamped here. */
  setHeight(pixels: number): void;
}

export function createPopover(hooks: PopoverHooks, appearance: Appearance): Popover {
  const win = new BrowserWindow({
    ...POPOVER_SIZE,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // A panel hanging off the tray, not a window in the window list. It has to
    // sit above whatever the user is working in, since that is what they were
    // looking at when they reached for the tray.
    alwaysOnTop: true,
    icon: WINDOW_ICON,
    backgroundColor: windowBackground(appearance),
    title: '40 Hz',
    webPreferences: preloadPreferences(),
  });

  hooks.adopt(win);

  // Follow the user between Spaces rather than pulling them back to the one
  // the popover was first shown on.
  //
  // `skipTransformProcessType` is what keeps the Dock icon. Without it,
  // `visibleOnFullScreen` makes Electron turn the whole app into a UI element
  // on macOS — measured on 43.4.1, `app.dock.isVisible()` goes from true to
  // false — which also takes it out of Cmd+Tab, stops its menu bar appearing
  // over Studio, and leaves the Dock-click `activate` handler unreachable. The
  // price is that the popover may not float above another app's full-screen
  // Space.
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });

  /**
   * When the popover last dismissed itself.
   *
   * Clicking the tray icon while the popover is open blurs it first, so by the
   * time the click arrives the window is already hidden and a naive toggle
   * would immediately reopen it — the popover would appear impossible to
   * close. A dismissal this recent means the click that caused it has already
   * done its job.
   */
  let dismissedAt = 0;

  const hide = (): void => {
    if (win.isDestroyed() || !win.isVisible()) return;
    dismissedAt = Date.now();
    win.hide();
  };

  win.on('blur', hide);

  // Frameless windows are still closable through the OS: macOS installs a
  // default menu with Cmd+W, and Alt+F4 closes anything on Windows. Nothing
  // recreates this window, so allowing that would permanently disable Session
  // — the tray and the hotkey would open nothing until the app restarted.
  win.on('close', (event) => {
    if (isQuitting()) return;
    event.preventDefault();
    hide();
  });

  // Escape dismisses it too. Handled here rather than through a new IPC
  // channel, so the renderer gains no ability to move or hide windows.
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') hide();
  });

  forwardRendererLogs(win, 'popover');
  confineNavigation(win);
  load(win, 'session.html');

  /**
   * The tray rectangle the popover was last placed against.
   *
   * Kept so a resize can put the window back where it belongs. Growing from a
   * fixed top-left walks a bottom-anchored popover down into the taskbar.
   */
  let anchor: Rect | null = null;

  const place = (): void => {
    if (win.isDestroyed()) return;
    const display =
      anchor === null
        ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
        : screen.getDisplayMatching(anchor);

    // The window's real size, not the size it opens at. It resizes itself to
    // its content, so a fixed figure here would place a taller popover as
    // though it were short — off the bottom of the screen, or under the
    // taskbar, exactly when an advisory has made it taller.
    const [width, height] = win.getSize();

    const { x, y } = popoverPosition({
      tray: anchor,
      popover: { width, height },
      workArea: display.workArea,
    });
    win.setPosition(x, y, false);
  };

  const show = (tray: Tray | null): void => {
    // Close is prevented above, so this window is destroyed only on quit —
    // and asking a destroyed window anything throws.
    if (win.isDestroyed()) return;

    anchor = readTrayBounds(tray);
    place();
    win.show();
    win.focus();
  };

  return {
    window: win,
    show,
    hide,
    setHeight: (pixels) => {
      if (win.isDestroyed()) return;
      const display = screen.getDisplayNearestPoint(win.getBounds());
      // Never taller than the screen it is on, whatever the renderer asks.
      const ceiling = Math.min(POPOVER_MAX_HEIGHT, display.workArea.height - POPOVER_MARGIN * 2);
      const height = Math.round(Math.max(POPOVER_MIN_HEIGHT, Math.min(ceiling, pixels)));
      const [, current] = win.getContentSize();
      // A no-op resize still fires a resize event in the renderer, which would
      // measure and ask again — a loop that never settles.
      if (height === current) return;
      win.setContentSize(POPOVER_SIZE.width, height);
      // Its anchor is the tray, so growing from a fixed top-left walks a
      // bottom-anchored popover down into the taskbar. Put it back.
      //
      // Conditioned on being visible rather than on a flag saying it was shown
      // through `show()`: the renderer keeps measuring while hidden, and
      // moving an invisible window is work for nobody. A flag would also be
      // wrong whenever something showed the window another way.
      if (win.isVisible()) place();
    },
    toggle: (tray) => {
      if (win.isDestroyed()) return;
      if (win.isVisible()) hide();
      else if (Date.now() - dismissedAt > DISMISS_GRACE_MS) show(tray);
    },
  };
}

/**
 * How long after a self-dismissal a tray click counts as having caused it.
 *
 * Long enough to cover the gap between blur and click, short enough that a
 * deliberate second click still reopens the popover.
 */
const DISMISS_GRACE_MS = 250;

/**
 * The tray icon's rectangle, where the platform reports one.
 *
 * `Tray.getBounds()` exists only on macOS and Windows. On Linux the tray is
 * whatever the desktop environment provides, and there is no position to
 * anchor to — so the popover falls back to a corner of the work area.
 */
function readTrayBounds(tray: Tray | null): Rect | null {
  if (tray === null || typeof tray.getBounds !== 'function') return null;
  const bounds = tray.getBounds();
  // A zero rectangle is the tray saying it does not know where it is.
  if (bounds.width === 0 && bounds.height === 0) return null;
  return bounds;
}
