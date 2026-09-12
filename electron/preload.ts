/**
 * Preload bridge.
 *
 * Narrow and explicit: each capability is its own method, and there is no
 * generic `invoke` passthrough that would let renderer code reach any channel
 * it liked.
 *
 * The renderer must treat `window.desktop` as optional and degrade cleanly
 * when it is absent. That is what keeps Studio runnable in a plain browser,
 * and it is the fastest way to exercise the UI.
 *
 * Note what is missing: there is no way to append to history. Only the session
 * coordinator writes records, so exposing one here would let a renderer forge
 * or duplicate entries.
 *
 * Step 4 extends this with audio-device inspection and loopback capture.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from './ipc.ts';
import type { ExecutorMessage } from '../src/session/executor-link.ts';
import type { Published } from '../src/session/session-hub.ts';
import type { Preset } from '../src/audio/presets.ts';
import type { SessionRecord } from '../src/session/session.ts';
import type { ImportResult } from './store.ts';
import type { Settings } from '../src/session/settings.ts';

export interface DesktopBridge {
  readonly platform: NodeJS.Platform;
  /**
   * Whether this is an installed build rather than a development one.
   *
   * Some settings only mean anything once there is an app to apply them to —
   * launch at login registers an executable, and in development that
   * executable is Electron itself.
   */
  readonly packaged: boolean;
  readonly versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  readonly presets: {
    list(): Promise<Preset[]>;
    /**
     * Watch the saved presets, receiving the current list as part of
     * subscribing.
     *
     * The popover is hidden rather than closed between uses and cannot detect
     * being shown, so it is told when the list changes instead.
     */
    subscribe(onChange: (presets: Preset[]) => void): Promise<Preset[]>;
    /**
     * Add or replace one preset.
     *
     * Addressed by id rather than replacing the whole list, which would lose a
     * concurrent addition made from the same earlier snapshot.
     */
    upsert(preset: Preset): Promise<Preset[]>;
    remove(id: string): Promise<Preset[]>;
    /**
     * Hand over presets found in `localStorage`.
     *
     * Only stop reading local storage once the result is acknowledged: an
     * unacknowledged import means the store kept nothing.
     */
    importLegacy(presets: Preset[]): Promise<ImportResult>;
  };
  readonly history: {
    list(): Promise<SessionRecord[]>;
    /**
     * Watch the log, receiving it as part of subscribing.
     *
     * Every surface that shows listening time, the advisory, or recall reads
     * this, and any of them can be showing when another deletes a record or
     * the coordinator records a session.
     */
    subscribe(onChange: (records: SessionRecord[]) => void): Promise<SessionRecord[]>;
    remove(id: string): Promise<SessionRecord[]>;
  };
  readonly session: {
    /**
     * Watch session state, receiving the current snapshot as part of
     * subscribing.
     *
     * One step on purpose: reading and then listening would leave a window in
     * which a change passes unseen, and a popover opened mid-session would be
     * left guessing. Later events carry strictly increasing revisions, so one
     * arriving late or out of order can be discarded.
     */
    subscribe(onChange: (update: Published<unknown>) => void): Promise<Published<unknown>>;
    start(request: unknown): Promise<unknown>;
    stop(reason: unknown): Promise<unknown>;
    preview(configuration: unknown): Promise<unknown>;
  };
  readonly settings: {
    /**
     * Watch the settings, receiving the current values as part of
     * subscribing.
     *
     * Both windows read the advisory threshold, and either can be showing
     * when the other changes it.
     */
    subscribe(onChange: (settings: Settings) => void): Promise<Settings>;
    /**
     * Replace all of them.
     *
     * Whole-object rather than per-field: there are three, they are always
     * presented together, and a partial update needs a merge whose behaviour
     * on an unknown field is another decision to get wrong.
     */
    save(settings: Settings): Promise<Settings>;
  };
  readonly theme: {
    /**
     * Watch the *effective* colour scheme, receiving it as part of
     * subscribing.
     *
     * Separate from `settings` because it answers a different question. The
     * setting is the preference — light, dark, or follow the system — and this
     * is what that currently resolves to. Under `system` the preference never
     * changes while this does, so a renderer watching only the settings would
     * never learn that the OS had switched.
     *
     * It exists at all because a renderer cannot read the OS here: on Electron
     * 43 `prefers-color-scheme` reports light inside the renderer on a dark
     * machine, whatever `nativeTheme.themeSource` is. The main process can read
     * it, so it does, and tells.
     */
    subscribe(onChange: (theme: 'light' | 'dark') => void): Promise<'light' | 'dark'>;
  };
  readonly windows: {
    /** Bring Studio to the front, from the popover's "Open Studio". */
    showStudio(): Promise<void>;
    /**
     * Ask to be as tall as this window's content. Popover only; the main
     * process checks the sender and clamps the value.
     */
    setPopoverHeight(pixels: number): Promise<void>;
  };
  /**
   * Studio only. Present in every window, but the main process checks the
   * sender, so it is useful only to the renderer holding the audio graph.
   */
  readonly executor: {
    register(onMessage: (message: ExecutorMessage) => void): Promise<number>;
    /** Names the generation `register` returned, so a stale renderer cannot. */
    markReady(generation: number): Promise<boolean>;
    acknowledge(id: number, generation: number, result: unknown, error?: string): Promise<boolean>;
    /**
     * Report an edit made while a session is running.
     *
     * Names the generation `register` returned, so a report from a superseded
     * instance cannot overwrite the current one's configuration.
     */
    reportConfiguration(generation: number, configuration: unknown): Promise<boolean>;
    /**
     * Report what the integrity checks measured during a session.
     *
     * Names the generation and the session it is about: the same window
     * re-registers after a reload, and a fast stop-and-start keeps the
     * generation while changing the session. Resolving false means the report
     * was refused — a superseded executor, or a session that has ended — not
     * that the audio was found wanting.
     */
    reportIntegrity(generation: number, sessionId: string, report: unknown): Promise<boolean>;
  };
}

