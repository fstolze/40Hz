/**
 * When closing Studio should hide it, and when it should really close.
 *
 * These cases only appear on a desktop where the tray is absent or a lie, so
 * they are asserted here rather than discovered by a user left with a hidden
 * process playing audio they cannot stop.
 */

import { describe, it, expect } from './helpers/expect.ts';
import {
  studioBounds,
  studioCloseAction,
  STUDIO_MAXIMUM,
  STUDIO_MINIMUM,
} from '../electron/window-policy.ts';

describe('closing Studio where the tray is real', () => {
  it('hides on macOS when a tray was constructed', () => {
    // The point of tray residency: a session may be playing, and destroying
    // this window would take the audio graph with it.
    const action = studioCloseAction({
      quitting: false,
      trayConstructed: true,
      closeToTray: true,
      platform: 'darwin',
    });
    expect(action).toBe('hide');
  });

  it('hides on Windows when a tray was constructed', () => {
    const action = studioCloseAction({
      quitting: false,
      trayConstructed: true,
      closeToTray: true,
      platform: 'win32',
    });
    expect(action).toBe('hide');
  });

  it('quits where the tray could not be constructed at all', () => {
    // Quit, not close. Letting the window go first would destroy the renderer
    // that owns the audio graph, so a running session could no longer be
    // stopped cleanly — only recorded as an interruption after the fact.
    const action = studioCloseAction({
      quitting: false,
      trayConstructed: false,
      closeToTray: true,
      platform: 'win32',
    });
    expect(action).toBe('quit');
  });
});

describe('closing Studio on Linux', () => {
  it('quits even though a tray was constructed', () => {
    // The reported bug. `new Tray()` returns an object and throws nothing on a
    // desktop with no StatusNotifierItem host — GNOME without the extension —
    // so a constructed tray is not evidence of a visible one. Hiding there
    // left a session playing with no window, no icon, and no way to stop it.
    const action = studioCloseAction({
      quitting: false,
      trayConstructed: true,
      closeToTray: true,
      platform: 'linux',
    });
    expect(action).toBe('quit');
  });
});

describe('closing Studio with tray residency turned off', () => {
  it('quits on macOS even though the tray is real', () => {
    // The whole point of the setting: the user has asked for the window to be
    // the app. Quitting is always safe here — it finalizes a running session
    // while the renderer is still there to answer — so the setting can only
    // ever move the answer towards `quit`.
    const action = studioCloseAction({
      quitting: false,
      trayConstructed: true,
      closeToTray: false,
      platform: 'darwin',
    });
    expect(action).toBe('quit');
  });

  it('quits on Windows even though the tray is real', () => {
    const action = studioCloseAction({
      quitting: false,
      trayConstructed: true,
      closeToTray: false,
      platform: 'win32',
    });
    expect(action).toBe('quit');
  });

  it('still really closes while quitting', () => {
    // Quitting outranks it, or the window refuses to close and the app never
    // exits — the same failure the setting being on would cause.
    const action = studioCloseAction({
      quitting: true,
      trayConstructed: true,
      closeToTray: false,
      platform: 'darwin',
    });
    expect(action).toBe('close');
  });
});

describe('closing Studio while quitting', () => {
  it('really closes, however visible the tray is', () => {
    // Otherwise the window refuses to close and the app never exits.
    const action = studioCloseAction({
      quitting: true,
      trayConstructed: true,
      closeToTray: true,
      platform: 'darwin',
    });
    expect(action).toBe('close');
  });
});

describe('the size Studio opens at', () => {
  it('clears the one-line header threshold when the display allows it', () => {
    // 1280 is not a preference for space — it is where the header's two groups
    // stop wrapping. Wider only makes the workbench wide, so it is a ceiling.
    const { width } = studioBounds({ width: 3840, height: 2160 });
    expect(width).toBe(STUDIO_MAXIMUM.width);
  });

  it('takes the height the display offers, which the old literal did not', () => {
    /*
     * The asymmetry with width is the point. The recipe is about 875px of
     * content, so a fixed 840 showed roughly a quarter of it however tall the
     * screen was; a layout audit measured 1280x1000 as showing nearly twice
     * that with no change to density or hierarchy.
     */
    expect(studioBounds({ width: 1512, height: 945 }).height).toBeGreaterThan(840);
    expect(studioBounds({ width: 3840, height: 2160 }).height).toBe(STUDIO_MAXIMUM.height);
  });

  it('never opens larger than the work area it is given', () => {
    // The defect this replaces: a laptop whose work area is shorter than 840
    // opened a window taller than the space it had.
    for (const area of [
      { width: 1280, height: 800 },
      { width: 1440, height: 720 },
      { width: 1024, height: 768 },
    ]) {
      const opened = studioBounds(area);
      expect(opened.width).toBeLessThanOrEqual(area.width);
      expect(opened.height).toBeLessThanOrEqual(area.height);
    }
  });

  it('fits a display smaller than the supported minimum rather than hanging off it', () => {
    /*
     * Below the minimum the layout is not supported, and that is not a reason
     * to open a window whose edges cannot be reached: the single scroll owner
     * keeps every control reachable, a window off the screen does not.
     */
    const tiny = studioBounds({ width: 800, height: 560 });
    expect(tiny.width).toBeLessThanOrEqual(800);
    expect(tiny.height).toBeLessThanOrEqual(560);
  });

  it('holds the supported minimum whenever the display can carry it', () => {
    /*
     * The margin must not push the window below the supported size on its own.
     *
     * These work areas clear the minimum but not the minimum *plus* the margin
     * left for the dock and the frame — 910 against 900 + 24, 660 against
     * 640 + 32. Subtracting first and stopping there gives 886x628, which is
     * under the layout's own floor for no reason the display asked for. A
     * roomier display never exercises this, which is how the first version of
     * this test missed it.
     */
    const snug = studioBounds({ width: 910, height: 660 });
    expect(snug.width).toBe(STUDIO_MINIMUM.width);
    expect(snug.height).toBe(STUDIO_MINIMUM.height);
    // And it still fits, which is the constraint the floor is not allowed to break.
    expect(snug.width).toBeLessThanOrEqual(910);
    expect(snug.height).toBeLessThanOrEqual(660);

    const roomy = studioBounds({ width: 1000, height: 700 });
    expect(roomy.width).toBeGreaterThanOrEqual(STUDIO_MINIMUM.width);
    expect(roomy.height).toBeGreaterThanOrEqual(STUDIO_MINIMUM.height);
  });
});
