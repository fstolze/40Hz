/**
 * Bundle the AudioWorklet processors into self-contained scripts.
 *
 * AudioWorkletGlobalScope cannot resolve module imports, so each processor
 * must arrive as one file with its dependencies already inlined. Building
 * them explicitly here — rather than through a bundler-specific import
 * suffix — keeps dev and production byte-identical and leaves graph.ts free
 * of any bundler coupling: it takes worklet URLs as arguments.
 *
 *   node scripts/build-worklets.mjs [--watch]
 */

import { build, context } from 'esbuild';
import { mkdirSync } from 'node:fs';

const OUT_DIR = 'public/worklets';

const ENTRIES = [
  'src/audio/worklets/entrainment-processor.ts',
  'src/audio/worklets/noise-processor.ts',
  'src/audio/worklets/notch-processor.ts',
  // A terminal branch with no outputs. It makes no sound, which is exactly why
  // packaging has to be checked rather than assumed: nothing about the app
  // being audible proves this one loaded.
  'src/audio/worklets/capture-processor.ts',
];

mkdirSync(OUT_DIR, { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ENTRIES,
  outdir: OUT_DIR,
  bundle: true,
  // IIFE rather than ESM: the worklet scope has no module loader, and the
  // processors export nothing at runtime — they only call registerProcessor.
  format: 'iife',
  target: 'es2022',
  platform: 'browser',
  minify: process.argv.includes('--production'),
  sourcemap: process.argv.includes('--production') ? false : 'inline',
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[worklets] watching');
} else {
  await build(options);
  console.log(`[worklets] built ${ENTRIES.length} processors into ${OUT_DIR}`);
}
