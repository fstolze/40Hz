/**
 * What a history record says, in the terms the History view renders.
 *
 * Pure, and separate from the component, because these are the decisions worth
 * testing without a DOM: which endpoints a record can be recalled from, what
 * its recipe actually was, and whether the preset it names still exists. The
 * component below arranges them; it does not decide any of them.
 *
 * Nothing here reconstructs a recipe. Every configuration handed out is the
 * stored snapshot itself, so a recalled recipe cannot differ semantically from
 * the record that offered it.
 */

import { configurationsEqual, type SessionConfiguration } from '../../audio/configuration.ts';
import type { Preset } from '../../audio/presets.ts';
import type { SessionRecord } from '../../session/session.ts';
import { gainToDb, hz, percent } from './format.ts';

export interface RecallOption {
  /** The action's label, which is also what it restores. */
  label: string;
  /** Spoken form, so a screen reader hears which record it belongs to. */
  description: string;
  configuration: SessionConfiguration;
}

/**
 * The endpoints a record can be recalled from — one, or two when they differ.
 *
 * Unresolved decision 1, answered: expose both, and only when there are
 * genuinely two. The gate is the configurations themselves rather than the
 * record's `edited` flag, because `edited` is set by
 * `coordinator.reportConfiguration` on *any* change during a session — so a
 * value moved and moved back leaves `edited` true with two identical endpoints,
 * and gating on it would offer the same recipe twice under two different names.
 *
 * This is the same configuration comparison used for Modified. One function
 * decides "are these the same sound" for the whole product rather than two that
 * can drift.
 */
export function recallOptions(record: SessionRecord): RecallOption[] {
  const start = record.initialConfiguration;
  const end = record.finalConfiguration;
  if (configurationsEqual(start, end)) {
    return [
      {
        label: 'Recall recipe',
        description: 'Recall the recipe from this session',
        configuration: start,
      },
    ];
  }
  return [
    {
      label: 'Recall start',
      description: 'Recall the recipe this session started from',
      configuration: start,
    },
    {
      label: 'Recall end',
      description: 'Recall the recipe this session ended on',
      configuration: end,
    },
  ];
}

/**
 * The recipe, in a few short pieces the row can wrap.
 *
 * Pieces rather than one string so a narrow window breaks between them instead
 * of mid-figure. Read from the snapshot the record stores, never from whatever
 * Studio happens to be showing.
 */
export function recipeSummary(configuration: SessionConfiguration): string[] {
  const { params, soundscape } = configuration;
  const routing =
    params.twoToneMode === 'off'
      ? null
      : params.twoToneMode === 'dichotic'
        ? 'binaural'
        : 'monaural';
  /*
   * The pulse level earns its place: without it two records that ran different
   * presets read identically, because Focus and Masked share a modulation, a
   * carrier and a bed colour and differ mainly in how far the pulse sits under
   * it. That is the thing a person would use to tell them apart.
   */
  return [
    `${hz(params.modulationHz, 1)} mod`,
    `${hz(params.carrierHz, 1)} carrier`,
    `${gainToDb(params.amGain)} pulse`,
    `${soundscape.color} bed`,
    ...(routing === null ? [] : [routing]),
  ];
}

/**
 * How each field is named and shown, keyed by its path in a configuration.
 *
 * A table of *labels*, not of which fields exist. That distinction is the whole
 * point: the previous version enumerated the fields themselves, so a field the
 * table did not list simply vanished from the diff — and `recallOptions`, which
 * gates on `configurationsEqual` over the union of both key sets, would still
 * offer two recall buttons for a change nothing on the row could describe. Two
 * decisions that agreed only by inspection.
 *
 * Now the walk below finds the fields and this only dresses them, so a field
 * missing from here is rendered by its raw path rather than dropped.
 */
