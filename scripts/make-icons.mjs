/**
 * Render the application icon and the tray icon from one source logo.
 *
 *   node scripts/make-icons.mjs
 *
 * `build/icon-source.png` is the artwork; everything else is derived, so the
 * two marks cannot drift apart and neither is an opaque blob in the tree.
 *
 * They are very different jobs. The app icon is RGBA and draws its own rounded
 * square, because nothing masks it for us — macOS expects the shape to be in
 * the image, and electron-builder renders .icns and .ico from this one file.
 * The tray icon is grayscale + alpha, which is what a macOS template image
 * wants: the shape lives in the alpha channel and the OS tints it for a light
 * or dark menu bar.
 *
 * Only macOS does that tinting. Windows and Linux draw the pixels as given, so
 * a black-inked icon is invisible on a dark taskbar or panel — which is what
 * shipping one file did. Two inks are therefore written, black and white, and
 * electron/tray.ts picks per platform and per theme.
 *
 * Windows gets each ink as an .ico as well. It draws the tray at a size that
 * follows display scaling — 20px at 125%, 24px at 150% — and handed a single
 * 16px PNG it stretches, which is what made the icon look soft. An .ico carries
 * the sizes so the shell picks one instead of resampling.
 *
 * The app icon is also written small into electron/assets, because
 * build/icon.png is a build resource and never ships: an unpackaged run has no
 * icon to give its windows, so the taskbar falls back to Electron's own.
 *
 * The source is a landscape lockup, and the two icons crop it differently.
 * The full "40" is unreadable at 16px — the 4 collapses and the circle fills
 * in — so the tray takes the circular glyph alone, which is square and
 * survives. Measured, not guessed: see the boxes below.
 */

import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng, writePng } from './lib/png.mjs';
import { writeIco } from './lib/ico.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'build', 'icon-source.png');
const TRAY_OUT = join(ROOT, 'electron', 'assets');
/** electron-builder's default buildResources directory. */
const APP_OUT = join(ROOT, 'build');

/**
 * Where each mark sits in the source, as [x0, y0, x1, y1].
 *
 * Taken from the artwork's own alpha rather than eyeballed: the ink runs
 * 87–1162 across and 277–977 down, and the gap between the 4 and the circle
 * falls at x≈576. Replacing the source means re-measuring these.
 */
const LOCKUP = [87, 277, 1162, 977];
const GLYPH = [580, 382, 1162, 969];

/**
 * Apple's icon grid: an 824px rounded square inside a 1024px canvas, corner
 * radius 185. Getting this wrong is what makes an icon look subtly larger or
 * squarer than everything else in the Dock.
 */
const APP_SIZE = 1024;
const PLATE_INSET = (APP_SIZE - 824) / 2 / APP_SIZE;
const PLATE_RADIUS = 185 / APP_SIZE;
/** Of the canvas width. Leaves the mark breathing room inside the plate. */
const MARK_FILL = 0.65;

/** The app's own palette, so the icon and the window it opens agree. */
const PANEL = [21, 26, 33]; // --bg-panel
const EDGE = [38, 47, 58]; // --border

/**
 * Area-average resample, on premultiplied alpha.
 *
 * Averaging straight RGBA pulls the colour of fully transparent pixels into
 * the edges, which for artwork on transparency means every edge darkens
 * towards black. Premultiplying first is what avoids that halo.
 */
function resample(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y += 1) {
    const top = (y * sh) / dh;
    const bottom = ((y + 1) * sh) / dh;
    for (let x = 0; x < dw; x += 1) {
      const left = (x * sw) / dw;
      const right = ((x + 1) * sw) / dw;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (
        let sy = Math.floor(top);
        sy < Math.max(Math.ceil(bottom), Math.floor(top) + 1);
        sy += 1
      ) {
        if (sy < 0 || sy >= sh) continue;
        for (
          let sx = Math.floor(left);
          sx < Math.max(Math.ceil(right), Math.floor(left) + 1);
          sx += 1
        ) {
          if (sx < 0 || sx >= sw) continue;
          const i = (sy * sw + sx) * 4;
          const alpha = src[i + 3] / 255;
          r += src[i] * alpha;
          g += src[i + 1] * alpha;
          b += src[i + 2] * alpha;
          a += src[i + 3];
          n += 1;
        }
      }
      const o = (y * dw + x) * 4;
      if (n === 0 || a === 0) continue;
      const alpha = a / n / 255;
      out[o] = r / n / alpha;
      out[o + 1] = g / n / alpha;
      out[o + 2] = b / n / alpha;
      out[o + 3] = a / n;
    }
  }
  return out;
}

