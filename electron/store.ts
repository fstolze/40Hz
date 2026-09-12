/**
 * The main process's own copy of presets and history.
 *
 * Studio and the Session popover are separate renderer processes and cannot
 * share `localStorage`, so one owner holds the data and both surfaces ask it.
 *
 * Four properties matter here, and each exists because of a specific way the
 * naive version loses data:
 *
 * - **Serialized mutations.** Two concurrent saves would otherwise both read
 *   the same state and the second would overwrite the first.
 * - **Atomic writes.** A crash midway through `writeFile` leaves a truncated
 *   file; writing to a temporary path and renaming never does.
 * - **Normalization on read.** A file survives across versions and can be
 *   hand-edited, so it is untrusted input exactly as localStorage was.
 * - **A schema version.** A file written by a newer build is left alone rather
 *   than rewritten in an older shape, which would silently drop its fields.
 *
 * The directory is injected rather than taken from `app.getPath('userData')`,
 * so this runs under the test runner without Electron.
 */

import { rename, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Serial } from '../src/lib/serial.ts';
import { normalizePreset, snapshotPreset, type Preset } from '../src/audio/presets.ts';
import {
  normalizeCheckpoint,
  normalizeSessionRecord,
  withoutWithdrawnCoverage,
} from '../src/session/normalize.ts';
import type { Checkpoint } from '../src/session/coordinator.ts';
import { snapshotRecord, type SessionRecord } from '../src/session/session.ts';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  snapshotSettings,
  type Settings,
} from '../src/session/settings.ts';

const CHECKPOINT_FILE = 'checkpoint.json';

/** Bump when the on-disk shape changes in a way older builds cannot read. */
export const PRESETS_VERSION = 1;
/**
 * 3 since `graph` coverage means the audio was measured.
 *
 * 2 added `integrityCoverage`, and recorded `graph` on the strength of a device
 * property that was later withdrawn as a check — so a v2 record claims our own
 * output was verified when nothing had measured it. The bump is what lets a v2
 * file be recognised and corrected on read rather than trusted, and it keeps
 * the original reason for versioning: an older build must refuse to rewrite a
 * newer record instead of normalizing away what it does not understand.
 * `normalizeSessionRecord` still reads v1 and v2 files, which is what backward
 * compatibility means here.
 */
export const HISTORY_VERSION = 3;
export const SETTINGS_VERSION = 1;

interface FileShape {
  version: number;
  records: unknown[];
}

/**
 * Apply the withdrawn-coverage correction to a file below the current version.
 *
 * The rule itself lives in `normalize.ts`, because the browser store needs the
 * same one. What is decided here is *when*: a v2 file recorded `graph` from a
 * device property rather than from a measurement, so its records are corrected
 * on read, while a file already at the current version is trusted — otherwise
 * this would strip the first real measurement the moment one is produced.
 */
function correctWithdrawnCoverage(record: SessionRecord, fileVersion: number): SessionRecord {
  return fileVersion >= HISTORY_VERSION ? record : withoutWithdrawnCoverage(record);
}

/**
 * Thrown when a mutation cannot be persisted because the file was left alone.
 *
 * Reporting success would be worse than failing: the coordinator would treat
 * an append as durable and clear the checkpoint that was its only other copy,
 * and the record would be gone at the next start.
 */
export class StoreReadOnlyError extends Error {}

export interface ImportResult {
  /** How many presets were new and were written. */
  imported: number;
  /**
   * Whether the store is now the authority for presets.
   *
   * The renderer keeps reading `localStorage` until this is true, so a failed
   * or partial import can never orphan a user's saved presets.
   */
  acknowledged: boolean;
}

export class Store {
  private readonly directory: string;
  private readonly mutations = new Serial();

  private presetList: Preset[] = [];
  private historyList: SessionRecord[] = [];
  /**
   * Told whenever presets or history change, whoever changed them.
   *
   * On the store rather than on the IPC handlers, because the coordinator
   * appends history directly — a notification wired to the handlers would
   * miss every completed session and announce only deletions.
   */
  private readonly listeners = new Set<(what: 'presets' | 'history') => void>();

