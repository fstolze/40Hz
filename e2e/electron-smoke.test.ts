/**
 * The real cross-process path, end to end.
 *
 * Everything else in this project is tested against fakes, which is what keeps
 * it fast and honest about logic — but it means the boundary itself has never
 * run: the preload bridge, sender validation, executor registration, the
 * command and acknowledgement round trip, and persistence to a real file.
 * Those are exactly where the defects of the last several rounds lived.
 *
 * So this drives `window.desktop` from the renderer, as the UI does, and never
 * reaches for the coordinator or the store directly. Asserting main-process
 * internals would prove the internals work while leaving the boundary — the
 * only untested part — untested.
 *
 * Runs against the production build, not the dev server. `npm run build`
 * first; CI does that before this.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import type { SessionConfiguration } from '../src/audio/configuration.ts';
import type { Settings } from '../src/session/settings.ts';
import { MAX_MASTER_LEVEL } from '../src/audio/graph.ts';
import { notchChain, notchSettleSeconds, peakGainBound } from '../src/audio/dsp/biquad.ts';
import { transitionPeakBound } from '../src/audio/graph.ts';
import { carrierTrackFromHz } from '../src/audio/tuning.ts';
import { DEFAULT_PARAMS } from '../src/audio/dsp/entrainment-core.ts';
import { DEFAULT_SOUNDSCAPE } from '../src/audio/configuration.ts';

/** Generous: a cold Electron start plus worklet compilation. */
const LAUNCH_TIMEOUT_MS = 30_000;
/** Long enough for a two-second session to finish and be written. */
const SETTLE_TIMEOUT_MS = 15_000;
/**
 * Long enough for a capture pass to land.
 *
 * A pass waits out the ramp, then a whole window, then a margin, and the
 * window itself is over a second of audio at 48 kHz. This is real time
 * passing, not a slow machine.
 */
const MEASUREMENT_TIMEOUT_MS = 25_000;

let app: ElectronApplication;
/** Studio: the window that owns the audio graph. */
let page: Page;
/** The tray popover, which must never own one. */
let popover: Page;
let userData: string;

/**
 * Make one store write fail on every supported platform.
 *
 * Making the profile directory read-only does not prevent creating files on
 * Windows. The store writes through a process-named temporary file, however,
 * and opening an existing read-only file for replacement is refused on Windows
 * and Unix alike. Blocking that exact path keeps this a real filesystem error
 * while leaving the rest of the temporary profile usable.
 */
async function blockStoreWrite(
  file: 'presets.json' | 'history.json',
): Promise<() => Promise<void>> {
  const mainPid = await app.evaluate(() => process.pid);
  const temporary = join(userData, `${file}.${mainPid}.tmp`);
  await writeFile(temporary, '', { flag: 'wx' });
  await chmod(temporary, 0o444);

  return async () => {
    await chmod(temporary, 0o600).catch(() => undefined);
    await rm(temporary, { force: true });
  };
}

/** Poll until `check` passes, so nothing depends on a fixed sleep. */
async function until<T>(
  describeIt: string,
  check: () => Promise<T | null>,
  timeoutMs = SETTLE_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      const value = await check();
      if (value !== null && value !== false) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${describeIt}${last === null ? '' : `: ${String(last)}`}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * The window showing `page`.
 *
 * `firstWindow()` used to be unambiguous and no longer is: the popover is
 * created moments after Studio, and which one finishes loading first is a
 * race. Picking Studio by accident would still pass most of these tests —
 * right up to the ones about who is allowed to hold the audio graph.
 */
async function windowShowing(name: string): Promise<Page> {
  return until(
    `the ${name} window`,
    async () => {
      for (const candidate of app.windows()) {
        if (candidate.url().endsWith(name)) return candidate;
      }
      return null;
    },
    LAUNCH_TIMEOUT_MS,
  );
}

/**
 * A real configuration, in the shape the audio path actually uses.
 *
 * Spelled out rather than invented: `normalizeStartRequest` rebuilds every
 * field from defaults, so a configuration with the wrong field names is
 * silently replaced and the test passes while proving nothing about what it
 * sent. Quiet enough to run in CI.
 */
const TEST_CONFIGURATION = {
  params: {
    modulationHz: 40,
    carrierHz: 220,
    duty: 0.5,
    edge: 0.5,
    depth: 1,
    amGain: 0.1,
    twoToneGain: 0,
    twoToneMode: 'off',
  },
  soundscape: {
    source: 'noise',
    bedId: null,
    color: 'pink',
    gain: 0.1,
    notchDepthDb: 6,
    notchQ: 8,
  },
  masterLevel: 0.2,
} as const satisfies SessionConfiguration;

/** History as the renderer can see it, through the real bridge. */
async function history(
  target: Page,
): Promise<{ id: string; completionReason: string; actualSeconds: number }[]> {
  return target.evaluate(async () => {
    const bridge = window.desktop;
    if (bridge === undefined) throw new Error('no desktop bridge');
    return (await bridge.history.list()).map((r) => ({
      id: r.id,
      completionReason: r.completionReason,
      actualSeconds: r.actualSeconds,
    }));
  });
}

// `--test-timeout` bounds the tests; hooks need their own, and a launch that
// never completes would otherwise hang until the CI job limit.
before(
  async () => {
    app = await electron.launch({ args: ['e2e/bootstrap.mjs'], timeout: LAUNCH_TIMEOUT_MS });
    await app.firstWindow();
    page = await windowShowing('index.html');
    popover = await windowShowing('session.html');
    await page.waitForLoadState('domcontentloaded');
    await popover.waitForLoadState('domcontentloaded');
    userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  },
  { timeout: LAUNCH_TIMEOUT_MS + 10_000 },
);

after(
  async () => {
    // Always, so a failure cannot leave an Electron process or a temp
    // directory behind for the next run to trip over.
    await app?.close().catch(() => undefined);
    if (userData !== undefined) await rm(userData, { recursive: true, force: true });
  },
  { timeout: 30_000 },
);

/**
 * Sliders whose track is not their value, and the mapping into it.
 *
 * Carrier moves along cents rather than hertz, so writing 300 into the input
 * would set 300 *cents* — about 523 Hz. Everything here still names the
 * frequency it wants; the conversion happens once, through the app's own
 * function, so this file cannot hold a second opinion about the mapping.
 *
 * A scaled slider missing from here fails loudly rather than quietly: the
 * value written lands somewhere else entirely and the assertion that follows
 * it goes with it.
 */
const TRACKS: Record<string, (value: number) => number> = { Carrier: carrierTrackFromHz };

async function setRange(label: string, value: number): Promise<void> {
  const onTrack = TRACKS[label]?.(value) ?? value;
  await page.evaluate(
    ({ label: name, value: v }) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      const input = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type=range]'),
      ).find((el) => el.closest('.row')?.querySelector('label')?.textContent?.trim() === name);
      if (!input) throw new Error(`no slider labelled ${name}`);
      setter?.call(input, String(v));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    { label, value: onTrack },
  );
  await page.waitForTimeout(120);
}

/**
 * The Carrier setting on screen, in hertz — read from the readout, not the input.
 *
 * Two different quantisations meet at this control and only one of them is the
 * recipe. The engine holds a float; the input is a range whose track is whole
 * cents, so the *thumb* snaps to the nearest one and reading its value back
 * answers where the thumb is rather than what is playing. Recalling a stored
 * 288 Hz would come back 288.03.
 *
 * The readout is rendered from the value itself, so it is the honest source,
 * and it is also the thing a person actually reads.
 */
async function carrierHz(): Promise<number> {
  const shown = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll<HTMLInputElement>('input[type=range]'))
      .find((el) => el.closest('.row')?.querySelector('label')?.textContent?.trim() === 'Carrier')
      ?.closest('.row');
    return row?.querySelector('.value')?.textContent ?? undefined;
  });
  if (shown === undefined) throw new Error('no slider labelled Carrier');
  const hz = Number.parseFloat(shown);
  if (!Number.isFinite(hz)) throw new Error(`unreadable carrier readout: ${shown}`);
  return hz;
}

/**
 * Two frequencies that mean the same slider position.
 *
 * The track is whole cents, so asking for 333 Hz lands on 333.07 — the nearest
 * position that exists — and the readout rounds to a decimal on top of that.
 * Asserting exact equality would be testing the arithmetic of the request
 * rather than that nothing moved, so this asserts the pitch is the same to
 * within the resolution the control actually has.
 *
 * Deliberately in cents rather than hertz: a tolerance in hertz is a different
 * tolerance at each end of a 3.6-octave range, which is the whole reason the
 * track stopped being measured in hertz.
 */
function assertSameCarrier(actual: number, expected: number, message: string): void {
  const apart = Math.abs(carrierTrackFromHz(actual) - carrierTrackFromHz(expected));
  assert.ok(
    apart <= 1,
    `${message} — ${actual} Hz against ${expected} Hz is ${apart.toFixed(2)} cents apart`,
  );
}

describe('the preload bridge', () => {
  it('exposes exactly the surface the renderer is meant to have', async () => {
    const surface = await page.evaluate(() => {
      const bridge = window.desktop as unknown as
        Record<string, Record<string, unknown>> | undefined;
      if (bridge === undefined) return null;
      return {
        presets: Object.keys(bridge.presets).sort(),
        history: Object.keys(bridge.history).sort(),
        session: Object.keys(bridge.session).sort(),
        settings: Object.keys(bridge.settings).sort(),
        theme: Object.keys(bridge.theme).sort(),
        windows: Object.keys(bridge.windows).sort(),
        executor: Object.keys(bridge.executor).sort(),
      };
    });

    assert.notEqual(surface, null, 'window.desktop should be present under Electron');
    assert.deepEqual(surface?.presets, ['importLegacy', 'list', 'remove', 'subscribe', 'upsert']);
    // Deliberately no `append`: only the coordinator writes history, and
    // exposing one would let any renderer forge a record.
    assert.deepEqual(surface?.history, ['list', 'remove', 'subscribe']);
    assert.deepEqual(surface?.session, ['preview', 'start', 'stop', 'subscribe']);
    // Whole-object save, so there is no partial-update merge to get wrong.
    assert.deepEqual(surface?.settings, ['save', 'subscribe']);
    // Read-only by construction. The preference is written through `settings`;
    // this publishes what it currently resolves to, which is the main
    // process's answer because the renderer cannot read the OS here.
    assert.deepEqual(surface?.theme, ['subscribe']);
    // One direction, one window: the popover can ask for Studio and nothing
    // else. A general show-or-move-a-window surface would be a lever.
    assert.deepEqual(surface?.windows, ['setPopoverHeight', 'showStudio']);
    // Present in every window — the main process checks the sender — and
    // enumerated here because it was the one group this assertion omitted
    // entirely, so anything added to it was unproven while the test claimed to
    // be exhaustive. Both reports name a generation; the integrity one names a
    // session as well, since a fast stop-and-start keeps the first and changes
    // the second.
    assert.deepEqual(surface?.executor, [
      'acknowledge',
      'markReady',
      'register',
      'reportConfiguration',
      'reportIntegrity',
    ]);
  });

  it('uses a temporary userData directory, not the real one', () => {
    assert.match(userData, /fortyhz-e2e-/);
  });
});

describe('the capture tap, in a real audio context', () => {
  it('runs a node with no outputs and hands back the samples it heard', async () => {
    // The one thing about this worklet that cannot be established in Node. It
    // has an input and `numberOfOutputs: 0`, which is exactly the shape an
    // implementation could decide not to schedule — nothing downstream depends
    // on it, and it produces nothing. If Chromium ever stops driving it the
    // integrity checks go quiet rather than wrong, which is the failure mode
    // hardest to notice from the outside.
    //
    // Built from the shipped worklet file, addressed the way the app addresses
    // it, in a context of its own so nothing here depends on Studio's graph.
    const result = await page.evaluate(async () => {
      const context = new AudioContext({ sampleRate: 48000 });
      const url = new URL('worklets/capture-processor.js', document.baseURI).href;
      await context.audioWorklet.addModule(url);

      const tap = new AudioWorkletNode(context, 'capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 2,
        channelCountMode: 'explicit',
        processorOptions: { seconds: 2 },
      });

      // A tone on the left only, so the reply also shows the channels arriving
      // separately rather than summed.
      const left = context.createOscillator();
      left.frequency.value = 440;
      const merger = context.createChannelMerger(2);
      const silence = context.createConstantSource();
      silence.offset.value = 0;
      left.connect(merger, 0, 0);
      silence.connect(merger, 0, 1);
      merger.connect(tap);
      left.start();
      silence.start();

      const window = await new Promise<Record<string, unknown>>((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 5000);
        tap.port.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
          clearTimeout(timer);
          resolve(event.data);
        };
        tap.port.postMessage({ type: 'capture', id: 1, frames: 4096 });
      });

      left.stop();
      silence.stop();
      await context.close();

      if (window.ok !== true) return { ok: false, reason: window.reason };
      const asLeft = window.left as Float32Array;
      const asRight = window.right as Float32Array;
      let peakLeft = 0;
      let peakRight = 0;
      for (const value of asLeft) peakLeft = Math.max(peakLeft, Math.abs(value));
      for (const value of asRight) peakRight = Math.max(peakRight, Math.abs(value));
      return { ok: true, frames: window.frames, peakLeft, peakRight };
    });

    assert.equal(result.ok, true, `capture failed: ${String(result.reason)}`);
    assert.equal(result.frames, 4096);
    // Real audio, not zeros: the node was scheduled and the ring recorded it.
    assert.ok(
      (result.peakLeft ?? 0) > 0.5,
      `expected the tone on the left, got peak ${String(result.peakLeft)}`,
    );
    // And the channels stayed apart, which is what every stereo check depends on.
    assert.ok(
      (result.peakRight ?? 1) < 0.01,
      `expected silence on the right, got peak ${String(result.peakRight)}`,
    );
  });
});

describe('About, inside Settings', () => {
  it('shows the version the build was made from, and what the app is not', async () => {
    // About is a section of the Settings dialog rather than a destination of
    // its own: it is infrequent supporting information, and a global slot
    // spent on it is one not spent on Studio or History. Same facts, same
    // single owner — only the way in changed.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.locator('dialog').first();
    await dialog.waitFor();
    const copy = String(await dialog.textContent());

    // The same field the packaged app reports, rather than a string typed
    // twice: Vite substitutes it from package.json at build time.
    const { version } = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    assert.match(copy, new RegExp(version.replace(/\./g, '\\.')));

    // Product positioning calls this a focus tool and makes no medical claim.
    // Asserted rather than trusted, because it is the copy most likely to be
    // rewritten by someone who has not read that section.
    assert.match(copy, /focus and concentration tool/);
    assert.match(copy, /Not a medical device/);
    assert.match(copy, /no telemetry/);

    // The stamp, by shape rather than value: what it reads is whatever the
    // tree was when `build` ran, which is not knowable from here. `unknown` is
    // a legitimate answer — building outside a checkout is allowed to say so
    // rather than fail. A trailing `+` marks uncommitted changes.
    assert.match(copy, /(?:[0-9a-f]{7,}\+?|unknown) · (?:\d{4}-\d{2}-\d{2}|unknown)/);

    await page.keyboard.press('Escape');
  });
});

describe('the application menu', () => {
  it('carries nothing Electron put there by default', async () => {
    const labels = await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      if (menu === null) return null;
      return menu.items.map((item) => ({
        name: item.role ?? item.label,
        submenu: item.submenu?.items.map((child) => child.role ?? child.label) ?? null,
      }));
    });

    if (process.platform === 'darwin') {
      // macOS cannot have no menu without losing Cmd+Q and the clipboard
      // shortcuts, so it keeps the menus carrying those, plus Cmd+W and Cmd+M.
      // File and View are the ones with nothing in them worth having — View's
      // Reload would tear down the audio graph mid-session.
      // Electron lower-cases a role when reading it back off a built menu.
      assert.deepEqual(
        labels?.map((item) => item.name),
        ['appmenu', 'editmenu', 'Window'],
      );
      // Close is deliberately here rather than in a File menu, which is where
      // Electron's default template puts it.
      assert.deepEqual(labels?.[2].submenu, ['minimize', 'zoom', 'close']);
    } else {
      // Elsewhere the menu is drawn in the window and nothing depends on it.
      assert.equal(labels, null);
    }
  });
});

describe('the Dock', () => {
  it('keeps the app in it once the popover exists', async () => {
    // The popover asks to be visible over full-screen Spaces, and unless told
    // otherwise Electron does that by turning the whole app into a UI element:
    // no Dock icon, no Cmd+Tab, no menu bar over Studio. The popover is created
    // at startup, so by now that has either happened or it has not.
    const visible = await app.evaluate(({ app: electronApp }) => electronApp.dock?.isVisible());
    if (process.platform === 'darwin') {
      assert.equal(visible, true);
    } else {
      // `app.dock` is macOS only; there is nothing to lose elsewhere.
      assert.equal(visible, undefined);
    }
  });
});