const FIELD_LABELS: Record<string, { label: string; show: (v: unknown) => string }> = {
  'params.modulationHz': { label: 'Modulation', show: (v) => hz(v as number, 1) },
  'params.carrierHz': { label: 'Carrier', show: (v) => hz(v as number, 1) },
  'params.duty': { label: 'Duty', show: (v) => percent(v as number) },
  'params.edge': { label: 'Edge', show: (v) => percent(v as number) },
  'params.depth': { label: 'Depth', show: (v) => percent(v as number) },
  'params.amGain': { label: 'Entrainment level', show: (v) => gainToDb(v as number) },
  'params.twoToneGain': { label: 'Two-tone level', show: (v) => gainToDb(v as number) },
  'params.twoToneMode': {
    label: 'Routing',
    show: (v) => (v === 'off' ? 'off' : v === 'dichotic' ? 'binaural' : 'monaural'),
  },
  'soundscape.source': { label: 'Bed', show: (v) => String(v) },
  'soundscape.bedId': { label: 'Imported bed', show: (v) => (v === null ? 'none' : String(v)) },
  'soundscape.color': { label: 'Colour', show: (v) => String(v) },
  'soundscape.gain': { label: 'Soundscape level', show: (v) => gainToDb(v as number) },
  'soundscape.notchDepthDb': { label: 'Notch depth', show: (v) => `-${v as number} dB` },
  'soundscape.notchQ': { label: 'Notch Q', show: (v) => String(v) },
  masterLevel: { label: 'Master', show: (v) => percent(v as number) },
};

/** The paths this table dresses, so a test can hold it to the real schema. */
export const LABELLED_PATHS = Object.keys(FIELD_LABELS);

export interface EndpointChange {
  label: string;
  from: string;
  to: string;
}

function differs(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) > 1e-9;
  return a !== b;
}

/**
 * What actually changed between a session's two endpoints.
 *
 * Walks the union of both key sets, exactly as `configurationsEqual` does, so
 * the two can never disagree about whether a session changed: if that function
 * says the endpoints differ, this finds at least one field to name. The row
 * therefore always describes as many recipes as it offers to recall — one
 * decision rather than two that happen to agree.
 *
 * The reason both endpoints are offered at all is so the reader can choose
 * between them, and two summaries showing the same headline figures make that
 * choice blind — a session that moved only its duty rendered identically twice.
 */
export function endpointChanges(record: SessionRecord): EndpointChange[] {
  const start = record.initialConfiguration;
  const end = record.finalConfiguration;
  const changes: EndpointChange[] = [];

  const section = (name: 'params' | 'soundscape') => {
    const a = start[name] as unknown as Record<string, unknown>;
    const b = end[name] as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!differs(a[key], b[key])) continue;
      const path = `${name}.${key}`;
      const dress = FIELD_LABELS[path];
      changes.push({
        label: dress?.label ?? path,
        from: dress ? dress.show(a[key]) : String(a[key]),
        to: dress ? dress.show(b[key]) : String(b[key]),
      });
    }
  };

  section('params');
  section('soundscape');
  if (differs(start.masterLevel, end.masterLevel)) {
    const dress = FIELD_LABELS.masterLevel;
    changes.push({
      label: dress.label,
      from: dress.show(start.masterLevel),
      to: dress.show(end.masterLevel),
    });
  }
  return changes;
}

/** "1 session" / "2 sessions". These strings are read aloud. */
export const sessions = (n: number) => `${n} session${n === 1 ? '' : 's'}`;

/**
 * What a Clear that stopped part-way actually did, in one sentence.
 *
 * History is cleared one record at a time. A bulk store operation would be
 * acceptable only if it were normalized, sender-validated, announced, and tested,
 * and a second route into the store was judged the worse trade. The price is
 * that the operation is not atomic, so a failure in the middle leaves every
 * earlier removal permanently done.
 *
 * The message that reported such a failure was "History was not cleared",
 * which describes an operation that undid itself. A real `EACCES` part way
 * through forty records destroyed four and said none — the unannounced
 * mutation this message must disclose. So the count that is already gone leads:
 * it is the part the reader cannot get back, and the only part worth reading
 * first.
 *
 * Pure, and here rather than in the component, because the arithmetic and the
 * plural are the things that were wrong and they are worth pinning without a
 * DOM — the partial case needs a failure induced mid-loop to reach in the
 * running app, which is a race to stage and a race to assert.
 */
