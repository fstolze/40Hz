/**
 * What the History view is allowed to say about a record.
 *
 * The endpoint rule is the one worth pinning: a record stores where a session
 * started and where it ended, and unresolved decision 1 settled that both are
 * offered — but only when there are genuinely two. The trap is `edited`, which
 * the coordinator sets on any change during a session and which therefore says
 * nothing about whether the two endpoints actually differ.
 */

import { describe, it, expect } from './helpers/expect.ts';
import {
  LABELLED_PATHS,
  ambiguousIds,
  clearOutcome,
  endpointChanges,
  recallOptions,
  recipeSummary,
  presetLabel,
  integrityLabel,
} from '../src/renderer/lib/history-view.ts';
import {
  BUILT_IN_PRESETS,
  LEGACY_PRESETS,
  nameablePresets,
  presetConfiguration,
} from '../src/audio/presets.ts';
import { DEFAULT_PARAMS } from '../src/audio/dsp/entrainment-core.ts';
import {
  DEFAULT_MASTER_LEVEL,
  DEFAULT_SOUNDSCAPE,
  type SessionConfiguration,
} from '../src/audio/configuration.ts';
import type { SessionRecord } from '../src/session/session.ts';

function configuration(
  overrides: Partial<SessionConfiguration['params']> = {},
): SessionConfiguration {
  return {
    params: { ...DEFAULT_PARAMS, ...overrides },
    soundscape: { ...DEFAULT_SOUNDSCAPE },
    masterLevel: DEFAULT_MASTER_LEVEL,
  };
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'r1',
    presetId: 'focus',
    startedAt: 1_700_000_000_000,
    plannedSeconds: 1800,
    actualSeconds: 1800,
    completionReason: 'completed',
    integrityStatus: 'ok',
    integrityCoverage: ['engine'],
    initialConfiguration: configuration(),
    finalConfiguration: configuration(),
    edited: false,
    ...overrides,
  };
}

describe('recall endpoints', () => {
  it('offers one recall when the session ended where it began', () => {
    const options = recallOptions(record());
    expect(options.length).toBe(1);
    expect(options[0].label).toBe('Recall recipe');
  });

  it('offers both when the endpoints genuinely differ', () => {
    const options = recallOptions(
      record({
        edited: true,
        finalConfiguration: configuration({ carrierHz: 300 }),
      }),
    );
    expect(options.length).toBe(2);
    expect(options.map((o) => o.label).join(' / ')).toBe('Recall start / Recall end');
    expect(options[0].configuration.params.carrierHz).toBe(DEFAULT_PARAMS.carrierHz);
    expect(options[1].configuration.params.carrierHz).toBe(300);
  });

  it('offers one when the session was edited and put back', () => {
    // The reason the gate is the configurations and not the flag. The
    // coordinator sets `edited` on any change, so a value moved and moved back
    // leaves it true with two identical endpoints — and offering "start" and
    // "end" there would be two names for one recipe.
    const options = recallOptions(record({ edited: true }));
    expect(options.length).toBe(1);
    expect(options[0].label).toBe('Recall recipe');
  });

  it('hands out the stored snapshot itself, not a rebuilt one', () => {
    // Anything reconstructed could differ semantically from what the session
    // actually ran, which is the whole thing History exists to be able to say.
    const source = record({ initialConfiguration: configuration({ duty: 0.31 }) });
    const [only] = recallOptions(source);
    expect(only.configuration.params.duty).toBe(0.31);
    expect(only.configuration === source.initialConfiguration).toBe(true);
  });

  it('distinguishes endpoints that differ only in master', () => {
    // Master is part of a configuration, so it is part of an endpoint. Missing
    // this would silently collapse two real endpoints into one.
    const options = recallOptions(
      record({
        finalConfiguration: { ...configuration(), masterLevel: DEFAULT_MASTER_LEVEL - 0.2 },
      }),
    );
    expect(options.length).toBe(2);
  });
});