describe('a session over the real IPC path', () => {
  it('subscribes and reports idle to begin with', async () => {
    const initial = await page.evaluate(async () => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      // Record what arrives, so the next test can prove delivery rather than
      // only that subscribing answered.
      const seen: { state: string; revision: number }[] = [];
      (window as unknown as { __updates: typeof seen }).__updates = seen;
      const update = (await bridge.session.subscribe((u) => {
        const typed = u as { snapshot: { state: string }; revision: number };
        seen.push({ state: typed.snapshot.state, revision: typed.revision });
      })) as { snapshot: { state: string }; revision: number };
      return update;
    });

    assert.equal(initial.snapshot.state, 'idle');
    assert.equal(typeof initial.revision, 'number');
  });

  it('runs preview and stops it', async () => {
    const state = await until('preview to start', async () =>
      page.evaluate(async () => {
        const bridge = window.desktop;
        if (bridge === undefined) return null;
        try {
          const result = (await bridge.session.preview({})) as { snapshot: { state: string } };
          return result.snapshot.state;
        } catch {
          // The executor registers asynchronously; retry until it is ready.
          return null;
        }
      }),
    );
    assert.equal(state, 'previewing');

    const stopped = await page.evaluate(async () => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      const result = (await bridge.session.stop(null)) as { snapshot: { state: string } };
      return result.snapshot.state;
    });
    assert.equal(stopped, 'idle');
  });

  it('pushes later changes to the subscriber', async () => {
    // Subscribing answering is not delivery. Without this, breaking
    // `contents.send` or the preload listener would leave every test green.
    const seen = await page.evaluate(
      () => (window as unknown as { __updates: { state: string; revision: number }[] }).__updates,
    );

    assert.ok(seen.length > 0, 'the subscriber should have received the transitions above');
    assert.ok(
      seen.some((u) => u.state === 'previewing'),
      'preview starting should have been pushed',
    );
    assert.ok(
      seen.some((u) => u.state === 'idle'),
      'stopping should have been pushed',
    );
    // Revisions are the contract: strictly increasing, so a late or repeated
    // event can be discarded.
    const revisions = seen.map((u) => u.revision);
    assert.deepEqual(
      revisions,
      [...revisions].sort((a, b) => a - b),
    );
    assert.equal(new Set(revisions).size, revisions.length, 'revisions should not repeat');
  });

  it('runs a short session to natural completion and records it', async () => {
    await page.evaluate(async () => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      // A short duration is given to the real API rather than reached through
      // any development affordance in the app itself.
      await bridge.session.start({ presetId: 'focus', configuration: {}, plannedSeconds: 2 });
    });

    const records = await until('the completed session to be written', async () => {
      const rows = await history(page);
      return rows.length > 0 ? rows : null;
    });

    assert.equal(records.length, 1);
    assert.equal(records[0].completionReason, 'completed');
    assert.equal(records[0].actualSeconds, 2);
  });

  it('wrote that record to disk and cleared the checkpoint', async () => {
    // `history.list()` answers from the store's in-memory copy, so it proves
    // nothing about durability. A no-op clearCheckpoint would pass everything
    // above while leaving a checkpoint that recovery would replay.
    //
    // Polled rather than read once: the store updates memory before awaiting
    // the write, and the checkpoint is cleared after that, so the previous
    // test can see the record while both are still in flight. Reading
    // immediately would be a race that a slow filesystem loses.
    const durable = await until('the record to reach disk and the checkpoint to go', async () => {
      const raw = await readFile(join(userData, 'history.json'), 'utf8').catch(() => null);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as {
        version: number;
        records: {
          completionReason: string;
          integrityStatus: string;
          integrityCoverage: string[];
        }[];
      };
      if (parsed.records.length === 0) return null;
      // Only ENOENT proves absence. EACCES, EPERM or an I/O failure would
      // otherwise read as a successful deletion — the one outcome this test
      // exists to distinguish from.
      const checkpointGone = await stat(join(userData, 'checkpoint.json')).then(
        () => false,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return true;
          throw error;
        },
      );
      return checkpointGone ? parsed : null;
    });

    // 3 since `graph` coverage means the audio was measured. 2 added the field
    // and recorded that scope from a device property later withdrawn as a
    // check, so the bump is both the usual "an older build must refuse this
    // file" and the marker that lets a v2 record be corrected on read.
    assert.equal(durable.version, 3);
    assert.equal(durable.records.length, 1);
    assert.equal(durable.records[0].completionReason, 'completed');
    // Present and empty, and *not* because nothing produces findings: the
    // first test in this describe subscribes to the session channel through
    // the bridge, and the preload keeps one handler slot per channel — so it
    // displaced Studio's own fan-out and Studio never saw this session start.
    // A record with a device finding is proved in an instance this suite has
    // not reached into; here the point is that the field is written, and that
    // an unreported session says so rather than omitting it.
    assert.deepEqual(durable.records[0].integrityCoverage, []);
  });
});

describe('the scope, when the analyser hands it something that is not audio', () => {
  it('says so on screen and draws nothing, rather than reading zero from it', async () => {
    // The component's own wiring, which no unit test reaches. `isFinitePcm` and
    // `modulationReadout` can both be correct while the component calls neither
    // before it bins — which is precisely the bug this replaced: deleting the
    // guard and its import left all 564 Node tests green.
    //
    // So this drives the real component in the real window, with the fault
    // injected where it actually arrives: the analyser. Every other sample is
    // made NaN, because a wholly bad buffer is the easy case — it is the mixed
    // one, with enough finite samples to look like signal, that used to survive
    // every check and surface as a confident "0.0%".
    const observed = await page.evaluate(async (configuration) => {
      const readout = () => document.querySelector('.scope .readout')?.textContent ?? '';
      const canvas = document.querySelector('.scope canvas') as HTMLCanvasElement | null;

      /**
       * Pixels belonging to the envelope trace.
       *
       * Read the signal colour from the same theme token as the component. An
       * absolute channel threshold used to work against the one dark palette,
       * but the light-theme grid is itself bright enough to satisfy it and was
       * counted as thousands of trace pixels. Drawing the resolved token into
       * a one-pixel canvas lets the browser parse any supported CSS colour
       * syntax, and keeps this assertion about the semantic signal colour
       * rather than one theme's literal.
       */
      const colorProbe = document.createElement('canvas');
      colorProbe.width = 1;
      colorProbe.height = 1;
      const colorContext = colorProbe.getContext('2d');
      if (!colorContext) throw new Error('no canvas context for the signal colour');
      colorContext.fillStyle = getComputedStyle(document.documentElement)
        .getPropertyValue('--chart-signal')
        .trim();
      colorContext.fillRect(0, 0, 1, 1);
      const [signalRed, signalGreen, signalBlue] = colorContext.getImageData(0, 0, 1, 1).data;

      const tracePixels = (): number => {
        if (!canvas) return -1;
        const ctx = canvas.getContext('2d');
        if (!ctx || canvas.width === 0) return -1;
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (
            data[i + 3] > 0 &&
            Math.abs(data[i] - signalRed) <= 1 &&
            Math.abs(data[i + 1] - signalGreen) <= 1 &&
            Math.abs(data[i + 2] - signalBlue) <= 1
          ) {
            count += 1;
          }
        }
        return count;
      };

      /** Wait on the frame clock, since that is what redraws the scope. */
      const settle = (predicate: () => boolean, timeoutMs = 5000): Promise<boolean> =>
        new Promise((resolve) => {
          const deadline = performance.now() + timeoutMs;
          const tick = () => {
            if (predicate()) return resolve(true);
            if (performance.now() > deadline) return resolve(false);
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });

      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');

      const original = AnalyserNode.prototype.getFloatTimeDomainData;
      try {
        await bridge.session.preview(configuration);

        // A reading first, so a blank canvas later means something. Without
        // this the whole test would pass against a scope that never draws.
        const read = await settle(() => /%/.test(readout()) && tracePixels() > 0);
        const readingText = readout().replace(/\s+/g, ' ').trim();
        const readingTrace = tracePixels();

        AnalyserNode.prototype.getFloatTimeDomainData = function (
          this: AnalyserNode,
          array: Float32Array<ArrayBuffer>,
        ) {
          original.call(this, array);
          for (let i = 0; i < array.length; i += 2) array[i] = NaN;
        };

        const refused = await settle(() => /not readable/.test(readout()));
        const invalidText = readout().replace(/\s+/g, ' ').trim();
        // Read after the text, so this is the same frame's canvas or a later one.
        const invalidTrace = tracePixels();

        // Every frame, not one of them. The readout is recalculated on a 150 ms
        // timer while the trace redraws continuously, so a component that only
        // refuses inside the measurement shows the refusal six times a second
        // and the stale numbers in between. Catching that instant and calling
        // it a pass is exactly the hole this test exists to close.
        const frames: string[] = [];
        await settle(() => {
          frames.push(readout());
          return frames.length >= 30;
        });
        const steadyRefusal = frames.every((text) => /not readable/.test(text));

        AnalyserNode.prototype.getFloatTimeDomainData = original;

        // And it recovers: a guard that latched would also pass the above.
        const recovered = await settle(() => /%/.test(readout()) && tracePixels() > 0);
        const recoveredText = readout().replace(/\s+/g, ' ').trim();

        return {
          read,
          readingText,
          readingTrace,
          refused,
          invalidText,
          invalidTrace,
          steadyRefusal,
          framesSampled: frames.length,
          recovered,
          recoveredText,
        };
      } finally {
        AnalyserNode.prototype.getFloatTimeDomainData = original;
        await bridge.session.stop(null);
      }
    }, TEST_CONFIGURATION);

    assert.ok(observed.read, `the scope never produced a reading: "${observed.readingText}"`);
    assert.ok(observed.readingTrace > 0, 'expected a drawn trace to begin with');

    assert.ok(
      observed.refused,
      `expected the scope to refuse the buffer, it showed "${observed.invalidText}"`,
    );
    assert.equal(observed.invalidText, 'signal not readable');
    // The number it used to show instead, named so a regression is unambiguous.
    assert.doesNotMatch(observed.invalidText, /%/);
    assert.equal(
      observed.invalidTrace,
      0,
      'the scope drew an envelope from samples that were not numbers',
    );
    assert.ok(observed.framesSampled >= 30, 'the readout was not sampled over enough frames');
    assert.ok(
      observed.steadyRefusal,
      'the readout fell back to numbers between refusals, so it is refusing after measuring rather than before binning',
    );

    assert.ok(observed.recovered, `the scope stayed refused: "${observed.recoveredText}"`);
    assert.match(observed.recoveredText, /%/);
  });
});

describe('the coverage summary before anything has played', () => {
  /**
   * Its own instance, because the shared one has already played.
   *
   * By the time any test can look at the footer there, a preview and a session
   * have both run, so `app output` is checked and the state this asserts is
   * unreachable — the version of this test that lived in the shared window
   * would have passed even if app output had been marked checked at startup,
   * which is precisely the "coverage read as correctness" failure the whole
   * subsystem exists to prevent.
   */
  it('has not checked the app output, and says which scopes those are', async () => {
    const own = await electron.launch({ args: ['e2e/bootstrap.mjs'], timeout: LAUNCH_TIMEOUT_MS });
    let profile = '';
    try {
      const studio = await until(
        'the Studio window',
        async () => own.windows().find((w) => w.url().endsWith('index.html')) ?? null,
        LAUNCH_TIMEOUT_MS,
      );
      await studio.waitForLoadState('domcontentloaded');
      profile = await own.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));

      // Settle on the state after the self-test lands, which is the only part
      // of this that is timing-dependent. Everything asserted below is true
      // both before and after it.
      const headline = await until('the self-test to report', async () => {
        const text = await studio.locator('.integrity').innerText();
        return text.includes('Currently checked: engine') ? text : null;
      });

      // Nothing has played, so the graph has never existed and nothing about
      // our own output has been measured or even asked.
      assert.match(headline, /not checked:.*app output/);
      assert.doesNotMatch(headline, /Currently checked:[^·]*app output/);

      await studio.locator('.integrity').click();
      const dialog = studio.locator('dialog').first();
      await dialog.waitFor();
      const body = await dialog.innerText();
      assert.match(body, /App output not measured/);
      // And the device facts say the same thing rather than showing a number.
      assert.match(body, /Graph render rate\s+not available/);
      assert.match(body, /Output channels\s+not available/);
    } finally {
      await own.close().catch(() => undefined);
      if (profile !== '') await rm(profile, { recursive: true, force: true });
    }
  });
});

describe('the coverage summary', () => {
  it('reports the shipped build proving itself, and says what it has not checked', async () => {
    // The self-test is the one check that proves *this binary* rather than
    // CI's checkout, and it runs in the renderer at startup — so nothing but
    // the real window can show that it ran at all.
    const row = page.locator('.integrity');
    const headline = await until('the coverage summary to say the engine was checked', async () => {
      const text = await row.innerText();
      return text.includes('engine') ? text : null;
    });

    // Present tense, deliberately: this is what the checks say now, while the
    // session record keeps the worst result seen during a session. The two
    // are different questions and are allowed to disagree.
    assert.match(headline, /^Currently checked:/);
    assert.match(headline, /engine/);
    // Never checked anywhere, on any platform, so it must never be implied.
    assert.match(headline, /not checked:.*delivery/);

    await row.click();
    const dialog = page.locator('dialog').first();
    await dialog.waitFor();
    const body = await dialog.innerText();

    // The line that keeps the panel's answer from being read as the record's.
    assert.match(body, /Current checks are shown here/);
    assert.match(body, /worst result observed during each session/);
    // Every scope is listed, including the two that cannot be checked — a
    // scope left out looks exactly like one that passed.
    for (const scope of ['engine', 'app output', 'system mix', 'delivery']) {
      assert.ok(body.includes(scope), `the panel should account for ${scope}`);
    }
    assert.match(body, /no checker exists/);

    await page.keyboard.press('Escape');
    await until('the dialog to close', async () =>
      (await page.locator('dialog').count()) === 0 ? true : null,
    );
  });
});

