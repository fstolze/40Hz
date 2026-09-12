import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// @ts-expect-error -- a .mjs helper shared with the esbuild scripts, which are
// plain JavaScript and not part of the TypeScript project.
import { buildInfo } from './scripts/lib/build-info.mjs';

const { version } = createRequire(import.meta.url)('./package.json') as { version: string };
const build = buildInfo() as { commit: string; date: string };

export default defineConfig({
  plugins: [svelte()],
  // One source for the version the About panel shows. Through the bundler
  // rather than the desktop bridge, so the renderer running standalone in a
  // browser reports the same thing as the packaged app.
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_COMMIT__: JSON.stringify(build.commit),
    __BUILD_DATE__: JSON.stringify(build.date),
  },
  // Relative base so the built renderer loads over file:// inside Electron.
  base: './',
  build: {
    outDir: 'out/renderer',
    emptyOutDir: true,
    target: 'chrome120',
    rollupOptions: {
      // Two windows, two documents. The Session popover is a separate entry
      // rather than a route inside Studio so it cannot pull in the audio
      // engine: only Studio may hold the graph.
      input: {
        index: fileURLToPath(new URL('index.html', import.meta.url)),
        session: fileURLToPath(new URL('session.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5273,
    strictPort: true,
  },
  // public/worklets holds the pre-bundled AudioWorklet processors; Vite serves
  // it at the root in dev and copies it into the build.
  publicDir: 'public',
});