describe('record description', () => {
  it('summarises the recipe from the record, in wrappable pieces', () => {
    const pieces = recipeSummary(configuration({ carrierHz: 300, modulationHz: 41, amGain: 0.25 }));
    expect(pieces.join(' · ')).toBe('41.0 Hz mod · 300.0 Hz carrier · -12.0 dB pulse · pink bed');
  });

  it('distinguishes two presets that share a carrier and a bed', () => {
    // Focus and Masked differ mainly in how far the pulse sits under the bed,
    // so a summary without the level reads identically for both — which is the
    // case that made this piece worth including.
    const focus = recipeSummary(configuration({ amGain: 0.28 })).join(' ');
    const masked = recipeSummary(configuration({ amGain: 0.1 })).join(' ');
    expect(focus === masked).toBe(false);
  });

  it('names the routing only when the layer is on', () => {
    expect(recipeSummary(configuration()).length).toBe(4);
    // `.includes` rather than a matcher: this expect shim has `toBe` and the
    // numeric comparisons, and nothing for substrings.
    expect(recipeSummary(configuration({ twoToneMode: 'dichotic' })).includes('binaural')).toBe(
      true,
    );
    expect(recipeSummary(configuration({ twoToneMode: 'diotic' })).includes('monaural')).toBe(true);
  });

  it('names a preset that still exists', () => {
    const label = presetLabel(record({ presetId: 'masked' }), BUILT_IN_PRESETS);
    expect(label.name).toBe('Subtle pulse');
    expect(label.missing).toBe(false);
  });

  it('says so when the preset is gone, and keeps its identity', () => {
    const label = presetLabel(record({ presetId: 'user-gone' }), BUILT_IN_PRESETS);
    expect(label.missing).toBe(true);
    expect(label.id).toBe('user-gone');
  });

  it('names a built-in that is no longer offered, rather than calling it deleted', () => {
    // A record of Maximum contrast outlives its place in the picker. Reading
    // "Deleted preset" there would tell someone they removed a preset they
    // never touched.
    expect(BUILT_IN_PRESETS.some((p) => p.id === 'contrast')).toBe(false);
    const label = presetLabel(record({ presetId: 'contrast' }), nameablePresets([]));
    expect(label.name).toBe('Maximum contrast');
    expect(label.missing).toBe(false);
  });

  it('reports nothing checked as "Not checked", whatever verdict was stored', () => {
    /*
     * This test previously asserted the opposite, and was wrong.
     *
     * A stored `ok` over an empty coverage renders as a clean bill of health
     * from an examination that never ran — and normalization permits exactly
     * that combination, because it is what every record written before the
     * coverage field existed looks like. The coverage decides.
     */
    for (const status of ['ok', 'unknown', 'warning', 'failed'] as const) {
      const label = integrityLabel(record({ integrityStatus: status, integrityCoverage: [] }));
      expect(label.verdict).toBe('Not checked');
      expect(label.coverage).toBe(null);
    }
  });

  it('reports the verdict and what it covered when something was checked', () => {
    const some = integrityLabel(
      record({ integrityStatus: 'warning', integrityCoverage: ['engine'] }),
    );
    expect(some.verdict).toBe('Check warning');
    expect(some.coverage).toBe('engine');
  });
});

describe('what changed between the endpoints', () => {
  /*
   * Every field, not only the carrier.
   *
   * Two summaries showing the same four headline figures made the choice
   * between endpoints blind: a session that moved only its duty rendered
   * identically twice. Each case below is a change a session can really make.
   */
  const CASES: [string, Partial<SessionConfiguration['params']>][] = [
    ['Modulation', { modulationHz: 41 }],
    ['Carrier', { carrierHz: 300 }],
    ['Duty', { duty: 0.85 }],
    ['Edge', { edge: 0.2 }],
    ['Depth', { depth: 0.4 }],
    ['Entrainment level', { amGain: 0.4 }],
    ['Two-tone level', { twoToneGain: 0.3 }],
    ['Routing', { twoToneMode: 'dichotic' }],
  ];

  for (const [expected, override] of CASES) {
    it(`names ${expected} when only that changed`, () => {
      const changes = endpointChanges(
        record({ edited: true, finalConfiguration: configuration(override) }),
      );
      expect(changes.length).toBe(1);
      expect(changes[0].label).toBe(expected);
      expect(changes[0].from === changes[0].to).toBe(false);
    });
  }

  it('names master, which lives outside params', () => {
    const changes = endpointChanges(
      record({
        edited: true,
        finalConfiguration: { ...configuration(), masterLevel: DEFAULT_MASTER_LEVEL - 0.3 },
      }),
    );
    expect(changes.length).toBe(1);
    expect(changes[0].label).toBe('Master');
  });

  for (const [field, value] of [
    ['gain', 0.6],
    ['notchDepthDb', 12],
    ['notchQ', 14],
    ['color', 'brown'],
  ] as const) {
    it(`names the soundscape's ${field} when only that changed`, () => {
      const end = configuration();
      (end.soundscape as unknown as Record<string, unknown>)[field] = value;
      const changes = endpointChanges(record({ edited: true, finalConfiguration: end }));
      expect(changes.length).toBe(1);
    });
  }

  it('reports nothing when the endpoints match', () => {
    expect(endpointChanges(record()).length).toBe(0);
  });

  it('finds a change in any field, including one it has never heard of', () => {
    /*
     * The invariant that makes this one decision rather than two.
     *
     * `recallOptions` gates on `configurationsEqual`, which walks the union of
     * both key sets; the diff now walks the same union. So whenever the row
     * offers two recalls there is at least one change to name — even for a
     * field added to a configuration and never added to the label table, which
     * previously vanished from the diff while still producing two buttons.
     */
    const end = configuration();
    (end.params as unknown as Record<string, unknown>).invented = 7;
    const changed = record({ finalConfiguration: end });
    expect(recallOptions(changed).length).toBe(2);
    expect(endpointChanges(changed).length).toBe(1);
    // Named by its path rather than dropped, which is the honest fallback.
    expect(endpointChanges(changed)[0].label).toBe('params.invented');
  });

  it('has a human label for every field the schema actually has', () => {
    // A walk, not a count. The previous version compared lengths, so swapping
    // one field for a duplicate of another left it green — which is exactly
    // how a field could lose its name without anything noticing.
    const actual = [
      ...Object.keys(DEFAULT_PARAMS).map((k) => `params.${k}`),
      ...Object.keys(DEFAULT_SOUNDSCAPE).map((k) => `soundscape.${k}`),
      'masterLevel',
    ];
    const labelled = new Set(LABELLED_PATHS);
    const missing = actual.filter((path) => !labelled.has(path));
    expect(missing.join(', ')).toBe('');
    // And nothing labelled that no longer exists.
    const stale = LABELLED_PATHS.filter((path) => !actual.includes(path));
    expect(stale.join(', ')).toBe('');
  });
});