describe('a window the app did not open', () => {
  /**
   * The only thing that exercises the guards at all.
   *
   * Every other test speaks from Studio, which is trusted and designated as
   * the executor — so `guard()` and the executor restriction could be deleted
   * and the suite would stay green.
   *
   * Every method is enumerated from the bridge rather than listed here, so a
   * channel added later without a guard fails this by default instead of
   * quietly widening the hole.
   */
  it('is refused by every method the bridge exposes', async () => {
    const preloadPath = join(process.cwd(), 'out', 'main', 'preload.cjs');

    const outcome = await app.evaluate(async ({ BrowserWindow }, preload) => {
      const win = new BrowserWindow({
        show: false,
        webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      await win.loadURL('about:blank');

      const script = `
        (async () => {
          const bridge = window.desktop;
          if (typeof bridge !== 'object' || bridge === null) return { absent: true };
          const results = {};
          for (const group of [
            'presets',
            'history',
            'session',
            'settings',
            'theme',
            'windows',
            'executor',
          ]) {
            const surface = bridge[group];
            if (surface === undefined) { results[group + '.<missing>'] = 'GROUP ABSENT'; continue; }
            for (const name of Object.keys(surface)) {
              if (typeof surface[name] !== 'function') continue;
              try {
                // Only the listener-taking methods get a callback: a function
                // is not structured-cloneable, so passing one to the others
                // fails at the IPC boundary *before* the guard runs, which
                // would look like a refusal while testing nothing.
                const takesListener = name === 'subscribe' || name === 'register';
                await (takesListener ? surface[name](() => {}) : surface[name]());
                results[group + '.' + name] = 'RESOLVED';
              } catch (error) {
                results[group + '.' + name] = String(error && error.message ? error.message : error);
              }
            }
          }
          return { absent: false, results };
        })()
      `;
      const probed = (await win.webContents.executeJavaScript(script)) as {
        absent: boolean;
        results?: Record<string, string>;
      };
      win.destroy();
      return probed;
    }, preloadPath);

    // If the preload had not loaded, every call would "fail" for the wrong
    // reason and this test would pass while proving nothing.
    assert.equal(outcome.absent, false, 'the preload should expose the bridge in this window too');

    const results = outcome.results ?? {};
    const methods = Object.keys(results);
    // Guards against the enumeration silently finding nothing.
    assert.ok(methods.length >= 10, `expected the whole bridge, saw ${methods.length}`);

    const notRefused = methods.filter(
      (name) => !/untrusted sender|unexpected sender|non-executor/.test(results[name]),
    );
    assert.deepEqual(
      notRefused,
      [],
      `these accepted a call from an untrusted window: ${notRefused
        .map((n) => `${n} -> ${results[n]}`)
        .join(', ')}`,
    );
  });

  /**
   * `isMainFrame()` is not isolated by the test above: the untrusted window is
   * refused on its WebContents id first, so the frame check never decides.
   *
   * Reaching it would need a call from a subframe of a *trusted* window, which
   * this configuration cannot produce — the preload runs only in the main
   * frame, so a subframe has no bridge to call through. It is therefore
   * defence-in-depth against a future change that enables subframe preloads,
   * and this records that rather than pretending it is covered.
   */
  it('does not expose the bridge to subframes at all', async () => {
    const preloadPath = join(process.cwd(), 'out', 'main', 'preload.cjs');

    const inSubframe = await app.evaluate(async ({ BrowserWindow }, preload) => {
      const win = new BrowserWindow({
        show: false,
        webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      await win.loadURL(
        'data:text/html,' + encodeURIComponent('<iframe src="about:blank"></iframe>'),
      );
      const result = (await win.webContents.executeJavaScript(`
        new Promise((resolve) => {
          const frame = document.querySelector('iframe');
          const check = () => {
            try {
              resolve(typeof frame.contentWindow.desktop);
            } catch (error) {
              resolve('cross-origin: ' + String(error && error.message));
            }
          };
          if (frame.contentDocument && frame.contentDocument.readyState === 'complete') check();
          else frame.addEventListener('load', check);
        })
      `)) as string;
      win.destroy();
      return result;
    }, preloadPath);

    assert.equal(inSubframe, 'undefined', 'a subframe must not receive the bridge');
  });
});

describe('the Session popover', () => {
  it('is a window of its own, trusted with the store', async () => {
    // A separate Vite entry, so this proves the second document actually
    // builds, loads, and gets the bridge — not only that main opened a window.
    const saved = await popover.evaluate(async () => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      return (await bridge.presets.list()).length;
    });
    assert.equal(saved, 0, 'a fresh profile has no saved presets');
  });

  it('offers presets to start from on a fresh profile', async () => {
    // The store holds saved presets only — the built-in ones are code. A
    // picker fed from the store alone is empty until the user has saved
    // something, which is to say the popover does nothing on first run.
    const options = await popover.locator('select option').count();
    assert.ok(options > 0, 'the preset picker should not be empty');
  });

  it('says what binaural routing needs, before it starts one', async () => {
    // The path that would otherwise pass no warning at all: this window can
    // start a remembered preset with Studio hidden, so the routing control —
    // where that warning lives — is never on screen. Driven through the real
    // picker, because the defect is about what is rendered next to the button
    // the user is about to press.
    const guidance = popover.locator('.note.advisory', { hasText: 'Binaural routing' });

    await popover.locator('select').selectOption('focus');
    await until('the guidance to be absent for a preset that does not need it', async () =>
      (await guidance.count()) === 0 ? true : null,
    );

    await popover.locator('select').selectOption('binaural');
    await until('the guidance to appear for the binaural preset', async () =>
      (await guidance.count()) > 0 ? true : null,
    );
    const text = await guidance.first().innerText();
    assert.match(text, /headphones/i);
    // Guidance about the routing, not a claim about the device: only Studio
    // holds a context, so this window cannot know what the output accepts.
    assert.doesNotMatch(text, /mono/i);

    // Left as it was found, so a later test starting from the picker is not
    // silently starting a binaural session.
    await popover.locator('select').selectOption('focus');
  });

  it('survives being closed, so the tray can reopen it', async () => {
    // Frameless does not mean unclosable: macOS installs a default menu with
    // Cmd+W and Alt+F4 closes anything on Windows. Nothing recreates this
    // window, so a real close would disable Session until the app restarted.
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith('session.html'),
      );
      if (win === undefined) throw new Error('no popover window');
      win.show();
      win.close();
    });

    // Destruction is asynchronous, so `isDestroyed()` read straight after
    // `close()` is false whether the close was prevented or not — an earlier
    // version of this test passed with the fix removed. Proving something did
    // not happen needs a settle, not a poll.
    await new Promise((r) => setTimeout(r, 500));

    const state = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith('session.html'),
      );
      if (win === undefined) return null;
      win.show();
      const visibleAgain = win.isVisible();
      // Do not leak a visible, unfocused popover into the next test. Some
      // compositors will not reactivate an already-visible window when it is
      // shown again, which leaves its renderer suspended in the background.
      win.hide();
      return { visibleAgain };
    });

    assert.notEqual(state, null, 'closing the popover must not destroy it');
    assert.equal(state?.visibleAgain, true, 'it must be showable again afterwards');
  });

  it('picks up a preset saved after it was created', async () => {
    // The popover is created once at startup and hidden between uses, and it
    // cannot detect being shown, so without a push from the store its picker
    // would show the launch-time list for the rest of the session.
    const before = await popover.locator('select option').count();

    await page.evaluate(async (configuration) => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      await bridge.presets.upsert({
        id: 'saved-after-launch',
        name: 'Saved After Launch',
        description: 'written by the smoke test',
        ...configuration,
      });
    }, TEST_CONFIGURATION);

    const after = await until('the popover to see the new preset', async () => {
      const count = await popover.locator('select option').count();
      return count > before ? count : null;
    });
    assert.equal(after, before + 1);
  });

  it('is placed again when its own content resizes it', async () => {
    // It sizes itself to its content, so a resize has to re-run placement:
    // growing from a fixed top-left walks a bottom-anchored popover down into
    // the taskbar.
    //
    // What this can assert depends on the machine, and on what a test can
    // reach. Showing it here does not go through the tray, so there is no tray
    // rectangle to anchor to and placement takes its no-anchor path; and this
    // machine's tray is at the top of the screen, so the bottom clamp never
    // engages either. Both of those are covered by the `popoverPosition` unit
    // tests, which drive a bottom-anchored tray directly. What is proved here
    // is the wiring nothing else covers: that content growing re-runs
    // placement at all, and leaves the window inside the work area.
    // Its own instance, and its own attempts at staying visible.
    //
    // Two things make this awkward to drive, and both are the product being
    // correct rather than the test being unlucky. The popover dismisses itself
    // on blur, because that is what a tray panel does — and `setHeight`
    // deliberately skips placement while hidden, since moving an invisible
    // window is work for nobody. So a resize that lands after something else
    // took focus grows the content and leaves the window where it was, which
    // is exactly what was observed here: height 283 to 523 with y unmoved at
    // the stray position, and `isVisible()` false.
    //
    // Each attempt therefore re-establishes the starting state — visible,
    // then shoved somewhere placement would never leave it — and only then
    // asks for a new height. `show()` places the window itself, so it happens
    // *before* the stray position is set; anything that moves the window
    // afterwards can only be the resize under test.
    const own = await electron.launch({ args: ['e2e/bootstrap.mjs'], timeout: LAUNCH_TIMEOUT_MS });
    let profile = '';
    try {
      const ownPopover = await until(
        'the isolated Session popover',
        async () => own.windows().find((w) => w.url().endsWith('session.html')) ?? null,
        LAUNCH_TIMEOUT_MS,
      );
      await ownPopover.waitForLoadState('domcontentloaded');
      profile = await own.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));

      /** Where the window is, and whether placement could have run. */
      const bounds = async (): Promise<{
        y: number;
        height: number;
        visible: boolean;
        withinBottom: boolean;
        withinTop: boolean;
      }> =>
        own.evaluate(({ BrowserWindow, screen: display }) => {
          const win = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().endsWith('session.html'),
          );
          if (win === undefined) throw new Error('no popover window');
          const at = win.getBounds();
          const { workArea } = display.getDisplayMatching(at);
          return {
            y: at.y,
            height: at.height,
            visible: win.isVisible(),
            withinBottom: at.y + at.height <= workArea.y + workArea.height,
            withinTop: at.y >= workArea.y,
          };
        });

      let moved: Awaited<ReturnType<typeof bounds>> | null = null;
      let last = await bounds();

      for (let attempt = 0; attempt < 5 && moved === null; attempt += 1) {
        // Unlike BrowserWindow.focus(), Playwright can foreground the page
        // through its automation connection on compositors that reject focus
        // stealing. The real tray path is user-initiated and focuses the
        // window.
        await ownPopover.bringToFront();
        const stray = await own.evaluate(({ BrowserWindow, screen: display }) => {
          const win = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().endsWith('session.html'),
          );
          if (win === undefined) throw new Error('no popover window');
          if (!win.isVisible()) win.show();
          const placed = win.getBounds();
          const { workArea } = display.getDisplayMatching(placed);
          const y = workArea.y + workArea.height - placed.height;
          win.setPosition(placed.x, y, false);
          return { y, height: placed.height };
        });

        // Grown from the renderer, not with `setContentSize` from main: the
        // resize only happens because the content asked, and driving the
        // window directly would skip the very path under test. A different
        // height each attempt, because a no-op resize is refused on purpose.
        await ownPopover.evaluate(
          (height: number) => {
            const existing = document.getElementById('resize-probe');
            const filler = existing ?? document.createElement('div');
            filler.id = 'resize-probe';
            filler.style.height = `${String(height)}px`;
            if (existing === null) document.body.append(filler);
          },
          240 + attempt * 40,
        );

        for (let poll = 0; poll < 15; poll += 1) {
          await new Promise((r) => setTimeout(r, 100));
          last = await bounds();
          // Hidden again: this attempt cannot prove anything, since placement
          // is skipped while invisible. Start over rather than accept a move
          // that a later `show()` would have made anyway.
          if (!last.visible) break;
          if (last.height > stray.height && last.y !== stray.y) {
            moved = last;
            break;
          }
        }
      }

      assert.notEqual(
        moved,
        null,
        `the popover never moved on a resize; last seen ${JSON.stringify(last)}`,
      );
      if (moved === null) throw new Error('unreachable');
      await ownPopover.evaluate(() => document.getElementById('resize-probe')?.remove());

      assert.equal(moved.withinBottom, true, 'a resize should leave it inside the work area');
      assert.equal(moved.withinTop, true, 'at both edges');
    } finally {
      await own.close().catch(() => undefined);
      if (profile !== '') await rm(profile, { recursive: true, force: true });
    }
  });

  it('cannot claim the audio graph', async () => {
    // The security property that makes a second window safe. Only Studio is
    // nominated as the executor; a popover that could register would drive
    // audio from a window with no graph and displace the one that has it.
    const refused = await popover.evaluate(async () => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      try {
        await bridge.executor.register(() => {});
        return null;
      } catch (error) {
        return String(error);
      }
    });
    assert.notEqual(refused, null, 'the popover must not be able to register as the executor');
    assert.match(String(refused), /unexpected sender/);
  });

  it('sees the same session state Studio does', async () => {
    // Both windows subscribe to the one coordinator in main. If the popover
    // got its own, it would count down against a session nobody is playing.
    const state = await popover.evaluate(async () => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      return (await bridge.session.subscribe(() => {})) as {
        snapshot: { state: string };
        revision: number;
      };
    });
    assert.equal(state.snapshot.state, 'idle');
    // Revisions are global to the coordinator, and the earlier tests already
    // ran a preview and a session through it — so a popover with its own
    // machine would be starting from zero here.
    assert.ok(state.revision > 0, 'should be watching the coordinator that already ran a session');
  });

  it('starts a session that Studio actually plays', async () => {
    // The point of the whole stage: the window with the controls is not the
    // window with the audio graph. The popover asks main, main commands
    // Studio, and Studio makes sound — across two renderers and a process.
    // Earlier tests have already written records, so "a completed record
    // exists" is satisfied by one of theirs: the wait returns at once, this
    // test proves nothing, and it leaves a session running for whatever comes
    // next. Named for what it holds rather than `before`, which is the
    // node:test hook and would shadow silently.
    const existingIds = new Set((await history(popover)).map((r) => r.id));

    await popover.evaluate(async (configuration) => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      const [preset] = await bridge.presets.list();
      await bridge.session.start({
        presetId: preset?.id ?? 'focus',
        configuration,
        plannedSeconds: 2,
      });
    }, TEST_CONFIGURATION);

    // Asked of Studio, not of the popover: reading it back where it was set
    // would prove nothing about the other window.
    const seenByStudio = await until("Studio to see the popover's session", async () => {
      const state = await page.evaluate(async () => {
        const bridge = window.desktop;
        if (bridge === undefined) throw new Error('no desktop bridge');
        const update = (await bridge.session.subscribe(() => {})) as {
          snapshot: { state: string };
        };
        return update.snapshot.state;
      });
      return state === 'session-active' || state === 'session-ending' ? state : null;
    });
    assert.match(seenByStudio, /^session-/);

    const settled = await until("the popover's session to be recorded", async () => {
      const records = await history(popover);
      return records.find((r) => !existingIds.has(r.id)) ?? null;
    });
    assert.equal(settled.completionReason, 'completed');
    assert.ok(settled.actualSeconds >= 2, `ran for ${settled.actualSeconds}s`);
  });
});

describe('settings', () => {
  it('answers the stored values as part of subscribing', async () => {
    // The contract this depends on, and the one easiest to misuse: the
    // callback fires only on later changes, so a surface that ignores the
    // returned promise shows the defaults until something else changes them —
    // which meant a stored advisory did nothing at all after a restart.
    await page.evaluate(async () => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      await bridge.settings.save({
        dailyAdvisorySeconds: 5400,
        cooldownSeconds: 0,
        launchAtLogin: false,
        closeToTray: true,
        appearance: 'system',
      });
    });

    const onSubscribe = await popover.evaluate(async () => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      // A window that has not been told about the change, subscribing fresh.
      return bridge.settings.subscribe(() => {});
    });
    assert.equal(onSubscribe.dailyAdvisorySeconds, 5400);
  });

  it('shows the stored values in the Studio form, not the defaults', async () => {
    // The bug at the level it actually appeared: the panel mounts when the
    // dialog opens, which is after the save, so it never sees a change event.
    await page.getByRole('button', { name: 'Settings' }).click();
    const select = page.locator('dialog select').first();
    await select.waitFor();
    assert.equal(await select.inputValue(), '90');
    await page.keyboard.press('Escape');
  });

  it('does not offer launch at login, and says why', async () => {
    // The control used to be offered here with a promise that the preference
    // would apply to an installed build. It would not: the installed build
    // reads the OS at startup and corrects the file, so a `true` stored in
    // development was overwritten before it ever took effect. This suite runs
    // unpackaged, which is exactly the case in question.
    //
    // Two reasons it can be absent, and which one applies depends on where
    // this is running: unpackaged everywhere, and unsupported on Linux, where
    // autostart is a `.desktop` file rather than anything Electron sets. Both
    // hide the control; they owe the user different explanations.
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.locator('dialog').first();
    await dialog.waitFor();

    // Scoped to this control rather than counting every checkbox in the
    // dialog: that stood in for "launch at login is absent" only while it was
    // the sole checkbox, and it stopped meaning that the moment another
    // setting arrived.
    assert.equal(await dialog.getByRole('checkbox', { name: /log in/ }).count(), 0);
    // `textContent` is nullable for a locator that matched nothing; it did
    // match, since `waitFor` returned, but the type does not know that.
    const copy = String(await dialog.textContent());
    if (process.platform === 'linux') assert.match(copy, /not available on this platform/);
    else assert.match(copy, /development build/);

    await page.keyboard.press('Escape');
  });

  it('offers tray residency where closing can actually leave the app running', async () => {
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.locator('dialog').first();
    await dialog.waitFor();

    const toggle = dialog.getByRole('checkbox', { name: /running in the tray/ });
    if (process.platform === 'linux') {
      // Closing always quits there, because a constructed tray is not evidence
      // of a visible one, so the control would decide nothing.
      assert.equal(await toggle.count(), 0);
      assert.match(String(await dialog.textContent()), /quits 40 Hz on this platform/);
    } else {
      assert.equal(await toggle.count(), 1);
      // On by default: tray residency is what the window closing is for.
      assert.equal(await toggle.isChecked(), true);
    }

    await page.keyboard.press('Escape');
  });

  it('normalizes what the renderer sends', async () => {
    // IPC is untrusted like everything else. A truthy string is not a boolean,
    // and starting the app at login is not something to guess at.
    const saved = await page.evaluate(async () => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      return bridge.settings.save({ launchAtLogin: 'yes', dailyAdvisorySeconds: -5 } as never);
    });
    assert.equal(saved.launchAtLogin, false);
    // Clamped to off rather than restored to a default the user had changed.
    assert.equal(saved.dailyAdvisorySeconds, 0);
  });
});

describe('deleting a record', () => {
  it('reaches windows that did not ask for it', async () => {
    // Every surface counts history into listening time, the advisory and
    // recall. Answering only the window that deleted left the others counting
    // a record that no longer exists, until the app restarted.
    const before = await history(popover);
    assert.ok(before.length > 0, 'earlier tests should have recorded something');

    // Deleted from Studio; observed in the popover, which never asked.
    const seen = await popover.evaluate(async () => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      const updates: number[] = [];
      await bridge.history.subscribe((records) => updates.push(records.length));
      (window as unknown as { __historyUpdates: number[] }).__historyUpdates = updates;
      return updates.length;
    });
    assert.equal(seen, 0, 'subscribing should not itself deliver an update');

    await page.evaluate(async (id) => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      await bridge.history.remove(id);
    }, before[0].id);

    const delivered = await until('the popover to hear about the deletion', async () => {
      const updates = await popover.evaluate(
        () => (window as unknown as { __historyUpdates: number[] }).__historyUpdates,
      );
      return updates.length > 0 ? updates : null;
    });
    assert.equal(delivered.at(-1), before.length - 1);
  });

  it('also announces a session the coordinator recorded', async () => {
    // The reason this is driven from the store rather than from the delete
    // handler: the coordinator appends directly, so a notification wired to
    // the handlers would carry deletions and miss every completed session.
    await popover.evaluate(() => {
      (window as unknown as { __historyUpdates: number[] }).__historyUpdates.length = 0;
    });

    await popover.evaluate(async (configuration) => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      await bridge.session.start({ presetId: 'focus', configuration, plannedSeconds: 2 });
    }, TEST_CONFIGURATION);

    const delivered = await until('the recorded session to be announced', async () => {
      const updates = await popover.evaluate(
        () => (window as unknown as { __historyUpdates: number[] }).__historyUpdates,
      );
      return updates.length > 0 ? updates : null;
    });
    assert.ok(delivered.length > 0);
  });
});

/**
 * Last of the suites sharing the app instance: it clears the log, and the
 * deletion tests before it need something to delete.
 */
