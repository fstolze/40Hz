/// <reference types="svelte" />

/// <reference types="vite/client" />

import type { DesktopBridge } from '../../electron/preload.ts';

declare global {
  /** Injected by Vite from package.json — see `define` in vite.config.ts. */
  const __APP_VERSION__: string;
  /** The short commit this build came from, `+` if the tree was dirty. */
  const __BUILD_COMMIT__: string;
  /** That commit's date, `YYYY-MM-DD`. */
  const __BUILD_DATE__: string;

  interface Window {
    /**
     * Present only under Electron. The renderer must degrade cleanly without
     * it, so that Studio stays runnable in a plain browser.
     */
    desktop?: DesktopBridge;
  }
}

export {};
