/**
 * Does the thing we actually ship work?
 *
 * `npm run test:electron` runs against `out/`, which is the same code but not
 * the same shape. Packaging puts the renderer, the worklets and the tray icon
 * inside an asar archive, and the worklets are the risk: `addModule()` fetches
 * them over `file://` through Chromium's loader rather than Node's `fs`, so
 * asar support for them is Electron's patched file protocol rather than
 * anything this project controls. If that ever stops working, audio silently
 * never starts and every other test still passes.
 *
 * Not part of `npm test` or the usual Electron suite: it needs a full package
 * first, which downloads an Electron distribution. Run it after `npm run
 * dist` (or `dist:dir`), and in the release workflow.
 *
 *   npm run dist:dir && npm run test:packaged
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

/** Cold start of a packaged app, which is slower than a dev launch. */
const LAUNCH_TIMEOUT_MS = 60_000;

/**
 * The packaged binary for whichever platform this is running on.
 *
 * electron-builder leaves an unpacked directory beside the installers, which
 * is what can be launched directly — mounting a dmg or running an installer to
 * test would prove more but needs privileges CI does not have.
 */
function packagedBinary(): string {
  if (process.platform === 'darwin') {
    // The directory carries the architecture, and which one depends on the
    // machine, so it is found rather than assumed.
    const bundle = readdirSync('dist').find((entry) => entry.startsWith('mac'));
    if (bundle === undefined) throw new Error('no dist/mac* — run `npm run dist:dir` first');
    return join('dist', bundle, '40 Hz.app', 'Contents', 'MacOS', '40 Hz');
  }
  if (process.platform === 'win32') return join('dist', 'win-unpacked', '40 Hz.exe');
  return join('dist', 'linux-unpacked', 'fortyhz');
}

let app: ElectronApplication;
let studio: Page;
let profile: string;