describe('two components watching the same channel', () => {
  it('keeps updating the panel behind a dialog that has been opened and closed', async () => {
    // The preload keeps one handler slot per channel, so a second subscriber
    // in the same window used to displace the first — and closing the dialog
    // left the replacement installed. Studio's session panel then stopped
    // hearing about history for the rest of the session.
    //
    // Driven through the real UI, because the defect is entirely about which
    // components are mounted.
    await page.evaluate(async () => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      // One second, so any recorded listening at all is past it.
      await bridge.settings.save({
        dailyAdvisorySeconds: 1,
        cooldownSeconds: 0,
        launchAtLogin: false,
        closeToTray: true,
        appearance: 'system',
      });
    });

    const advisory = page.locator('.advisory');
    await until('the advisory to appear in Studio', async () =>
      (await advisory.count()) > 0 ? true : null,
    );

    // Visit History and come back. Its panel subscribes to the same channel
    // the session panel is watching, and it now mounts and unmounts on
    // navigation rather than on a dialog opening — the same lifecycle
    // question, reached a different way.
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await until('the History view to mount', async () =>
      (await page.locator('.history-view').count()) > 0 ? true : null,
    );
    await page.getByRole('button', { name: 'Studio', exact: true }).click();
    await until('the History view to unmount', async () =>
      (await page.locator('.history-view').count()) === 0 ? true : null,
    );

    // Clear the log from another window entirely, so only a live subscription
    // can tell the session panel about it.
    await popover.evaluate(async () => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      for (const record of await bridge.history.list()) await bridge.history.remove(record.id);
    });

    // With nothing recorded there is no listening time, so the advisory has
    // nothing to report — unless the panel never heard.
    await until('the advisory to clear', async () =>
      (await advisory.count()) === 0 ? true : null,
    );
  });
});

describe('quitting while a session runs', () => {
  /**
   * Its own Electron instance, because the assertion is about what survives
   * the process ending. The shared one has to outlive every other test.
   */
  it('writes the record before the process exits', async () => {
    const own = await electron.launch({ args: ['e2e/bootstrap.mjs'], timeout: LAUNCH_TIMEOUT_MS });
    let profile = '';
    try {
      const studio = await until(
        'the Studio window',
        async () => own.windows().find((w) => w.url().endsWith('index.html')) ?? null,
        LAUNCH_TIMEOUT_MS,
      );
      await studio.waitForLoadState('domcontentloaded');
      profile = await own.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));

      await studio.evaluate(async (configuration) => {
        const bridge = window.desktop;
        if (bridge === undefined) throw new Error('no desktop bridge');
        await bridge.session.start({ presetId: 'focus', configuration, plannedSeconds: 600 });
      }, TEST_CONFIGURATION);

      // Quit with the session still running. The windows are still open here,
      // so the executor can still answer — which is the whole reason the
      // finalization happens on `before-quit` rather than after.
      await own.close();

      const raw = await readFile(join(profile, 'history.json'), 'utf8');
      const parsed = JSON.parse(raw) as { records: { completionReason: string }[] };
      assert.equal(parsed.records.length, 1, 'quitting mid-session must still record it');
      assert.equal(parsed.records[0]?.completionReason, 'stopped');
    } finally {
      await own.close().catch(() => undefined);
      if (profile !== '') await rm(profile, { recursive: true, force: true });
    }
  });
});

describe('an integrity report crossing the boundary', () => {
  /**
   * Its own Electron instance, because it takes the executor over.
   *
   * Registering from the test replaces Studio's own registration, which is
   * the honest way to obtain a generation — it is the value `register`
   * answers with, and nothing exposes it otherwise. Answering the commands
   * here means this needs no audio at all: what it proves is the report path
   * to a record on disk, and a graph would only add a way for it to fail for
   * unrelated reasons.
   */
  it('records what was measured, and refuses what it must', async () => {
    const own = await electron.launch({ args: ['e2e/bootstrap.mjs'], timeout: LAUNCH_TIMEOUT_MS });
    let profile = '';
    try {
      const studio = await until(
        'the Studio window',
        async () => own.windows().find((w) => w.url().endsWith('index.html')) ?? null,
        LAUNCH_TIMEOUT_MS,
      );
      await studio.waitForLoadState('domcontentloaded');
      profile = await own.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));

      const outcome = await studio.evaluate(async (configuration) => {
        const bridge = window.desktop;
        if (bridge === undefined) throw new Error('no desktop bridge');

        const generation = await bridge.executor.register((message) => {
          if (message.kind !== 'command') return;
          // A start is answered with the instant audio "began"; everything
          // else with nothing. Main cannot tell the difference, which is the
          // point — the coordinator only ever sees acknowledgements.
          const result = message.name === 'startSession' ? Date.now() : null;
          void bridge.executor.acknowledge(message.id, message.executor, result);
        });
        await bridge.executor.markReady(generation);

        const started = (await bridge.session.start({
          presetId: 'focus',
          configuration,
          plannedSeconds: 600,
        })) as { snapshot: { session: { id: string } | null } };
        const sessionId = started.snapshot.session?.id ?? '';

        const warning = {
          id: 'envelope',
          scope: 'graph',
          status: 'warning',
          checked: true,
          title: 'Envelope',
          detail: 'shallower than the offline render',
        };
        const accepted = await bridge.executor.reportIntegrity(generation, sessionId, [
          warning,
          // The claim nothing on any platform can make. It crosses IPC as
          // ordinary JSON, so only the normalizer stands between it and a
          // record saying the app verified what the listener heard.
          {
            id: 'acoustic',
            scope: 'delivery',
            status: 'ok',
            checked: true,
            title: 'Delivery',
            detail: 'claims to have measured the air',
          },
        ]);
        const staleGeneration = await bridge.executor.reportIntegrity(generation + 1, sessionId, [
          warning,
        ]);
        const staleSession = await bridge.executor.reportIntegrity(generation, `${sessionId}-old`, [
          { ...warning, status: 'failed' },
        ]);

        await bridge.session.stop(null);
        return { accepted, staleGeneration, staleSession, sessionId };
      }, TEST_CONFIGURATION);

      assert.equal(outcome.accepted, true, 'the report from the current executor was refused');
      assert.equal(outcome.staleGeneration, false, 'a superseded executor was believed');
      assert.equal(outcome.staleSession, false, 'a report about another session was believed');
      assert.notEqual(outcome.sessionId, '');

      // The disk, not the store's memory: it updates before awaiting its
      // write, so reading the instant the record appears is a race.
      const record = await until('the record to reach the file', async () => {
        const raw = await readFile(join(profile, 'history.json'), 'utf8');
        const parsed = JSON.parse(raw) as {
          records: { integrityStatus: string; integrityCoverage: string[] }[];
        };
        return parsed.records[0] ?? null;
      });

      assert.equal(record.integrityStatus, 'warning');
      // `graph` alone: the delivery finding was refused rather than recorded,
      // and a report that never mentioned the engine does not cover it.
      assert.deepEqual(record.integrityCoverage, ['graph']);
    } finally {
      await own.close().catch(() => undefined);
      if (profile !== '') await rm(profile, { recursive: true, force: true });
    }
  });
});

describe('measuring the app’s own output', () => {
  /**
   * The wiring, which nothing else reaches.
   *
   * `CaptureSchedule` is proved against a fake host, and `runCaptureChecks`
   * against fake taps — but whether the engine ever *calls* them, against a
   * real graph with real audio in it, is only observable here. Deleting the
   * calls from `engine.svelte.ts` leaves every other suite green.
   *
   * Its own instance, since it plays for several seconds and the shared window
   * is shared.
   */
  it('checks the app output during playback, and unsays it when the settings move', async () => {
    const own = await electron.launch({ args: ['e2e/bootstrap.mjs'], timeout: LAUNCH_TIMEOUT_MS });
    let profile = '';
    try {
      const studio = await until(
        'the Studio window',
        async () => own.windows().find((w) => w.url().endsWith('index.html')) ?? null,
        LAUNCH_TIMEOUT_MS,
      );
      await studio.waitForLoadState('domcontentloaded');
      profile = await own.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));

      const footer = studio.locator('.integrity');

      // Nothing has played, so there is nothing to measure and the button says
      // so rather than sitting there inviting a press.
      await footer.click();
      const idle = studio.locator('dialog').first();
      await idle.waitFor();
      assert.equal(
        await studio.getByRole('button', { name: 'Check app output now' }).isDisabled(),
        true,
        'the check should be idle before anything has played',
      );
      assert.match(await idle.innerText(), /Nothing is playing/);
      await studio.keyboard.press('Escape');

      await studio.getByRole('button', { name: 'Preview' }).click();

      // A pass waits for the ramp, then a whole window, then a margin — so
      // this is several seconds of real audio being captured and compared
      // against an offline render of the same parameters.
      const measured = await until(
        'the app output to be measured',
        async () => {
          const text = await footer.innerText();
          return /Currently checked:[^·]*app output/.test(text) ? text : null;
        },
        MEASUREMENT_TIMEOUT_MS,
      );
      assert.match(measured, /app output/);

      // The panel shows what was measured rather than a device property, and
      // the check is offered while there is audio to check.
      await footer.click();
      const dialog = studio.locator('dialog').first();
      await dialog.waitFor();
      assert.match(await dialog.innerText(), /reference render/);
      assert.equal(
        await studio.getByRole('button', { name: 'Check app output now' }).isDisabled(),
        false,
        'the check should run while audio is playing',
      );
      await studio.keyboard.press('Escape');

      // Moving a control epochs the ring, so what was measured describes
      // settings no longer in force and is withdrawn rather than left up.
      // Reached through the graph's epoch rather than a call beside this
      // control, so every other control is covered by the same path.
      await studio.locator('input[type=range]').nth(1).fill('36');
      await until(
        'the measurement to be withdrawn',
        async () => ((await footer.innerText()).includes('app output — ') ? null : true),
        SETTLE_TIMEOUT_MS,
      );

      // Stopping while that pass is still pending has to cancel it. Left to
      // fire, it would measure a ring winding down against a suspending
      // context and report a refusal — findings about audio nobody is hearing.
      await studio.evaluate(async () => {
        await window.desktop?.session.stop(null);
      });
      await new Promise((r) => setTimeout(r, 9000));
      await footer.click();
      const afterStop = studio.locator('dialog').first();
      await afterStop.waitFor();
      const stopped = await afterStop.innerText();
      assert.match(stopped, /App output not measured/);
      assert.doesNotMatch(stopped, /Playback ended before a whole window/);
      assert.doesNotMatch(stopped, /overlapped a ramp/);

      // And the button says why it cannot run — a graph outlives the audio it
      // played, so one gated on the graph would still be offering to measure.
      assert.equal(
        await studio.getByRole('button', { name: 'Check app output now' }).isDisabled(),
        true,
        'the check should be idle with nothing playing',
      );
      assert.match(stopped, /Nothing is playing/);
    } finally {
      await own.close().catch(() => undefined);
      if (profile !== '') await rm(profile, { recursive: true, force: true });
    }
  });
});

describe('a timed session measuring its own output', () => {
  /**
   * The session path, which the preview test does not reach.
   *
   * `applyConfiguration` runs while nothing is playing, when no pass can be
   * scheduled — so the measurement a session gets depends entirely on the call
   * after `startSession`. Deleting that one leaves the preview test green and
   * every timed session unmeasured, which is the case that matters most: a
   * session is the thing that gets recorded.
   */
  it('records the audio it measured', async () => {
    const own = await electron.launch({ args: ['e2e/bootstrap.mjs'], timeout: LAUNCH_TIMEOUT_MS });
    let profile = '';
    try {
      const studio = await until(
        'the Studio window',
        async () => own.windows().find((w) => w.url().endsWith('index.html')) ?? null,
        LAUNCH_TIMEOUT_MS,
      );
      await studio.waitForLoadState('domcontentloaded');
      profile = await own.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));

      // Long enough to outlast the ramp, a whole window and the margin.
      await studio.evaluate(async (configuration) => {
        await window.desktop?.session.start({
          presetId: 'focus',
          configuration,
          plannedSeconds: 20,
        });
      }, TEST_CONFIGURATION);

      await until(
        'the session to measure the app output',
        async () => {
          const text = await studio.locator('.integrity').innerText();
          return /Currently checked:[^·]*app output/.test(text) ? text : null;
        },
        MEASUREMENT_TIMEOUT_MS,
      );

      await studio.evaluate(async () => {
        await window.desktop?.session.stop(null);
      });

      // And what was measured reaches the record, which is the point of
      // measuring during a session rather than only during a preview.
      const record = await until('the record to reach the file', async () => {
        const raw = await readFile(join(profile, 'history.json'), 'utf8').catch(() => null);
        if (raw === null) return null;
        const parsed = JSON.parse(raw) as { records: { integrityCoverage: string[] }[] };
        return parsed.records[0] ?? null;
      });
      assert.deepEqual(record.integrityCoverage, ['engine', 'graph']);
    } finally {
      await own.close().catch(() => undefined);
      if (profile !== '') await rm(profile, { recursive: true, force: true });
    }
  });
});

describe('the current view, reported by the window that holds it', () => {
  /**
   * Its own Electron instance, and no reaching into the renderer.
   *
   * Studio owns the current view and reports it through its own session
   * subscription. The shared instance is no use here:
   * a test there subscribes to the session channel directly, and the preload's
   * one-slot-per-channel rule means that displaces Studio's own handler, so
   * Studio never learns a session started.
   *
   * The session is therefore started from the UI's own path and left alone.
   */
  it('reaches the record through the whole path, unassisted', async () => {
    const own = await electron.launch({ args: ['e2e/bootstrap.mjs'], timeout: LAUNCH_TIMEOUT_MS });
    let profile = '';
    try {
      const studio = await until(
        'the Studio window',
        async () => own.windows().find((w) => w.url().endsWith('index.html')) ?? null,
        LAUNCH_TIMEOUT_MS,
      );
      await studio.waitForLoadState('domcontentloaded');
      profile = await own.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));

      await studio.evaluate(async (configuration) => {
        const bridge = window.desktop;
        if (bridge === undefined) throw new Error('no desktop bridge');
        await bridge.session.start({ presetId: 'focus', configuration, plannedSeconds: 2 });
      }, TEST_CONFIGURATION);

      const record = await until('the completed session to reach the file', async () => {
        const raw = await readFile(join(profile, 'history.json'), 'utf8').catch(() => null);
        if (raw === null) return null;
        const parsed = JSON.parse(raw) as {
          records: { integrityStatus: string; integrityCoverage: string[] }[];
        };
        return parsed.records[0] ?? null;
      });

      // `engine` alone: the startup self-test, having crossed the effect that
      // reports it, the executor channel, the coordinator's queue and
      // `completeSession`. **Not `graph`** — the channel count that used to
      // cover it was demoted to a fact once it turned out to read 2 whatever
      // the device does, so nothing measures our own output until the capture
      // checks are driven.
      assert.deepEqual(record.integrityCoverage, ['engine']);
      assert.notEqual(record.integrityStatus, 'unknown');
    } finally {
      await own.close().catch(() => undefined);
      if (profile !== '') await rm(profile, { recursive: true, force: true });
    }
  });
});

describe('losing the renderer', () => {
  it('finalizes a running session as interrupted', async () => {
    const before = (await history(page)).length;

    await page.evaluate(async () => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      await bridge.session.start({ presetId: 'focus', configuration: {}, plannedSeconds: 600 });
    });

    // Reloading destroys the audio graph. Main must notice and finalize rather
    // than leave a session counting against a renderer that no longer exists.
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    const records = await until('the interrupted session to be written', async () => {
      const rows = await history(page);
      return rows.length > before ? rows : null;
    });

    const latest = records[records.length - 1];
    assert.equal(latest.completionReason, 'interrupted');
    assert.ok(latest.actualSeconds < 600, 'should record what was heard, not the planned length');
  });
});

describe('closing a dialog', () => {
  /**
   * Both ways out have to land in the same place.
   *
   * Escape goes through the element's own `cancel` → `close` lifecycle, so the
   * browser restores focus for free. The visible Close button did not: it
   * called the parent handler directly, which unmounted the `<dialog>` before
   * any of that ran, and focus fell to `<body>`. A keyboard user lost their
   * position on every pointer-equivalent close — and the two paths disagreeing
   * is exactly the kind of thing a click-driven test never notices.
   *
   * Asserted against the *specific* invoker rather than "something is focused",
   * because returning focus to the wrong control is its own defect.
   */
  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (el === null) return 'null';
      if (el === document.body) return 'BODY';
      return (el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().slice(0, 24);
    });

  const dialogCount = () => page.locator('dialog').count();

  /*
   * The expected invoker is named, not inferred from "whatever had focus".
   *
   * These tests share one page, so the previously focused control is whatever
   * the last test left behind — reading it as the baseline made this assert
   * that the integrity row should restore focus to the Settings button. The
   * integrity row's accessible name also carries the live coverage headline,
   * which changes as checks land, so it is matched by prefix.
   */
  const SURFACES = [
    {
      name: 'Settings',
      open: () => page.getByRole('button', { name: 'Settings', exact: true }).click(),
      invoker: /^Settings$/,
    },
    {
      name: 'integrity',
      open: () => page.locator('.integrity').click(),
      invoker: /^Signal integrity/,
    },
  ] as const;

  for (const surface of SURFACES) {
    it(`returns focus to the ${surface.name} control after the Close button`, async () => {
      // Twice, because a stale invoker only shows up on the second cycle.
      for (let cycle = 0; cycle < 2; cycle++) {
        await surface.open();
        await until('the dialog to open', async () => ((await dialogCount()) > 0 ? true : null));

        await page.locator('dialog button[aria-label="Close"]').click();
        await until('the dialog to unmount', async () =>
          (await dialogCount()) === 0 ? true : null,
        );

        const after = await focused();
        assert.notEqual(after, 'BODY', `cycle ${cycle}: focus fell to the document body`);
        assert.match(after, surface.invoker, `cycle ${cycle}: focus went somewhere else`);
      }
    });

    it(`returns focus to the ${surface.name} control after Escape`, async () => {
      await surface.open();
      await until('the dialog to open', async () => ((await dialogCount()) > 0 ? true : null));

      await page.keyboard.press('Escape');
      await until('the dialog to unmount', async () => ((await dialogCount()) === 0 ? true : null));

      const after = await focused();
      assert.notEqual(after, 'BODY', 'focus fell to the document body');
      assert.match(after, surface.invoker, 'focus went somewhere else');
    });
  }
});

