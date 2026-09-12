/**
 * The main process's IPC surface.
 *
 * Two surfaces, deliberately separate:
 *
 * - **Renderer** — presets and history, available to any window the app
 *   itself opened. Note what is *not* here: `history.append`. Only the session
 *   coordinator creates history records, and exposing an append would let any
 *   renderer forge or duplicate entries even with the payload normalized.
 * - **Executor** — Studio only, for driving audio. Arrives with the
 *   coordinator in stage 4; the channel names are fixed here so both sides are
 *   written against one contract.
 *
 * Every handler validates its sender. Electron's guidance is to check the
 * sender on each message rather than trusting the channel, and to identify it
 * by frame rather than by URL, which a compromised renderer can influence.
 */

import { ipcMain, nativeTheme, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { Store } from './store.ts';
import { normalizeSettings, resolveTheme } from '../src/session/settings.ts';
import { normalizeConfiguration } from '../src/audio/configuration.ts';
import type { ExecutorLink } from '../src/session/executor-link.ts';
import type { Published, Subscriber } from '../src/session/session-hub.ts';

/**
 * Whatever publishes session state.
 *
 * Narrow on purpose: the coordinator satisfies it directly, and so does a bare
 * `SessionHub`, so these handlers do not need to know which they are wired to.
 */
export interface SessionPublisher<T> {
  subscribeUnique(
    key: string | number,
    subscriber: Subscriber<T>,
  ): { initial: Published<T>; unsubscribe: () => void };
  /** Drop whatever subscription `key` holds, when its window disappears. */
  unsubscribeKey(key: string | number): void;
}

export const CHANNELS = {
  presetsList: 'presets:list',
  presetsUpsert: 'presets:upsert',
  presetsRemove: 'presets:remove',
  presetsImportLegacy: 'presets:import-legacy',
  presetsSubscribe: 'presets:subscribe',
  presetsChanged: 'presets:changed',
  historySubscribe: 'history:subscribe',
  historyChanged: 'history:changed',
  historyList: 'history:list',
  historyRemove: 'history:remove',
  sessionSubscribe: 'session:subscribe',
  sessionStart: 'session:start',
  sessionStop: 'session:stop',
  sessionPreview: 'session:preview',
  sessionChanged: 'session:changed',
  executorRegister: 'executor:register',
  executorCommand: 'executor:command',
  executorAck: 'executor:ack',
  executorConfiguration: 'executor:configuration',
  executorIntegrity: 'executor:integrity',
  settingsSubscribe: 'settings:subscribe',
  settingsSave: 'settings:save',
  settingsChanged: 'settings:changed',
  themeSubscribe: 'theme:subscribe',
  themeChanged: 'theme:changed',
  windowsShowStudio: 'windows:show-studio',
  windowsPopoverHeight: 'windows:popover-height',
} as const;

/** WebContents ids the app opened itself. Nothing else may call in. */
const trustedRenderers = new Set<number>();
/**
 * The one WebContents permitted to act as the audio executor.
 *
 * Set when the window that owns the graph is created. Without it any renderer
 * could elect itself and drive audio.
 */
let designatedExecutorId: number | null = null;
/** The WebContents currently registered as the executor. */
let executorId: number | null = null;

export function trustRenderer(contents: WebContents): void {
  trustedRenderers.add(contents.id);
  contents.once('destroyed', () => trustedRenderers.delete(contents.id));
}

/**
 * The one window allowed to resize itself.
 *
 * Nominated like the executor, and for the same reason: without it any
 * renderer could reshape a window it has no business touching.
 */
let popoverId: number | null = null;

export function designatePopover(contents: WebContents): void {
  popoverId = contents.id;
  contents.once('destroyed', () => {
    if (popoverId === contents.id) popoverId = null;
  });
}

/** Nominate the window allowed to become the executor. */
export function designateExecutor(contents: WebContents): void {
  designatedExecutorId = contents.id;
  contents.once('destroyed', () => {
    if (designatedExecutorId === contents.id) designatedExecutorId = null;
  });
}

export function setExecutor(contents: WebContents | null): void {
  executorId = contents?.id ?? null;
}

export function isExecutor(event: IpcMainInvokeEvent): boolean {
  return executorId !== null && event.sender.id === executorId && isMainFrame(event);
}

/**
 * True when the message came from the top frame of a window we opened.
 *
 * Comparing frames rather than URLs matters: a renderer can navigate a child
 * frame, so a URL check can be satisfied by content the app never loaded.
 */
function isMainFrame(event: IpcMainInvokeEvent): boolean {
  return event.senderFrame !== null && event.senderFrame === event.sender.mainFrame;
}

function isTrusted(event: IpcMainInvokeEvent): boolean {
  return trustedRenderers.has(event.sender.id) && isMainFrame(event);
}

/** Reject rather than answer, so an untrusted caller learns nothing. */
function guard<A extends unknown[], R>(
  handler: (event: IpcMainInvokeEvent, ...args: A) => Promise<R> | R,
): (event: IpcMainInvokeEvent, ...args: A) => Promise<R> {
  return async (event, ...args) => {
    if (!isTrusted(event)) {
      throw new Error('ipc: rejected a message from an untrusted sender');
    }
    return handler(event, ...args);
  };
}

/**
 * What the session channels delegate to.
 *
 * Implemented by the coordinator in stage 4. Kept as an interface so the
 * transport, its validation, and its subscription semantics are finished and
 * tested independently of whatever ends up driving them.
 */
export interface SessionHost {
  start(request: unknown): Promise<unknown>;
  stop(reason: unknown): Promise<unknown>;
  preview(configuration: unknown): Promise<unknown>;
}

/**
 * Wire the session channels.
 *
 * `subscribe` answers with the snapshot and its revision together, and every
 * later change arrives on `sessionChanged` carrying a strictly increasing
 * revision — so a window opened mid-session is never left guessing, and an
 * event that arrives late can be discarded.
 */
export function registerSessionHandlers<T>(hub: SessionPublisher<T>, host: SessionHost): void {
  /**
   * Windows already carrying a teardown listener.
   *
   * `once('destroyed', ...)` would otherwise be added on every subscribe, so
   * a component that remounts repeatedly would accumulate closures and
   * eventually trip Electron's max-listener warning.
   */
  const teardownAttached = new Set<number>();

  ipcMain.handle(
    CHANNELS.sessionSubscribe,
    guard((event) => {
      const contents = event.sender;

      // Keyed by window, so subscribing twice replaces rather than adds.
      const { initial, unsubscribe } = hub.subscribeUnique(contents.id, (update) => {
        if (contents.isDestroyed()) {
          unsubscribe();
          return;
        }
        contents.send(CHANNELS.sessionChanged, update);
      });
      if (!teardownAttached.has(contents.id)) {
        teardownAttached.add(contents.id);
        contents.once('destroyed', () => {
          teardownAttached.delete(contents.id);
          hub.unsubscribeKey(contents.id);
        });
      }
      return initial;
    }),
  );
  ipcMain.handle(
    CHANNELS.sessionStart,
    guard((_event, request: unknown) => host.start(request)),
  );
  ipcMain.handle(
    CHANNELS.sessionStop,
    guard((_event, reason: unknown) => host.stop(reason)),
  );
  ipcMain.handle(
    CHANNELS.sessionPreview,
    guard((_event, configuration: unknown) => host.preview(configuration)),
  );
}

/**
 * Wire the executor surface, which only Studio may use.
 *
 * Separate from the renderer surface on purpose: these drive audio, so they
 * are checked against the one WebContents registered as the executor rather
 * than against the set of windows the app opened.
 */
export function registerExecutorHandlers(link: ExecutorLink): void {
  /**
   * Windows already carrying a teardown listener.
   *
   * A reload re-registers through the same WebContents, so attaching one per
   * registration would pile up dormant closures and eventually trip
   * Electron's max-listener warning.
   */
  const teardownAttached = new Set<number>();

  ipcMain.handle(CHANNELS.executorRegister, (event, generation: unknown) => {
    // Only the nominated window, and only its top frame. Anything else could
    // otherwise elect itself and drive audio.
    if (!isMainFrame(event) || event.sender.id !== designatedExecutorId) {
      throw new Error('ipc: rejected an executor registration from an unexpected sender');
    }
    const contents = event.sender;

    if (typeof generation === 'number') {
      // Readiness names the generation it was issued, so a renderer that has
      // since been replaced cannot mark the current executor ready.
      if (event.sender.id !== executorId) {
        throw new Error('ipc: readiness came from a renderer that is not the executor');
      }
      return link.markReady(generation);
    }

    setExecutor(contents);
    const registered = link.register((message) => {
      if (contents.isDestroyed()) throw new Error('executor window is gone');
      contents.send(CHANNELS.executorCommand, message);
    });
    // A reload replaces the executor; losing the window removes it entirely,
    // and anything still in flight fails rather than waiting on a renderer
    // that will never answer. Attached once per window, not once per
    // registration.
    if (!teardownAttached.has(contents.id)) {
      teardownAttached.add(contents.id);
      contents.once('destroyed', () => {
        teardownAttached.delete(contents.id);
        if (executorId === contents.id) {
          setExecutor(null);
          link.unregister();
        }
      });
    }
    return registered;
  });

  ipcMain.handle(
    CHANNELS.executorConfiguration,
    (event, generation: unknown, configuration: unknown) => {
      if (!isExecutor(event)) {
        throw new Error('ipc: rejected a configuration report from a non-executor');
      }
      // Bound to a generation like everything else here: the same window can
      // re-register after a reload, and a report still in flight from the
      // previous instance must not overwrite the current one's configuration.
      //
      // Normalized at the boundary, because IPC is untrusted input like disk
      // and localStorage — this value ends up in a history record and in the
      // checkpoint that survives losing the renderer.
      return link.reportConfiguration(Number(generation), normalizeConfiguration(configuration));
    },
  );

  ipcMain.handle(
    CHANNELS.executorIntegrity,
    (event, generation: unknown, sessionId: unknown, report: unknown) => {
      if (!isExecutor(event)) {
        throw new Error('ipc: rejected an integrity report from a non-executor');
      }
      // Passed on as it arrived, and rebuilt by the coordinator: what a
      // finding may claim is the integrity model's rule, not this layer's, and
      // stating it twice is how the two drift. The generation and the session
      // id are this layer's business, and both are checked on the link.
      return link.reportIntegrity(Number(generation), sessionId, report);
    },
  );

  ipcMain.handle(
    CHANNELS.executorAck,
    (event, id: unknown, generation: unknown, result: unknown, error: unknown) => {
      if (!isExecutor(event))
        throw new Error('ipc: rejected an acknowledgement from a non-executor');
      return link.acknowledge(
        Number(id),
        Number(generation),
        result,
        typeof error === 'string' ? error : undefined,
      );
    },
  );
}

/** Wire the renderer surface: presets and history. */
/**
 * Wire the window channel.
 *
 * Deliberately one direction and one window: the popover can ask for Studio,
 * and that is all. A general "show this window" or "move this window" surface
 * would let a renderer reposition or reveal windows it has no business
 * touching — the popover's own dismissal is handled in the main process for
 * the same reason.
 */
export interface WindowHooks {
  showStudio(): void;
  /**
   * The popover asking to be as tall as its content.
   *
   * Its height genuinely varies — a countdown, a preset picker, an advisory
   * that may or may not be there — and a fixed height is either padded with
   * dead space or clips the one message that matters. Main clamps it.
   */
  setPopoverHeight(pixels: number): void;
}

export function registerWindowHandlers(hooks: WindowHooks): void {
  ipcMain.handle(
    CHANNELS.windowsShowStudio,
    guard(() => {
      hooks.showStudio();
    }),
  );
  ipcMain.handle(
    CHANNELS.windowsPopoverHeight,
    guard((event, pixels: unknown) => {
      // Only the popover, and only its top frame. Studio is trusted for the
      // store but has no business resizing another window.
      if (!isMainFrame(event) || event.sender.id !== popoverId) {
        throw new Error('ipc: rejected a resize from a window that is not the popover');
      }
      const height = Number(pixels);
      if (!Number.isFinite(height)) throw new Error('ipc: popover height must be a number');
      hooks.setPopoverHeight(height);
    }),
  );
}

export interface StoreHooks {
  /**
   * Put the OS setting where it was asked, and answer with where it is.
   *
   * Main owns this because the store has no business knowing about the OS —
   * and it returns rather than accepts, because a refusal has to reach the
   * file. Remembering a request as though it succeeded would show the user a
   * setting that is not in force.
   */
  applyLaunchAtLogin(enabled: boolean): boolean;
  /** What the OS currently says, or null where there is nothing to ask. */
  readLaunchAtLogin(): boolean | null;
}

export function registerStoreHandlers(store: Store, hooks: StoreHooks): void {
  /**
   * Windows watching for preset changes.
   *
   * The popover is created once at startup and hidden rather than closed, so
   * without this its picker shows whatever existed at launch for the rest of
   * the session. A renderer cannot notice being shown — Electron fires neither
   * `visibilitychange` nor `focus` for a window revealed with `show()`, and
   * `document.visibilityState` reads `visible` the whole time it is hidden —
   * so the owner of the data has to say when it changed.
   */
  const watchers = new Set<WebContents>();
  const historyWatchers = new Set<WebContents>();
  const settingsWatchers = new Set<WebContents>();
  const themeWatchers = new Set<WebContents>();

  /** Keyed by set, so one window can watch presets, settings, or both. */
  const notify = (group: Set<WebContents>, channel: string, payload: unknown): void => {
    for (const contents of group) {
      if (contents.isDestroyed()) group.delete(contents);
      else contents.send(channel, payload);
    }
  };

  // Driven by the store rather than by these handlers, so a session the
  // coordinator recorded reaches every window the same way a deletion does.
  // Without it, deleting a record updated only the window that asked, and
  // every other surface kept counting it toward the day's listening total,
  // the advisory, and the recall list.
  store.onChanged((what) => {
    if (what === 'presets') notify(watchers, CHANNELS.presetsChanged, store.presets());
    else notify(historyWatchers, CHANNELS.historyChanged, store.history());
  });

  /**
   * Add a window to a watcher set.
   *
   * Attached once per window, not once per call: a reload re-subscribes
   * through the same WebContents, and a listener per call accumulates.
   */
  const watch = (group: Set<WebContents>, contents: WebContents): void => {
    if (group.has(contents)) return;
    group.add(contents);
    contents.once('destroyed', () => group.delete(contents));
  };

  ipcMain.handle(
    CHANNELS.presetsList,
    guard(() => store.presets()),
  );
  ipcMain.handle(
    CHANNELS.presetsSubscribe,
    guard((event) => {
      watch(watchers, event.sender);
      // The current list comes back as part of subscribing, so there is no gap
      // in which a change could pass unseen.
      return store.presets();
    }),
  );
  ipcMain.handle(
    CHANNELS.presetsUpsert,
    guard((_event, preset: unknown) => store.upsertPreset(preset)),
  );
  ipcMain.handle(
    CHANNELS.presetsRemove,
    guard((_event, id: unknown) => store.removePreset(String(id))),
  );
  ipcMain.handle(
    CHANNELS.presetsImportLegacy,
    guard((_event, presets: unknown) => store.importLegacyPresets(presets)),
  );
  /**
   * What the preference currently resolves to, read from the OS.
   *
   * The renderer cannot work this out for itself under Electron: measured on
   * Electron 43, `matchMedia('(prefers-color-scheme: dark)')` inside the
   * renderer answers light on a dark Mac, whatever `nativeTheme.themeSource`
   * is set to. So the OS answer is main's, and it is published rather than
   * asked for — which is also what makes `system` change *live*.
   */
  const effectiveTheme = (): 'light' | 'dark' =>
    resolveTheme(store.settings().appearance, nativeTheme.shouldUseDarkColors);

  // The OS changed under a `system` preference. Nothing is stored: the
  // preference is still `system`, and only what it resolves to has moved.
  const onNativeThemeUpdated = (): void => {
    notify(themeWatchers, CHANNELS.themeChanged, effectiveTheme());
  };
  nativeTheme.on('updated', onNativeThemeUpdated);

  ipcMain.handle(
    CHANNELS.themeSubscribe,
    guard((event) => {
      watch(themeWatchers, event.sender);
      return effectiveTheme();
    }),
  );

  ipcMain.handle(
    CHANNELS.settingsSubscribe,
    guard((event) => {
      watch(settingsWatchers, event.sender);
      return store.settings();
    }),
  );
  ipcMain.handle(
    CHANNELS.settingsSave,
    guard(async (_event, raw: unknown) => {
      // Applied before it is stored, and what gets stored is what the OS
      // actually reports — not what was asked for. The other order remembers
      // a refusal as a success and then shows it as one.
      const requested = normalizeSettings(raw);
      const before = hooks.readLaunchAtLogin();
      const applied = hooks.applyLaunchAtLogin(requested.launchAtLogin);
      try {
        const settings = await store.saveSettings({ ...requested, launchAtLogin: applied });
        notify(settingsWatchers, CHANNELS.settingsChanged, settings);
        // After the write, never before: publishing a theme the store had not
        // accepted would leave every window showing something no file records.
        // `nativeTheme.themeSource` is deliberately not touched — see main.ts.
        notify(themeWatchers, CHANNELS.themeChanged, effectiveTheme());
        return settings;
      } catch (error) {
        // The disk refused. Put the machine back, or the two disagree
        // permanently: the form rolls back to the stored value while the
        // login item keeps the setting that was never recorded.
        if (before === null || before === applied) throw error;

        const restored = hooks.applyLaunchAtLogin(before);
        if (restored === before) throw error;

        // Both the write and the compensation failed, so the machine really
        // does differ from the file and nothing here can reconcile them — the
        // file is the thing that cannot be written. Saying only "could not
        // save" would leave the user with a login item they did not ask for
        // and no reason to suspect it, so the error carries the truth instead.
        throw new Error(
          `settings: not saved, and the launch-at-login setting could not be put back — it is now ${
            restored ? 'on' : 'off'
          }`,
          { cause: error },
        );
      }
    }),
  );
  ipcMain.handle(
    CHANNELS.historyList,
    guard(() => store.history()),
  );
  ipcMain.handle(
    CHANNELS.historySubscribe,
    guard((event) => {
      watch(historyWatchers, event.sender);
      return store.history();
    }),
  );
  ipcMain.handle(
    CHANNELS.historyRemove,
    guard((_event, id: unknown) => store.removeHistory(String(id))),
  );
}
