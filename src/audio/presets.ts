/**
 * Presets — the bridge between Studio and Session.
 *
 * Studio is where a configuration is built; Session runs one without exposing
 * any controls. A preset is therefore the complete state needed to reproduce a
 * sound, and nothing else: no UI state, no session length, no scheduling.
 */

import { DEFAULT_PARAMS, type EntrainmentParams } from './dsp/entrainment-core.ts';
import {
  DEFAULT_MASTER_LEVEL,
  DEFAULT_SOUNDSCAPE,
  asNumber,
  asRecord,
  clampOr,
  normalizeParams,
  normalizeSoundscape,
  snapshotConfiguration,
  type SessionConfiguration,
  type SoundscapeOptions,
} from './configuration.ts';

export interface Preset {
  id: string;
  name: string;
  /** One line on what this preset is for, shown under the name. */
  description: string;
  params: EntrainmentParams;
  soundscape: SoundscapeOptions;
  masterLevel: number;
  builtIn?: boolean;
}

function preset(
  id: string,
  name: string,
  description: string,
  params: Partial<EntrainmentParams>,
  soundscape: Partial<SoundscapeOptions> = {},
  masterLevel = DEFAULT_MASTER_LEVEL,
): Preset {
  return {
    id,
    name,
    description,
    params: { ...DEFAULT_PARAMS, ...params },
    soundscape: { ...DEFAULT_SOUNDSCAPE, ...soundscape },
    masterLevel,
    builtIn: true,
  };
}

/**
 * Built-in presets, in the order the picker offers them.
 *
 * The copy describes the signal and does not promise an outcome. Every one of
 * these carries a 40 Hz envelope; whether any of them helps anyone concentrate
 * is not established, and none of the published results used these recipes.
 * Relative response strength is claimed only where studies compared the
 * signals directly — binaural against acoustic beats, and carriers against one
 * another.
 *
 * Ids are permanent even where names change: session records store the id, and
 * resolve it to whatever the preset is called now.
 */
export const BUILT_IN_PRESETS: Preset[] = [
  preset(
    'focus',
    'Balanced pulse',
    'Raised-cosine 40 Hz pulses over notched pink noise. Between sine and square gating; the default.',
    { duty: 0.5, edge: 0.5, depth: 1, amGain: 0.28, twoToneMode: 'off', twoToneGain: 0 },
    { color: 'pink', gain: 0.32, notchDepthDb: 6, notchQ: 8 },
  ),
  preset(
    'smooth',
    'Gentle AM',
    'Sinusoidal 40 Hz AM over brown noise — a carrier and two sidebands only. The smoothest envelope.',
    { duty: 1, edge: 1, depth: 1, amGain: 0.3, twoToneMode: 'off', twoToneGain: 0 },
    { color: 'brown', gain: 0.35, notchDepthDb: 5, notchQ: 8 },
  ),
  preset(
    'masked',
    'Subtle pulse',
    'Lower-level 40 Hz pulses under notched pink noise. Less noticeable; an equivalent neural response is not established.',
    { duty: 0.5, edge: 0.6, depth: 1, amGain: 0.1, twoToneMode: 'off', twoToneGain: 0 },
    { color: 'pink', gain: 0.55, notchDepthDb: 9, notchQ: 6 },
  ),
  preset(
    'monaural',
    'Monaural beat',
    'Two tones 40 Hz apart, mixed into both ears. The beat is in the signal itself, so it works on speakers.',
    { amGain: 0, twoToneMode: 'diotic', twoToneGain: 0.3 },
    { color: 'pink', gain: 0.3, notchDepthDb: 4, notchQ: 10 },
  ),
  preset(
    'binaural',
    'Binaural beat — headphones',
    'One tone per ear, 40 Hz apart. Needs headphones, and the response measured to it is smaller than to an acoustic beat.',
    { amGain: 0, twoToneMode: 'dichotic', twoToneGain: 0.26 },
    { color: 'brown', gain: 0.3, notchDepthDb: 4, notchQ: 10 },
  ),
  preset(
    'reference-500',
    '500 Hz AM reference',
    'Sinusoidal 40 Hz AM on a 500 Hz carrier with no bed. Resembles a signal used in hearing research; a reference, not a stronger setting.',
    {
      modulationHz: 40,
      carrierHz: 500,
      duty: 1,
      edge: 1,
      depth: 1,
      amGain: 0.25,
      twoToneMode: 'off',
      twoToneGain: 0,
    },
    { gain: 0 },
    0.5,
  ),
];