describe('appearance, and what it is not allowed to touch', () => {
  /**
   * The tray reads the *system* theme, not the app's.
   *
   * `tray.ts` picks its icon ink from `nativeTheme.shouldUseDarkColors` — on
   * Linux because there is no system/app split to read, and on Windows when the
   * registry cannot be. That global is writable through `nativeTheme.themeSource`,
   * so an app that assigned its own appearance there would be telling the tray
   * the desktop had changed. On a dark desktop with the app set to Light, the
   * tray would then draw dark ink onto a dark panel.
   *
   * Asserted at the boundary rather than by reading `tray.ts`: what matters is
   * that the signal the tray consumes still describes the OS after the user has
   * chosen a theme.
   */
  it('does not move the system theme signal the tray depends on', async () => {
    const before = await app.evaluate(({ nativeTheme }) => ({
      source: nativeTheme.themeSource,
      dark: nativeTheme.shouldUseDarkColors,
    }));

    for (const appearance of ['light', 'dark', 'system'] as const) {
      await page.evaluate(async (next) => {
        const bridge = window.desktop;
        if (bridge === undefined) throw new Error('no desktop bridge');
        const current = await new Promise<Settings>((resolve) => {
          void bridge.settings.subscribe(() => {}).then(resolve);
        });
        await bridge.settings.save({ ...current, appearance: next });
      }, appearance);

      const after = await app.evaluate(({ nativeTheme }) => ({
        source: nativeTheme.themeSource,
        dark: nativeTheme.shouldUseDarkColors,
      }));
      assert.equal(
        after.source,
        before.source,
        `saving appearance ${appearance} must not write nativeTheme.themeSource`,
      );
      assert.equal(
        after.dark,
        before.dark,
        `saving appearance ${appearance} must not move nativeTheme.shouldUseDarkColors`,
      );
    }
  });

  /**
   * The renderer is told the theme; it does not work it out.
   *
   * Both windows resolve the same answer from the same publication, and the
   * popover has no settings UI of its own — so this also covers a change in
   * Studio reaching the away-from-window surface.
   */
  it('publishes one effective theme to every window', async () => {
    for (const [appearance, expected] of [
      ['light', 'light'],
      ['dark', 'dark'],
    ] as const) {
      await page.evaluate(async (next) => {
        const bridge = window.desktop;
        if (bridge === undefined) throw new Error('no desktop bridge');
        const current = await new Promise<Settings>((resolve) => {
          void bridge.settings.subscribe(() => {}).then(resolve);
        });
        await bridge.settings.save({ ...current, appearance: next });
      }, appearance);

      const inStudio = await until(`Studio to show ${expected}`, async () => {
        const theme = await page.evaluate(() => document.documentElement.dataset.theme);
        return theme === expected ? theme : null;
      });
      const inPopover = await until(`the popover to show ${expected}`, async () => {
        const theme = await popover.evaluate(() => document.documentElement.dataset.theme);
        return theme === expected ? theme : null;
      });
      assert.equal(inStudio, expected);
      assert.equal(inPopover, expected);
    }
  });

  /**
   * `system` is a following state, and following is what makes it different
   * from a third palette. The OS reading belongs to main, so main is asked what
   * the answer should be and the renderer is required to already agree.
   */
  it('resolves system to what the operating system actually reports', async () => {
    await page.evaluate(async () => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      const current = await new Promise<Settings>((resolve) => {
        void bridge.settings.subscribe(() => {}).then(resolve);
      });
      await bridge.settings.save({ ...current, appearance: 'system' });
    });

    const osDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
    const expected = osDark ? 'dark' : 'light';
    const resolved = await until(`Studio to follow the system (${expected})`, async () => {
      const theme = await page.evaluate(() => document.documentElement.dataset.theme);
      return theme === expected ? theme : null;
    });
    assert.equal(resolved, expected);
  });
});

describe('the notch chain, measured on the real BiquadFilterNode', () => {
  /**
   * Gate A's other half.
   *
   * `dsp/biquad.ts` computes the bound that keeps the output ceiling true, and
   * everything in the Node suite tests it against *itself* — a model of
   * Chromium's `BiquadFilterNode` written from the Web Audio specification's
   * peaking formulae. That the model matches the node is an assumption until
   * something measures the node, and this is that measurement.
   *
   * Run in an `OfflineAudioContext` so it is deterministic and faster than
   * real time; the filters are the same implementation either way.
   */

  /**
   * The admitted rates, not one convenient one.
   *
   * `sampleRate` enters the cookbook formulae directly through w0, and it sets
   * how long the impulse response runs — so agreement at 48 kHz says nothing
   * about 22.05 or 96. The graph asks for 48 kHz and takes whatever the OS
   * gives, which reaches all of these.
   */
  const RATES = [22050, 32000, 48000, 96000];
  const RATE = 48000;

  /**
   * Drive the shipped notch worklet offline and report the output peak.
   *
   * `from` seeds it; `to`, when given, is handed over to at the midpoint with
   * the crossfade the graph would use.
   */
  async function notchPeak(
    from: number[],
    to: number[] | null,
    crossfadeSeconds: number,
    rate: number,
  ): Promise<number> {
    return page.evaluate(
      async ({ from: a, to: b, crossfade, rate }) => {
        const frames = Math.floor(rate * 1.2);
        const context = new OfflineAudioContext(1, frames, rate);
        await context.audioWorklet.addModule(
          new URL('worklets/notch-processor.js', document.baseURI).href,
        );

        const buffer = context.createBuffer(1, frames, rate);
        const data = buffer.getChannelData(0);
        let seed = 5;
        for (let i = 0; i < frames; i++) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          data[i] = seed / 0x3fffffff - 1;
        }
        let m = 0;
        for (let i = 0; i < frames; i++) m = Math.max(m, Math.abs(data[i]));
        for (let i = 0; i < frames; i++) data[i] /= m;

        const source = context.createBufferSource();
        source.buffer = buffer;
        const node = new AudioWorkletNode(context, 'notch-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: 'explicit',
          processorOptions: {
            carrierHz: a[0],
            modulationHz: 40,
            q: a[1],
            depthDb: a[2],
            channels: 1,
          },
        });
        source.connect(node).connect(context.destination);

        if (b) {
          const at = Math.floor(frames / 2);
          // Posted during a suspension: an offline context renders faster than
          // a port message can arrive.
          void context.suspend(128 / rate).then(() => {
            node.port.postMessage({
              type: 'notch',
              carrierHz: b[0],
              modulationHz: 40,
              q: b[1],
              depthDb: b[2],
              atFrame: at,
              crossfadeFrames: Math.round(crossfade * rate),
              revision: 1,
            });
            return context.resume();
          });
        }

        source.start();
        const rendered = await context.startRendering();
        const out = rendered.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < out.length; i++) {
          const v = Math.abs(out[i]);
          if (Number.isFinite(v) && v > peak) peak = v;
        }
        return peak;
      },
      { from, to, crossfade: crossfadeSeconds, rate },
    );
  }

  it('keeps the shipped cascade inside the bound it is given', async () => {
    // The bound is no longer computed from a *model* of what runs. The notch
    // cascade lives in a worklet that takes its coefficients from the same
    // `dsp/biquad.ts` the bound is derived from, so this asserts the
    // implementation against its own bound rather than establishing that two
    // separate implementations agree.
    // Carrier, Q and depth across the admitted space; modulation is fixed at
    // 40 Hz below, so the sideband spacing is the default one rather than a
    // swept parameter. That is narrower than the whole admitted space, and
    // saying so here is the point: the sweep this asserts over is carrier,
    // resonance, depth and sample rate.
    const cases = [
      [220, 8, 6],
      [220, 6, 9],
      [80, 20, 18],
      [1000, 1, 24],
      [440, 1, 18],
    ];
    // Every admitted rate, not one convenient one. Sample rate enters the
    // cookbook formulae through w0 and sets the response length, so a worklet
    // that hardcoded 48 kHz would satisfy a single-rate sweep completely.
    for (const rate of RATES) {
      for (const c of cases) {
        const peak = await notchPeak(c, null, 0.02, rate);
        const bound = peakGainBound(notchChain(c[0], 40, c[1], c[2], rate)).bound;
        assert.ok(
          peak <= bound,
          `${rate} Hz ${c.join('/')}: the shipped cascade peaked at ${peak.toFixed(4)}, over its bound ${bound.toFixed(4)}`,
        );
      }
    }
  });

  it('bounds a live handover, swept, against the bound the graph computes', async () => {
    // Gate A's live half. Retuning a cascade that carries signal has no bound,
    // so the worklet builds a second one with zero state and crossfades; this
    // asserts the consequence across the space, against `transitionPeakBound`
    // — the value the shipped code actually guards with — rather than against
    // anything derived from this measurement.
    const PAIRS: { a: number[]; b: number[] }[] = [];
    for (const fcA of [80, 1000]) {
      for (const qA of [1, 20]) {
        for (const dA of [0, 18]) {
          for (const fcB of [80, 440]) {
            for (const qB of [1, 20]) {
              for (const dB of [0, 18]) {
                PAIRS.push({ a: [fcA, qA, dA], b: [fcB, qB, dB] });
              }
            }
          }
        }
      }
    }

    const soundscape = (q: number, depth: number) => ({
      ...DEFAULT_SOUNDSCAPE,
      gain: 1,
      notchQ: q,
      notchDepthDb: depth,
    });
    const params = (carrier: number) => ({
      ...DEFAULT_PARAMS,
      carrierHz: carrier,
      modulationHz: 40,
      amGain: 0,
      twoToneGain: 0,
      twoToneMode: 'off' as const,
    });

    let worst = 0;
    let worstLabel = '';
    let anyOverUnity = false;
    for (const rate of RATES) {
      for (const pair of PAIRS) {
        const crossfade = notchSettleSeconds(pair.b[0], 40, pair.b[1], pair.b[2], rate);
        const peak = await notchPeak(pair.a, pair.b, crossfade, rate);
        if (peak > 1) anyOverUnity = true;
        const bound = transitionPeakBound(
          [
            { params: params(pair.a[0]), soundscape: soundscape(pair.a[1], pair.a[2]) },
            { params: params(pair.b[0]), soundscape: soundscape(pair.b[1], pair.b[2]) },
          ],
          rate,
        );
        const ratio = peak / bound;
        if (ratio > worst) {
          worst = ratio;
          worstLabel = `${rate} Hz ${pair.a.join('/')} -> ${pair.b.join('/')} peak=${peak.toFixed(4)} bound=${bound.toFixed(4)}`;
        }
      }
    }

    assert.ok(worst <= 1, `a handover exceeded the bound by ${worst.toFixed(2)}x: ${worstLabel}`);
    // The control: these transitions really do produce substantial output.
    assert.ok(anyOverUnity, 'no handover exceeded unity, so this proves nothing');
  });

  it('holds the ceiling across a live notch change, and would not without the ordering', async () => {
    // The transition, on the real node, with its own control built in.
    //
    // Coefficients used to move at once while the master ramped over 50 ms, so
    // a change that raised the bound left the old, higher gain in force for
    // the whole ramp. Both orders are rendered here from the same material and
    // the same master level, so the comparison is between the orderings and
    // nothing else.
    //
    // The master level is *derived from a measurement* rather than picked. A
    // hand-chosen figure passed the guarded assertion for the wrong reason
    // once already — the chain simply never got loud enough — so the level is
    // computed from the deep chain's own measured gain, and the unguarded
    // render has to break the ceiling or this proves nothing.
    const result = await page.evaluate(
      async ({ rate, ceiling }) => {
        const frames = rate * 2;

        function material(context: OfflineAudioContext): AudioBuffer {
          const buffer = context.createBuffer(1, frames, rate);
          const data = buffer.getChannelData(0);
          let seed = 999;
          for (let i = 0; i < frames; i++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            data[i] = seed / 0x3fffffff - 1;
          }
          let m = 0;
          for (let i = 0; i < frames; i++) m = Math.max(m, Math.abs(data[i]));
          for (let i = 0; i < frames; i++) data[i] /= m;
          return buffer;
        }

        function peakOf(rendered: AudioBuffer): number {
          const out = rendered.getChannelData(0);
          let peak = 0;
          for (let i = 0; i < out.length; i++) {
            const v = Math.abs(out[i]);
            if (Number.isFinite(v) && v > peak) peak = v;
          }
          return peak;
        }

        // A wide, deep cut rings far harder than a narrow one, which is why an
        // earlier attempt at this test with Q 20 could not reach the ceiling.
        const SHALLOW = { freqs: [180, 220, 260], q: 1, gain: -3 };
        const DEEP = { freqs: [400, 440, 480], q: 1, gain: -18 };

        /** Peak gain of a fixed chain at unity master, measured. */
        async function gainOf(spec: typeof SHALLOW): Promise<number> {
          const context = new OfflineAudioContext(1, frames, rate);
          const source = context.createBufferSource();
          source.buffer = material(context);
          let node: AudioNode = source;
          for (let i = 0; i < 3; i++) {
            const f = context.createBiquadFilter();
            f.type = 'peaking';
            f.frequency.value = spec.freqs[i];
            f.Q.value = spec.q;
            f.gain.value = spec.gain;
            node = node.connect(f);
          }
          node.connect(context.destination);
          source.start();
          return peakOf(await context.startRendering());
        }

        const shallowGain = await gainOf(SHALLOW);
        const deepGain = await gainOf(DEEP);

        // The highest master the shallow chain may legally run at. The deep
        // chain at this same level is what the ceiling has to be protected
        // from during the change.
        // The two fixed-chain measurements and the transition render each
        // round through Float32 filter state independently. Keep eight
        // Float32 epsilons of representational headroom so this test isolates
        // the scheduling order while the hard ceiling assertion stays strict.
        const targetPeak = ceiling - 8 * 2 ** -23;
        const master = targetPeak / shallowGain;
        const safeAfter = targetPeak / deepGain;

        async function render(guarded: boolean): Promise<number> {
          const context = new OfflineAudioContext(1, frames, rate);
          const source = context.createBufferSource();
          source.buffer = material(context);
          const filters = [0, 1, 2].map(() => {
            const f = context.createBiquadFilter();
            f.type = 'peaking';
            return f;
          });
          const gain = context.createGain();
          let node: AudioNode = source;
          for (const f of filters) node = node.connect(f);
          node.connect(gain).connect(context.destination);

          filters.forEach((f, i) => {
            f.frequency.setValueAtTime(SHALLOW.freqs[i], 0);
            f.Q.setValueAtTime(SHALLOW.q, 0);
            f.gain.setValueAtTime(SHALLOW.gain, 0);
          });
          gain.gain.setValueAtTime(master, 0);

          const changeAt = 1.0;
          // Guarded: the gain reaches its new level first and the coefficients
          // land at the end of that ramp. Unguarded: coefficients now, gain
          // catching up over the old 50 ms headroom ramp.
          const landAt = guarded ? changeAt + 0.008 : changeAt;
          gain.gain.setValueAtTime(master, changeAt);
          if (guarded) {
            gain.gain.linearRampToValueAtTime(safeAfter, changeAt + 0.008);
          } else {
            gain.gain.linearRampToValueAtTime(safeAfter, changeAt + 0.05);
          }
          filters.forEach((f, i) => {
            f.frequency.setValueAtTime(DEEP.freqs[i], landAt);
            f.Q.setValueAtTime(DEEP.q, landAt);
            f.gain.setValueAtTime(DEEP.gain, landAt);
          });

          source.start();
          return peakOf(await context.startRendering());
        }

        return {
          shallowGain,
          deepGain,
          master,
          safeAfter,
          guardedPeak: await render(true),
          unguardedPeak: await render(false),
        };
      },
      { rate: RATE, ceiling: MAX_MASTER_LEVEL },
    );

    // The control first: without the ordering the ceiling really is exceeded.
    // If this ever stops being true the assertion below means nothing.
    assert.ok(
      result.unguardedPeak > MAX_MASTER_LEVEL,
      `the unguarded order peaked at only ${result.unguardedPeak.toPrecision(9)} ` +
        `(shallow gain ${result.shallowGain.toFixed(3)}, deep ${result.deepGain.toFixed(3)}, ` +
        `master ${result.master.toFixed(3)}), so the guarded assertion proves nothing`,
    );

    // And with it, the ceiling holds through the whole transition.
    assert.ok(
      result.guardedPeak <= MAX_MASTER_LEVEL,
      `guarded peak ${result.guardedPeak.toPrecision(9)} exceeds the ceiling ` +
        `${MAX_MASTER_LEVEL} by ${(result.guardedPeak - MAX_MASTER_LEVEL).toExponential(3)}`,
    );
  });

  it('snaps its gains at settlement, not merely reporting that it did', async () => {
    // The graph releases its attenuation on the strength of settlement meaning
    // the gains are *exactly* at their targets — `BOUND_MARGIN` covers the
    // notch chain's bed term and nothing else, so a residual on `amGain` is
    // covered by nothing. A worklet that posted `settled` while still
    // asymptotically approaching would satisfy every message-shaped assertion,
    // so this measures the audio instead: a target of zero has to become
    // exactly silent.
    const result = await page.evaluate(async (rate) => {
      const url = new URL('worklets/entrainment-processor.js', document.baseURI).href;
      const frames = Math.floor(rate * 1.5);
      const QUANTUM = 128;
      const context = new OfflineAudioContext(2, frames, rate);
      await context.audioWorklet.addModule(url);

      const node = new AudioWorkletNode(context, 'entrainment-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        // Audible to begin with, and smoothing left at its default so the
        // approach is real and the snap has something to remove.
        processorOptions: { params: { amGain: 0.5, depth: 1, duty: 1, edge: 1 } },
      });
      node.connect(context.destination);

      let settledAt = -1;
      node.port.onmessage = (event: MessageEvent<{ type?: string }>) => {
        if (event.data?.type === 'settled') settledAt = context.currentTime;
      };

      const changeAt = QUANTUM;
      void context.suspend(changeAt / rate).then(() => {
        node.port.postMessage({
          type: 'params',
          params: { amGain: 0 },
          applyAtFrame: changeAt,
          revision: 1,
        });
        return context.resume();
      });

      const rendered = await context.startRendering();
      const data = rendered.getChannelData(0);

      let lastNonZero = -1;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 0) lastNonZero = i;
      }
      // Was it still moving shortly before the snap? If the smoother had
      // already reached zero on its own, silence afterwards would prove
      // nothing about snapping.
      const probe = Math.floor(changeAt + 0.15 * rate);
      let movingBefore = 0;
      for (let i = probe; i < probe + 2000 && i < data.length; i++) {
        movingBefore = Math.max(movingBefore, Math.abs(data[i]));
      }
      return { lastNonZero, movingBefore, settledAt, frames, rate };
    }, RATE);

    // The control: the one-pole really had not arrived by itself.
    assert.ok(
      result.movingBefore > 0,
      'the source was already exactly silent before the snap, so this proves nothing',
    );

    // Exactly silent afterwards — not small, zero.
    const settleFrame = 128 + Math.ceil(0.21 * result.rate);
    assert.ok(
      result.lastNonZero >= 0 && result.lastNonZero < settleFrame + 2 * 128,
      `output was still non-zero at frame ${result.lastNonZero}, past the settlement at ${settleFrame}`,
    );
    assert.ok(result.settledAt > 0, 'no settlement was reported at all');
  });

  it('adopts scheduled parameters at the frame it was given, in the shipped worklet', async () => {
    // The behavioural gap. Everything else about `applyAtFrame` is asserted
    // against a fake that records the message — so a processor that applied
    // the change immediately, or never drained its queue, or replayed a
    // superseded entry last, would pass every one of those tests.
    //
    // This drives the shipped `entrainment-processor.js`, addressed the way
    // the app addresses it, and listens to the audio it makes.
    const result = await page.evaluate(async (rate) => {
      const url = new URL('worklets/entrainment-processor.js', document.baseURI).href;
      const frames = Math.floor(rate * 0.5);
      const QUANTUM = 128;

      const acks: number[] = [];
      const settlements: number[] = [];

      /** Render the worklet, applying `messages`, and report where sound starts. */
      async function onsetFrame(messages: Record<string, unknown>[]): Promise<number> {
        const context = new OfflineAudioContext(2, frames, rate);
        await context.audioWorklet.addModule(url);
        const node = new AudioWorkletNode(context, 'entrainment-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          // Silent to begin with, and no gain smoothing, so the onset is a
          // frame rather than a slope that has to be thresholded.
          processorOptions: {
            params: { amGain: 0, twoToneGain: 0, depth: 1, duty: 1, edge: 1 },
            smoothingSeconds: 0,
          },
        });
        node.connect(context.destination);
        node.port.onmessage = (event: MessageEvent<{ type?: string; revision?: number }>) => {
          if (typeof event.data?.revision !== 'number') return;
          if (event.data.type === 'applied') acks.push(event.data.revision);
          if (event.data.type === 'settled') settlements.push(event.data.revision);
        };

        // Each message gets its own suspension, one quantum apart.
        //
        // An OfflineAudioContext renders faster than a port message can be
        // delivered — the entrainment worklet's own header says so, which is
        // why it is seeded through processorOptions — so messages posted
        // before `startRendering` can miss the render entirely. Suspending
        // gives delivery a real event-loop turn at a known frame, and one
        // suspension each guarantees they are processed in order rather than
        // racing inside a single turn. It is also what actually happens: two
        // changes a couple of milliseconds apart.
        messages.forEach((message, index) => {
          void context.suspend((QUANTUM * (index + 1)) / rate).then(() => {
            node.port.postMessage(message);
            return context.resume();
          });
        });

        const rendered = await context.startRendering();
        const data = rendered.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
          if (Number.isFinite(data[i]) && Math.abs(data[i]) > 0.02) return i;
        }
        return -1;
      }

      const quarter = Math.floor(frames / 4);
      const half = Math.floor(frames / 2);

      return {
        rate,
        frames,
        quarter,
        half,
        // Scheduled: silence until the named frame, then sound.
        scheduled: await onsetFrame([
          { type: 'params', params: { amGain: 0.5 }, applyAtFrame: half, revision: 1 },
        ]),
        // Unscheduled: sound from the start.
        immediate: await onsetFrame([{ type: 'params', params: { amGain: 0.5 }, revision: 1 }]),
        // A newer revision applying immediately must discard the older
        // scheduled one, so the bed stays silent for the whole render.
        supersededByImmediate: await onsetFrame([
          { type: 'params', params: { amGain: 0.5 }, applyAtFrame: half, revision: 1 },
          { type: 'params', params: { amGain: 0 }, revision: 2 },
        ]),
        // And a newer revision scheduled *earlier* must win over an older one
        // scheduled later — the reversal an ordered queue would get wrong.
        newerEarlierWins: await onsetFrame([
          { type: 'params', params: { amGain: 0 }, applyAtFrame: half, revision: 1 },
          { type: 'params', params: { amGain: 0.5 }, applyAtFrame: quarter, revision: 2 },
        ]),
        // An out-of-order arrival at an older revision is ignored outright.
        olderRevisionIgnored: await onsetFrame([
          { type: 'params', params: { amGain: 0 }, revision: 5 },
          { type: 'params', params: { amGain: 0.5 }, revision: 4 },
        ]),
        // Acknowledgements, which are what let the graph stop guarding. A
        // scheduled change and an immediate one must both report back; a
        // superseded one must not.
        ackedScheduled: await (async () => {
          acks.length = 0;
          await onsetFrame([
            { type: 'params', params: { amGain: 0.5 }, applyAtFrame: half, revision: 11 },
          ]);
          return [...acks];
        })(),
        // Settlement is a separate, later event, and the gains are exact by
        // the time it is reported. The graph restores the master on it, so a
        // worklet that only ever adopts leaves the attenuation on forever.
        settledScheduled: await (async () => {
          acks.length = 0;
          settlements.length = 0;
          await onsetFrame([
            { type: 'params', params: { amGain: 0.5 }, applyAtFrame: quarter, revision: 31 },
          ]);
          return { acks: [...acks], settlements: [...settlements] };
        })(),
        ackedSuperseded: await (async () => {
          acks.length = 0;
          await onsetFrame([
            { type: 'params', params: { amGain: 0.5 }, applyAtFrame: half, revision: 21 },
            { type: 'params', params: { amGain: 0 }, revision: 22 },
          ]);
          return [...acks];
        })(),
      };
    }, RATE);

    const quantum = 128;

    // The control: unscheduled parameters really do sound as soon as they
    // arrive, so a scheduled onset later in the render is the scheduling and
    // not silence for some unrelated reason.
    assert.ok(
      result.immediate >= 0 && result.immediate < quantum * 8,
      `unscheduled params should sound as soon as they arrive, started at ${result.immediate}`,
    );

    // Scheduled: at the named frame, never before it, and within a quantum of
    // it — the processor rounds late by design, which is the safe direction.
    assert.ok(
      result.scheduled >= result.half,
      `sounded at ${result.scheduled}, before ${result.half}`,
    );
    assert.ok(
      result.scheduled - result.half <= quantum,
      `sounded at ${result.scheduled}, more than a quantum after ${result.half}`,
    );

    // Superseded by a newer immediate message: silent throughout.
    assert.equal(
      result.supersededByImmediate,
      -1,
      'a superseded scheduled change still landed and made sound',
    );

    // Newer revision scheduled earlier wins, and lands at its own frame.
    assert.ok(
      result.newerEarlierWins >= result.quarter &&
        result.newerEarlierWins - result.quarter <= quantum,
      `newer-but-earlier change landed at ${result.newerEarlierWins}, not near ${result.quarter}`,
    );

    // An older revision arriving late changes nothing.
    assert.equal(result.olderRevisionIgnored, -1, 'an older revision was applied');

    // The acknowledgement is what the graph waits for before relaxing its
    // attenuation, so a worklet that adopts silently is a worklet the graph
    // keeps guarding against forever. Nothing in the Node suite can catch that
    // — its worklet is a fake and the acknowledgements are delivered by hand.
    assert.deepEqual(
      result.ackedScheduled,
      [11],
      'the scheduled change was adopted without reporting back',
    );
    // The superseded entry must not report: it was never applied.
    assert.deepEqual(
      result.ackedSuperseded,
      [22],
      'acknowledgements did not match the revision actually applied',
    );

    // Adoption and settlement are distinct, and both must arrive. The graph
    // promotes a configuration to audible only on the second, because the
    // gains are still between the old and new values after the first.
    assert.deepEqual(result.settledScheduled.acks, [31], 'the change was not adopted');
    assert.deepEqual(
      result.settledScheduled.settlements,
      [31],
      'the worklet adopted the change but never reported it settled',
    );
  });
});

