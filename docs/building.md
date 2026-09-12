# Building 40 Hz Studio from source

This page covers running the app in development, testing it, and packaging installers. To install
a ready-made build instead, use [Releases](https://github.com/fstolze/40Hz/releases).

## Requirements

| Requirement             | Why                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Node.js 24 or later** | Tests and build scripts run TypeScript directly, with Node's built-in type stripping and test runner. CI uses Node 24. |
| **npm**                 | The repository ships a `package-lock.json`.                                                                            |
| **Git** (optional)      | Builds stamp the commit into the About panel and the installer filename, and report `unknown` without it.              |
| **The target platform** | Only to package installers, which are built on the platform they target.                                               |

## Quick start

```bash
git clone https://github.com/fstolze/40Hz.git
cd 40Hz
npm install
npm run dev
```

All dependencies are development dependencies; the app bundles everything it runs.

## Commands

| Command                 | Purpose                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `npm run dev`           | Builds the AudioWorklets and the Electron main process, starts Vite, launches the desktop app |
| `npm run dev:web`       | Serves Studio alone at `http://localhost:5273` in an ordinary browser                         |
| `npm test`              | Unit tests                                                                                    |
| `npm run typecheck`     | `tsc` and `svelte-check`                                                                      |
| `npm run lint`          | ESLint, then `prettier --check`                                                               |
| `npm run verify`        | Prints a measurement report rather than pass/fail                                             |
| `npm run build`         | Compiles the worklets, the renderer and the Electron main process into `out/`                 |
| `npm run test:electron` | Electron smoke test; run `npm run build` first                                                |
| `npm run dist`          | Builds, then packages installers for the current platform into `dist/`                        |
| `npm run dist:dir`      | The unpacked app only, without installers — much faster                                       |
| `npm run test:packaged` | Checks that audio starts in the packaged app; run `npm run dist:dir` first                    |

## Run in development

`npm run dev` launches the full desktop app. `npm run dev:web` is the quickest way to work on the
interface, but the tray, the session popover and the desktop-only settings are not available there.

A development run keeps its own presets, history and settings, fully separate from any installed
copy of the app.

## Test

`npm test` works even before `npm install`, because the audio engine has no runtime dependencies.

`npm run lint` runs two tools in sequence, so read its output in full.

The Electron smoke test runs against the production build:

```bash
npm run build
npm run test:electron
```

On Linux without a display, run it as `xvfb-run -a npm run test:electron`.

CI runs `test`, `typecheck`, `lint`, `verify`, `build` and the Electron smoke test on every push and
pull request to `main`. It does not package or publish anything.

## Build and package

> [!WARNING]
> **Packaging is broken on Windows.** `scripts/dist.mjs` spawns `electron-builder.cmd` without a
> shell, which current Node refuses to launch, so `npm run dist` and `npm run dist:dir` fail there.
> macOS and Linux are unaffected.

`npm run dist` produces, for the platform you run it on:

- macOS: `.dmg` for Apple silicon (arm64) and Intel (x64)
- Windows: NSIS installer (`.exe`), x64, installed for the current user
- Linux: AppImage and `.deb`, x64

Build each platform's installers on that platform. macOS apps cannot be cross-built at all;
electron-builder can cross-build some other targets, but this project neither uses nor tests that
path.

Files are named `fortyhz-<version>-<commit>-<platform>-<arch>.<ext>`, with a `-dirty` suffix when
the tree had uncommitted changes. Always package through `npm run dist` or `dist:dir`, which supply
the commit; running `electron-builder` directly stops with an error.

Builds are not signed by a trusted publisher. The [install notes](../README.md#install) explain how
to open an unsigned build on each platform.

### Check the packaged app

Packaging moves the renderer and worklets into an asar archive, and no other test covers that. After
packaging on each platform, check that audio still starts:

```bash
npm run dist:dir && npm run test:packaged
```

This exercises the unpacked app. It does not install the `.dmg`, run the NSIS installer or start
the AppImage, so those still need a check by hand on a clean machine.

## Notes

- The repository uses LF line endings everywhere, pinned by `.gitattributes`. A checkout converted
  to CRLF fails `npm run lint` on every file.
- For contributor process and the project's traps and invariants, see [AGENTS.md](../AGENTS.md).