before(
  async () => {
    const binary = packagedBinary();
    assert.ok(existsSync(binary), `packaged app not found at ${binary}; run \`npm run dist:dir\``);

    // A throwaway profile, so this never touches a real installation's presets
    // or history. `--user-data-dir` is honoured by Electron itself, so the
    // shipped code needs no test branch for it.
    profile = mkdtempSync(join(tmpdir(), 'fortyhz-packaged-'));
    app = await electron.launch({
      executablePath: binary,
      args: [`--user-data-dir=${profile}`],
      timeout: LAUNCH_TIMEOUT_MS,
    });

    await app.firstWindow();
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    let found: Page | undefined;
    while (found === undefined && Date.now() < deadline) {
      found = app.windows().find((w) => w.url().endsWith('index.html'));
      if (found === undefined) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(found, 'the packaged app never opened Studio');
    studio = found;
    await studio.waitForLoadState('domcontentloaded');
  },
  { timeout: LAUNCH_TIMEOUT_MS + 30_000 },
);

after(
  async () => {
    await app?.close().catch(() => undefined);
    if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
  },
  { timeout: 30_000 },
);

describe('the packaged app', () => {
  it('loads the renderer from inside the archive', async () => {
    // Proves this is the packaged shape and not a stray dev server, so the
    // assertion below is about asar rather than about `out/`.
    assert.match(studio.url(), /app\.asar/);
  });

  it('loads the interface font from inside the archive', async () => {
    /*
     * The same risk as the worklets, and new with the redesign.
     *
     * Fontsource's stylesheet points at seven woff2 subsets that Vite emits
     * as separate files; packaged, those move inside the asar and Chromium
     * fetches them over `file://`. If that fails the app does not break — it
     * silently renders in the fallback stack, which looks close enough that a
     * screenshot review would very likely pass it.
     *
     * `document.fonts.check` is the honest question: it asks whether the face
     * is actually usable at a given size, not whether a stylesheet mentioned
     * it. `ready` first, because loading is asynchronous and a check made too
     * early answers false for a font that is about to arrive.
     */
    const loaded = await studio.evaluate(async () => {
      await document.fonts.ready;
      // `forEach` rather than spreading: `FontFaceSet` is iterable at runtime
      // but the DOM typings do not say so.
      const faces: { family: string; status: string }[] = [];
      document.fonts.forEach((face) => {
        if (face.family.includes('Inter')) faces.push({ family: face.family, status: face.status });
      });
      return {
        usable: document.fonts.check('14px "Inter Variable"'),
        families: [...new Set(faces.map((f) => f.family))],
        anyLoaded: faces.some((f) => f.status === 'loaded'),
        // What the interface is actually being drawn in.
        rendered: getComputedStyle(document.body).fontFamily,
      };
    });

    assert.ok(loaded.anyLoaded, `no Inter face loaded from the archive: ${JSON.stringify(loaded)}`);
    assert.ok(loaded.usable, `Inter Variable is not usable: ${JSON.stringify(loaded)}`);
    // The fallback stack must still be behind it, so a future packaging
    // failure degrades to system-ui rather than to a serif default.
    assert.match(loaded.rendered, /Inter Variable/);
    assert.match(loaded.rendered, /system-ui/);
  });

  it('offers launch at login where the platform has one', async () => {
    // The other side of the development check in the Electron suite: there
    // the app is unpackaged and the control is absent, here it is installed
    // and should be present — except on Linux, where `setLoginItemSettings`
    // does not exist and autostart is a `.desktop` file, a packaging concern
    // rather than a runtime one. Packaging does not change that.
    //
    // Nothing is clicked: opening the dialog reads the setting, it does not
    // write one, so this cannot disturb a real login item.
    await studio.getByRole('button', { name: 'Settings' }).click();
    const dialog = studio.locator('dialog').first();
    await dialog.waitFor();

    // Scoped to this control by name rather than counting every checkbox in
    // the dialog. The count stood in for "launch at login is present" only
    // while it was the sole checkbox, and it silently stopped meaning that when
    // tray residency gained one — a failure this suite did not report for two
    // features, because it only runs by hand.
    const control = dialog.getByRole('checkbox', { name: /log in/ });
    if (process.platform === 'linux') {
      assert.equal(await control.count(), 0);
      assert.match(String(await dialog.textContent()), /not available on this platform/);
    } else {
      assert.equal(await control.count(), 1);
    }

    await studio.keyboard.press('Escape');
  });

  it('builds the audio graph, worklets and all', async () => {
    // The one that matters. Preview cannot reach `previewing` unless both
    // `addModule()` calls resolved, which is the asar question — and a failure
    // here is otherwise silent: audio simply never starts.
    const failure = await studio.evaluate(async (configuration) => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      try {
        await bridge.session.preview(configuration);
        return null;
      } catch (error) {
        return String(error);
      }
    }, QUIET);
    assert.equal(failure, null, 'preview should start in the packaged app');

    const state = await studio.evaluate(async () => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      const update = (await bridge.session.subscribe(() => {})) as {
        snapshot: { state: string };
      };
      return update.snapshot.state;
    });
    assert.equal(state, 'previewing');

    // Leave nothing playing behind, in case a later test or a human is next.
    await studio.evaluate(async () => {
      await window.desktop?.session.stop(null);
    });
  });

  it('runs the capture worklet from inside the archive', async () => {
    // Loading is already covered: `engine.ensure()` awaits all three
    // `addModule()` calls, so preview could not have reached `previewing` above
    // if this module had failed to come out of the asar.
    //
    // What is not covered is everything after that. The node makes no sound, so
    // nothing about the app being audible says whether Chromium scheduled it or
    // whether the ring returned anything — and the symptom of either failing is
    // integrity checks that quietly never report. This drives the archived file
    // with a tone of its own and reads the samples back, which is the same
    // question the Electron suite asks of the built one.
    const result = await studio.evaluate(async () => {
      const context = new AudioContext({ sampleRate: 48000 });
      try {
        const url = new URL('worklets/capture-processor.js', document.baseURI).href;
        await context.audioWorklet.addModule(url);

        const tap = new AudioWorkletNode(context, 'capture-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 2,
          channelCountMode: 'explicit',
          processorOptions: { seconds: 1 },
        });

        // Silent to anyone in the room: the tap has no outputs, so this tone
        // reaches nothing but the ring.
        const tone = context.createOscillator();
        tone.frequency.value = 440;
        tone.connect(tap);
        tone.start();

        const reply = await new Promise<Record<string, unknown>>((resolve) => {
          const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 5000);
          tap.port.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
            clearTimeout(timer);
            resolve(event.data);
          };
          tap.port.postMessage({ type: 'capture', id: 1, frames: 2048 });
        });

        tone.stop();
        if (reply.ok !== true) return { ok: false, reason: String(reply.reason) };

        let peak = 0;
        for (const value of reply.left as Float32Array) peak = Math.max(peak, Math.abs(value));
        return { ok: true, peak };
      } catch (error) {
        return { ok: false, reason: String(error) };
      } finally {
        await context.close();
      }
    });

    assert.equal(result.ok, true, `capture worklet failed: ${String(result.reason)}`);
    assert.ok((result.peak ?? 0) > 0.5, `expected recorded audio, got peak ${String(result.peak)}`);
  });
});

/**
 * Quiet enough to run unattended.
 *
 * This starts real audio on whatever machine runs it, so the gains are set
 * well below anything audible rather than at a preset's normal level.
 */
const QUIET = {
  params: {
    modulationHz: 40,
    carrierHz: 220,
    duty: 0.5,
    edge: 0.5,
    depth: 1,
    amGain: 0.02,
    twoToneGain: 0,
    twoToneMode: 'off',
  },
  soundscape: { color: 'pink', gain: 0.02, notchDepthDb: 6, notchQ: 8 },
  masterLevel: 0.02,
};