/**
 * Preset identity, and the Modified state derived from it.
 *
 * Driven through the picker and the recipe controls rather than the store,
 * because the thing under test is the relationship between what is selected and
 * what is playing — and only the UI can get those out of step. The store is
 * read afterwards to confirm a write actually landed, which is the stage's own
 * stop condition: no apparent success without durable confirmation.
 */
describe('presets and the Modified state', () => {
  const FOCUS = 'focus';
  const MASKED = 'masked';

  /**
   * Wait for focus to arrive, rather than sleeping and hoping.
   *
   * Focus lands after a Svelte flush and a `focus()` call, and a fixed pause
   * before asserting is a race that only ever shows up under load — which is
   * where an assertion should be most trustworthy, not least. Returns the
   * description of whatever finally holds it.
   */
  async function focusSettles(): Promise<{
    tag: string;
    label: string | null;
    text: string | null;
    disabled: boolean;
  }> {
    return until('focus to leave the body', async () => {
      const at = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return {
          tag: el?.tagName ?? 'null',
          label: el?.getAttribute('aria-label') ?? null,
          text: el?.textContent?.trim() ?? null,
          disabled: el instanceof HTMLButtonElement ? el.disabled : false,
        };
      });
      return at.tag === 'BODY' || at.tag === 'null' ? null : at;
    });
  }

  /** Is the Modified badge on screen? */
  const modified = (): Promise<boolean> =>
    page
      .locator('.modified')
      .isVisible()
      .catch(() => false);

  /** Every recipe control's value, as the user would read them back. */
  const recipe = (): Promise<string[]> =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLInputElement>('.recipe input')).map((i) => i.value),
    );

  /** Move a slider the way a drag does, through the control. */
  /**
   * Back to a known preset, and actually applied.
   *
   * Selecting the option that is already selected fires no `change`, so the
   * recipe is never reapplied and the preset stays modified — which is how a
   * later test came to fail its very first assertion after an earlier one left
   * the fallback selected with a different recipe playing. Stepping through
   * another preset guarantees the change event, and therefore the application.
   */
  async function select(id: string): Promise<void> {
    /*
     * `exact`, because the confirmation dialog is named "Delete preset".
     *
     * Giving that dialog a programmatic name — which it needed — made
     * `getByLabel('Preset')` match it as well as the picker, and the helper
     * started failing on a substring rather than on anything the product did.
     * An accessibility fix can break a selector; a selector that matches by
     * accident is the thing to fix.
     */
    const picker = page.getByLabel('Preset', { exact: true });
    if ((await picker.inputValue()) === id) {
      await picker.selectOption(id === MASKED ? FOCUS : MASKED);
      await page.waitForTimeout(150);
    }
    await picker.selectOption(id);
    await page.waitForTimeout(150);
  }

  /** Save the current recipe under a name, and answer its id. */
  async function makeUserPreset(name: string): Promise<string> {
    await page.getByRole('button', { name: 'Save as…' }).click();
    await page.getByLabel('Preset name').fill(name);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await until(`${name} to be stored`, async () =>
      (await saved()).some((p) => p.name === name) ? true : null,
    );
    return page.getByLabel('Preset', { exact: true }).inputValue();
  }

  const saved = (): Promise<{ id: string; name: string; carrierHz: number }[]> =>
    page.evaluate(async () => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      const list = await bridge.presets.list();
      return list.map((p) => ({ id: p.id, name: p.name, carrierHz: p.params.carrierHz }));
    });

  it('opens on a built-in that is not modified', async () => {
    await select(FOCUS);
    assert.equal(await modified(), false, 'a freshly applied preset must not read as modified');
  });

  it('marks Modified for a change in any layer, and clears when it returns exactly', async () => {
    // One field per layer, because a comparison that missed a whole section
    // would still pass a test that only ever moved the carrier.
    for (const [label, changed, original] of [
      ['Carrier', 300, 220],
      ['Duty', 0.8, 0.5],
      ['Notch depth', 12, 6],
    ] as const) {
      await select(FOCUS);
      assert.equal(await modified(), false, `${label}: not modified to begin with`);
      await setRange(label, changed);
      assert.equal(await modified(), true, `${label}: a change must read as modified`);
      await setRange(label, original);
      assert.equal(await modified(), false, `${label}: returning the value must clear it`);
    }
  });

  it('marks Modified when Master moves, which a preset also stores', async () => {
    await select(FOCUS);
    await page.evaluate(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      const input = document.querySelector<HTMLInputElement>('#master');
      if (!input) throw new Error('no master slider');
      setter?.call(input, '0.4');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(150);
    assert.equal(await modified(), true, 'master is part of what a preset restores');
    await select(FOCUS);
    assert.equal(await modified(), false, 'reselecting the preset restores master with it');
  });

  it('clears when another preset is selected', async () => {
    await select(FOCUS);
    await setRange('Carrier', 400);
    assert.equal(await modified(), true);
    await select(MASKED);
    assert.equal(await modified(), false, 'the new preset is what is playing');
    await select(FOCUS);
  });

  it('keeps Modified across Studio and History navigation', async () => {
    // Studio stays mounted while History shows, so this proves the state is
    // derived from the engine rather than held in something that unmounts.
    await select(FOCUS);
    await setRange('Carrier', 500);
    assert.equal(await modified(), true);
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: 'Studio', exact: true }).click();
    await page.waitForTimeout(200);
    assert.equal(await modified(), true, 'navigating away must not forget the edit');
    await select(FOCUS);
  });

  it('saves a copy from a built-in, and leaves the built-in alone', async () => {
    await select(FOCUS);
    await setRange('Carrier', 333);
    await page.getByRole('button', { name: 'Save as…' }).click();
    const name = page.getByLabel('Preset name');
    assert.equal(
      await name.inputValue(),
      'Balanced pulse (edited)',
      'the copy is seeded from the preset it came from',
    );
    await name.fill('Smoke Copy');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await until('the copy to be stored', async () =>
      (await saved()).some((p) => p.name === 'Smoke Copy') ? true : null,
    );

    const stored = (await saved()).find((p) => p.name === 'Smoke Copy');
    assert.ok(stored, 'the store must actually hold it');
    assertSameCarrier(stored.carrierHz, 333, 'it holds the recipe that was on screen');
    assert.equal(await modified(), false, 'what is playing is now exactly the saved preset');

    // The built-in it came from is untouched.
    await select(FOCUS);
    assertSameCarrier(await carrierHz(), 220, 'saving a copy must not write to the built-in');
  });

  it('updates a user preset in place, keeping its identity', async () => {
    const before = (await saved()).find((p) => p.name === 'Smoke Copy');
    assert.ok(before);
    await select(before.id);
    assert.equal(await modified(), false);

    await setRange('Carrier', 444);
    assert.equal(await modified(), true);
    // The label is "Save", not "Save as…", because a user preset is selected.
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await until('the update to land', async () =>
      (await saved()).some(
        (p) =>
          p.id === before.id &&
          Math.abs(carrierTrackFromHz(p.carrierHz) - carrierTrackFromHz(444)) <= 1,
      )
        ? true
        : null,
    );

    const after = (await saved()).filter((p) => p.name === 'Smoke Copy');
    assert.equal(after.length, 1, 'updating must not leave a duplicate behind');
    assert.equal(after[0].id, before.id, 'the preset keeps its identity');
    assert.equal(await modified(), false, 'saving clears Modified');

    /*
     * The same hazard as the copy path, on the other branch.
     *
     * Updating in place never opens the naming flow, so focus is still on the
     * Save button that was pressed — and that button is disabled the instant
     * the save succeeds, because the preset is now clean. A disabled control
     * drops the focus it holds.
     */
    const landed = await focusSettles();
    assert.notEqual(landed.tag, 'BODY', 'an in-place update must not drop the keyboard either');
    assert.ok(!landed.disabled, 'nor leave it on a control that has just been disabled');
  });

  it('names the preset in the delete confirmation, and cancelling changes nothing', async () => {
    const target = (await saved()).find((p) => p.name === 'Smoke Copy');
    assert.ok(target);
    await select(target.id);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();

    const dialog = page.locator('dialog[open]');
    assert.match(
      (await dialog.textContent()) ?? '',
      /Smoke Copy/,
      'the confirmation has to say which preset it means',
    );

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(150);
    assert.ok(
      (await saved()).some((p) => p.id === target.id),
      'cancelling must not delete anything',
    );
    assert.equal(
      await page.getByLabel('Preset', { exact: true }).inputValue(),
      target.id,
      'selection is unchanged',
    );
  });

  it('deletes on confirm and falls back without changing the sound again', async () => {
    const target = (await saved()).find((p) => p.name === 'Smoke Copy');
    assert.ok(target);
    await select(target.id);
    const before = await recipe();

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.locator('dialog[open]').getByRole('button', { name: 'Delete preset' }).click();
    await until('the preset to go', async () =>
      (await saved()).some((p) => p.id === target.id) ? null : true,
    );

    assert.equal(
      await page.getByLabel('Preset', { exact: true }).inputValue(),
      FOCUS,
      'selection falls back to a defined surviving preset',
    );
    assert.deepEqual(
      await recipe(),
      before,
      'the audible recipe must not change a second time when its preset is deleted',
    );
    assert.equal(
      await modified(),
      true,
      'and it reads as modified against the fallback, which is what it is',
    );
    await select(FOCUS);
  });

  /**
   * Focus, exercised by typing rather than by filling.
   *
   * `fill()` sets the value whether or not the field ever had the keyboard, so
   * the tests above would pass against a flow that renders the field and
   * leaves focus on `<body>` — which is exactly what it did. Typing is the
   * only way to tell the difference.
   */
  it('hands the keyboard to the name field, and gives it back on the way out', async () => {
    await select(FOCUS);
    await setRange('Carrier', 321);

    const saveAs = page.getByRole('button', { name: 'Save as…' });
    await saveAs.click();
    assert.equal(
      (await focusSettles()).label,
      'Preset name',
      'the field has to have the keyboard, not merely exist',
    );

    // The seeded name is selected, so typing replaces it rather than appending.
    await page.keyboard.type('Typed Through');
    assert.equal(await page.getByLabel('Preset name').inputValue(), 'Typed Through');

    // Escape is handled on the field, so it only works if the field has focus.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    assert.equal(
      await page.locator('input[aria-label="Preset name"]').count(),
      0,
      'Escape has to leave the naming flow',
    );
    assert.equal((await focusSettles()).text, 'Save as…', 'and focus returns to what opened it');
    await select(FOCUS);
  });

  it('leaves focus somewhere usable after a successful save', async () => {
    /*
     * The success path, which Cancel and Escape do not cover.
     *
     * Saving replaces the whole action group: the button that opened the flow
     * is unmounted, and its replacement is *disabled*, because the preset that
     * was just written is by definition clean. Focusing either one silently
     * fails and the keyboard ends up on `<body>` — with the save itself
     * perfectly durable, which is what made it easy to miss.
     */
    await select(FOCUS);
    await setRange('Carrier', 341);
    await page.getByRole('button', { name: 'Save as…' }).click();
    await page.waitForTimeout(300);
    await page.getByLabel('Preset name').fill('Focus After Save');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await until('the preset to be stored', async () =>
      (await saved()).some((p) => p.name === 'Focus After Save') ? true : null,
    );
    const landed = await focusSettles();
    assert.notEqual(landed.tag, 'BODY', 'a successful save must not drop the keyboard');
    assert.ok(!landed.disabled, 'and must not park focus on a disabled control');
    assert.equal(landed.label, 'Preset', 'the picker is the control the save just changed');

    // Tidy up, so the tests that follow see the profile they expect.
    const made = (await saved()).find((p) => p.name === 'Focus After Save');
    assert.ok(made);
    await page.evaluate(async (id) => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      await bridge.presets.remove(id);
    }, made.id);
    await select(FOCUS);
  });

  it('opens the same flow, focused, from the keyboard shortcut', async () => {
    await select(FOCUS);
    await setRange('Carrier', 322);
    // Away from any control: a focused button keeps the keystroke for itself,
    // which is `ownsKeystroke` working as designed rather than a missed
    // shortcut.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    assert.equal(
      (await focusSettles()).label,
      'Preset name',
      'the shortcut has to land the keyboard in the field too',
    );
    await page.keyboard.type('From The Shortcut');
    assert.equal(await page.getByLabel('Preset name').inputValue(), 'From The Shortcut');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(300);
    await select(FOCUS);
  });

  it('gives the confirmation a name a screen reader can read', async () => {
    const target = await makeUserPreset('Named Dialog');
    await select(target);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.waitForTimeout(300);
    assert.equal(
      await page.getByRole('dialog', { name: 'Delete preset' }).count(),
      1,
      'a visible heading is content; the dialog needs its own name',
    );
    await page.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(300);
    assert.equal(
      (await focusSettles()).text,
      'Delete',
      'cancelling returns focus to the button that opened it',
    );
  });

  it('reports a failed deletion inside the dialog, where it can be reached', async () => {
    // The store's own atomic-write file is made unwritable, so the failure is real.
    // A global banner would render behind the modal's backdrop: visible,
    // dimmed, and impossible to reach or dismiss.
    const target = (await saved()).find((p) => p.name === 'Named Dialog');
    assert.ok(target);
    await select(target.id);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.waitForTimeout(300);

    const unblock = await blockStoreWrite('presets.json');
    try {
      await page.locator('dialog[open]').getByRole('button', { name: 'Delete preset' }).click();
      await until('the failure to be reported', async () =>
        (await page.locator('dialog[open] [role=alert]').count()) > 0 ? true : null,
      );
      const state = await page.evaluate(() => {
        const dialog = document.querySelector('dialog[open]');
        const alert = dialog?.querySelector('[role=alert]') ?? null;
        const box = alert?.getBoundingClientRect();
        const hit =
          box === undefined
            ? null
            : document.elementFromPoint(
                Math.round(box.left + box.width / 2),
                Math.round(box.top + box.height / 2),
              );
        return {
          dialogOpen: dialog !== null,
          reachable: alert !== null && (hit === alert || alert.contains(hit)),
          focused: document.activeElement === alert,
          globalBanner: document.querySelector('.banner.error') !== null,
        };
      });
      assert.ok(state.dialogOpen, 'the dialog stays open so the failure can be answered');
      assert.ok(state.reachable, 'the message is not behind the backdrop');
      assert.ok(state.focused, 'focus moves to it, because the pressed button is disabled');
      assert.ok(!state.globalBanner, 'and it is not also reported somewhere unreachable');
      assert.ok(
        (await saved()).some((p) => p.id === target.id),
        'the preset is still stored, which is what the failure means',
      );
    } finally {
      await unblock();
    }

    // Recovery from inside the dialog, now that the store is writable again.
    await page.locator('dialog[open]').getByRole('button', { name: 'Delete preset' }).click();
    await until('the retry to succeed', async () =>
      (await saved()).some((p) => p.id === target.id) ? null : true,
    );
    assert.equal(await page.locator('dialog[open]').count(), 0, 'the dialog closes on success');
    assert.equal(
      (await focusSettles()).label,
      'Preset',
      'focus lands on the picker, since Delete is disabled once a built-in is selected',
    );
  });

  it('is unaffected by Preview, which changes no recipe field', async () => {
    // Listed as a hazard rather than assumed away: Modified reads the three
    // fields a preset stores, and starting or stopping playback touches none
    // of them. Cheaper to pin than to argue.
    await select(FOCUS);
    assert.equal(await modified(), false);
    const preview = page.getByRole('banner').getByRole('button', { name: /Preview|Stop/ });
    await preview.click();
    await page.waitForTimeout(900);
    assert.equal(await modified(), false, 'starting preview is not an edit');
    await preview.click();
    await page.waitForTimeout(600);
    assert.equal(await modified(), false, 'nor is stopping it');
  });

  it('cannot delete a built-in', async () => {
    await select(FOCUS);
    assert.ok(
      await page.getByRole('button', { name: 'Delete', exact: true }).isDisabled(),
      'built-ins are not deletable',
    );
  });
});

