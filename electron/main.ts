/**
 * Electron main process.
 *
 * Owns the store, the session coordinator, the tray, and both windows. Audio
 * lives in the Studio renderer — main decides *when* a session starts and ends
 * and what is recorded, and never touches the graph itself.
 *
 * The Studio renderer is deliberately able to run standalone in a browser
 * against the Vite dev server, so the UI can be exercised without launching
 * Electron. Device inspection arrives in step 4.
 */

import { app, BrowserWindow, globalShortcut, powerMonitor } from 'electron';
import { Store } from './store.ts';
import {
  designateExecutor,
  registerExecutorHandlers,
  registerSessionHandlers,
  registerStoreHandlers,
  registerWindowHandlers,
  designatePopover,
  trustRenderer,
  type SessionHost,
} from './ipc.ts';
import {
  beginQuit,
  createPopover,
  createStudioWindow,
  revealStudio,
  type Popover,
} from './windows.ts';
import { createTray, type TrayHandle, type TraySessionState } from './tray.ts';
import { installApplicationMenu } from './app-menu.ts';
import { ExecutorLink } from '../src/session/executor-link.ts';
import { SessionCoordinator, type InterruptOptions } from '../src/session/coordinator.ts';
import { normalizeStartRequest } from '../src/session/normalize.ts';
import { normalizeConfiguration } from '../src/audio/configuration.ts';
import {
  linkAudioExecutor,
  storeSessionStorage,
  systemClock,
  systemScheduler,
} from './session-adapters.ts';

/**
 * Ends the running session, once the coordinator exists.
 *
 * Windows are created after it, but the handlers are attached during creation,
 * so this is the seam between them.
 */
let sessionInterrupt: ((why: string) => void) | null = null;

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

/**
 * The hotkey.
 *
 * It never starts a session: the governing decision is reminders, never
 * autoplay, and a keystroke that begins playing audio with no visible choice
 * of preset or duration is exactly that. So it stops what is playing, or opens
 * the popover to let the user choose.
 */
const HOTKEY = 'CommandOrControl+Shift+F';

/**
 * How long quitting waits for a running session to be written.
 *
 * Long enough for a stop and a disk write, short enough that a renderer which
 * will never answer does not leave the user unable to quit.
 */
const QUIT_SETTLE_MS = 3000;

/**
 * Whether this platform can start the app at login.
 *
 * `setLoginItemSettings` is documented as macOS and Windows only. On Linux it
 * is a `.desktop` file in an autostart directory, which is a packaging
 * concern rather than a runtime one — so the setting is simply unavailable
 * there rather than accepted and quietly ignored.
 */
const SUPPORTS_LAUNCH_AT_LOGIN = process.platform === 'darwin' || process.platform === 'win32';

/**
 * What the OS says about launching at login, or null when there is no OS
 * answer to be had.
 *
 * Null on Linux, where there is no such API, and in an unpackaged build, where
 * the executable is Electron itself rather than this app — asking about it
 * would be asking about the wrong thing.
 */
function osLaunchAtLogin(): boolean | null {
  if (!SUPPORTS_LAUNCH_AT_LOGIN || !app.isPackaged) return null;
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch (error) {
    console.warn('[main] could not read the launch-at-login setting:', error);
    return null;
  }
}

/**
 * Put the OS setting where it was asked to be, and answer with where it is.
 *
 * Two things this must not do. It must not report success it does not have: a
 * managed machine can refuse, and remembering the request as though it had
 * worked would show the user a setting that is not in force. So the value is
 * read back and that is what gets stored.
 *
 * And it must not touch the machine from an unpackaged build, where
 * registering Electron itself would be both wrong and invasive — every run of
 * the Electron suite would rewrite a real, machine-level setting that
 * redirecting `userData` does nothing to isolate. Development stores the
 * preference and applies it when there is an installed app to apply it to.
 */
function applyLaunchAtLogin(enabled: boolean): boolean {
  if (!SUPPORTS_LAUNCH_AT_LOGIN) return false;
  if (!app.isPackaged) return enabled;
  try {
    // Read first: writing the value it already holds is churn, and on macOS a
    // no-op write still re-registers the login item.
    if (app.getLoginItemSettings().openAtLogin !== enabled) {
      app.setLoginItemSettings({ openAtLogin: enabled });
    }
    return app.getLoginItemSettings().openAtLogin;
  } catch (error) {
    console.warn('[main] could not change the launch-at-login setting:', error);
    // Whatever it is now is the truth, however this ended up.
    return osLaunchAtLogin() ?? false;
  }
}

