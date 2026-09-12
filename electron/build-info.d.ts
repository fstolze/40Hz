/**
 * Build stamps substituted by esbuild — see `define` in
 * scripts/build-electron.mjs, which reads them from scripts/lib/build-info.mjs.
 *
 * Declared rather than imported because they do not exist in the source at
 * all: every path that produces out/main/main.js runs that script, so there is
 * no build where these are undefined.
 */

/** The short commit this build came from, `+` if the tree was dirty. */
declare const __BUILD_COMMIT__: string;
/** That commit's date, `YYYY-MM-DD`. */
declare const __BUILD_DATE__: string;
