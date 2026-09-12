# Building 40 Hz Studio from source

Most people should install a ready-made build from
[Releases](https://github.com/fstolze/40Hz/releases). This page covers building the app
yourself, running it in development, and packaging installers.

## Requirements

- **Node.js 24 or later.** The tests and build scripts run TypeScript directly, using Node's
  built-in type stripping and test runner. CI uses Node 24.
- **npm.** The repository ships a `package-lock.json`.
- **Git** (optional). Builds stamp the commit into the About panel and the installer filename,
  and report `unknown` without it.
- **To package an installer, a machine running that platform.** This project builds each
  platform's installer on that platform; macOS apps cannot be cross-built at all. electron-builder
  can cross-build some other targets, but that path is neither used nor tested here.

## Get the code

```bash
git clone https://github.com/fstolze/40Hz.git
cd 40Hz
npm install
```

All dependencies are development dependencies. The app itself bundles everything it runs.

## Run in development

```bash
npm run dev
```

Builds the AudioWorklets and the Electron main process, starts Vite, and launches the desktop
app.

```bash
npm run dev:web
```

Serves Studio alone at `http://localhost:5273` in an ordinary browser. The tray, the session
popover and the desktop-only settings are not available there. It is the quickest way to work on
the interface.

A development run keeps its own presets, history and settings, separate from an installed copy of
the app. Anything saved in development does not appear in the installed build, and the reverse is
also true.

## Test

```bash
npm test
```

Runs the unit tests. This works before `npm install`, because the audio engine has no runtime
dependencies.

```bash
npm run typecheck   # tsc and svelte-check
npm run lint        # ESLint, then Prettier --check
npm run verify      # a measurement report rather than pass/fail
```

`npm run lint` runs two tools in sequence, so read its output in full.

The Electron smoke test runs against the production build:

```bash
npm run build
npm run test:electron
```

On Linux without a display, run it as `xvfb-run -a npm run test:electron`.

CI runs `test`, `typecheck`, `lint`, `verify`, `build` and the Electron smoke test on every push
and pull request to `main`. It does not package or publish anything.

## Build and package

```bash
npm run build
```

Compiles the worklets, the renderer and the Electron main process into `out/`.

```bash
npm run dist
```

Builds, then packages installers for the current platform into `dist/`:

- macOS: `.dmg` for Apple silicon (arm64) and Intel (x64)
- Windows: NSIS installer (`.exe`), x64, installed for the current user
- Linux: AppImage and `.deb`, x64

> **Known issue on Windows.** `scripts/dist.mjs` spawns `electron-builder.cmd` without a shell,
> which current Node refuses to launch, so `npm run dist` and `npm run dist:dir` fail there.
> macOS and Linux are unaffected.

Files are named `fortyhz-<version>-<commit>-<platform>-<arch>.<ext>`. A `-dirty` suffix means
the tree had uncommitted changes. Package through `npm run dist` (or `dist:dir`), which supplies
the commit. Running `electron-builder` directly stops with an error.

```bash
npm run dist:dir
```

Produces only the unpacked app, without installers. This is much faster when you only need to
know that packaging works.

Packaging moves the renderer and worklets into an asar archive, and no other test covers that. To
check that audio still starts in the packaged app, run this after packaging on each platform:

```bash
npm run dist:dir && npm run test:packaged
```

This exercises the unpacked packaged app. It does not install a `.dmg`, run the NSIS installer, or
start the AppImage, so those paths still need a check by hand on a clean machine.

Builds are not signed by a trusted publisher. The [install notes](../README.md#install) explain how
to open an unsigned build on each platform.

## Notes

- The repository uses LF line endings everywhere, pinned by `.gitattributes`. A checkout
  converted to CRLF fails `npm run lint` on every file.
- For contributor process and the project's traps and invariants, see
  [AGENTS.md](../AGENTS.md).
