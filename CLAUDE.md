# CLAUDE.md

The working notes for this repo live in **[AGENTS.md](AGENTS.md)** — traps, invariants, testing
standards, and environment facts. Read that first; it is the canonical version and applies to any
agent, not just Claude Code. Everything below is specific to this tool.

## Verifying a change

`/verify` runs the right gates for what you touched, unpiped. Reach for it rather than composing
the commands by hand — `npm run lint` chains two tools, and truncating its output has twice
hidden a real problem.

## Reading CI

Use `gh` when it is available, or open GitHub Actions in a browser. Failures filter fastest via
`https://github.com/fstolze/40Hz/actions?query=is%3Afailure`.

## Exercising the UI

`preview_start` with the `studio` configuration from `.claude/launch.json` serves the renderer at
`http://localhost:5273`. Studio runs standalone in a plain browser by design, so most UI work can
be verified without launching Electron.

Two things to remember there:

- **Stop the audio before you finish.** Closing the tab is what actually ends it; stopping the
  dev server leaves the page's `AudioContext` running. This has been left playing once.
- **Clear anything you seed into `localStorage`.** Preset and history round-trips are easiest to
  test by seeding storage directly, but it persists.

A canvas read immediately after `navigate` can report a 0×0 viewport; resize or re-read rather
than concluding the page is broken.

## Editing files

Scripted replacements must assert they applied — see the trap in AGENTS.md. Prettier reflows
code between edits, so a pattern can stop matching without any error.
