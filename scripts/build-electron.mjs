/**
 * Bundle the Electron main and preload scripts.
 *
 * The preload is emitted as CommonJS (.cjs) because sandboxed preload scripts
 * are loaded as classic scripts, not modules. The main process is ESM, matching
 * "type": "module" in package.json.
 *
 *   node scripts/build-electron.mjs [--watch]
 */

import { build, context } from 'esbuild';
import { cpSync } from 'node:fs';
import { buildInfo } from './lib/build-info.mjs';

const external = ['electron'];
const production = process.argv.includes('--production');

// The same stamp Vite gives the renderer, so the macOS About panel and the
// in-app one cannot name different builds. Only main reads them; the preload
// has no use for either.
const info = buildInfo();
const define = {
  __BUILD_COMMIT__: JSON.stringify(info.commit),
  __BUILD_DATE__: JSON.stringify(info.date),
};

/** @type {import('esbuild').BuildOptions[]} */
const targets = [
  {
    entryPoints: ['electron/main.ts'],
    outfile: 'out/main/main.js',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    bundle: true,
    external,
    define,
    minify: production,
    sourcemap: !production,
    logLevel: 'info',
  },
  {
    entryPoints: ['electron/preload.ts'],
    outfile: 'out/main/preload.cjs',
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    bundle: true,
    external,
    minify: production,
    sourcemap: !production,
    logLevel: 'info',
  },
];

/**
 * The tray icon travels with the bundled main process.
 *
 * `main.ts` resolves it relative to its own location, which is out/main in
 * development and in the build alike, so one copy step covers both.
 */
function copyAssets() {
  cpSync('electron/assets', 'out/main/assets', { recursive: true });
}

if (process.argv.includes('--watch')) {
  for (const options of targets) {
    const ctx = await context(options);
    await ctx.watch();
  }
  copyAssets();
  console.log('[electron] watching main and preload');
} else {
  await Promise.all(targets.map((options) => build(options)));
  copyAssets();
  console.log('[electron] built main and preload into out/main');
}