  private settingsValue: Settings = DEFAULT_SETTINGS;
  private presetsReadOnly = false;
  private historyReadOnly = false;
  private settingsReadOnly = false;
  private loaded = false;

  constructor(directory: string) {
    this.directory = directory;
  }

  private path(name: string): string {
    return join(this.directory, name);
  }

  /** Watch for changes. Returns the function that stops watching. */
  onChanged(listener: (what: 'presets' | 'history') => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private announce(what: 'presets' | 'history'): void {
    // A copy, so a listener that unsubscribes while being called cannot
    // shorten the set mid-iteration.
    for (const listener of [...this.listeners]) listener(what);
  }

  /** Read both files once. Safe to call repeatedly; only the first reads. */
  async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.directory, { recursive: true });

    const presets = await this.read(this.path('presets.json'), PRESETS_VERSION);
    this.presetsReadOnly = presets.readOnly;
    this.presetList = dedupeById(
      presets.records.map(normalizePreset).filter((p): p is Preset => p !== null),
    );

    const history = await this.read(this.path('history.json'), HISTORY_VERSION);
    this.historyReadOnly = history.readOnly;
    this.historyList = dedupeById(
      history.records
        .map(normalizeSessionRecord)
        .filter((r): r is SessionRecord => r !== null)
        .map((record) => correctWithdrawnCoverage(record, history.version)),
    );

    // Settings are a single object rather than a list, but they get the same
    // file shape — `records` holding exactly one entry. Reusing the reader is
    // what gives them versioning, the atomic write, the "written by a newer
    // build, so never write it back" rule, and the distinction between a
    // missing file and one that merely could not be read.
    const settings = await this.read(this.path('settings.json'), SETTINGS_VERSION);
    this.settingsReadOnly = settings.readOnly;
    // Absent is the first run; `normalizeSettings` answers the defaults for
    // undefined, so there is no separate first-run branch.
    this.settingsValue = normalizeSettings(settings.records[0]);

