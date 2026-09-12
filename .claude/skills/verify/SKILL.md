---
name: verify
description: Run this project's verification gates for the files that changed, with output read in full. Use before committing, after applying a fix, or when asked to check whether the tree is green.
---

# Verify

Runs the gates CI runs, choosing the extra ones by what changed, and reading output in full.

## Why not just run the commands

`npm run lint` is `eslint . && prettier --check .`. Piping it through `tail` shows only Prettier's
last lines and hides eslint completely — including warnings that reveal an edit which silently
did nothing. That has already let a commit through claiming a fix it did not contain.

Two gates are also not covered by the other three, and are easy to forget:

- `npm run verify` — a measurement report for the DSP. Not pass/fail: read the numbers.
- `npm run build` — the only thing that exercises the esbuild bundle for main and preload.

## Steps

1. See what changed:

   ```bash
   git status --short && git diff --stat HEAD
   ```

2. Always run, and read every line of the output:

   ```bash
   npm test
   npm run typecheck
   npm run lint
   ```

   If `lint` reports warnings as well as errors, treat a warning about an unused import or
   binding as a likely broken edit rather than noise — that is what it has meant here.

3. Add gates by area touched:

   | Touched                       | Also run                                                                |
   | ----------------------------- | ----------------------------------------------------------------------- |
   | `src/audio/**`                | `npm run verify`, and compare the reported figures against the last run |
   | `electron/**`, `preload`, IPC | `npm run build`, then `npm run test:electron` (Linux: `xvfb-run -a`)    |
   | renderer UI                   | serve it and drive it — see CLAUDE.md                                   |

4. Report honestly. Give the assertion count, name anything that failed with its output, and say
   plainly which gates you did not run and why. Do not describe a tree as green on the strength
   of a subset.

## If a gate fails

Fix the cause, not the assertion — unless the assertion is genuinely wrong, in which case say so
explicitly and explain why. When a test looks wrong, check the arithmetic in the _expectation_
first; that has been the actual error more than once.
