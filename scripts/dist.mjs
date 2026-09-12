/**
 * Package a distributable, with the commit in its filename.
 *
 *   node scripts/dist.mjs [--dir]
 *
 * `artifactName` can only interpolate what electron-builder knows about, and
 * the commit is not one of those things — but `${env.X}` is, so this sets it
 * and hands off. An unset one is a hard error there, not a blank, so this is
 * the supported way to package: invoking electron-builder directly stops with
 * ERR_ELECTRON_BUILDER_ENV_NOT_DEFINED instead of writing a file nobody can
 * identify.
 *
 * Why bother: the version moves on release and the artifact name is all the
 * recipient of a file has to go on. Two builds a month apart were both called
 * fortyhz-0.2.0-mac-arm64.dmg, and nothing about the file said which was which.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInfo } from './lib/build-info.mjs';

// Resolved rather than looked up on PATH: npm puts node_modules/.bin there for
// `npm run dist`, and nothing does for `node scripts/dist.mjs`, which is a
// reasonable way to run this and failed with a bare ENOENT.
//
// The package's own cli.js, not the node_modules/.bin shim: on Windows that
// shim is a .cmd file, and spawning one directly (rather than through a shell,
// which is how a PATH lookup normally runs it) fails with EINVAL rather than
// launching cmd.exe as its interpreter. cli.js is a plain Node script, so
// running it through process.execPath sidesteps the shim on every platform
// and avoids shell:true's argument-escaping risk entirely.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILDER = join(ROOT, 'node_modules', 'electron-builder', 'cli.js');

const { commit } = buildInfo();

// `+` is legal in a filename on all three platforms but reads as noise in one;
// a dirty build says so in a word instead.
const stamp = commit.endsWith('+') ? `${commit.slice(0, -1)}-dirty` : commit;

const args = process.argv.slice(2);
console.log(`[dist] packaging ${stamp}${args.length > 0 ? ` (${args.join(' ')})` : ''}`);

const child = spawn(process.execPath, [BUILDER, ...args], {
  stdio: 'inherit',
  env: { ...process.env, FORTYHZ_COMMIT: stamp },
});

child.on('close', (code) => process.exit(code ?? 0));