// Windows identifies an application by this, not by its executable: it decides
// which taskbar button the windows group under, which icon that button shows,
// and who notifications come from. Without it an unpackaged run is just
// electron.exe. It must match the `appId` in electron-builder.yml, or an
// installed build and the shortcut that launches it disagree about who it is.
if (process.platform === 'win32') app.setAppUserModelId('us.stolze.fortyhz');

// Audio must keep running when the window is in the background — a session is
// a 45-60 minute thing that the user works over, not something they watch.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

void app.whenReady().then(async () => {
  // Before any window exists, so no window is ever drawn with the default menu.
  installApplicationMenu();

  // macOS's application menu carries an About item that opens the OS panel,
  // which otherwise describes Electron. Same facts as the in-app About dialog;
  // `app.getVersion()` reads the same package.json field the renderer is given
  // at build time.
  app.setAboutPanelOptions({
    applicationName: '40 Hz',
    // The commit as well as the version: the version has named a dozen
    // different builds and cannot identify one in a bug report.
    applicationVersion: `${app.getVersion()} (${__BUILD_COMMIT__})`,
    copyright: '© Frank Stolze',
    credits:
      'A focus and concentration tool built on 40 Hz auditory entrainment. Not a medical device.',
  });

  // One owner for presets and history, since Studio and the Session popover
  // are separate renderers and cannot share localStorage.
  const store = new Store(app.getPath('userData'));
  await store.load();
  if (store.readOnly) {
    console.warn('[main] a data file could not be written back safely; it was left alone');
  }
  registerStoreHandlers(store, { applyLaunchAtLogin, readLaunchAtLogin: osLaunchAtLogin });

  // Startup reads the OS and corrects the file, never the other way round.
  //
  // Writing at startup was wrong twice over. It re-imposed the app's opinion
  // on a user who may have removed the login item in System Settings, which is
  // theirs to do. And it meant merely *launching* the packaged app changed
  // machine-level state — so the packaged smoke test, whose temporary profile
  // isolates files and nothing else, could disable a real login item just by
  // starting the app.
  const actualLaunchAtLogin = osLaunchAtLogin();
  /*
   * `nativeTheme.themeSource` is deliberately left alone.
   *
   * Setting it from the app's appearance looked appealing — it is the obvious
   * way to tell Chromium what theme the app is in — but it is global, and
   * `tray.ts` reads `nativeTheme.shouldUseDarkColors` back out of it to choose
   * the tray icon's ink on Linux and as the Windows fallback. Assigning the
   * app's preference there means a user choosing Light on a dark desktop also
   * tells the tray the system is light, and the tray then draws dark ink onto
   * a dark panel. Measured: `themeSource = 'light'` flips
   * `shouldUseDarkColors` from true to false while the OS never moved.
   *
   * It also bought nothing. The renderer cannot see `prefers-color-scheme`
   * here whatever `themeSource` says — see the trap in AGENTS.md — which is
   * why the effective theme is published over IPC instead.
   *
   * So `shouldUseDarkColors` stays what it is worth being: the operating
   * system's answer, read by the tray for platform ink and by the theme
   * publication for what `system` resolves to. Two consumers, one meaning.
   */

  if (actualLaunchAtLogin !== null && actualLaunchAtLogin !== store.settings().launchAtLogin) {
    await store
      .saveSettings({ ...store.settings(), launchAtLogin: actualLaunchAtLogin })
      .catch((error: unknown) => {
        console.warn('[main] could not record the launch-at-login setting:', error);
      });
  }

  // The command link to whichever renderer owns the audio graph.
  const executor = new ExecutorLink();
  registerExecutorHandlers(executor);

  const coordinator = new SessionCoordinator({
    clock: systemClock,
    scheduler: systemScheduler,
    storage: storeSessionStorage(store),
    executor: linkAudioExecutor(executor),
    newId: () => `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    // Timer-driven work has no caller to reject to. Without this a failure
    // there would be swallowed entirely.
    onError: (error: unknown) => {
      console.error('[main] session background failure:', error);
    },
  });

  // Settle whatever the last run left behind before anything new can start:
  // a reservation that never became audio is discarded, and a session that was
  // running is recorded as interrupted at its last heartbeat.
  await coordinator.recover().catch((error: unknown) => {
    console.error('[main] could not settle the previous session:', error);
  });

  // An edit in Studio has to reach the record, and the checkpoint that
  // survives losing the renderer.
  executor.onConfiguration((configuration) => {
    coordinator.reportConfiguration(configuration as never);
  });

  // What Studio measured about the audio it is playing. The coordinator owns
  // the aggregate and normalizes the report; nothing here inspects it. The
  // answer is passed back rather than swallowed, so the producer can tell a
  // report that was recorded from one that arrived after its session ended.
  executor.onIntegrity((sessionId, report) => coordinator.reportIntegrity(sessionId, report));

  const host: SessionHost = {
    start: (request) => {
      // IPC is untrusted input. An unchecked duration would reach both the
      // audio executor and the history record.
      const normalized = normalizeStartRequest(request);
      if (normalized === null) throw new Error('session: malformed start request');
      return coordinator.startSession(normalized);
    },
    // The renderer cannot choose the reason. Accepting one would let it record
    // a session it stopped as 'completed', or as 'interrupted'. It also cannot
    // choose *what* to stop: there is one thing playing, and this stops it.
    stop: () => coordinator.stopPlayback('stopped'),
    preview: (configuration) => coordinator.startPreview(normalizeConfiguration(configuration)),
  };
  registerSessionHandlers(coordinator, host);

  /**
   * End the running session.
   *
   * `executorGone` says whether the graph is *certainly* gone. A renderer that
   * was replaced, lost, or navigated away is; a machine suspending or a
   * command timing out is not — there the graph may still exist and still be
   * playing, so the coordinator keeps ownership rather than publishing idle
   * over live audio.
   */
  const interrupt = (why: string, options: InterruptOptions): void => {
    void coordinator.interrupt(options).catch((error: unknown) => {
      console.error(`[main] could not finalize after ${why}:`, error);
    });
  };

  // Counting time asleep as listening would corrupt the log, so a session ends
  // at the instant the machine suspends rather than carried across it. The
  // graph may well survive the sleep, so the executor is not known to be gone
  // — but the suspend itself really did stop the sound, so it is a boundary.
  powerMonitor.on('suspend', () =>
    interrupt('suspend', { executorGone: false, boundaryConfirmed: true }),
  );

  executor.onLost((reason) => {
    // 'unresponsive' is a command timeout: the renderer may simply be busy,
    // and the audio may still be playing, so this ends nothing by itself.
    const gone = reason !== 'unresponsive';
    interrupt(`the executor was ${reason}`, {
      executorGone: gone,
      boundaryConfirmed: gone,
    });
  });

  sessionInterrupt = (why) => interrupt(why, { executorGone: true, boundaryConfirmed: true });

  // ---- windows, tray, hotkey -------------------------------------------

  let studio: BrowserWindow | null = null;

  /**
   * Whether a tray icon was constructed.
   *
   * A function rather than a value: the tray is established after Studio
   * exists, and Studio's close handler runs long after both.
   */
  let trayConstructed = (): boolean => false;

  const openStudio = (): BrowserWindow => {
    studio = createStudioWindow(
      {
        adopt: (win) => {
          // Only windows the app opened itself may call into the store.
          trustRenderer(win.webContents);
          // Studio holds the audio graph, so it is the only window allowed to
          // become the executor. Nominating it here is what stops any other
          // renderer electing itself and driving audio — the popover included.
          designateExecutor(win.webContents);
        },
        audioLost: (why) => sessionInterrupt?.(why),
        trayConstructed: () => trayConstructed(),
        closeToTray: () => store.settings().closeToTray,
        // Closing Studio ends the app on Linux, and anywhere without a tray.
        // Quitting rather than closing, so the quit path below can finalize a
        // running session while this renderer is still there to answer.
        quitRequested: () => {
          app.quit();
        },
        // Read at creation, not held: Studio is re-created after a close on some
        // platforms, and it should open in whatever the setting says *then*.
      },
      store.settings().appearance,
    );
    return studio;
  };

  const showStudio = (): void => {
    studio = revealStudio(studio, openStudio);
  };

  openStudio();

  const popover: Popover = createPopover(
    {
      adopt: (win) => {
        trustRenderer(win.webContents);
        // The only window allowed to resize itself, and only itself.
        designatePopover(win.webContents);
      },
    },
    store.settings().appearance,
  );

  registerWindowHandlers({
    showStudio,
    setPopoverHeight: (pixels) => popover.setHeight(pixels),
  });

  const stopPlayback = (): void => {
    void coordinator.stopPlayback('stopped').catch((error: unknown) => {
      console.error('[main] could not stop playback:', error);
    });
  };

  const tray: TrayHandle | null = createTray({
    togglePopover: (owner) => popover.toggle(owner),
    showPopover: (owner) => popover.show(owner),
    showStudio,
    stopSession: stopPlayback,
    quit: () => app.quit(),
  });

  /** What the tray should say about a given session state. */
  const describe = (state: string): TraySessionState => {
    const previewing = state === 'previewing';
    const inSession = state === 'session-active' || state === 'session-ending';
    return {
      playing: previewing || inSession,
      stopLabel: previewing ? 'Stop preview' : 'Stop session',
      summary: inSession ? '40 Hz — session running' : previewing ? '40 Hz — preview' : '40 Hz',
    };
  };

  // Keep the tray menu and tooltip honest about what is playing. Keyed like
  // any other subscriber, so this cannot displace a window's subscription —
  // and seeded from the initial snapshot rather than assuming idle, since
  // recovery runs before this and could have left something playing.
  const trayView = coordinator.subscribeUnique('tray', (update) => {
    tray?.update(describe(update.snapshot.state));
  });
  tray?.update(describe(trayView.initial.snapshot.state));

  // Stops what is playing, wherever the user is. When nothing is playing it
  // opens the popover rather than starting blind — see HOTKEY.
  const registered = globalShortcut.register(HOTKEY, () => {
    if (coordinator.getSnapshot().snapshot.state === 'idle') popover.show(tray?.tray ?? null);
    else stopPlayback();
  });
  if (!registered) {
    // Another application already holds it. Not fatal, and not worth a dialog
    // — every action it offers is on the tray menu — but silence here would
    // leave the user pressing a key that does nothing with no explanation.
    console.warn(`[main] could not register the global hotkey ${HOTKEY}; it is already in use`);
  }

  trayConstructed = () => tray !== null;

  app.on('activate', () => {
    // Not the usual `getAllWindows().length === 0` test: Studio hides rather
    // than closing, so the count is never zero and a Dock click would do
    // nothing at all.
    showStudio();
  });

  /**
   * Quitting is already under way, so let the second attempt through.
   *
   * `app.quit()` re-emits `before-quit`; without this the finalization below
   * would restart on every attempt and the app would never exit.
   */
  let quitting = false;

  app.on('before-quit', (event) => {
    // Windows survive `close` only until the user means it.
    beginQuit();
    if (quitting) return;

    const { state } = coordinator.getSnapshot().snapshot;
    if (state === 'idle') return;

    // A session is playing. Finalizing it writes its record, and that write is
    // not instant — letting the process exit first loses the session, which is
    // the one thing the history is for. The windows are still open at this
    // point, so the executor is still there to answer.
    quitting = true;
    event.preventDefault();

    // Bounded, so a renderer that will never answer cannot prevent quitting.
    const abandon = new Promise<void>((resolve) => setTimeout(resolve, QUIT_SETTLE_MS));
    void Promise.race([coordinator.stopPlayback('stopped').then(() => undefined), abandon])
      .catch((error: unknown) => {
        console.error('[main] could not finalize the session while quitting:', error);
      })
      .finally(() => app.quit());
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    // Tray icons outlive the app on some Windows shells if not removed.
    tray?.destroy();
  });

  // Deliberately no `window-all-closed` handler. Both windows hide rather than
  // close, so it could never fire — a hidden window is not a closed one, and
  // the popover alone would keep the count above zero. The case it would have
  // covered is handled where it can actually be observed, in `closedForGood`.
});

export { isDev };