/** Composite `src` over `dst` in place, both straight RGBA. */
function over(dst, src, count) {
  for (let i = 0; i < count * 4; i += 4) {
    const sa = src[i + 3] / 255;
    if (sa === 0) continue;
    const da = dst[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    for (let c = 0; c < 3; c += 1) {
      dst[i + c] = (src[i + c] * sa + dst[i + c] * da * (1 - sa)) / oa;
    }
    dst[i + 3] = oa * 255;
  }
}

/** The rounded square, with a hairline edge so it reads on a dark desktop. */
function plate(size) {
  const out = new Uint8ClampedArray(size * size * 4);
  const lo = size * PLATE_INSET;
  const hi = size - lo;
  const radius = size * PLATE_RADIUS;
  const SAMPLES = 4;

  const inside = (px, py, pad) => {
    const l = lo - pad;
    const h = hi + pad;
    const r = radius + pad;
    if (px < l || px > h || py < l || py > h) return false;
    const cx = px < l + r ? l + r : px > h - r ? h - r : px;
    const cy = py < l + r ? l + r : py > h - r ? h - r : py;
    if (cx === px && cy === py) return true;
    return Math.hypot(px - cx, py - cy) <= r;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let body = 0;
      let ring = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = x + (sx + 0.5) / SAMPLES;
          const py = y + (sy + 0.5) / SAMPLES;
          if (inside(px, py, 0)) body += 1;
          if (inside(px, py, size * 0.006)) ring += 1;
        }
      }
      const f = body / (SAMPLES * SAMPLES);
      const e = ring / (SAMPLES * SAMPLES);
      const alpha = Math.max(f, e);
      if (alpha === 0) continue;
      const o = (y * size + x) * 4;
      for (let c = 0; c < 3; c += 1) out[o + c] = (PANEL[c] * f + EDGE[c] * (e - f)) / alpha;
      out[o + 3] = alpha * 255;
    }
  }
  return out;
}

/** Cut a box out of the source. */
function crop(image, [x0, y0, x1, y1]) {
  const width = x1 - x0 + 1;
  const height = y1 - y0 + 1;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const s = ((y0 + y) * image.width + x0 + x) * 4;
      const d = (y * width + x) * 4;
      for (let c = 0; c < 4; c += 1) out[d + c] = image.pixels[s + c];
    }
  }
  return { width, height, pixels: out };
}

/** Scale a mark to `fill` of a square canvas and centre it. */
function centre(mark, size, fill, background) {
  const width = Math.round(size * fill);
  const height = Math.round((width * mark.height) / mark.width);
  const scaled = resample(mark.pixels, mark.width, mark.height, width, height);

  const canvas = background ?? new Uint8ClampedArray(size * size * 4);
  const layer = new Uint8ClampedArray(size * size * 4);
  const ox = Math.round((size - width) / 2);
  const oy = Math.round((size - height) / 2);
  for (let y = 0; y < height; y += 1) {
    const cy = oy + y;
    if (cy < 0 || cy >= size) continue;
    for (let x = 0; x < width; x += 1) {
      const cx = ox + x;
      if (cx < 0 || cx >= size) continue;
      const s = (y * width + x) * 4;
      const d = (cy * size + cx) * 4;
      for (let c = 0; c < 4; c += 1) layer[d + c] = scaled[s + c];
    }
  }
  over(canvas, layer, size * size);
  return canvas;
}

const source = readPng(SOURCE);

mkdirSync(APP_OUT, { recursive: true });
writePng(
  join(APP_OUT, 'icon.png'),
  APP_SIZE,
  APP_SIZE,
  centre(crop(source, LOCKUP), APP_SIZE, MARK_FILL, plate(APP_SIZE)),
);
console.log(`[icons] wrote icon.png (${APP_SIZE}x${APP_SIZE})`);

mkdirSync(TRAY_OUT, { recursive: true });

/** A 256px app icon that ships, for windows to carry at runtime. */
const RUNTIME_APP_SIZE = 256;
writePng(
  join(TRAY_OUT, 'app-icon.png'),
  RUNTIME_APP_SIZE,
  RUNTIME_APP_SIZE,
  centre(crop(source, LOCKUP), RUNTIME_APP_SIZE, MARK_FILL, plate(RUNTIME_APP_SIZE)),
);
console.log(`[icons] wrote app-icon.png (${RUNTIME_APP_SIZE}x${RUNTIME_APP_SIZE})`);

const glyph = crop(source, GLYPH);

/** What Windows asks for as display scaling goes 100% → 300%. */
const ICO_SIZES = [16, 20, 24, 32, 40, 48];

// Only the alpha survives; `grey` discards the artwork's colour and stamps one
// ink through it. `-light` is the white one, for a dark taskbar or panel.
for (const [ink, suffix] of [
  [0, ''],
  [255, '-light'],
]) {
  for (const [name, size] of [
    [`tray-icon${suffix}.png`, 16],
    [`tray-icon${suffix}@2x.png`, 32],
  ]) {
    writePng(join(TRAY_OUT, name), size, size, centre(glyph, size, 1), { grey: true, ink });
    console.log(`[icons] wrote ${name} (${size}x${size}, ink ${ink})`);
  }

  // The .ico carries colour, so the ink is painted rather than implied by a
  // colour type the format does not have.
  const name = `tray-icon${suffix}.ico`;
  writeIco(
    join(TRAY_OUT, name),
    ICO_SIZES.map((size) => {
      const pixels = centre(glyph, size, 1);
      for (let i = 0; i < size * size; i += 1) {
        pixels[i * 4] = ink;
        pixels[i * 4 + 1] = ink;
        pixels[i * 4 + 2] = ink;
      }
      return { width: size, height: size, pixels };
    }),
  );
  console.log(`[icons] wrote ${name} (${ICO_SIZES.join(', ')}, ink ${ink})`);
}