describe('the built-ins, as history would show them', () => {
  it('recalls a built-in recipe identically to selecting that preset', () => {
    // The property recall depends on: a record of an unmodified built-in must
    // restore something that compares equal to the preset itself, or Modified
    // would light up for a recipe that has not been modified.
    for (const preset of [...BUILT_IN_PRESETS, ...LEGACY_PRESETS]) {
      const [only] = recallOptions(
        record({
          presetId: preset.id,
          initialConfiguration: presetConfiguration(preset),
          finalConfiguration: presetConfiguration(preset),
        }),
      );
      expect(only.configuration.params.carrierHz).toBe(preset.params.carrierHz);
      expect(only.configuration.soundscape.gain).toBe(preset.soundscape.gain);
      expect(only.configuration.masterLevel).toBe(preset.masterLevel);
    }
  });
});

describe('telling two rows apart by name', () => {
  it('adds nothing when the preset and the instant already separate them', () => {
    // The case that actually happens. One session runs at a time and
    // `startedAt` is the wall clock at audio start, so the coordinator cannot
    // write two records with the same preset in the same millisecond — and no
    // ordinary log should pay for the one that can only come off disk.
    const ids = ambiguousIds([
      record({ id: 'a', startedAt: 1_000 }),
      record({ id: 'b', startedAt: 2_000 }),
      record({ id: 'c', presetId: 'masked', startedAt: 1_000 }),
    ]);
    expect(ids.size).toBe(0);
  });

  it('marks every row in a collision, not just the later one', () => {
    /*
     * Four actions, two names.
     *
     * A hand-edited, merged or restored file can hold two records with the
     * same preset and instant, and both rows then answer to "Delete Focus,
     * 10:00:00" — a voice user choosing blind between two permanent
     * deletions. Both sides need the discriminator, because naming only the
     * duplicate would leave the first still ambiguous against it.
     */
    const ids = ambiguousIds([
      record({ id: 'a', startedAt: 1_000 }),
      record({ id: 'b', startedAt: 1_000 }),
      record({ id: 'c', startedAt: 3_000 }),
    ]);
    expect(ids.size).toBe(2);
    expect(ids.has('a') && ids.has('b')).toBe(true);
    expect(ids.has('c')).toBe(false);
  });

  it('separates a preset id that runs into the timestamp', () => {
    // The key joins two fields, so it needs a separator no field can contain.
    const ids = ambiguousIds([
      record({ id: 'a', presetId: 'p1', startedAt: 23 }),
      record({ id: 'b', presetId: 'p', startedAt: 123 }),
    ]);
    expect(ids.size).toBe(0);
  });
});

describe('what a Clear says it did', () => {
  it('leads with what is already gone, because that is what cannot come back', () => {
    // The defect: a real EACCES four records into forty reported "History was
    // not cleared" — an operation that undid itself, which this one cannot.
    expect(clearOutcome(4, 40)).toBe(
      '4 sessions deleted and permanently gone. 36 sessions still stored.',
    );
  });

  it('says plainly when nothing was destroyed', () => {
    expect(clearOutcome(0, 40)).toBe('No sessions were deleted. 40 sessions still stored.');
  });

  it('reports a complete clear as what it removed', () => {
    expect(clearOutcome(40, 40)).toBe('40 sessions deleted.');
  });

  it('gets the singular right, because these are read aloud', () => {
    expect(clearOutcome(1, 1)).toBe('1 session deleted.');
    expect(clearOutcome(1, 2)).toBe(
      '1 session deleted and permanently gone. 1 session still stored.',
    );
    expect(clearOutcome(0, 1)).toBe('No sessions were deleted. 1 session still stored.');
  });
});
