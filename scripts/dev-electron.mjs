/**
 * Development launcher: worklets, Vite dev server, then Electron.
 *
 * Avoids a task-runner dependency by starting Vite in-process and handing its
 * resolved URL to Electron through VITE_DEV_SERVER_URL.
 *
 *   node scripts/dev-electron.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';

// Worklets are a separate esbuild pass; keep it watching alongside Vite.
const worklets = spawn(process.execPath, ['scripts/build-worklets.mjs', '--watch'], {
  stdio: 'inherit',
});

const server = await createServer();
await server.listen();

const url = server.resolvedUrls?.local?.[0];
if (!url) {
  console.error('[dev] Vite did not report a local URL');
  process.exit(1);
}

server.printUrls();
console.log(`[dev] launching Electron against ${url}`);

const child = spawn(electron, ['out/main/main.js'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});

const shutdown = async (code = 0) => {
  worklets.kill();
  await server.close().catch(() => {});
  process.exit(code);
};

child.on('close', (code) => void shutdown(code ?? 0));
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
