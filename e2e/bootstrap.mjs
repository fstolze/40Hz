/**
 * Test entry point for the Electron smoke test.
 *
 * Its whole job is to redirect `userData` somewhere disposable *before* the
 * app loads, so a test run cannot touch real presets or history — and so the
 * shipped code needs no automation flag or test branch at all. A production
 * build with a way to enter test mode is a production build with a way to
 * enter test mode; this keeps that door from existing.
 *
 *   electron e2e/bootstrap.mjs
 *
 * `out/main/main.js` is imported rather than executed directly, so the real
 * main process runs exactly as it ships.
 */

import { app } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'fortyhz-e2e-'));
app.setPath('userData', directory);

// The test reads this back to assert on what actually reached disk.
process.env.FORTYHZ_E2E_USERDATA = directory;

await import('../out/main/main.js');