/**
 * A running session owns the recipe it captured.
 *
 * Preset identity has a life of its own — it can be modified, saved
 * under a new name, or deleted out from under the selection — and none of that
 * may reach backwards into a session already running. `finalConfiguration` is
 * *expected* to move, because Studio stays editable while a session runs; the
 * starting snapshot and the preset the session recorded are the things that
 * must not.
 */
describe('a session and the preset it started from', () => {
  it('keeps its starting snapshot when the recipe and the selection change under it', async () => {
    await page.getByLabel('Preset', { exact: true }).selectOption('masked');
    await page.waitForTimeout(200);

    // A value that belongs to nothing else, so the record cannot pass by
    // coincidence.
    await setRange('Carrier', 261);
    await page.waitForTimeout(250);

    const before = await history(page);
    await page
      .getByLabel('Session')
      .getByRole('button', { name: /Start session/ })
      .click();
    await until('the session to be running', async () =>
      (await page.locator('.session.running').count()) > 0 ? true : null,
    );

    // Now move everything the session might otherwise be reading through.
    await setRange('Carrier', 355);
    await page.getByLabel('Preset', { exact: true }).selectOption('focus');
    await page.waitForTimeout(300);

    await page
      .getByLabel('Session')
      .getByRole('button', { name: /Stop session/ })
      .click();
    const records = await until('the stopped session to be recorded', async () => {
      const rows = await history(page);
      return rows.length > before.length ? rows : null;
    });

    // Read locally rather than widening the shared `history` helper, whose
    // narrow shape the rest of the suite relies on.
    const recorded = await page.evaluate(
      async (id) => {
        const bridge = window.desktop;
        if (bridge === undefined) throw new Error('no desktop bridge');
        const row = (await bridge.history.list()).find((r) => r.id === id);
        if (row === undefined) throw new Error('the record went missing');
        return {
          presetId: row.presetId,
          startedFrom: row.initialConfiguration.params.carrierHz,
          endedOn: row.finalConfiguration.params.carrierHz,
        };
        /*
         * The record this test made, not the first in the list.
         *
         * An earlier test in this file runs a session with `presetId: 'focus'`,
         * and `history.list()` is not ordered newest-first — so reading
         * `records[0]` picked up that one and reported a preset mismatch that was
         * entirely this test's own doing.
         */
      },
      records.find((r) => !before.some((seen) => seen.id === r.id))!.id,
    );

    assert.equal(
      recorded.presetId,
      'masked',
      'the session recorded the preset it actually started from',
    );
    assertSameCarrier(
      recorded.startedFrom,
      261,
      'the starting snapshot must not follow later edits',
    );
    /*
     * And the other half of the contract, stated rather than left implicit.
     *
     * The *ending* configuration is meant to move: Studio stays editable while
     * a session runs. This session was edited to 355 and then had Balanced
     * pulse selected over it, so it ends on that preset's 220 — the last thing that was
     * actually playing. The pair is the point: the same two actions moved the
     * ending configuration and left the starting snapshot alone.
     */
    assert.equal(recorded.endedOn, 220, 'the ending configuration follows what was last applied');
  });
});

/**
 * History, and recalling a recipe out of it.
 *
 * Records can only be created by the coordinator; the renderer has no append
 * path. Every record here is therefore made by running a real session. What is
 * under test is the presentation over them and the recall out of them: that a
 * row says what the record stores, that recall restores the configuration and
 * nothing else, and that preset identity afterwards comes from a configuration
 * comparison rather than from a label the record happens to carry.
 */
