/**
 * Popover placement.
 *
 * Pure geometry, which is the point: a taskbar docked to the top, a tray icon
 * hard against a screen edge, a second monitor at negative coordinates, and a
 * platform that reports no tray rectangle at all are all cheap to assert here
 * and tedious to reproduce by hand.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { POPOVER_MARGIN, popoverPosition, type Rect } from '../electron/popover-position.ts';

const POPOVER = { width: 360, height: 420 };

/** A 1920x1080 display with a 40px taskbar at the bottom. */
const TASKBAR_BOTTOM: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
/** The same display with the bar at the top, as macOS and some Linux setups have. */
const BAR_TOP: Rect = { x: 0, y: 40, width: 1920, height: 1040 };

describe('anchored to a tray icon', () => {
  it('opens upwards from an icon in the lower half', () => {
    // The usual Windows taskbar: the icon is at the bottom, so the only room
    // is above it.
    const tray = { x: 1700, y: 1040, width: 24, height: 24 };
    const { y } = popoverPosition({ tray, popover: POPOVER, workArea: TASKBAR_BOTTOM });
    expect(y).toBe(1040 - POPOVER.height - POPOVER_MARGIN);
  });

  it('opens downwards from an icon in the upper half', () => {
    // A menu bar, or a taskbar docked to the top. One rule covers both.
    // The bar itself is outside the work area, so the popover lands just
    // below the bar rather than overlapping it.
    const tray = { x: 1700, y: 8, width: 24, height: 24 };
    const { y } = popoverPosition({ tray, popover: POPOVER, workArea: BAR_TOP });
    expect(y).toBe(BAR_TOP.y + POPOVER_MARGIN);
  });

  // A taskbar docked to a side puts the icon in the middle of the screen
  // vertically, where neither direction is forced by the work area edge. This
  // is where the upper/lower rule does the work rather than the clamp.
  const TASKBAR_RIGHT: Rect = { x: 0, y: 0, width: 1880, height: 1080 };

  it('opens upwards from an icon low on a side taskbar', () => {
    const tray = { x: 1885, y: 900, width: 24, height: 24 };
    const { y } = popoverPosition({ tray, popover: POPOVER, workArea: TASKBAR_RIGHT });
    expect(y).toBe(900 - POPOVER.height - POPOVER_MARGIN);
  });

  it('opens downwards from an icon high on a side taskbar', () => {
    const tray = { x: 1885, y: 100, width: 24, height: 24 };
    const { y } = popoverPosition({ tray, popover: POPOVER, workArea: TASKBAR_RIGHT });
    expect(y).toBe(100 + 24 + POPOVER_MARGIN);
  });

  it('pulls back from a side taskbar rather than sitting under it', () => {
    // Centring on an icon in the taskbar would push the popover past the work
    // area and under the bar.
    const tray = { x: 1885, y: 900, width: 24, height: 24 };
    const { x } = popoverPosition({ tray, popover: POPOVER, workArea: TASKBAR_RIGHT });
    expect(x).toBe(1880 - POPOVER.width - POPOVER_MARGIN);
  });

  it('centres horizontally on the icon', () => {
    const tray = { x: 900, y: 1040, width: 24, height: 24 };
    const { x } = popoverPosition({ tray, popover: POPOVER, workArea: TASKBAR_BOTTOM });
    expect(x).toBe(Math.round(900 + 12 - POPOVER.width / 2));
  });
});

describe('staying on screen', () => {
  it('does not run off the right edge', () => {
    // A tray icon in the far corner would centre the popover past the screen.
    const tray = { x: 1900, y: 1040, width: 24, height: 24 };
    const { x } = popoverPosition({ tray, popover: POPOVER, workArea: TASKBAR_BOTTOM });
    expect(x).toBe(1920 - POPOVER.width - POPOVER_MARGIN);
  });

  it('does not run off the left edge', () => {
    const tray = { x: 0, y: 1040, width: 24, height: 24 };
    const { x } = popoverPosition({ tray, popover: POPOVER, workArea: TASKBAR_BOTTOM });
    expect(x).toBe(POPOVER_MARGIN);
  });

  it('keeps the top-left visible when the popover is taller than the work area', () => {
    // Clamping in the other direction would slide the window off the top,
    // leaving the controls unreachable.
    const small: Rect = { x: 0, y: 0, width: 300, height: 200 };
    const tray = { x: 250, y: 180, width: 24, height: 24 };
    const { x, y } = popoverPosition({ tray, popover: POPOVER, workArea: small });
    expect(x).toBe(POPOVER_MARGIN);
    expect(y).toBe(POPOVER_MARGIN);
  });
});

describe('a second monitor', () => {
  it('places within that display, not the primary', () => {
    // A display to the left of the primary has negative coordinates; treating
    // the work area origin as 0 would put the popover on the wrong screen.
    const secondary: Rect = { x: -1920, y: 0, width: 1920, height: 1040 };
    const tray = { x: -300, y: 1040, width: 24, height: 24 };
    const { x, y } = popoverPosition({ tray, popover: POPOVER, workArea: secondary });
    expect(x).toBe(Math.round(-300 + 12 - POPOVER.width / 2));
    expect(y).toBe(1040 - POPOVER.height - POPOVER_MARGIN);
  });

  it('clamps to the edges of that display', () => {
    const secondary: Rect = { x: -1920, y: 0, width: 1920, height: 1040 };
    const tray = { x: -1920, y: 1040, width: 24, height: 24 };
    const { x } = popoverPosition({ tray, popover: POPOVER, workArea: secondary });
    expect(x).toBe(-1920 + POPOVER_MARGIN);
  });
});

describe('without a tray rectangle', () => {
  it('falls back to the top-right of the work area', () => {
    // Linux: Tray.getBounds() does not exist, so there is nothing to anchor
    // to. Top-right is where a tray usually is when there is one.
    const { x, y } = popoverPosition({ tray: null, popover: POPOVER, workArea: TASKBAR_BOTTOM });
    expect(x).toBe(1920 - POPOVER.width - POPOVER_MARGIN);
    expect(y).toBe(POPOVER_MARGIN);
  });

  it('respects a work area that does not start at the origin', () => {
    const { x, y } = popoverPosition({ tray: null, popover: POPOVER, workArea: BAR_TOP });
    expect(x).toBe(1920 - POPOVER.width - POPOVER_MARGIN);
    expect(y).toBe(40 + POPOVER_MARGIN);
  });
});
