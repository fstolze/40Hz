/**
 * The main-process store.
 *
 * Runs against a real temporary directory rather than a mocked filesystem: the
 * properties worth proving here — that a crash cannot truncate a file, that
 * concurrent saves do not lose each other, that a newer file is not rewritten
 * in an older shape — are properties of actual file operations.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Store,
  StoreReadOnlyError,
  HISTORY_VERSION,
  PRESETS_VERSION,
  SETTINGS_VERSION,
} from '../electron/store.ts';
import { DEFAULT_SETTINGS } from '../src/session/settings.ts';
import {
  DEFAULT_MASTER_LEVEL,
  DEFAULT_SOUNDSCAPE,
  defaultConfiguration,
} from '../src/audio/configuration.ts';
import { DEFAULT_PARAMS } from '../src/audio/dsp/entrainment-core.ts';

async function freshStore(): Promise<{ store: Store; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'fortyhz-store-'));
  const store = new Store(dir);
  await store.load();
  return { store, dir };
}

function preset(id: string, name = id): Record<string, unknown> {
  return {
    id,
    name,
    description: '',
    params: defaultConfiguration().params,
    soundscape: defaultConfiguration().soundscape,
    masterLevel: 0.5,
  };
}

function record(id: string, startedAt = 1_700_000_000_000): Record<string, unknown> {
  return {
    id,
    presetId: 'focus',
    startedAt,
    plannedSeconds: 600,
    actualSeconds: 600,
    completionReason: 'completed',
    integrityStatus: 'unknown',
    initialConfiguration: defaultConfiguration(),
    finalConfiguration: defaultConfiguration(),
    edited: false,
  };
}

describe('first run', () => {
  it('starts empty without a file, and creates the directory', async () => {
    const { store } = await freshStore();
    expect(store.presets().length).toBe(0);
    expect(store.history().length).toBe(0);
    expect(store.readOnly).toBe(false);
  });

  it('round-trips presets through a reload', async () => {
    const { store, dir } = await freshStore();
    await store.savePresets([preset('a', 'Alpha')]);

    const reopened = new Store(dir);
    await reopened.load();
    expect(reopened.presets().length).toBe(1);
    expect(reopened.presets()[0].name).toBe('Alpha');
  });

  it('writes a version alongside the records', async () => {
    const { store, dir } = await freshStore();
    await store.savePresets([preset('a')]);
    const raw: unknown = JSON.parse(await readFile(join(dir, 'presets.json'), 'utf8'));
    expect((raw as { version: number }).version).toBe(PRESETS_VERSION);
  });

  it('leaves no temporary files behind', async () => {
    const { store, dir } = await freshStore();
    await store.savePresets([preset('a')]);
    await store.appendHistory(record('r1'));
    const left = (await readdir(dir)).filter((f) => f.endsWith('.tmp'));
    expect(left.length).toBe(0);
  });
});

describe('untrusted files', () => {
  it('normalizes a corrupt preset rather than crashing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fortyhz-store-'));
    await writeFile(
      join(dir, 'presets.json'),
      JSON.stringify({
        version: 1,
        records: [
          { id: 'x', name: 'X', params: { carrierHz: null }, soundscape: { color: 'puce' } },
        ],
      }),
      'utf8',
    );
    const store = new Store(dir);
    await store.load();
    expect(store.presets().length).toBe(1);
    expect(store.presets()[0].soundscape.color).toBe('pink');
  });

  it('drops entries that are not records at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fortyhz-store-'));
    await writeFile(
      join(dir, 'history.json'),
      JSON.stringify({ version: 1, records: [record('good'), null, 'nope', { id: 'no-start' }] }),
      'utf8',
    );
    const store = new Store(dir);
    await store.load();
    expect(store.history().length).toBe(1);
    expect(store.history()[0].id).toBe('good');
  });

  it('reads the pre-versioning bare-array shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fortyhz-store-'));
    await writeFile(join(dir, 'presets.json'), JSON.stringify([preset('legacy')]), 'utf8');
    const store = new Store(dir);
    await store.load();
    expect(store.presets().length).toBe(1);
    expect(store.readOnly).toBe(false);
  });

  it('refuses to rewrite a file from a newer build', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fortyhz-store-'));
    const future = JSON.stringify({ version: 99, records: [preset('theirs')] });
    await writeFile(join(dir, 'presets.json'), future, 'utf8');

    const store = new Store(dir);
    await store.load();
    expect(store.readOnly).toBe(true);

    // Reporting success would be worse than failing: the caller would believe
    // the write landed. It refuses, and the newer file is left exactly as it
    // was rather than rewritten in a shape that drops whatever it added.
    let refused = false;
    await store.savePresets([preset('mine')]).catch((e: unknown) => {
      refused = e instanceof StoreReadOnlyError;
    });
    expect(refused).toBe(true);
    expect(await readFile(join(dir, 'presets.json'), 'utf8')).toBe(future);
  });

  it('handles valid JSON that is not an object', async () => {
    // `null` parses fine and used to throw on the property access, taking
    // down startup rather than being treated as the corruption it is.
    for (const body of ['null', '42', '"a string"', 'true']) {
      const dir = await mkdtemp(join(tmpdir(), 'fortyhz-store-'));
      await writeFile(join(dir, 'presets.json'), body, 'utf8');
      const store = new Store(dir);
      await store.load();
      expect(store.presets().length).toBe(0);
      expect(store.readOnly).toBe(true);
    }
  });

  it('handles a records field that is not an array', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fortyhz-store-'));
    await writeFile(
      join(dir, 'presets.json'),
      JSON.stringify({ version: 1, records: 'no' }),
      'utf8',
    );
    const store = new Store(dir);
    await store.load();
    expect(store.presets().length).toBe(0);
    expect(store.readOnly).toBe(true);
  });

  it('does not overwrite an unparseable file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fortyhz-store-'));
    await writeFile(join(dir, 'presets.json'), '{ this is not json', 'utf8');
    const store = new Store(dir);
    await store.load();
    expect(store.readOnly).toBe(true);
    let refused = false;
    await store.savePresets([preset('mine')]).catch((e: unknown) => {
      refused = e instanceof StoreReadOnlyError;
    });
    expect(refused).toBe(true);
    expect(await readFile(join(dir, 'presets.json'), 'utf8')).toBe('{ this is not json');
  });
});

describe('serialized mutations', () => {
  it('does not lose concurrent appends', async () => {
    const { store, dir } = await freshStore();
    // Fired together without awaiting between: unserialized, each would read
    // the same list and the last write would drop the others.
    await Promise.all([
      store.appendHistory(record('r1')),
      store.appendHistory(record('r2')),
      store.appendHistory(record('r3')),
    ]);
    expect(store.history().length).toBe(3);

    const reopened = new Store(dir);
    await reopened.load();
    expect(reopened.history().length).toBe(3);
  });

  it('does not lose a concurrent save and remove', async () => {
    const { store } = await freshStore();
    await store.savePresets([preset('a'), preset('b')]);
    await Promise.all([
      store.savePresets([preset('a'), preset('b'), preset('c')]),
      store.removePreset('a'),
    ]);
    const ids = store
      .presets()
      .map((p) => p.id)
      .sort()
      .join(',');
    expect(ids).toBe('b,c');
  });
});

describe('history', () => {
  it('carries integrity coverage to disk and back', async () => {
    const { store, dir } = await freshStore();
    await store.appendHistory({ ...record('r1'), integrityCoverage: ['graph', 'engine'] });

    const reopened = new Store(dir);
    await reopened.load();
    // Canonical order, not the order it was written in, so two equal sets
    // cannot render differently.
    expect(reopened.history()[0].integrityCoverage.join(',')).toBe('engine,graph');
  });

  it('writes the version that says records carry coverage', async () => {
    // Optional-and-defaulting is not enough. Left at 1, an older build reads
    // the file happily, normalizes the field it does not know away, and erases
    // the coverage on its next history write.
    const { store, dir } = await freshStore();
    await store.appendHistory(record('r1'));
    const raw: unknown = JSON.parse(await readFile(join(dir, 'history.json'), 'utf8'));
    expect((raw as { version: number }).version).toBe(HISTORY_VERSION);
    expect(HISTORY_VERSION).toBeGreaterThan(1);
  });

  it('drops graph coverage from a v2 record, which never measured the audio', async () => {
    // Version 2 recorded `graph` on the strength of `maxChannelCount`, which
    // describes this app's own graph rather than the output device and was
    // withdrawn as a check. Those records claim the app's output was verified
    // when nothing measured it — and left alone they would be
    // indistinguishable from the ones real capture measurements will produce.
    const dir = await mkdtemp(join(tmpdir(), 'fortyhz-store-'));
    await writeFile(
      join(dir, 'history.json'),
      JSON.stringify({
        version: 2,
        records: [
          { ...record('old'), integrityStatus: 'ok', integrityCoverage: ['engine', 'graph'] },
        ],
      }),
      'utf8',
    );
    const store = new Store(dir);
    await store.load();

    expect(store.history()[0].integrityCoverage.join(',')).toBe('engine');
    // The status stays: those checks did run, and the engine self-test was
    // among them. Only the coverage claim was wrong.
    expect(store.history()[0].integrityStatus).toBe('ok');
  });

  it('keeps graph coverage written at the current version', async () => {
    // The migration must not outlive the thing it corrects, or the first real
    // measurement would be stripped by it.
    const dir = await mkdtemp(join(tmpdir(), 'fortyhz-store-'));
    await writeFile(
      join(dir, 'history.json'),
      JSON.stringify({
        version: HISTORY_VERSION,
        records: [{ ...record('new'), integrityCoverage: ['engine', 'graph'] }],
      }),
      'utf8',
    );
    const store = new Store(dir);
    await store.load();
    expect(store.history()[0].integrityCoverage.join(',')).toBe('engine,graph');
  });

  it('still reads a v1 file, as nothing checked', async () => {
    // Backward compatibility is reading the old file, not writing the old
    // shape. A record from before any checker existed did not fail its
    // scopes — nothing looked at them.
    const dir = await mkdtemp(join(tmpdir(), 'fortyhz-store-'));
    await writeFile(
      join(dir, 'history.json'),
      JSON.stringify({ version: 1, records: [record('old')] }),
      'utf8',
    );
    const store = new Store(dir);
    await store.load();
    expect(store.history().length).toBe(1);
    expect(store.history()[0].integrityCoverage.length).toBe(0);
    expect(store.readOnly).toBe(false);
  });

  it('hands out a coverage array a caller cannot write through', async () => {
    const { store } = await freshStore();
    await store.appendHistory({ ...record('r1'), integrityCoverage: ['engine'] });
    store.history()[0].integrityCoverage.push('graph');
    expect(store.history()[0].integrityCoverage.join(',')).toBe('engine');
  });

  it('ignores a duplicate id, so crash recovery can re-append safely', async () => {
    const { store } = await freshStore();
    await store.appendHistory(record('r1'));
    await store.appendHistory(record('r1'));
    expect(store.history().length).toBe(1);
  });

  it('ignores a record it cannot normalize', async () => {
    const { store } = await freshStore();
    await store.appendHistory({ nonsense: true });
    expect(store.history().length).toBe(0);
  });

  it('removes by id', async () => {
    const { store } = await freshStore();
    await store.appendHistory(record('r1'));
    await store.appendHistory(record('r2'));
    await store.removeHistory('r1');
    expect(
      store
        .history()
        .map((r) => r.id)
        .join(','),
    ).toBe('r2');
  });

  it('hands out copies, so a caller cannot mutate the store', async () => {
    const { store } = await freshStore();
    await store.appendHistory(record('r1'));
    store.history()[0].actualSeconds = 99_999;
    expect(store.history()[0].actualSeconds).toBe(600);
  });

  it('hands out copies of the nested configurations too', async () => {
    // A spread alone leaves both configurations shared, so a caller could
    // rewrite stored history from a value it was merely shown — outside the
    // serialized queue, and without anything reaching disk.
    const { store } = await freshStore();
    await store.appendHistory(record('r1'));

    const handed = store.history()[0];
    handed.initialConfiguration.masterLevel = 0.99;
    handed.initialConfiguration.params.amGain = 0.91;
    handed.finalConfiguration.soundscape.gain = 0.88;

    const held = store.history()[0];
    expect(held.initialConfiguration.masterLevel).toBe(DEFAULT_MASTER_LEVEL);
    expect(held.initialConfiguration.params.amGain).toBe(DEFAULT_PARAMS.amGain);
    expect(held.finalConfiguration.soundscape.gain).toBe(DEFAULT_SOUNDSCAPE.gain);
  });
});

describe('legacy import', () => {
  it('takes presets that were living in localStorage', async () => {
    const { store } = await freshStore();
    const result = await store.importLegacyPresets([preset('old-1'), preset('old-2')]);
    expect(result.imported).toBe(2);
    expect(result.acknowledged).toBe(true);
    expect(store.presets().length).toBe(2);
  });

  it('is idempotent, so a retry after failure imports nothing twice', async () => {
    const { store } = await freshStore();
    await store.importLegacyPresets([preset('old-1')]);
    const second = await store.importLegacyPresets([preset('old-1')]);
    expect(second.imported).toBe(0);
    expect(second.acknowledged).toBe(true);
    expect(store.presets().length).toBe(1);
  });

  it('keeps presets the store already had', async () => {
    const { store } = await freshStore();
    await store.savePresets([preset('mine')]);
    await store.importLegacyPresets([preset('old-1')]);
    expect(store.presets().length).toBe(2);
  });

  it('survives nonsense instead of refusing to import', async () => {
    const { store } = await freshStore();
    const result = await store.importLegacyPresets('not an array');
    expect(result.imported).toBe(0);
    expect(result.acknowledged).toBe(true);
  });

  it('does not acknowledge when the store cannot be written', async () => {
    // Without this the renderer would stop reading localStorage while the
    // store had in fact kept nothing — losing the user's presets outright.
    const dir = await mkdtemp(join(tmpdir(), 'fortyhz-store-'));
    await writeFile(
      join(dir, 'presets.json'),
      JSON.stringify({ version: 99, records: [] }),
      'utf8',
    );
    const store = new Store(dir);
    await store.load();
    const result = await store.importLegacyPresets([preset('old-1')]);
    expect(result.acknowledged).toBe(false);
  });
});

describe('presets', () => {
  it('never persists a built-in', async () => {
    const { store } = await freshStore();
    await store.savePresets([{ ...preset('focus'), builtIn: true }, preset('mine')]);
    expect(
      store
        .presets()
        .map((p) => p.id)
        .join(','),
    ).toBe('mine');
  });

  it('hands out copies of the nested params and soundscape', async () => {
    const { store } = await freshStore();
    await store.upsertPreset(preset('a'));

    const handed = store.presets()[0];
    handed.params.amGain = 0.91;
    handed.soundscape.gain = 0.88;
    handed.masterLevel = 0.99;

    const held = store.presets()[0];
    expect(held.params.amGain).toBe(DEFAULT_PARAMS.amGain);
    expect(held.soundscape.gain).toBe(DEFAULT_SOUNDSCAPE.gain);
    expect(held.masterLevel).toBe(0.5);
  });

  it('does not share nested state between two handed-out copies', async () => {
    const { store } = await freshStore();
    await store.upsertPreset(preset('a'));
    const first = store.presets()[0];
    const second = store.presets()[0];
    first.params.amGain = 0.91;
    expect(second.params.amGain).toBe(DEFAULT_PARAMS.amGain);
  });

  it('keeps the first of a duplicated id', async () => {
    const { store } = await freshStore();
    await store.savePresets([preset('a', 'First'), preset('a', 'Second')]);
    expect(store.presets().length).toBe(1);
    expect(store.presets()[0].name).toBe('First');
  });
});

/** True when the promise rejected, so a silent success cannot pass as one. */
async function rejected(work: Promise<unknown>): Promise<boolean> {
  return work.then(
    () => false,
    () => true,
  );
}