/**
 * One listener per channel, installed once.
 *
 * Adding a listener per call would stack them: subscribing twice, or an
 * executor re-registering in the same renderer, would run every later message
 * through each handler that had ever been installed — so a command would be
 * executed more than once. The current handler is swapped instead.
 *
 * The consequence is that the *renderer* must fan out. One slot per channel
 * means the last component to subscribe in a window displaces the one before
 * it, which is not a hypothetical: opening the Settings dialog took over the
 * session panel's settings subscription and closing it left the replacement
 * installed. `src/renderer/lib/fan-out.ts` is where that is handled; nothing
 * should call these directly.
 */
let onPresetsChanged: ((presets: Preset[]) => void) | null = null;
let onHistoryChanged: ((records: SessionRecord[]) => void) | null = null;
let onSettingsChanged: ((settings: Settings) => void) | null = null;
let onThemeChanged: ((theme: 'light' | 'dark') => void) | null = null;
let onSessionChanged: ((update: Published<unknown>) => void) | null = null;
let onExecutorMessage: ((message: ExecutorMessage) => void) | null = null;

ipcRenderer.on(CHANNELS.presetsChanged, (_event, presets: Preset[]) => {
  onPresetsChanged?.(presets);
});
ipcRenderer.on(CHANNELS.historyChanged, (_event, records: SessionRecord[]) => {
  onHistoryChanged?.(records);
});
ipcRenderer.on(CHANNELS.settingsChanged, (_event, settings: Settings) => {
  onSettingsChanged?.(settings);
});
ipcRenderer.on(CHANNELS.themeChanged, (_event, theme: 'light' | 'dark') => {
  onThemeChanged?.(theme);
});
ipcRenderer.on(CHANNELS.sessionChanged, (_event, update: Published<unknown>) => {
  onSessionChanged?.(update);
});
ipcRenderer.on(CHANNELS.executorCommand, (_event, message: ExecutorMessage) => {
  onExecutorMessage?.(message);
});

const bridge: DesktopBridge = {
  platform: process.platform,
  // `app` is not available in a sandboxed preload; main sets this on argv.
  packaged: process.argv.includes('--fortyhz-packaged'),
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  presets: {
    list: () => ipcRenderer.invoke(CHANNELS.presetsList),
    subscribe: (onChange) => {
      onPresetsChanged = onChange;
      return ipcRenderer.invoke(CHANNELS.presetsSubscribe);
    },
    upsert: (preset) => ipcRenderer.invoke(CHANNELS.presetsUpsert, preset),
    remove: (id) => ipcRenderer.invoke(CHANNELS.presetsRemove, id),
    importLegacy: (presets) => ipcRenderer.invoke(CHANNELS.presetsImportLegacy, presets),
  },
  history: {
    list: () => ipcRenderer.invoke(CHANNELS.historyList),
    subscribe: (onChange) => {
      onHistoryChanged = onChange;
      return ipcRenderer.invoke(CHANNELS.historySubscribe);
    },
    remove: (id) => ipcRenderer.invoke(CHANNELS.historyRemove, id),
  },
  session: {
    subscribe: (onChange) => {
      onSessionChanged = onChange;
      return ipcRenderer.invoke(CHANNELS.sessionSubscribe);
    },
    start: (request) => ipcRenderer.invoke(CHANNELS.sessionStart, request),
    stop: (reason) => ipcRenderer.invoke(CHANNELS.sessionStop, reason),
    preview: (configuration) => ipcRenderer.invoke(CHANNELS.sessionPreview, configuration),
  },
  settings: {
    subscribe: (onChange) => {
      onSettingsChanged = onChange;
      return ipcRenderer.invoke(CHANNELS.settingsSubscribe);
    },
    save: (settings) => ipcRenderer.invoke(CHANNELS.settingsSave, settings),
  },
  theme: {
    subscribe: (onChange) => {
      onThemeChanged = onChange;
      return ipcRenderer.invoke(CHANNELS.themeSubscribe);
    },
  },
  windows: {
    showStudio: () => ipcRenderer.invoke(CHANNELS.windowsShowStudio),
    setPopoverHeight: (pixels) => ipcRenderer.invoke(CHANNELS.windowsPopoverHeight, pixels),
  },
  executor: {
    register: (onMessage) => {
      onExecutorMessage = onMessage;
      return ipcRenderer.invoke(CHANNELS.executorRegister, null);
    },
    markReady: (generation) => ipcRenderer.invoke(CHANNELS.executorRegister, generation),
    acknowledge: (id, generation, result, error) =>
      ipcRenderer.invoke(CHANNELS.executorAck, id, generation, result, error),
    reportConfiguration: (generation, configuration) =>
      ipcRenderer.invoke(CHANNELS.executorConfiguration, generation, configuration),
    reportIntegrity: (generation, sessionId, report) =>
      ipcRenderer.invoke(CHANNELS.executorIntegrity, generation, sessionId, report),
  },
};

contextBridge.exposeInMainWorld('desktop', bridge);