/**
 * Built-ins no longer offered, kept so history can still name them.
 *
 * A record whose preset id resolves to nothing reads "Deleted preset", which
 * would tell someone they deleted a preset they never touched. Anything that
 * names a record searches these too — through `nameablePresets` — and anything
 * that offers a choice must not.
 *
 * Maximum contrast left the picker as a comfort decision, not a research one:
 * square gating is transient-rich and fatiguing, and it remains a Studio
 * setting.
 */
export const LEGACY_PRESETS: Preset[] = [
  preset(
    'contrast',
    'Maximum contrast',
    'Square gating. The hardest, most transient-rich envelope — expect fatigue over long sessions.',
    { duty: 0.5, edge: 0, depth: 1, amGain: 0.2, twoToneMode: 'off', twoToneGain: 0 },
    { color: 'pink', gain: 0.5, notchDepthDb: 9, notchQ: 5 },
    0.6,
  ),
];

/**
 * The preset a fresh Studio and a fresh popover start on.
 *
 * Named once, because the choice used to live in three places — `App` hard-
 * coded an id while the picker and the popover took the first entry — and a
 * reordering would have split them without any of them noticing.
 */
export const DEFAULT_PRESET_ID = 'focus';

export const DEFAULT_PRESET: Preset = (() => {
  const found = BUILT_IN_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID);
  if (found === undefined) throw new Error(`default preset ${DEFAULT_PRESET_ID} is not offered`);
  return found;
})();

/** Every preset a session record might name: offered, retired, and saved. */
export function nameablePresets(saved: readonly Preset[]): Preset[] {
  return [...BUILT_IN_PRESETS, ...LEGACY_PRESETS, ...saved];
}

const STORAGE_KEY = 'fortyhz.presets.v1';

export function loadUserPresets(): Preset[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizePreset).filter((p): p is Preset => p !== null);
  } catch {
    return [];
  }
}

export function saveUserPresets(presets: Preset[]): void {
  try {
    const own = presets.filter((p) => !p.builtIn);
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(own));
  } catch {
    // Storage unavailable (private mode, quota). Presets stay in memory.
  }
}

/**
 * Coerce one stored entry into a usable preset, or `null` if it is not one.
 *
 * localStorage is untrusted input: it survives across versions, and a hand-
 * edited or half-written entry must not reach the audio thread. Every field is
 * therefore rebuilt from defaults rather than checked in place — the previous
 * shape test admitted `{ params: {} }`, and an unrecognised noise colour made
 * `createNoise()` return undefined and took the worklet down with it.
 *
 * Identity is the only hard requirement. Everything else falls back.
 */
export function normalizePreset(value: unknown): Preset | null {
  if (typeof value !== 'object' || value === null) return null;
  const p = value as Record<string, unknown>;
  if (typeof p.id !== 'string' || p.id === '') return null;
  if (typeof p.name !== 'string' || p.name === '') return null;

  return {
    id: p.id,
    name: p.name,
    description: typeof p.description === 'string' ? p.description : '',
    params: normalizeParams(asRecord(p.params)),
    soundscape: normalizeSoundscape(asRecord(p.soundscape)),
    masterLevel: clampOr(asNumber(p.masterLevel), 0, 1, DEFAULT_MASTER_LEVEL),
    builtIn: false,
  };
}

/**
 * A detached copy, safe to hand out.
 *
 * A spread alone is not one: `params` and `soundscape` would stay shared, so a
 * caller could reach through a returned preset and mutate whoever owns it.
 */
export function snapshotPreset(preset: Preset): Preset {
  return {
    ...preset,
    params: { ...preset.params },
    soundscape: { ...preset.soundscape },
  };
}

/**
 * The sound a preset describes, without its identity.
 *
 * `SessionConfiguration` is the same three fields a preset carries minus its
 * id, name and description, so this is a projection rather than a conversion —
 * and it is what lets Modified be a comparison between two values of one type
 * instead of a bespoke field-by-field check against a preset. Detached, so a
 * caller cannot reach through it into the stored preset.
 */
export function presetConfiguration(preset: Preset): SessionConfiguration {
  return snapshotConfiguration({
    params: preset.params,
    soundscape: preset.soundscape,
    masterLevel: preset.masterLevel,
  });
}

export function newPresetId(): string {
  return `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