export function clearOutcome(deleted: number, total: number): string {
  if (deleted === 0) return `No sessions were deleted. ${sessions(total)} still stored.`;
  if (deleted >= total) return `${sessions(deleted)} deleted.`;
  return `${sessions(deleted)} deleted and permanently gone. ${sessions(total - deleted)} still stored.`;
}

/**
 * The rows whose spoken name is not unique on its own, and what to add.
 *
 * A row's accessible name is its preset and its start time to the second, which
 * separates every record the coordinator can write: one session runs at a time
 * and `startedAt` is stamped from the wall clock when audio begins, so two of
 * them cannot share a millisecond. History is a *file*, though, and a file that
 * has been hand-edited, merged or restored can hold two records with the same
 * preset and the same instant. Both rows then answer to one name, and a voice
 * user saying "delete Focus, 10:00:00" is choosing blind between two permanent
 * deletions.
 *
 * So the tie is broken by the record id, which the store already treats as the
 * thing that identifies a record — it is what `remove` is given. Only the ids
 * that need it are returned, because the fix must not cost anything in the case
 * that actually happens: with no collision this is empty and every name stays
 * the short, speakable one.
 */
export function ambiguousIds(records: readonly SessionRecord[]): Set<string> {
  const byName = new Map<string, SessionRecord[]>();
  for (const record of records) {
    // NUL between the parts, so a preset id ending in a digit cannot combine
    // with one timestamp to look like a different preset and another.
    const key = `${record.presetId}\u0000${record.startedAt}`;
    const group = byName.get(key);
    if (group === undefined) byName.set(key, [record]);
    else group.push(record);
  }

  const ambiguous = new Set<string>();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (const record of group) ambiguous.add(record.id);
  }
  return ambiguous;
}

/**
 * The preset a record ran, named if it still exists.
 *
 * A record keeps the id it was started with, and that preset may since have
 * been renamed, edited or deleted. Naming it from the current list is the only
 * honest answer available; when there is no match the record still holds an
 * identity, so the row says the preset is gone rather than printing a raw id at
 * someone. The id itself stays reachable as the title, because it is the only
 * thing that distinguishes two deleted presets from one another.
 */
export function presetLabel(
  record: SessionRecord,
  presets: readonly Preset[],
): { name: string; missing: boolean; id: string } {
  const found = presets.find((p) => p.id === record.presetId);
  return {
    name: found?.name ?? 'Deleted preset',
    missing: found === undefined,
    id: record.presetId,
  };
}

/** How a session ended, in the product's own words. */
export const OUTCOME: Record<string, string> = {
  completed: 'Completed',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
};

/**
 * What the integrity checks said, and what they never looked at.
 *
 * Two facts, kept apart on purpose — the record stores them separately for the
 * reason its own comment gives: a clean status with empty coverage means
 * nothing was examined, and folding those together would read as a pass.
 */
export function integrityLabel(record: SessionRecord): {
  verdict: string;
  coverage: string | null;
} {
  const scopes = record.integrityCoverage;
  /*
   * Empty coverage means "not checked", whatever the verdict says.
   *
   * A stored `ok` over an empty coverage is a combination normalization
   * permits — it is what every record written before the field existed looks
   * like — and rendering it as "Checks clear" told the reader that something
   * had passed when nothing had run. The record keeps the two apart for exactly
   * this reason; the label has to as well, and the coverage is the one that
   * decides. Anything else is a clean bill of health from an examination that
   * never happened.
   */
  if (scopes.length === 0) return { verdict: 'Not checked', coverage: null };
  return {
    verdict:
      record.integrityStatus === 'ok'
        ? 'Checks clear'
        : record.integrityStatus === 'unknown'
          ? 'Not checked'
          : record.integrityStatus === 'warning'
            ? 'Check warning'
            : 'Check failed',
    coverage: scopes.join(', '),
  };
}
