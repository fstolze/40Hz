/**
 * Where the renderer reads and writes presets and history.
 *
 * Two backends behind one interface. Under Electron the main process owns the
 * data, because Studio and the Session popover are separate renderers and
 * cannot share `localStorage`. In a plain browser there is no main process, so
 * `localStorage` remains the store — which is what keeps Studio runnable under
 * `npm run dev:web` and the UI exercisable without launching Electron.
 *
 * Everything is asynchronous even in the browser, so the calling code does not
 * change shape between the two.
 */

import {
  loadUserPresets,
  saveUserPresets,
  normalizePreset,
  type Preset,
} from '../../audio/presets.ts';
import { normalizeSettings, type Settings } from '../../session/settings.ts';
import { readHistory, writeHistory } from './browser-history.ts';
import { fanOut, type Unsubscribe } from './fan-out.ts';
import type { SessionRecord } from '../../session/session.ts';

export interface PresetStore {
  list(): Promise<Preset[]>;
  /**
   * Watch the saved presets, receiving them immediately.
   *
   * Returns the function that stops watching. Components mount and unmount —
   * a dialog's panel mounts every time it opens — and a listener that is never
   * removed accumulates and writes into a component nobody can see.
   */
  subscribe(onChange: (presets: Preset[]) => void): Unsubscribe;
  /**
   * Add or replace one preset.
   *
   * Addressed by id rather than by replacing the whole list: two callers
   * working from the same earlier snapshot, one adding A and one adding B,
   * would otherwise finish with only whichever wrote last.
   */
  upsert(preset: Preset): Promise<Preset[]>;
  remove(id: string): Promise<Preset[]>;
}

export interface HistoryStore {
  list(): Promise<SessionRecord[]>;
  /**
   * Watch the log, receiving it immediately. Returns the function that stops.
   *
   * Listening totals, the advisory and recall all read this, and any surface
   * can be showing when another deletes a record or a session is recorded.
   */
  subscribe(onChange: (records: SessionRecord[]) => void): Unsubscribe;
  remove(id: string): Promise<SessionRecord[]>;
}

export interface SettingsStore {
  /**
   * Watch the settings, receiving them immediately. Returns the function that
   * stops watching.
   *
   * Both windows read the advisory threshold and either can be showing when
   * the other changes it, so this is a subscription rather than a read.
   */
  subscribe(onChange: (settings: Settings) => void): Unsubscribe;
  save(settings: Settings): Promise<Settings>;
}

const LEGACY_PRESETS_KEY = 'fortyhz.presets.v1';
const BROWSER_SETTINGS_KEY = 'fortyhz.settings.v1';

function readLegacyPresets(): Preset[] {
  try {
    const raw = globalThis.localStorage?.getItem(LEGACY_PRESETS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizePreset).filter((p): p is Preset => p !== null);
  } catch {
    return [];
  }
}

function writeLegacyPresets(presets: readonly Preset[]): void {
  try {
    globalThis.localStorage?.setItem(LEGACY_PRESETS_KEY, JSON.stringify(presets));
  } catch {
    // Storage unavailable. Nothing else to do.
  }
}

function clearLegacyPresets(): void {
  try {
    globalThis.localStorage?.removeItem(LEGACY_PRESETS_KEY);
  } catch {
    // Left behind. The import is idempotent, so a later run imports nothing.
  }
}

/** Later entries do not displace earlier ones with the same id. */
function mergeById(primary: readonly Preset[], extra: readonly Preset[]): Preset[] {
  const known = new Set(primary.map((p) => p.id));
  return [...primary, ...extra.filter((p) => !known.has(p.id))];
}

/**
 * Hand any presets still in `localStorage` to the main process.
 *
 * Resolves true once the store is the authority. The key is cleared only then:
 * an unacknowledged import means the store kept nothing, and clearing anyway
 * would lose the user's saved presets outright. Unparseable storage yields
 * nothing to import and is left untouched, since it may still be recoverable
 * by hand.
 */
async function attemptMigration(bridge: NonNullable<Window['desktop']>): Promise<boolean> {
  const legacy = readLegacyPresets();
  if (legacy.length === 0) return true;
  try {
    const result = await bridge.presets.importLegacy(legacy);
    if (!result.acknowledged) return false;
    clearLegacyPresets();
    return true;
  } catch {
    return false;
  }
}

/**
 * Exported for testing.
 *
 * The module-level singleton binds to `window.desktop` at import, which a
 * test cannot supply — and the behaviour worth proving is precisely what this
 * does with a bridge that misbehaves.
 */
