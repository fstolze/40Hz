/**
 * The `dev:web` history, and the boundary its key marks.
 *
 * `localStorage` is not versioned the way a file is, so the key has always
 * carried the version instead. That only means anything if something actually
 * moves records across when the meaning of a record changes — which is what
 * this is: records written under the old key recorded `graph` coverage from a
 * device property that was withdrawn as a check, and left alone they would be
 * indistinguishable from the ones real capture measurements will produce.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { HISTORY_KEY, readHistory, writeHistory } from '../src/renderer/lib/browser-history.ts';
import type { WebStorage } from '../src/renderer/lib/browser-history.ts';
import { defaultConfiguration } from '../src/audio/configuration.ts';
import type { SessionRecord } from '../src/session/session.ts';

const LEGACY_KEY = 'fortyhz.history.v1';

/** `localStorage` as a map, so the migration can be driven in Node. */
class FakeStorage implements WebStorage {
  readonly entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'r1',
    presetId: 'focus',
    startedAt: 1_700_000_000_000,
    plannedSeconds: 600,
    actualSeconds: 600,
    completionReason: 'completed',
    integrityStatus: 'ok',
    integrityCoverage: ['engine', 'graph'],
    initialConfiguration: defaultConfiguration(),
    finalConfiguration: defaultConfiguration(),
    edited: false,
    ...overrides,
  };
}

describe('reading the browser history', () => {
  it('corrects the coverage of records under the superseded key', () => {
    // The claim the desktop store strips from a v2 file, arriving by the other
    // door. `dev:web` writes real records through the same coordinator, so
    // "it is only development data" is not a reason for them to say something
    // the desktop records are corrected for saying.
    const storage = new FakeStorage();
    storage.setItem(LEGACY_KEY, JSON.stringify([record()]));

    const held = readHistory(storage);
    expect(held.length).toBe(1);
    expect(held[0].integrityCoverage.join(',')).toBe('engine');
    // The status stays: those checks ran, the engine self-test among them.
    expect(held[0].integrityStatus).toBe('ok');
  });

  it('moves them across once, so the correction cannot outlive them', () => {
    // Left in place, the correction would strip the first real `graph`
    // measurement the moment one is written — the same trap the disk store's
    // version check exists to avoid.
    const storage = new FakeStorage();
    storage.setItem(LEGACY_KEY, JSON.stringify([record()]));

    readHistory(storage);
    expect(storage.getItem(LEGACY_KEY)).toBe(null);
    expect(storage.getItem(HISTORY_KEY) === null).toBe(false);

    // A measurement written afterwards is trusted, because it is under the
    // key that means what it says.
    writeHistory([record({ id: 'measured' })], storage);
    expect(readHistory(storage)[0].integrityCoverage.join(',')).toBe('engine,graph');
  });

  it('trusts what is already under the current key', () => {
    const storage = new FakeStorage();
    storage.setItem(HISTORY_KEY, JSON.stringify([record()]));
    expect(readHistory(storage)[0].integrityCoverage.join(',')).toBe('engine,graph');
  });

  it('prefers the current key over a superseded one left behind', () => {
    const storage = new FakeStorage();
    storage.setItem(HISTORY_KEY, JSON.stringify([record({ id: 'current' })]));
    storage.setItem(LEGACY_KEY, JSON.stringify([record({ id: 'stale' })]));

    const held = readHistory(storage);
    expect(held.map((r) => r.id).join(',')).toBe('current');
    // And the old one is left alone rather than half-migrated over a newer
    // list, which would lose whichever records only it had.
    expect(storage.getItem(LEGACY_KEY) === null).toBe(false);
  });

  it('normalizes what it finds, since localStorage is untrusted input', () => {
    const storage = new FakeStorage();
    storage.setItem(LEGACY_KEY, JSON.stringify([record(), null, 'nonsense', { id: 'no-start' }]));
    expect(readHistory(storage).length).toBe(1);
  });

  it('reads nothing from an empty, absent or unparseable store', () => {
    const storage = new FakeStorage();
    expect(readHistory(storage).length).toBe(0);

    storage.setItem(HISTORY_KEY, '{ not json');
    expect(readHistory(storage).length).toBe(0);

    storage.setItem(HISTORY_KEY, JSON.stringify({ records: [record()] }));
    expect(readHistory(storage).length).toBe(0);

    // No storage at all — a private window, or Node.
    expect(readHistory(undefined).length).toBe(0);
  });

  it('does not throw when the store refuses a write', () => {
    // Quota, or a private window. History stays in memory; the session is not
    // worth failing over its log.
    const refusing: WebStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => undefined,
    };
    writeHistory([record()], refusing);
  });
});
