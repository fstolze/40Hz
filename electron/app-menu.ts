/**
 * The application menu.
 *
 * Electron installs a default File / Edit / View / Window / Help menu. For this
 * app that is all noise — there are no files to open, and View's Reload is
 * worse than noise: reloading tears down the audio graph, which is why
 * `windows.ts` treats a main-frame navigation as losing the executor.
 *
 * It cannot simply be removed everywhere, because the menu means different
 * things on different platforms:
 *
 * - Windows and Linux draw it inside the window, and Chromium handles the
 *   clipboard shortcuts itself, so removing it costs nothing at all.
 * - macOS puts it on the screen rather than the window, and it is where the
 *   standard shortcuts actually live. With no menu, Cmd+Q stops quitting and
 *   Cmd+C/V/X/A stop working in text fields — which this app has, in the
 *   preset name and the settings. So macOS keeps the two menus carrying those
 *   roles and loses the other three.
 *
 * macOS keeps a Window menu as well, for Cmd+W and Cmd+M, which are reflexes
 * rather than features anyone goes looking in a menu for. It is spelled out
 * rather than using `{ role: 'windowMenu' }` because Electron's default layout
 * puts Close in the File menu and Minimize in Window, so taking both roles the
 * default way would mean bringing back two menus to get two shortcuts.
 *
 * Both windows already intercept `close`: Studio hides to the tray and the
 * popover dismisses, which is what `windows.ts` does for the OS-installed Cmd+W
 * it was already defending against.
 */

import { Menu } from 'electron';

export function installApplicationMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }

  // `appMenu` carries About, Services, Hide and Quit; `editMenu` carries undo,
  // redo, cut, copy, paste and select-all. Both are Electron's own templates,
  // so they stay correct as macOS conventions change.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
    ]),
  );
}