describe('history and recipe recall', () => {
  /** Run one short session with a known configuration, and wait for its record. */
  async function record(
    presetId: string,
    configuration: SessionConfiguration,
    seconds = 1,
  ): Promise<number> {
    const before = (await history(page)).length;
    await page.evaluate(
      async ({ presetId: id, configuration: c, seconds: s }) => {
        const bridge = window.desktop;
        if (bridge === undefined) throw new Error('no desktop bridge');
        await bridge.session.start({ presetId: id, configuration: c, plannedSeconds: s });
      },
      { presetId, configuration, seconds },
    );
    await until('the session to be recorded', async () =>
      (await history(page)).length > before ? true : null,
    );
    return before + 1;
  }

  const toHistory = async () => {
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await until('the History view', async () =>
      (await page.locator('.history-view').count()) > 0 ? true : null,
    );
  };
  const toStudio = async () => {
    await page.getByRole('button', { name: 'Studio', exact: true }).click();
    await page.waitForTimeout(200);
  };

  const studioState = () =>
    page.evaluate(() => ({
      preset: document.querySelector<HTMLSelectElement>('select[aria-label="Preset"]')
        ?.selectedOptions[0]?.text,
      modified: document.querySelectorAll('.modified').length > 0,
      recalled: document.querySelector('.recalled') !== null,
      transport: document.querySelector('.transport button')?.textContent?.trim(),
      sessionRunning: document.querySelector('.session.running') !== null,
    }));

  const carrier = () => carrierHz();

  /** Clear every record, so each test starts from a known log. */
  async function clearHistory(): Promise<void> {
    await page.evaluate(async () => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      for (const row of await bridge.history.list()) await bridge.history.remove(row.id);
    });
    await until('the log to empty', async () => ((await history(page)).length === 0 ? true : null));
  }

  it('shows the empty state before anything has been recorded', async () => {
    await clearHistory();
    await toHistory();
    const empty = page.locator('.empty');
    assert.equal(await empty.count(), 1, 'an empty log needs to say so, not show a blank list');
    const text = (await empty.textContent()) ?? '';
    assert.match(text, /No sessions recorded yet/);
    // Says how the list fills, and does not claim anything about what sessions do.
    assert.match(text, /recorded when it finishes|finishes/);
    assert.match(text, /this machine/, 'the device-local claim belongs here');
    assert.equal(await page.locator('.summary').count(), 0, 'no totals over an empty log');
  });

  it('describes a record from what the record stores', async () => {
    await record('masked', {
      ...TEST_CONFIGURATION,
      params: { ...TEST_CONFIGURATION.params, carrierHz: 261 },
    });
    await toHistory();
    const row = page.locator('.records > li').first();
    assert.equal((await row.locator('.preset').textContent())?.trim(), 'Subtle pulse');
    const recipe = (await row.locator('.recipe').first().textContent()) ?? '';
    assert.match(recipe, /261\.0 Hz carrier/, 'the row reads the record, not the live recipe');
    assert.match((await row.locator('.timing').textContent()) ?? '', /of 0:01 planned/);
    assert.equal(
      await row.getByRole('button', { name: /Recall recipe/ }).count(),
      1,
      'an unedited record has one endpoint and therefore one recall',
    );
  });

  it('recalls the stored recipe into Studio without starting anything', async () => {
    await clearHistory();
    await record('focus', {
      ...TEST_CONFIGURATION,
      params: { ...TEST_CONFIGURATION.params, carrierHz: 288 },
    });
    await toStudio();
    await page.getByLabel('Preset', { exact: true }).selectOption('focus');
    await page.waitForTimeout(200);

    await toHistory();
    await page
      .locator('.records > li')
      .first()
      .getByRole('button', { name: /Recall/ })
      .click();
    await until('Studio', async () =>
      (await page.locator('.history-view').count()) === 0 ? true : null,
    );

    assertSameCarrier(
      await carrier(),
      288,
      'the recalled configuration is the one that was stored',
    );
    const state = await studioState();
    assert.ok(state.recalled, 'the change is announced rather than silent');
    assert.equal(state.transport, 'Preview', 'recall must not start audio');
    assert.equal(state.sessionRunning, false, 'nor a session');
    assert.equal(
      state.preset,
      'Balanced pulse',
      'and it must not adopt the identity the record carried',
    );
    assert.ok(state.modified, 'the recipe differs from the selected preset, so it says so');
  });

  it('reads preset identity from the comparison, not from the record', async () => {
    // A record whose recipe *is* a built-in must recall as that built-in with
    // no Modified — the identity comes from the configuration value comparison, which
    // is the only thing that can be right after a preset has been edited or
    // deleted since the session ran.
    await clearHistory();
    const focus = await page.evaluate(() => {
      const el = document.querySelector('select[aria-label="Preset"]');
      return el === null ? null : true;
    });
    assert.ok(focus);
    await toStudio();
    await page.getByLabel('Preset', { exact: true }).selectOption('focus');
    await page.waitForTimeout(200);
    const asFocus = await page.evaluate(() => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      return bridge.presets.list();
    });
    assert.ok(Array.isArray(asFocus));

    // Start a session from Studio, so the record holds exactly what Balanced pulse is.
    await page
      .getByLabel('Session')
      .getByRole('button', { name: /Start session/ })
      .click();
    await until('the session to run', async () =>
      (await page.locator('.session.running').count()) > 0 ? true : null,
    );
    await page
      .getByLabel('Session')
      .getByRole('button', { name: /Stop session/ })
      .click();
    await until('the record', async () => ((await history(page)).length > 0 ? true : null));

    // Move away, then recall it back.
    await page.getByLabel('Preset', { exact: true }).selectOption('smooth');
    await page.waitForTimeout(200);
    await toHistory();
    await page
      .locator('.records > li')
      .first()
      .getByRole('button', { name: /Recall/ })
      .click();
    await until('Studio', async () =>
      (await page.locator('.history-view').count()) === 0 ? true : null,
    );

    // Selection is still Gentle AM and the recipe is Balanced pulse's, so
    // Modified is true and honest. Selecting Balanced pulse must then clear it
    // without touching audio.
    assert.ok((await studioState()).modified);
    await page.getByLabel('Preset', { exact: true }).selectOption('focus');
    await page.waitForTimeout(300);
    const state = await studioState();
    assert.equal(state.modified, false, 'the recalled recipe really is Balanced pulse');
    assert.equal(state.recalled, false, 'and selecting a preset withdraws the recall note');
  });

  it('withdraws the recall note as soon as the recipe changes', async () => {
    await clearHistory();
    await record('focus', {
      ...TEST_CONFIGURATION,
      params: { ...TEST_CONFIGURATION.params, carrierHz: 299 },
    });
    await toHistory();
    await page
      .locator('.records > li')
      .first()
      .getByRole('button', { name: /Recall/ })
      .click();
    await until('Studio', async () =>
      (await page.locator('.history-view').count()) === 0 ? true : null,
    );
    assert.ok((await studioState()).recalled);

    await setRange('Carrier', 305);
    await page.waitForTimeout(300);
    const state = await studioState();
    assert.equal(state.recalled, false, 'the note cannot outlive the recipe it describes');
    assert.ok(state.modified, 'but the recipe still differs from the preset, so Modified stays');
  });

  it('offers both endpoints only when a session really changed', async () => {
    await clearHistory();
    // Started from Studio so the live recipe is captured, then edited mid-run.
    await toStudio();
    await page.getByLabel('Preset', { exact: true }).selectOption('focus');
    await page
      .getByLabel('Session')
      .getByRole('button', { name: /Start session/ })
      .click();
    await until('the session to run', async () =>
      (await page.locator('.session.running').count()) > 0 ? true : null,
    );
    await setRange('Carrier', 333);
    await page.waitForTimeout(400);
    await page
      .getByLabel('Session')
      .getByRole('button', { name: /Stop session/ })
      .click();
    await until('the record', async () => ((await history(page)).length > 0 ? true : null));

    await toHistory();
    const row = page.locator('.records > li').first();
    assert.equal(await row.getByRole('button', { name: /Recall start/ }).count(), 1);
    assert.equal(await row.getByRole('button', { name: /Recall end/ }).count(), 1);
    assert.equal(
      await row.locator('.recipe').count(),
      2,
      'a row offering two recalls has to describe two recipes',
    );

    await row.getByRole('button', { name: /Recall start/ }).click();
    await until('Studio', async () =>
      (await page.locator('.history-view').count()) === 0 ? true : null,
    );
    assertSameCarrier(await carrier(), 220, 'the start endpoint is where the session began');

    await toHistory();
    await page
      .locator('.records > li')
      .first()
      .getByRole('button', { name: /Recall end/ })
      .click();
    await until('Studio', async () =>
      (await page.locator('.history-view').count()) === 0 ? true : null,
    );
    assertSameCarrier(await carrier(), 333, 'and the end endpoint is where it finished');
  });

  it('recalls into a running session without rewriting the snapshot it captured', async () => {
    await clearHistory();
    await record('masked', {
      ...TEST_CONFIGURATION,
      params: { ...TEST_CONFIGURATION.params, carrierHz: 244 },
    });

    await toStudio();
    await page.getByLabel('Preset', { exact: true }).selectOption('focus');
    await page.waitForTimeout(200);
    await page
      .getByLabel('Session')
      .getByRole('button', { name: /Start session/ })
      .click();
    await until('the session to run', async () =>
      (await page.locator('.session.running').count()) > 0 ? true : null,
    );

    await toHistory();
    await page
      .locator('.records > li')
      .first()
      .getByRole('button', { name: /Recall/ })
      .click();
    await until('Studio', async () =>
      (await page.locator('.history-view').count()) === 0 ? true : null,
    );
    assertSameCarrier(await carrier(), 244, 'the recall applied to the editable recipe');
    assert.ok((await studioState()).sessionRunning, 'and the session is still running');

    await page
      .getByLabel('Session')
      .getByRole('button', { name: /Stop session/ })
      .click();
    await until('the second record', async () => ((await history(page)).length > 1 ? true : null));
    const rows = await page.evaluate(async () => {
      const bridge = window.desktop;
      if (bridge === undefined) throw new Error('no desktop bridge');
      const list = await bridge.history.list();
      return list.map((r) => ({
        id: r.id,
        presetId: r.presetId,
        startedFrom: r.initialConfiguration.params.carrierHz,
        endedOn: r.finalConfiguration.params.carrierHz,
        edited: r.edited,
      }));
    });
    const fromSession = rows.find((r) => r.presetId === 'focus');
    assert.ok(fromSession);
    assert.equal(
      fromSession.startedFrom,
      220,
      'recalling into Studio must not rewrite the snapshot a running session captured',
    );
    /*
     * And the other half, which the name used to paper over.
     *
     * Recall during a session really does change what is playing —
     * `applyConfiguration` drives the same setters ordinary editing does — and
     * the strip reports that, so the session's *ending* configuration follows
     * and it is marked edited. That is Studio staying editable during a
     * session, which is the accepted editing behaviour; the test now says so
     * rather than asserting only the half that stays still.
     */
    assert.equal(
      fromSession.endedOn,
      244,
      'the ending configuration follows the recall, because Studio stays editable',
    );
    assert.equal(fromSession.edited, true, 'and the session is marked edited');
  });

  it('confirms a per-row delete, and cancelling changes nothing', async () => {
    await clearHistory();
    await record('focus', TEST_CONFIGURATION);
    await toHistory();
    const before = (await history(page)).length;

    await page
      .locator('.records > li')
      .first()
      .getByRole('button', { name: /^Delete / })
      .click();
    await until('the confirmation', async () =>
      (await page.getByRole('dialog', { name: 'Delete session' }).count()) > 0 ? true : null,
    );
    await page.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(300);
    assert.equal((await history(page)).length, before, 'cancelling deletes nothing');

    await page
      .locator('.records > li')
      .first()
      .getByRole('button', { name: /^Delete / })
      .click();
    await page.locator('dialog[open]').getByRole('button', { name: 'Delete session' }).click();
    await until('the record to go', async () =>
      (await history(page)).length < before ? true : null,
    );
  });

  it('gives every row a name that singles it out, within one minute', async () => {
    // Minute-precision names collapsed twenty valid sessions into nine, so a
    // voice user could not say which row they meant. Three sessions started
    // seconds apart is the same failure in miniature.
    await clearHistory();
    for (let i = 0; i < 3; i += 1) await record('focus', TEST_CONFIGURATION);
    await toHistory();
    const names = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.records > li button')).map((b) =>
        b.getAttribute('aria-label'),
      ),
    );
    assert.equal(names.length, 6, 'three rows, two actions each');
    assert.equal(new Set(names).size, names.length, 'every action needs a name of its own');
  });

  it('keeps a failed deletion inside the dialog, reachable and focused', async () => {
    await clearHistory();
    await record('focus', TEST_CONFIGURATION);
    await toHistory();
    await page
      .locator('.records > li')
      .first()
      .getByRole('button', { name: /^Delete / })
      .click();
    await until('the confirmation', async () =>
      (await page.locator('dialog[open]').count()) > 0 ? true : null,
    );

    const unblock = await blockStoreWrite('history.json');
    try {
      await page.locator('dialog[open]').getByRole('button', { name: 'Delete session' }).click();
      await until('the failure', async () =>
        (await page.locator('dialog[open] [role=alert]').count()) > 0 ? true : null,
      );
      const state = await page.evaluate(() => {
        const dialog = document.querySelector('dialog[open]');
        const alert = dialog?.querySelector('[role=alert]') ?? null;
        const box = alert?.getBoundingClientRect();
        const hit =
          box === undefined
            ? null
            : document.elementFromPoint(
                Math.round(box.left + box.width / 2),
                Math.round(box.top + box.height / 2),
              );
        return {
          dialogOpen: dialog !== null,
          reachable: alert !== null && (hit === alert || alert.contains(hit)),
          focused: document.activeElement === alert,
          text: alert?.textContent ?? '',
          cancelPresent:
            Array.from(dialog?.querySelectorAll('button') ?? []).some(
              (b) => b.textContent?.trim() === 'Cancel',
            ) === true,
        };
      });
      assert.ok(state.dialogOpen, 'the dialog stays open so the failure can be answered');
      assert.ok(state.reachable, 'the message is not behind the backdrop');
      assert.ok(state.focused, 'and focus moves to it');
      assert.ok(state.cancelPresent, 'Cancel and retry both remain');
      assert.doesNotMatch(
        state.text,
        /invoking remote method/,
        'the IPC channel is plumbing, not something the reader can act on',
      );
      assert.match(
        state.text,
        /Permission was denied/,
        'but the category is kept, because it decides what to do next',
      );
      /*
       * And the path is not. Node ends a filesystem error with the file it was
       * opening, which for this app is the profile directory and a
       * process-numbered temp name — the longest part of the sentence and the
       * part with the least in it for the reader.
       */
      assert.doesNotMatch(state.text, /\/(var|Users|tmp)\//, 'no filesystem path reaches the user');
      assert.doesNotMatch(state.text, /\.tmp/, 'nor a temp filename');
    } finally {
      await unblock();
    }
    await page.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(300);
  });

  it('says how much a failed Clear had already destroyed', async () => {
    /*
     * Clear removes one record at a time, so it is not atomic: a failure part
     * way through leaves every earlier removal permanently done. The message
     * was "History was not cleared", which describes an operation that undid
     * itself — a production probe destroyed four of forty records and was told
     * none had gone.
     *
     * The store's atomic-write file is locked before the first removal rather than
     * during, because a partial is a race to stage and a race to assert. This
     * pins the shape and the announcement; `clearOutcome` in
     * `test/history-view.test.ts` pins the arithmetic for every split,
     * including the partial one.
     */
    await clearHistory();
    await record('focus', TEST_CONFIGURATION);
    await record('masked', TEST_CONFIGURATION);
    await toHistory();
    const live = page.locator('.history-view [role=status][aria-live=polite]');
    await page.getByRole('button', { name: 'Delete all history' }).click();
    await until('the confirmation', async () =>
      (await page.locator('dialog[open]').count()) > 0 ? true : null,
    );

    const unblock = await blockStoreWrite('history.json');
    try {
      await page.locator('dialog[open]').getByRole('button', { name: 'Delete everything' }).click();
      await until('the failure', async () =>
        (await page.locator('dialog[open] [role=alert]').count()) > 0 ? true : null,
      );
      const text = (await page.locator('dialog[open] [role=alert]').textContent()) ?? '';
      assert.match(text, /No sessions were deleted/, 'it accounts for what was destroyed');
      assert.match(text, /2 sessions still stored/, 'and for what survived');
      assert.doesNotMatch(text, /\.tmp/, 'without the path');
      // Announced too: the dialog can be dismissed, and the fact that records
      // were or were not destroyed outlives it.
      assert.match((await live.textContent()) ?? '', /No sessions were deleted/);
      assert.equal((await history(page)).length, 2, 'and nothing actually went');
    } finally {
      await unblock();
    }
    await page.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(300);
    await clearHistory();
  });

  it('leaves the keyboard on the intended control after every deletion', async () => {
    /*
     * Both paths used to land on `<body>`.
     *
     * The row's own Delete button is gone with the row, and the Clear control
     * is only rendered while records exist — so emptying the log removed the
     * very element the fallback was aiming at.
     *
     * Asserting the *target*, not merely that it is not `<body>`. The weaker
     * form passed for any focused element, so it could not tell the intended
     * control from the confirmation button that happened still to hold focus,
     * and it never covered the case where rows remain — where the chain is
     * supposed to stop at Clear rather than fall through to the heading.
     * Each leg waits for the dialog to detach first, so what is measured is
     * where focus was *put* rather than where it had not yet moved from.
     */
    const dialogGone = () =>
      until('the confirmation to close', async () =>
        (await page.locator('dialog[open]').count()) === 0 ? true : null,
      );
    const focused = () =>
      page.evaluate(() => {
        const el = document.activeElement;
        if (el === null || el === document.body) return 'BODY';
        return `${el.tagName}:${(el.textContent ?? '').trim().slice(0, 24)}`;
      });

    // Rows remain: the chain stops at Clear, which is still mounted.
    await clearHistory();
    await record('focus', TEST_CONFIGURATION);
    await record('masked', TEST_CONFIGURATION);
    await toHistory();
    await page
      .locator('.records > li')
      .first()
      .getByRole('button', { name: /^Delete / })
      .click();
    await page.locator('dialog[open]').getByRole('button', { name: 'Delete session' }).click();
    await until('one record left', async () => ((await history(page)).length === 1 ? true : null));
    await dialogGone();
    assert.equal(
      await focused(),
      'BUTTON:Delete all history',
      'with rows left, focus belongs on the control that is still there',
    );

    // The last row: Clear goes with it, so the heading is the end of the chain.
    await page
      .locator('.records > li')
      .first()
      .getByRole('button', { name: /^Delete / })
      .click();
    await page.locator('dialog[open]').getByRole('button', { name: 'Delete session' }).click();
    await until('the log to empty', async () => ((await history(page)).length === 0 ? true : null));
    await dialogGone();
    assert.equal(
      await focused(),
      'H2:Session history',
      'deleting the final row must land on the one element that survives it',
    );

    // And the same for a successful Clear.
    await record('focus', TEST_CONFIGURATION);
    await record('masked', TEST_CONFIGURATION);
    await toHistory();
    await page.getByRole('button', { name: 'Delete all history' }).click();
    await page.locator('dialog[open]').getByRole('button', { name: 'Delete everything' }).click();
    await until('the log to empty', async () => ((await history(page)).length === 0 ? true : null));
    await dialogGone();
    assert.equal(await focused(), 'H2:Session history', 'nor must clearing everything drop it');
  });

  it('shows the newest twenty and reveals the rest without touching storage', async () => {
    // Assert the default limit and that expanding the view does not change storage.
    await clearHistory();
    for (let i = 0; i < 22; i += 1) await record('focus', TEST_CONFIGURATION);
    await toHistory();

    assert.equal(await page.locator('.records > li').count(), 20, 'the newest twenty by default');
    const storedBefore = (await history(page)).length;
    await page.getByRole('button', { name: /Show all/ }).click();
    await until('the rest', async () =>
      (await page.locator('.records > li').count()) === 22 ? true : null,
    );
    assert.equal((await history(page)).length, storedBefore, 'showing more stores nothing');

    await page.getByRole('button', { name: /Show the 20 most recent/ }).click();
    await until('the page again', async () =>
      (await page.locator('.records > li').count()) === 20 ? true : null,
    );
    await clearHistory();
  });

  it('picks up a session that finishes while History is open', async () => {
    /*
     * "Subscription is live" is the first behavioural acceptance clause, and
     * every other test here records first and navigates second — which proves
     * only that the list loads. This stays on History throughout.
     */
    await clearHistory();
    await toHistory();
    assert.equal(await page.locator('.empty').count(), 1, 'starting from an empty log');

    // `record` waits on the store, not on the view, so waiting for it does not
    // hide the thing under test: the row has to arrive through the panel's own
    // subscription while it stays mounted.
    await record('focus', TEST_CONFIGURATION);
    await until('the row to appear without navigating', async () =>
      (await page.locator('.records > li').count()) === 1 ? true : null,
    );
    assert.equal(await page.locator('.empty').count(), 0, 'and the empty state gives way');
  });

  it('announces a deletion rather than only performing it', async () => {
    await clearHistory();
    await record('focus', TEST_CONFIGURATION);
    await toHistory();
    // Scoped to the panel: App keeps its own status region for recall
    // announcements, and it comes first in the document.
    const live = page.locator('.history-view [role=status][aria-live=polite]');
    assert.equal(await live.count(), 1, 'the view needs a live region at all');

    await page
      .locator('.records > li')
      .first()
      .getByRole('button', { name: /^Delete / })
      .click();
    await page.locator('dialog[open]').getByRole('button', { name: 'Delete session' }).click();
    await until('the announcement', async () =>
      ((await live.textContent()) ?? '').includes('deleted') ? true : null,
    );
    assert.match((await live.textContent()) ?? '', /0 remaining/);
  });

  it('confirms Clear, empties the log, and leaves the recipe alone', async () => {
    await clearHistory();
    await record('focus', TEST_CONFIGURATION);
    await record('masked', TEST_CONFIGURATION);
    await toStudio();
    const recipeBefore = await carrier();
    await toHistory();

    await page.getByRole('button', { name: 'Delete all history' }).click();
    await until('the confirmation', async () =>
      (await page.getByRole('dialog', { name: 'Delete all history' }).count()) > 0 ? true : null,
    );
    await page.locator('dialog[open]').getByRole('button', { name: 'Delete everything' }).click();
    await until('the log to empty', async () => ((await history(page)).length === 0 ? true : null));
    // The list above is a separate IPC read. It can observe the completed
    // store write before the final remove response reaches this component and
    // Svelte renders `records = []`, so durability is not also a DOM barrier.
    await until('the empty state to take over', async () =>
      (await page.locator('.empty').count()) === 1 ? true : null,
    );

    assert.equal(await page.locator('.empty').count(), 1, 'the empty state takes over');
    await toStudio();
    assert.equal(await carrier(), recipeBefore, 'clearing history changes no recipe');
  });
});
