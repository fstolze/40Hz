/**
 * Stored preset validation.
 *
 * localStorage is untrusted input: it survives across versions, and a hand-
 * edited or half-written entry must not reach the audio thread. The cases that
 * matter are the ones that used to pass a shape check and fail later — an
 * unknown noise colour in particular, which made `createNoise()` return
 * undefined and took the worklet down on the next render.
 */

import { describe, it, expect } from './helpers/expect.ts';
import {
  loadUserPresets,
  BUILT_IN_PRESETS,
  DEFAULT_PRESET,
  DEFAULT_PRESET_ID,
  LEGACY_PRESETS,
  presetConfiguration,
} from '../src/audio/presets.ts';
import { DEFAULT_PARAMS } from '../src/audio/dsp/entrainment-core.ts';
import {
  DEFAULT_MASTER_LEVEL,
  DEFAULT_SOUNDSCAPE,
  configurationsEqual,
  type SessionConfiguration,
} from '../src/audio/configuration.ts';
import { createNoise } from '../src/audio/dsp/noise.ts';
import { clampCarrierHz } from '../src/audio/tuning.ts';

/** Install a localStorage stub holding `value` verbatim. */
function withStored(value: string, run: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => value, setItem: () => {} },
  });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

function loadOne(entry: unknown): ReturnType<typeof loadUserPresets>[number] | undefined {
  let result: ReturnType<typeof loadUserPresets> = [];
  withStored(JSON.stringify([entry]), () => {
    result = loadUserPresets();
  });
  return result[0];
}

const VALID = {
  id: 'user-1',
  name: 'Mine',
  description: 'a preset',
  params: { ...DEFAULT_PARAMS, amGain: 0.4 },
  soundscape: { ...DEFAULT_SOUNDSCAPE },
  masterLevel: 0.5,
};

describe('preset loading', () => {
  it('keeps a well-formed preset', () => {
    const p = loadOne(VALID);
    expect(p?.id).toBe('user-1');
    expect(p?.params.amGain).toBe(0.4);
    expect(p?.masterLevel).toBe(0.5);
  });

  it('marks loaded presets as not built in', () => {
    expect(loadOne({ ...VALID, builtIn: true })?.builtIn).toBe(false);
  });

  it('drops entries with no usable identity', () => {
    expect(loadOne({ ...VALID, id: undefined })).toBe(undefined);
    expect(loadOne({ ...VALID, name: '' })).toBe(undefined);
    expect(loadOne(null)).toBe(undefined);
    expect(loadOne('not a preset')).toBe(undefined);
  });

  it('survives malformed JSON and a non-array payload', () => {
    withStored('{{{', () => expect(loadUserPresets().length).toBe(0));
    withStored('{"a":1}', () => expect(loadUserPresets().length).toBe(0));
  });
});