describe('settings', () => {
  it('answers the defaults before anything has been saved', async () => {
    const { store, dir } = await freshStore();
    try {
      const settings = store.settings();
      expect(settings.dailyAdvisorySeconds).toBe(DEFAULT_SETTINGS.dailyAdvisorySeconds);
      expect(settings.launchAtLogin).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('round-trips through disk, normalized on the way in', async () => {
    const { store, dir } = await freshStore();
    try {
      await store.saveSettings({ dailyAdvisorySeconds: 5400, launchAtLogin: 'yes', junk: 1 });

      // Reloaded from the file rather than read back from memory, which would
      // prove only that the object was kept.
      const reopened = new Store(dir);
      await reopened.load();
      expect(reopened.settings().dailyAdvisorySeconds).toBe(5400);
      // A truthy string is not a boolean, and starting the app at login is not
      // something to guess at.
      expect(reopened.settings().launchAtLogin).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists the appearance preference across a reload', async () => {
    // Theme is a durable preference, not a session detail, and it has to reach
    // disk through the same normalizing path as everything else — a value the
    // renderer holds but the file does not is one restart from being lost.
    const { store, dir } = await freshStore();
    try {
      await store.saveSettings({ ...DEFAULT_SETTINGS, appearance: 'light' });

      const reopened = new Store(dir);
      await reopened.load();
      expect(reopened.settings().appearance).toBe('light');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to following the system for an appearance it cannot render', async () => {
    const { store, dir } = await freshStore();
    try {
      await store.saveSettings({ ...DEFAULT_SETTINGS, appearance: 'solarized' });

      const reopened = new Store(dir);
      await reopened.load();
      expect(reopened.settings().appearance).toBe('system');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('hands out a copy, not the stored object', async () => {
    const { store, dir } = await freshStore();
    try {
      const settings = store.settings();
      settings.dailyAdvisorySeconds = 1;
      expect(store.settings().dailyAdvisorySeconds).toBe(DEFAULT_SETTINGS.dailyAdvisorySeconds);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes the versioned shape, not a bare object', async () => {
    const { store, dir } = await freshStore();
    try {
      await store.saveSettings({ cooldownSeconds: 300 });
      const raw = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as {
        version: number;
        records: { cooldownSeconds: number }[];
      };
      expect(raw.version).toBe(SETTINGS_VERSION);
      expect(raw.records.length).toBe(1);
      expect(raw.records[0].cooldownSeconds).toBe(300);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite a file written by a newer build', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fortyhz-store-'));
    try {
      await writeFile(
        join(dir, 'settings.json'),
        JSON.stringify({ version: SETTINGS_VERSION + 1, records: [{ dailyAdvisorySeconds: 60 }] }),
        'utf8',
      );
      const store = new Store(dir);
      await store.load();

      // Readable, so the value is used...
      expect(store.settings().dailyAdvisorySeconds).toBe(60);
      // ...but writing it back in this build's shape would drop whatever the
      // newer one added.
      expect(await rejected(store.saveSettings({ dailyAdvisorySeconds: 120 }))).toBe(true);
      expect(store.readOnly).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps memory and disk in step when a write fails', async () => {
    const { store, dir } = await freshStore();
    try {
      await store.saveSettings({ dailyAdvisorySeconds: 3600 });
      // A directory where the temp file wants to be: the write fails, and the
      // in-memory value must go back rather than reporting a change that is
      // not on disk.
      await rm(dir, { recursive: true, force: true });
      await mkdir(join(dir, 'settings.json'), { recursive: true });

      expect(await rejected(store.saveSettings({ dailyAdvisorySeconds: 1800 }))).toBe(true);
      expect(store.settings().dailyAdvisorySeconds).toBe(3600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('announcing changes', () => {
  it('tells watchers when history changes, however it changed', async () => {
    // Driven from the store rather than from the IPC handlers precisely
    // because the coordinator appends directly: a notification wired to the
    // handlers would carry deletions and miss every completed session.
    const { store, dir } = await freshStore();
    try {
      const seen: string[] = [];
      store.onChanged((what) => seen.push(what));

      await store.appendHistory(record('r1'));
      await store.removeHistory('r1');
      await store.upsertPreset(preset('p1'));

      expect(seen.join(',')).toBe('history,history,presets');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('says nothing when the write failed', async () => {
    // Memory is rolled back on a failed write, so announcing would have every
    // window adopt data that is not on disk — and then disagree with the store
    // itself.
    const { store, dir } = await freshStore();
    try {
      const seen: string[] = [];
      store.onChanged((what) => seen.push(what));

      await rm(dir, { recursive: true, force: true });
      await mkdir(join(dir, 'history.json'), { recursive: true });
      expect(await rejected(store.appendHistory(record('r1')))).toBe(true);

      expect(seen.length).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stops telling a watcher that unsubscribed', async () => {
    const { store, dir } = await freshStore();
    try {
      const seen: string[] = [];
      const stop = store.onChanged((what) => seen.push(what));
      await store.appendHistory(record('r1'));
      stop();
      await store.appendHistory(record('r2'));
      expect(seen.length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('a write that fails', () => {
  /** A directory the store can read but never write into. */
  async function unwritable(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'fortyhz-store-'));
    return dir;
  }

  it('leaves memory matching disk, so the append can be retried', async () => {
    const dir = await unwritable();
    const store = new Store(dir);
    await store.load();

    // Make the next write fail by putting a directory where the temp file goes.
    await mkdir(join(dir, `history.json.${process.pid}.tmp`), { recursive: true });

    let failed = false;
    await store.appendHistory(record('r1')).catch(() => {
      failed = true;
    });
    expect(failed).toBe(true);
    // The record must not linger in memory: a retry would otherwise see a
    // duplicate id, return success, and never write it at all.
    expect(store.history().length).toBe(0);
  });

  it('persists on retry once the obstruction is gone', async () => {
    const dir = await unwritable();
    const store = new Store(dir);
    await store.load();
    const blocker = join(dir, `history.json.${process.pid}.tmp`);
    await mkdir(blocker, { recursive: true });

    await store.appendHistory(record('r1')).catch(() => undefined);
    await rm(blocker, { recursive: true, force: true });

    await store.appendHistory(record('r1'));
    expect(store.history().length).toBe(1);

    const reopened = new Store(dir);
    await reopened.load();
    expect(reopened.history().length).toBe(1);
  });
});

describe('concurrent additions', () => {
  it('keeps both when two callers upsert from the same stale snapshot', async () => {
    const { store } = await freshStore();
    // Both callers hold the same earlier list. A whole-list save would finish
    // with only whichever ran last; addressing one preset by id cannot.
    await Promise.all([store.upsertPreset(preset('a')), store.upsertPreset(preset('b'))]);
    const ids = store
      .presets()
      .map((p) => p.id)
      .sort()
      .join(',');
    expect(ids).toBe('a,b');
  });

  it('replaces an existing preset rather than duplicating it', async () => {
    const { store } = await freshStore();
    await store.upsertPreset(preset('a', 'First'));
    await store.upsertPreset(preset('a', 'Second'));
    expect(store.presets().length).toBe(1);
    expect(store.presets()[0].name).toBe('Second');
  });

  it('still refuses a built-in', async () => {
    const { store } = await freshStore();
    await store.upsertPreset({ ...preset('focus'), builtIn: true });
    expect(store.presets().length).toBe(0);
  });
});

describe('a store that cannot be written', () => {
  async function readOnlyStore(): Promise<Store> {
    const dir = await mkdtemp(join(tmpdir(), 'fortyhz-store-'));
    await writeFile(
      join(dir, 'history.json'),
      JSON.stringify({ version: 99, records: [] }),
      'utf8',
    );
    await writeFile(
      join(dir, 'presets.json'),
      JSON.stringify({ version: 99, records: [] }),
      'utf8',
    );
    const store = new Store(dir);
    await store.load();
    return store;
  }

  it('refuses an append rather than reporting false durability', async () => {
    // The coordinator would otherwise treat the append as durable, clear the
    // checkpoint that was its only other copy, and lose it at the next start.
    const store = await readOnlyStore();
    let refused = false;
    await store.appendHistory(record('r1')).catch((e: unknown) => {
      refused = e instanceof StoreReadOnlyError;
    });
    expect(refused).toBe(true);
  });

  it('leaves memory untouched when it refuses', async () => {
    const store = await readOnlyStore();
    await store.appendHistory(record('r1')).catch(() => undefined);
    expect(store.history().length).toBe(0);
  });

  it('refuses an upsert too', async () => {
    const store = await readOnlyStore();
    let refused = false;
    await store.upsertPreset(preset('a')).catch((e: unknown) => {
      refused = e instanceof StoreReadOnlyError;
    });
    expect(refused).toBe(true);
    expect(store.presets().length).toBe(0);
  });

  it('does not acknowledge a legacy import it cannot keep', async () => {
    const store = await readOnlyStore();
    const result = await store.importLegacyPresets([preset('old-1')]);
    expect(result.acknowledged).toBe(false);
    expect(result.imported).toBe(0);
  });
});

describe('a file that cannot be read', () => {
  it('does not treat an unreadable file as an empty writable store', async () => {
    // Only a missing file means "nothing here yet". Any other failure may be
    // hiding real data, and writing would replace it with nothing.
    const dir = await mkdtemp(join(tmpdir(), 'fortyhz-store-'));
    // A directory where the file should be: readFile fails with EISDIR.
    await mkdir(join(dir, 'presets.json'), { recursive: true });

    const store = new Store(dir);
    await store.load();
    expect(store.readOnly).toBe(true);

    let refused = false;
    await store.upsertPreset(preset('a')).catch((e: unknown) => {
      refused = e instanceof StoreReadOnlyError;
    });
    expect(refused).toBe(true);
  });

  it('still treats a genuinely missing file as writable', async () => {
    const { store } = await freshStore();
    expect(store.readOnly).toBe(false);
    await store.upsertPreset(preset('a'));
    expect(store.presets().length).toBe(1);
  });
});