    this.loaded = true;
  }

  private async read(
    file: string,
    currentVersion: number,
  ): Promise<{ records: unknown[]; readOnly: boolean; version: number }> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      // Absent is the normal first-run case, and the only one safe to treat as
      // an empty *writable* store. Any other failure — a permission problem, a
      // transient I/O error — means data may well be there and simply could
      // not be read, so writing would overwrite it with nothing.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { records: [], readOnly: false, version: currentVersion };
      }
      return { records: [], readOnly: true, version: currentVersion };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Unreadable. Start empty rather than refusing to run, but do not
      // overwrite it either — the file may still be recoverable by hand.
      return { records: [], readOnly: true, version: currentVersion };
    }

    // A bare array is the pre-versioning shape.
    if (Array.isArray(parsed)) return { records: parsed, readOnly: false, version: 0 };

    // Valid JSON is not necessarily an object: a file containing `null`
    // parses fine and would throw on the property access below, taking down
    // startup rather than being handled as the corruption it is.
    if (typeof parsed !== 'object' || parsed === null) {
      return { records: [], readOnly: true, version: currentVersion };
    }

    const shape = parsed as Partial<FileShape>;
    if (!Array.isArray(shape.records))
      return { records: [], readOnly: true, version: currentVersion };

    const version = typeof shape.version === 'number' ? shape.version : 0;
    // Written by a newer build: read what we can, but never write it back in
    // an older shape, which would drop whatever that build added.
    return { records: shape.records, readOnly: version > currentVersion, version };
  }

  private async write(file: string, version: number, records: unknown[]): Promise<void> {
    const body: FileShape = { version, records };
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(body, null, 2), 'utf8');
    // Rename is atomic within a filesystem, so a reader sees either the whole
    // previous file or the whole new one, never a partial write.
    await rename(temporary, file);
  }

  /**
   * Apply a change to memory and persist it, rolling memory back if the write
   * fails.
   *
   * Keeping the two in step is what makes a retry meaningful. A record left in
   * memory after a failed write would be deduplicated away on the next
   * attempt and never reach the disk at all — and the caller, seeing success,
   * would clear the checkpoint that was its only other copy.
   */
  private async commitPresets(next: Preset[]): Promise<Preset[]> {
    if (this.presetsReadOnly) {
      throw new StoreReadOnlyError('presets.json was left alone and cannot be written');
    }
    const previous = this.presetList;
    this.presetList = next;
    try {
      await this.write(this.path('presets.json'), PRESETS_VERSION, next);
    } catch (error) {
      this.presetList = previous;
      throw error;
    }
    // Only after the write. Announcing a change that was rolled back would
    // have every window adopt data that is not on disk.
    this.announce('presets');
    return this.presets();
  }

  private async commitHistory(next: SessionRecord[]): Promise<SessionRecord[]> {
    if (this.historyReadOnly) {
      throw new StoreReadOnlyError('history.json was left alone and cannot be written');
    }
    const previous = this.historyList;
    this.historyList = next;
    try {
      await this.write(this.path('history.json'), HISTORY_VERSION, next);
    } catch (error) {
      this.historyList = previous;
      throw error;
    }
    this.announce('history');
    return this.history();
  }

  // --- settings --------------------------------------------------------------

  /** A detached copy, so a caller cannot edit main-process state in place. */
  settings(): Settings {
    return snapshotSettings(this.settingsValue);
  }

  /**
   * Replace the settings.
   *
   * Whole-object rather than per-field: there are three fields, they are
   * always presented together, and a partial update would need a merge whose
   * behaviour on an unknown field is another decision to get wrong.
   */
  async saveSettings(raw: unknown): Promise<Settings> {
    return this.mutations.run(async () => {
      if (this.settingsReadOnly) {
        throw new StoreReadOnlyError('settings.json was left alone and cannot be written');
      }
      const next = normalizeSettings(raw);
      const previous = this.settingsValue;
      this.settingsValue = next;
      try {
        await this.write(this.path('settings.json'), SETTINGS_VERSION, [next]);
      } catch (error) {
        this.settingsValue = previous;
        throw error;
      }
      return this.settings();
    });
  }

  // --- presets ---------------------------------------------------------------

  /** Detached copies. A spread alone would leave `params` and `soundscape`
   * shared, letting a caller mutate main-process state outside the serialized
   * queue and without anything reaching disk. */
  presets(): Preset[] {
    return this.presetList.map(snapshotPreset);
  }

  /** Replace the stored presets. Built-ins are never persisted. */
  async savePresets(next: readonly unknown[]): Promise<Preset[]> {
    return this.mutations.run(async () => {
      // Built-ins are filtered before normalizing, not after: normalizePreset
      // clears the flag on everything it returns, so filtering afterwards
      // would never match and every built-in would be persisted as a user one.
      const cleaned = dedupeById(
        next
          .filter((raw) => !isBuiltIn(raw))
          .map(normalizePreset)
          .filter((p): p is Preset => p !== null),
      );
      return this.commitPresets(cleaned);
    });
  }

  /**
   * Add or replace a single preset.
   *
   * The primary way the UI writes. Replacing the whole list from a snapshot
   * loses concurrent additions — two callers working from the same earlier
   * list, one adding A and one adding B, would finish with only whichever ran
   * last. Addressing one preset by id cannot do that.
   */
  async upsertPreset(raw: unknown): Promise<Preset[]> {
    return this.mutations.run(async () => {
      if (isBuiltIn(raw)) return this.presets();
      const preset = normalizePreset(raw);
      if (preset === null) return this.presets();
      const exists = this.presetList.some((p) => p.id === preset.id);
      const next = exists
        ? this.presetList.map((p) => (p.id === preset.id ? preset : p))
        : [...this.presetList, preset];
      return this.commitPresets(next);
    });
  }

  async removePreset(id: string): Promise<Preset[]> {
    return this.mutations.run(async () => {
      return this.commitPresets(this.presetList.filter((p) => p.id !== id));
    });
  }

  /**
   * Take presets that were living in the renderer's `localStorage`.
   *
   * Deduplicated by id, so running it twice imports nothing the second time —
   * which is what makes it safe to retry after a failure.
   */
  async importLegacyPresets(raw: unknown): Promise<ImportResult> {
    return this.mutations.run(async () => {
      const incoming = Array.isArray(raw)
        ? raw.map(normalizePreset).filter((p): p is Preset => p !== null)
        : [];
      const known = new Set(this.presetList.map((p) => p.id));
      const fresh = dedupeById(incoming.filter((p) => !known.has(p.id)));

      if (this.presetsReadOnly) {
        // Nothing was kept, so the renderer must go on reading storage.
        return { imported: 0, acknowledged: false };
      }
      if (fresh.length > 0) {
        await this.commitPresets([...this.presetList, ...fresh]);
      }
      // Acknowledged even when nothing was new: the store still holds
      // everything the renderer had, so it is safe to stop reading storage.
      return { imported: fresh.length, acknowledged: true };
    });
  }

  // --- history ---------------------------------------------------------------

  /** Detached copies, for the same reason as `presets()`. */
  history(): SessionRecord[] {
    return this.historyList.map(snapshotRecord);
  }

  /**
   * Add one finished session.
   *
   * Deduplicated by id and idempotent, because crash recovery re-appends a
   * record it cannot know was already written.
   */
  async appendHistory(raw: unknown): Promise<SessionRecord[]> {
    return this.mutations.run(async () => {
      const record = normalizeSessionRecord(raw);
      if (record === null) return this.history();
      if (this.historyList.some((r) => r.id === record.id)) return this.history();

      return this.commitHistory([...this.historyList, record]);
    });
  }

  async removeHistory(id: string): Promise<SessionRecord[]> {
    return this.mutations.run(async () => {
      return this.commitHistory(this.historyList.filter((r) => r.id !== id));
    });
  }

  // --- checkpoint ------------------------------------------------------------

  /**
   * The in-progress session, if any.
   *
   * Its own file rather than a field in history: it is written on a heartbeat
   * and deleted on every clean finish, so keeping it apart avoids rewriting
   * the whole history each time, and a corrupt checkpoint cannot cost the log.
   *
   * Read defensively like everything else here, but a checkpoint that cannot
   * be understood is discarded rather than refused — the alternative is
   * refusing to start.
   */
  async readCheckpoint(): Promise<Checkpoint | null> {
    let raw: string;
    try {
      raw = await readFile(this.path(CHECKPOINT_FILE), 'utf8');
    } catch (error) {
      // Absent means no session was interrupted. Anything else may be hiding
      // one, and reporting absence would let the next start overwrite it.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return normalizeCheckpoint(parsed);
    } catch {
      return null;
    }
  }

  async writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
    return this.mutations.run(async () => {
      const temporary = `${this.path(CHECKPOINT_FILE)}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(checkpoint, null, 2), 'utf8');
      await rename(temporary, this.path(CHECKPOINT_FILE));
    });
  }

  async clearCheckpoint(): Promise<void> {
    return this.mutations.run(async () => {
      try {
        await rm(this.path(CHECKPOINT_FILE));
      } catch (error) {
        // Already gone is the normal case after a clean finish.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
  }

  /** True when a file could not be written back safely and was left alone. */
  get readOnly(): boolean {
    return this.presetsReadOnly || this.historyReadOnly || this.settingsReadOnly;
  }
}

function isBuiltIn(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as { builtIn?: unknown }).builtIn === true;
}

/** First occurrence of each id wins; a duplicate is a bug upstream, not data. */
function dedupeById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}
