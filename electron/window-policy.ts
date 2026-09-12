/**
 * Decisions about window lifecycle, separated from the windows themselves.
 *
 * Free of any `electron` import so it can be tested in Node, like
 * `popover-position.ts`. The reasoning here is easy to get wrong and hard to
 * reproduce by hand — it only shows up on a desktop where the tray is not what
 * it appears to be.
 */

/**
 * What closing Studio should do.
 *
 * `quit` means *ask the app to quit*, not *let this window go*. The difference
 * matters: destroying the window first kills the renderer that owns the audio
 * graph, so a running session can no longer be stopped cleanly or recorded as
 * anything but an interruption. Quitting first finalizes it while the renderer
 * is still there to answer, and the window closes on the way out.
 */
export type CloseAction = 'hide' | 'close' | 'quit';

export interface CloseState {
  /** The user is quitting; nothing may refuse to close. */
  quitting: boolean;
  /**
   * `new Tray()` returned without throwing.
   *
   * Deliberately not called `hasTray`: on Linux it is not evidence that any
   * icon is visible. See `studioCloseAction`.
   */
  trayConstructed: boolean;
  /**
   * The user's setting: whether closing Studio should leave the app running.
   *
   * A request rather than an instruction. It can ask for hiding, and
   * `studioCloseAction` still refuses where hiding could strand the app.
   */
  closeToTray: boolean;
  platform: NodeJS.Platform;
}

/**
 * Hide Studio on close, unless hiding could strand the app.
 *
 * Hiding is the point of tray residency — a session may be playing, and
 * destroying this window would take the audio graph with it. It is only safe
 * while the user can certainly get back to a window.
 *
 * On macOS and Windows a constructed `Tray` really is displayed, so hiding is
 * safe. On Linux it is not: the icon appears only where the desktop provides a
 * StatusNotifierItem host — GNOME needs an extension — and where there is
 * none, `new Tray()` still returns an object and throws nothing. Trusting it
 * there hid the window behind a tray that did not exist, leaving a session
 * playing with no window, no icon, and no way to stop it short of killing the
 * process. Being wrong in this direction strands the user; being wrong the
 * other way merely quits an app they asked to close.
 *
 * The global hotkey is deliberately not counted. It is undiscoverable, it may
 * fail to register, and a user who does not know it exists is as stuck as one
 * with no hotkey at all.
 *
 * `closeToTray` off short-circuits all of that: the user has asked for the
 * window to be the app, so closing it quits. That is always safe — quitting
 * finalizes a running session while the renderer is still there to answer —
 * which is why the setting can only ever move the answer towards `quit`.
 */
export function studioCloseAction(state: CloseState): CloseAction {
  // Already on the way out: this is the close that actually ends the window.
  if (state.quitting) return 'close';
  if (!state.closeToTray) return 'quit';
  if (state.platform === 'linux') return 'quit';
  return state.trayConstructed ? 'hide' : 'quit';
}

/**
 * The widest worth opening, and the tallest.
 *
 * Width is a *threshold*, not a preference for space: 1280 clears the one-line
 * header with 30px in hand, and wider only makes the workbench wide. Height is
 * the opposite — the recipe is 875px of content, so at 840 about 26% of it is
 * visible before scrolling, and a layout audit measured 1280x1000 as showing
 * nearly twice that with no change to density or hierarchy. So height takes
 * what the display offers, up to a ceiling past which a window is simply large.
 */
export const STUDIO_MAXIMUM = { width: 1280, height: 1200 };
/** The size below which the layout stops being supported. */
export const STUDIO_MINIMUM = { width: 900, height: 640 };
/** Left for the dock, the taskbar and the window's own frame. */
const WORK_AREA_MARGIN = { width: 24, height: 32 };

/**
 * The opening size, fitted to the display it will open on.
 *
 * The old literals were taken as the answer rather than as bounds, so a laptop
 * whose work area is shorter than 840px opened a window taller than the space
 * it had, and a large display never got more than 840 however much it offered.
 *
 * The minimum wins over the work area deliberately, and then only down to what
 * the screen actually has: on a display smaller than the supported minimum the
 * window fits the screen rather than hanging off it. The layout is not
 * supported down there, but the single scroll owner keeps every control
 * reachable, which is a better answer than edges the user cannot reach.
 */
export function studioBounds(workArea: { width: number; height: number }): {
  width: number;
  height: number;
} {
  const fit = (available: number, margin: number, most: number, least: number) => {
    const room = Math.max(1, available - margin);
    return Math.max(Math.min(room, most), Math.min(least, available));
  };
  return {
    width: fit(workArea.width, WORK_AREA_MARGIN.width, STUDIO_MAXIMUM.width, STUDIO_MINIMUM.width),
    height: fit(
      workArea.height,
      WORK_AREA_MARGIN.height,
      STUDIO_MAXIMUM.height,
      STUDIO_MINIMUM.height,
    ),
  };
}