describe('preset field coercion', () => {
  it('fills missing sections from defaults', () => {
    const p = loadOne({ id: 'u', name: 'n' });
    expect(p?.params.amGain).toBe(DEFAULT_PARAMS.amGain);
    expect(p?.soundscape.color).toBe(DEFAULT_SOUNDSCAPE.color);
    expect(p?.soundscape.gain).toBe(DEFAULT_SOUNDSCAPE.gain);
    expect(p?.masterLevel).toBe(0.7);
  });

  it('replaces an unknown noise colour, so createNoise cannot return undefined', () => {
    const p = loadOne({ ...VALID, soundscape: { ...DEFAULT_SOUNDSCAPE, color: 'chartreuse' } });
    expect(p?.soundscape.color).toBe(DEFAULT_SOUNDSCAPE.color);
    // The failure this guards: an unrecognised colour reaching the generator.
    expect(typeof createNoise(p!.soundscape.color).next()).toBe('number');
  });

  it('replaces an unknown two-tone mode', () => {
    const p = loadOne({ ...VALID, params: { ...DEFAULT_PARAMS, twoToneMode: 'sideways' } });
    expect(p?.params.twoToneMode).toBe(DEFAULT_PARAMS.twoToneMode);
  });

  it('rejects non-finite numbers rather than passing NaN to the audio thread', () => {
    const p = loadOne({
      ...VALID,
      params: { ...DEFAULT_PARAMS, carrierHz: Number.NaN, amGain: Number.POSITIVE_INFINITY },
      soundscape: { ...DEFAULT_SOUNDSCAPE, gain: Number.NaN },
      masterLevel: Number.NaN,
    });
    expect(p?.params.carrierHz).toBe(DEFAULT_PARAMS.carrierHz);
    expect(p?.params.amGain).toBe(DEFAULT_PARAMS.amGain);
    expect(p?.soundscape.gain).toBe(DEFAULT_SOUNDSCAPE.gain);
    expect(p?.masterLevel).toBe(0.7);
  });

  it('rejects wrong-typed fields', () => {
    const p = loadOne({
      ...VALID,
      description: 42,
      params: { ...DEFAULT_PARAMS, amGain: '0.9' },
      soundscape: 'pink',
    });
    expect(p?.description).toBe('');
    expect(p?.params.amGain).toBe(DEFAULT_PARAMS.amGain);
    expect(p?.soundscape.color).toBe(DEFAULT_SOUNDSCAPE.color);
  });

  it('clamps out-of-range values into the ranges the engine accepts', () => {
    const p = loadOne({
      ...VALID,
      params: { ...DEFAULT_PARAMS, carrierHz: 999999, depth: -5 },
      soundscape: { ...DEFAULT_SOUNDSCAPE, gain: 12, notchQ: 0 },
      masterLevel: 40,
    });
    expect(p!.params.carrierHz).toBeLessThanOrEqual(8000);
    expect(p!.params.depth).toBeGreaterThanOrEqual(0);
    expect(p!.soundscape.gain).toBeLessThanOrEqual(1);
    expect(p!.soundscape.notchQ).toBeGreaterThan(0);
    expect(p!.masterLevel).toBeLessThanOrEqual(1);
  });
});

