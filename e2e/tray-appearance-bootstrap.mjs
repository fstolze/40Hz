/** Inspect the actual glyph loaded by the shipped main process in light mode. */
import { nativeImage, nativeTheme } from 'electron';

// Electron-only state in this disposable process; no OS theme change.
nativeTheme.themeSource = 'light';
const images = [];
globalThis.__fortyhzTrayImages = images;
const createFromPath = nativeImage.createFromPath;
nativeImage.createFromPath = function (file) {
  const image = createFromPath.call(nativeImage, file);
  if (/tray-icon(?:-light)?\.png$/.test(file)) {
    const bitmap = image.toBitmap();
    let brightness = 0;
    let opaquePixels = 0;
    for (let i = 0; i < bitmap.length; i += 4) {
      if (bitmap[i + 3] < 128) continue;
      // Linux's bitmap is premultiplied: antialiased white pixels carry their
      // alpha in each colour channel. Recover the ink rather than averaging
      // the edge's transparency into it.
      brightness += ((bitmap[i] + bitmap[i + 1] + bitmap[i + 2]) / 3 / bitmap[i + 3]) * 255;
      opaquePixels += 1;
    }
    images.push({ opaquePixels, brightness: brightness / opaquePixels });
  }
  return image;
};

await import('./bootstrap.mjs');
