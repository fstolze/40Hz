/**
 * What this build actually is, beyond the version in package.json.
 *
 * The version moves when someone remembers to move it. The commit moves every
 * time. "0.2.0" has identified a dozen different builds, which is no use in a
 * bug report, so About reports both.
 *
 * Read here rather than in each build script, so the renderer and the main
 * process cannot disagree about which build they are halves of.
 */

import { execFileSync } from 'node:child_process';

function git(...args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      // Git's own errors are not this script's business: every failure here
      // means the same thing, which is that there is nothing to report.
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * `{ commit, date }`, both strings and never null.
 *
 * Building outside a checkout — from a tarball, or where git is absent — is a
 * legitimate way to get here and reports `unknown` rather than failing the
 * build over a label.
 */
export function buildInfo() {
  const commit = git('rev-parse', '--short', 'HEAD');
  if (commit === null) return { commit: 'unknown', date: 'unknown' };

  // Uncommitted changes mean the build is not that commit, and saying so is
  // the difference between a build id and a guess. A status that cannot be
  // read is treated the same way, since it cannot prove the tree is clean.
  const status = git('status', '--porcelain');
  const dirty = status === null || status !== '';

  return {
    commit: dirty ? `${commit}+` : commit,
    // The commit's date, not the build's: it identifies the source rather than
    // when someone happened to run the build. The `+` covers the difference.
    date: git('log', '-1', '--format=%cd', '--date=short') ?? 'unknown',
  };
}
