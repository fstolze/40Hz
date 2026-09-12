/**
 * Where the Session popover goes.
 *
 * Pure geometry, so the cases that matter — a taskbar at the top, a tray icon
 * near the screen edge, a second monitor, no tray bounds at all — are tested
 * rather than discovered by dragging a taskbar around.
 *
 * `Tray.getBounds()` exists only on macOS and Windows. On Linux there is no
 * tray rectangle to anchor to, so the popover falls back to a corner of the
 * work area; tray presence there depends on the desktop environment anyway.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Breathing room from the screen edge, and between popover and tray icon. */
export const POPOVER_MARGIN = 8;

export interface PopoverPlacement {
  /** The tray icon, or null where the platform cannot report one. */
  tray: Rect | null;
  popover: Size;
  /** The display's usable area, excluding taskbar or dock. */
  workArea: Rect;
}

function clamp(value: number, low: number, high: number): number {
  // `high` can fall below `low` on a work area smaller than the popover;
  // preferring `low` keeps the top-left corner visible rather than the window
  // sliding off the opposite edge.
  return Math.max(low, Math.min(high, value));
}

/**
 * Position the popover, clamped inside the work area.
 *
 * Anchored to the tray icon where one is known: centred on it horizontally,
 * and placed on whichever side of it has the screen — below an icon in the
 * upper half, above one in the lower half. That single rule covers a menu bar
 * at the top and a taskbar at the bottom without asking which platform it is.
 */
export function popoverPosition(placement: PopoverPlacement): { x: number; y: number } {
  const { tray, popover, workArea } = placement;

  const minX = workArea.x + POPOVER_MARGIN;
  const maxX = workArea.x + workArea.width - popover.width - POPOVER_MARGIN;
  const minY = workArea.y + POPOVER_MARGIN;
  const maxY = workArea.y + workArea.height - popover.height - POPOVER_MARGIN;

  if (tray === null) {
    // No anchor. Top-right is where a tray usually lives when there is one,
    // so it is the least surprising place to find the window without one.
    return { x: clamp(maxX, minX, maxX), y: clamp(minY, minY, maxY) };
  }

  const trayCentreX = tray.x + tray.width / 2;
  const x = clamp(Math.round(trayCentreX - popover.width / 2), minX, maxX);

  const trayCentreY = tray.y + tray.height / 2;
  const workAreaCentreY = workArea.y + workArea.height / 2;
  const y =
    trayCentreY < workAreaCentreY
      ? // Icon in the upper half — a menu bar, or a taskbar docked at the top.
        clamp(tray.y + tray.height + POPOVER_MARGIN, minY, maxY)
      : // Lower half — the usual taskbar position. Open upwards.
        clamp(tray.y - popover.height - POPOVER_MARGIN, minY, maxY);

  return { x, y };
}
