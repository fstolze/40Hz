/**
 * The renderer's view of presets while migration is still pending.
 *
 * The requirement is that the renderer keeps returning what is in
 * `localStorage` until the store acknowledges it is the authority. The store
 * side of that is covered in store.test.ts; this is the half that decides
 * whether the user can still *see* their presets — which is where a failed
 * import would actually hurt.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { createBrowserStores, createDesktopStores } from '../src/renderer/lib/stores.ts';
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from '../src/session/settings.ts';
import { defaultConfiguration } from '../src/audio/configuration.ts';
import type { Preset } from '../src/audio/presets.ts';

const LEGACY_KEY = 'fortyhz.presets.v1';

function preset(id: string, name = id): Preset {
  return {
    id,
    name,
    description: '',
    params: defaultConfiguration().params,
    soundscape: defaultConfiguration().soundscape,
    masterLevel: 0.5,
    builtIn: false,
  };
}

/** A localStorage stub backed by a plain map. */
function installStorage(initial: Record<string, string> = {}): Map<string, string> {
  const cells = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => cells.get(k) ?? null,
      setItem: (k: string, v: string) => cells.set(k, v),
      removeItem: (k: string) => cells.delete(k),
    },
  });
  return cells;
}

interface FakeBridgeOptions {
  acknowledge?: boolean;
  throwOnImport?: boolean;
}

/** A stand-in for the main process, with a store that starts empty. */
function fakeBridge(options: FakeBridgeOptions = {}) {
  const held: Preset[] = [];
  let importCalls = 0;
  let stored: Settings = { ...DEFAULT_SETTINGS };
  let settingsListener: ((settings: Settings) => void) | null = null;
  const bridge = {
    presets: {
      list: async () => held.map((p) => ({ ...p })),
      upsert: async (p: Preset) => {
        held.push(p);
        return held.map((x) => ({ ...x }));
      },
      remove: async (id: string) => {
        const i = held.findIndex((p) => p.id === id);
        if (i >= 0) held.splice(i, 1);
        return held.map((x) => ({ ...x }));
      },
      importLegacy: async (presets: Preset[]) => {
        importCalls++;
        if (options.throwOnImport === true) throw new Error('main is unreachable');
        if (options.acknowledge === false) return { imported: 0, acknowledged: false };
        held.push(...presets);
        return { imported: presets.length, acknowledged: true };
      },
    },
    history: { list: async () => [], remove: async () => [] },
    settings: {
      // The real contract: subscribing hands back the current value *and*
      // registers for later ones. A fake that only registered would let a
      // consumer that ignores the returned value pass.
      subscribe: async (onChange: (settings: Settings) => void) => {
        settingsListener = onChange;
        return { ...stored };
      },
      save: async (next: Settings) => {
        stored = normalizeSettings(next);
        settingsListener?.({ ...stored });
        return { ...stored };
      },
    },
  };
  return {
    bridge: bridge as unknown as NonNullable<Window['desktop']>,
    held,
    calls: () => importCalls,
    /** Push a change the way the main process would, without a save. */
    announce: (next: Settings) => {
      stored = normalizeSettings(next);
      settingsListener?.({ ...stored });
    },
  };
}

describe('a successful migration', () => {
  it('hands the presets over and clears storage', async () => {
    const cells = installStorage({ [LEGACY_KEY]: JSON.stringify([preset('old-1')]) });
    const { bridge, held } = fakeBridge();

    const listed = await createDesktopStores(bridge).presets.list();

    expect(listed.length).toBe(1);
    expect(held.length).toBe(1);
    // Acknowledged, so storage is no longer the authority.
    expect(cells.has(LEGACY_KEY)).toBe(false);
  });

  it('migrates once, not on every call', async () => {
    installStorage({ [LEGACY_KEY]: JSON.stringify([preset('old-1')]) });
    const { bridge, calls } = fakeBridge();
    const stores = createDesktopStores(bridge);
    await stores.presets.list();
    await stores.presets.list();
    await stores.presets.list();
    expect(calls()).toBe(1);
  });
});