describe('built-in presets', () => {
  it('are all internally consistent', () => {
    for (const p of [...BUILT_IN_PRESETS, ...LEGACY_PRESETS]) {
      expect(typeof createNoise(p.soundscape.color).next()).toBe('number');
      expect(p.masterLevel).toBeLessThanOrEqual(1);
      expect(p.masterLevel).toBeGreaterThan(0);
    }
  });

  it('load inside the range their own carrier controls offer', () => {
    // Outside it, the slider cannot show the preset's carrier and its first
    // touch clamps the value away — the preset is then unreachable by editing.
    for (const p of [...BUILT_IN_PRESETS, ...LEGACY_PRESETS]) {
      expect(`${p.id}: ${clampCarrierHz(p.params.carrierHz)}`).toBe(
        `${p.id}: ${p.params.carrierHz}`,
      );
    }
  });

  it('offers the preset a fresh Studio and popover start on', () => {
    expect(DEFAULT_PRESET.id).toBe(DEFAULT_PRESET_ID);
    expect(BUILT_IN_PRESETS.includes(DEFAULT_PRESET)).toBe(true);
  });

  it('never gives two presets, offered or retired, the same id', () => {
    // History resolves a record against both lists at once, so a collision
    // would name the record after whichever list came first.
    const ids = [...BUILT_IN_PRESETS, ...LEGACY_PRESETS].map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * Modified, which is a value comparison and nothing else.
 *
 * Modified means the selected preset's persistable configuration differs from
 * `engine.currentConfiguration()`, ignoring transient UI state and numeric
 * formatting. The hazards are all in the details: a shallow
 * or reference comparison would report every recipe as modified the moment a
 * preset was applied, and an enumerated field list would silently stop
 * reporting the day someone adds a parameter.
 */
describe('configuration comparison', () => {
  const base = (): SessionConfiguration => ({
    params: { ...DEFAULT_PARAMS },
    soundscape: { ...DEFAULT_SOUNDSCAPE },
    masterLevel: DEFAULT_MASTER_LEVEL,
  });

  it('is a value comparison, not a reference one', () => {
    // Two distinct objects with identical contents. A reference check would
    // call these different and mark every freshly applied preset as modified.
    expect(configurationsEqual(base(), base())).toBe(true);
  });

  it('reports a difference in every entrainment parameter', () => {
    for (const key of Object.keys(DEFAULT_PARAMS)) {
      const other = base();
      const current = (other.params as unknown as Record<string, unknown>)[key];
      (other.params as unknown as Record<string, unknown>)[key] =
        typeof current === 'number' ? current + 1 : 'changed';
      expect(configurationsEqual(base(), other)).toBe(false);
    }
  });

  it('reports a difference in every soundscape option', () => {
    for (const key of Object.keys(DEFAULT_SOUNDSCAPE)) {
      const other = base();
      const current = (other.soundscape as unknown as Record<string, unknown>)[key];
      (other.soundscape as unknown as Record<string, unknown>)[key] =
        typeof current === 'number' ? current + 1 : 'changed';
      expect(configurationsEqual(base(), other)).toBe(false);
    }
  });

  it('reports a difference in master, which a preset also stores', () => {
    const other = base();
    other.masterLevel = DEFAULT_MASTER_LEVEL - 0.1;
    expect(configurationsEqual(base(), other)).toBe(false);
  });

  it('clears again when the value returns exactly', () => {
    const other = base();
    other.params.carrierHz = 440;
    expect(configurationsEqual(base(), other)).toBe(false);
    other.params.carrierHz = DEFAULT_PARAMS.carrierHz;
    expect(configurationsEqual(base(), other)).toBe(true);
  });

  it('ignores float noise, which is what "numeric formatting" means here', () => {
    const other = base();
    /*
     * One ulp, not a hand-written near-miss.
     *
     * The first version of this used `0.1 + 0.2 - 0.3`, which at 0.5 is half
     * an ulp and rounds straight back to 0.5 — so it proved nothing and failed
     * its own premise. `Number.EPSILON` is two ulps at this magnitude, which
     * really is a different double.
     */
    other.params.duty = DEFAULT_PARAMS.duty + Number.EPSILON;
    expect(other.params.duty === DEFAULT_PARAMS.duty).toBe(false);
    expect(configurationsEqual(base(), other)).toBe(true);
  });

  it('still reports the smallest change any control can make', () => {
    // 0.005 is the step on the two level sliders — the finest the UI offers,
    // and six orders of magnitude above the tolerance above.
    const other = base();
    other.params.amGain = DEFAULT_PARAMS.amGain + 0.005;
    expect(configurationsEqual(base(), other)).toBe(false);
  });

  it('compares a field one side has and the other does not', () => {
    // The schema-growth guard. Adding a parameter must not produce a field
    // that can change without the comparison noticing.
    const other = base();
    (other.params as unknown as Record<string, unknown>).newlyAdded = 1;
    expect(configurationsEqual(base(), other)).toBe(false);
  });

  it('treats a null bed id as equal to itself', () => {
    const a = base();
    const b = base();
    a.soundscape.bedId = null;
    b.soundscape.bedId = null;
    expect(configurationsEqual(a, b)).toBe(true);
    b.soundscape.bedId = 'bed-1';
    expect(configurationsEqual(a, b)).toBe(false);
  });
});

describe('preset projection', () => {
  it('matches its own preset, for every built-in', () => {
    // The property the picker depends on: selecting a preset and changing
    // nothing must not read as modified.
    for (const preset of BUILT_IN_PRESETS) {
      expect(configurationsEqual(presetConfiguration(preset), presetConfiguration(preset))).toBe(
        true,
      );
    }
  });

  it('detaches, so a caller cannot reach into the stored preset', () => {
    const preset = BUILT_IN_PRESETS[0];
    const projected = presetConfiguration(preset);
    projected.params.carrierHz = 999;
    projected.soundscape.gain = 0.99;
    expect(preset.params.carrierHz === 999).toBe(false);
    expect(preset.soundscape.gain === 0.99).toBe(false);
  });

  it('distinguishes the built-ins from one another', () => {
    // If this ever passed, Modified would be meaningless: every preset would
    // compare equal to every other and nothing would ever read as changed.
    // Every pair, rather than the first two: the order is presentation, and a
    // positional pick silently changes what it compares when the list moves.
    const all = [...BUILT_IN_PRESETS, ...LEGACY_PRESETS];
    for (const [i, a] of all.entries()) {
      for (const b of all.slice(i + 1)) {
        const same = configurationsEqual(presetConfiguration(a), presetConfiguration(b));
        expect(`${a.id} vs ${b.id}: ${same}`).toBe(`${a.id} vs ${b.id}: false`);
      }
    }
  });
});