export function createDesktopStores(bridge: NonNullable<Window['desktop']>): {
  settings: SettingsStore;
  presets: PresetStore;
  history: HistoryStore;
} {
  let acknowledged = false;
  let inFlight: Promise<boolean> | null = null;

  /**
   * Migrate if it has not succeeded yet.
   *
   * A failure is not cached: the next call tries again, so a transient error
   * does not strand the user's presets for the rest of the session.
   */
  const ensureMigrated = (): Promise<boolean> => {
    if (acknowledged) return Promise.resolve(true);
    inFlight ??= attemptMigration(bridge).then((ok) => {
      acknowledged = ok;
      inFlight = null;
      return ok;
    });
    return inFlight;
  };

  /**
   * The store's presets, plus anything migration has not yet rescued.
   *
   * Until the import is acknowledged, `localStorage` is still the authority
   * for what it holds. Returning only the store's copy would make the user's
   * saved presets vanish from the UI while they sit intact in a file.
   */
  const list = async (): Promise<Preset[]> => {
    const migrated = await ensureMigrated();
    const stored = await bridge.presets.list();
    return migrated ? stored : mergeById(stored, readLegacyPresets());
  };

  return {
    presets: {
      list,
      subscribe: fanOut((onChange) => bridge.presets.subscribe(onChange)),
      async upsert(preset) {
        await ensureMigrated();
        await bridge.presets.upsert(preset);
        return list();
      },
      async remove(id) {
        await ensureMigrated();
        await bridge.presets.remove(id);
        // Also drop it from storage still awaiting migration, or the next
        // list would resurrect what the user just deleted.
        const legacy = readLegacyPresets();
        if (legacy.some((p) => p.id === id)) {
          writeLegacyPresets(legacy.filter((p) => p.id !== id));
        }
        return list();
      },
    },
    history: {
      list: () => bridge.history.list(),
      subscribe: fanOut((onChange) => bridge.history.subscribe(onChange)),
      remove: (id) => bridge.history.remove(id),
    },
    settings: {
      // Fanned out here rather than in the preload: the preload keeps one
      // handler slot per channel on purpose, so without this the last
      // component to subscribe in a window displaces the one before it.
      subscribe: fanOut((onChange) => bridge.settings.subscribe(onChange)),
      save: (settings) => bridge.settings.save(settings),
    },
  };
}

/**
 * Subscribers in the browser build.
 *
 * There is no main process to broadcast from, so the store keeps its own
 * listeners and tells them when it writes. Without this, changing the advisory
 * in Settings left the already-mounted session panel on the previous values
 * until the page reloaded — the same staleness the desktop build broadcasts to
 * avoid, and easy to miss because only `dev:web` shows it.
 */
function emitter<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    add(listener: (value: T) => void): void {
      listeners.add(listener);
    },
    announce(value: T): void {
      for (const listener of [...listeners]) listener(value);
    },
  };
}

const browserSettingsChanged = emitter<Settings>();
const browserHistoryChanged = emitter<SessionRecord[]>();
const browserPresetsChanged = emitter<Preset[]>();

/**
 * Announce a history write made outside this module.
 *
 * The browser coordinator appends completed sessions through
 * `browser-session-storage.ts`, not through this store, so without this the
 * subscription would deliver deletions and miss every session actually run —
 * exactly the gap the desktop build avoids by announcing from the store the
 * coordinator writes to.
 */
export function noteBrowserHistoryChanged(records: readonly SessionRecord[]): void {
  browserHistoryChanged.announce([...records]);
}

function readBrowserSettings(): Settings {
  try {
    const raw = globalThis.localStorage?.getItem(BROWSER_SETTINGS_KEY);
    // `normalizeSettings` answers the defaults for anything unusable, so a
    // missing or corrupt value needs no branch of its own.
    return normalizeSettings(raw ? (JSON.parse(raw) as unknown) : undefined);
  } catch {
    return normalizeSettings(undefined);
  }
}

// Both directions live in `browser-history.ts`: this module and the session
// storage the coordinator writes through were parsing the same key with two
// copies of the same code, which is a format that drifts.
const readBrowserHistory = readHistory;
const writeBrowserHistory = writeHistory;

export function createBrowserStores(): {
  presets: PresetStore;
  history: HistoryStore;
  settings: SettingsStore;
} {
  return {
    presets: {
      list: async () => loadUserPresets(),
      subscribe: fanOut(async (onChange) => {
        browserPresetsChanged.add(onChange);
        return loadUserPresets();
      }),
      async upsert(preset) {
        const existing = loadUserPresets();
        const next = existing.some((p) => p.id === preset.id)
          ? existing.map((p) => (p.id === preset.id ? preset : p))
          : [...existing, preset];
        saveUserPresets(next);
        const saved = loadUserPresets();
        browserPresetsChanged.announce(saved);
        return saved;
      },
      async remove(id) {
        saveUserPresets(loadUserPresets().filter((p) => p.id !== id));
        const saved = loadUserPresets();
        browserPresetsChanged.announce(saved);
        return saved;
      },
    },
    settings: {
      subscribe: fanOut(async (onChange) => {
        browserSettingsChanged.add(onChange);
        return readBrowserSettings();
      }),
      save: async (settings) => {
        const next = normalizeSettings(settings);
        try {
          globalThis.localStorage?.setItem(BROWSER_SETTINGS_KEY, JSON.stringify(next));
        } catch {
          // Storage unavailable (private mode, quota). Settings stay in memory.
        }
        browserSettingsChanged.announce(next);
        return next;
      },
    },
    history: {
      list: async () => readBrowserHistory(),
      subscribe: fanOut(async (onChange) => {
        browserHistoryChanged.add(onChange);
        return readBrowserHistory();
      }),
      async remove(id) {
        const left = readBrowserHistory().filter((r) => r.id !== id);
        writeBrowserHistory(left);
        browserHistoryChanged.announce(left);
        return left;
      },
    },
  };
}

const bridge = globalThis.window?.desktop;
const stores = bridge ? createDesktopStores(bridge) : createBrowserStores();

export const presetStore: PresetStore = stores.presets;
export const historyStore: HistoryStore = stores.history;
export const settingsStore: SettingsStore = stores.settings;

/** True when the main process owns the data rather than `localStorage`. */
export const isDesktopStore = Boolean(bridge);
