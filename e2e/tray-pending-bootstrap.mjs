/** Delay the initial capability reply to make the pending UI observable. */
import { ipcMain, nativeImage } from 'electron';

// Exercise an unavailable tray on every platform, including the copy shown
// after the pending reply. The error is caught by the real createTray path.
const imageFromPath = nativeImage.createFromPath;
nativeImage.createFromPath = (file) => {
  if (/tray-icon(?:-light)?\.(?:png|ico)$/.test(file)) throw new Error('fixture: no tray');
  return imageFromPath.call(nativeImage, file);
};

let release;
const ready = new Promise((resolve) => {
  release = resolve;
});
globalThis.__releaseTrayReply = () => release();

const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => {
  if (channel === 'windows:tray-subscribe') {
    handle(channel, async (...args) => {
      await ready;
      return handler(...args);
    });
  } else handle(channel, handler);
};

await import('./bootstrap.mjs');