describe('a migration that is not acknowledged', () => {
  it('still shows the presets sitting in storage', async () => {
    // The store kept nothing. Returning only its copy would make the user's
    // presets vanish from the UI while they sit intact in a file.
    installStorage({ [LEGACY_KEY]: JSON.stringify([preset('old-1'), preset('old-2')]) });
    const { bridge } = fakeBridge({ acknowledge: false });

    const listed = await createDesktopStores(bridge).presets.list();

    expect(
      listed
        .map((p) => p.id)
        .sort()
        .join(','),
    ).toBe('old-1,old-2');
  });

  it('keeps the storage key, so nothing is lost', async () => {
    const cells = installStorage({ [LEGACY_KEY]: JSON.stringify([preset('old-1')]) });
    const { bridge } = fakeBridge({ acknowledge: false });
    await createDesktopStores(bridge).presets.list();
    expect(cells.has(LEGACY_KEY)).toBe(true);
  });

  it('retries rather than stranding the presets for the session', async () => {
    installStorage({ [LEGACY_KEY]: JSON.stringify([preset('old-1')]) });
    const { bridge, calls } = fakeBridge({ acknowledge: false });
    const stores = createDesktopStores(bridge);
    await stores.presets.list();
    await stores.presets.list();
    // A failure is not cached: each call tries again.
    expect(calls()).toBe(2);
  });

  it('does the same when the import throws outright', async () => {
    const cells = installStorage({ [LEGACY_KEY]: JSON.stringify([preset('old-1')]) });
    const { bridge } = fakeBridge({ throwOnImport: true });
    const listed = await createDesktopStores(bridge).presets.list();
    expect(listed.map((p) => p.id).join(',')).toBe('old-1');
    expect(cells.has(LEGACY_KEY)).toBe(true);
  });

  it('does not show a preset twice when the store already has it', async () => {
    installStorage({ [LEGACY_KEY]: JSON.stringify([preset('shared')]) });
    const { bridge, held } = fakeBridge({ acknowledge: false });
    held.push(preset('shared'));
    const listed = await createDesktopStores(bridge).presets.list();
    expect(listed.length).toBe(1);
  });

  it('does not resurrect a preset the user deleted', async () => {
    // Deleting must reach storage too, or the next list brings it back.
    const cells = installStorage({
      [LEGACY_KEY]: JSON.stringify([preset('old-1'), preset('old-2')]),
    });
    const { bridge } = fakeBridge({ acknowledge: false });
    const stores = createDesktopStores(bridge);
    await stores.presets.list();

    const left = await stores.presets.remove('old-1');

    expect(left.map((p) => p.id).join(',')).toBe('old-2');
    const stored: Preset[] = JSON.parse(cells.get(LEGACY_KEY) ?? '[]');
    expect(stored.map((p) => p.id).join(',')).toBe('old-2');
  });
});

describe('storage the migration cannot use', () => {
  it('leaves unparseable storage alone rather than importing nothing over it', async () => {
    const cells = installStorage({ [LEGACY_KEY]: '{ not json' });
    const { bridge, calls } = fakeBridge();
    const listed = await createDesktopStores(bridge).presets.list();
    expect(listed.length).toBe(0);
    expect(calls()).toBe(0);
    // It may still be recoverable by hand.
    expect(cells.has(LEGACY_KEY)).toBe(true);
  });

  it('treats an empty storage as nothing to do', async () => {
    installStorage({});
    const { bridge, calls } = fakeBridge();
    const listed = await createDesktopStores(bridge).presets.list();
    expect(listed.length).toBe(0);
    expect(calls()).toBe(0);
  });
});

describe('the appearance preference at the renderer boundary', () => {
  /**
   * Both backends, one contract.
   *
   * Appearance is the first setting the *renderer* acts on directly — it
   * decides what the whole interface looks like — so the way it arrives
   * matters as much as the way it is stored. The trap it is most exposed to is
   * the one this repo has already been caught by: subscribing returns the
   * current value and calls back only for later changes, so a consumer that
   * uses the callback alone sits on its defaults until something unrelated
   * happens to change a setting. That failure is silent and looks exactly like
   * "the user has not chosen a theme yet".
   */
  it('hands the desktop consumer the stored value as part of subscribing', async () => {
    const { bridge } = fakeBridge();
    const stores = createDesktopStores(bridge);

    await stores.settings.save({ ...DEFAULT_SETTINGS, appearance: 'light' });

    // A consumer that subscribes *after* the value was set — which is every
    // dialog, and the theme coordinator after a reload.
    const seen: Settings[] = [];
    const stop = stores.settings.subscribe((settings) => {
      seen.push(settings);
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(seen.at(-1)?.appearance).toBe('light');
    stop();
  });

  it('delivers a later change to an already-subscribed desktop consumer', async () => {
    const { bridge, announce } = fakeBridge();
    const stores = createDesktopStores(bridge);

    const seen: string[] = [];
    const stop = stores.settings.subscribe((settings) => {
      seen.push(settings.appearance);
    });
    await Promise.resolve();
    await Promise.resolve();

    // As the main process would when the value changed in the other window.
    announce({ ...DEFAULT_SETTINGS, appearance: 'dark' });

    expect(seen.includes('dark')).toBe(true);
    stop();
  });

  it('round-trips through browser storage and announces the change', async () => {
    const cells = installStorage();
    const stores = createBrowserStores();

    const seen: string[] = [];
    const stop = stores.settings.subscribe((settings) => {
      seen.push(settings.appearance);
    });
    await Promise.resolve();
    await Promise.resolve();

    await stores.settings.save({ ...DEFAULT_SETTINGS, appearance: 'light' });

    // Announced to the surface that was already watching...
    expect(seen.includes('light')).toBe(true);
    // ...and durable, rather than only held in memory.
    const raw = cells.get('fortyhz.settings.v1');
    expect(raw === undefined).toBe(false);
    expect((JSON.parse(raw ?? '{}') as Settings).appearance).toBe('light');
    stop();
  });

  it('normalizes an appearance the browser store cannot render', async () => {
    // `localStorage` is untrusted input like a file: hand-editable, and it
    // outlives the version that wrote it.
    installStorage({
      'fortyhz.settings.v1': JSON.stringify({ ...DEFAULT_SETTINGS, appearance: 'solarized' }),
    });
    const stores = createBrowserStores();

    const seen: Settings[] = [];
    const stop = stores.settings.subscribe((settings) => {
      seen.push(settings);
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(seen.at(-1)?.appearance).toBe(DEFAULT_SETTINGS.appearance);
    stop();
  });
});
