/**
 * The effective theme, and who decides it.
 *
 * The *preference* is a settings field and lives in the store like every other
 * setting. What this module owns is the much smaller question of what the
 * preference resolves to right now: `light` and `dark` answer themselves,
 * `system` has to ask the OS and keep asking.
 *
 * It is deliberately not a second source of truth. Nothing here writes a
 * preference, and nothing here persists anything — a theme key in
 * `localStorage` beside the settings file would be two answers to one question
 * and they would drift. The store is told by the Settings form and this module
 * only ever reads.
 *
 * It also owns the chart palette, for a mechanical reason: a canvas cannot use
 * `var()`, so the tokens have to be read out of the document and handed to the
 * drawing code. Reading them once per theme change rather than once per frame
 * matters — `getComputedStyle` is a real cost at sixty frames a second across
 * two canvases, and the answer only changes when the theme does.
 */

import { settingsStore } from './stores.ts';
import { DEFAULT_SETTINGS, resolveTheme, type Appearance } from '../../session/settings.ts';
import { fanOut, type Unsubscribe } from './fan-out.ts';

export type EffectiveTheme = 'light' | 'dark';

/** Every colour the two canvases draw with, resolved for the current theme. */
export interface ChartPalette {
  grid: string;
  gridFaint: string;
  axisText: string;
  signal: string;
  signalFillEdge: string;
  signalFillMid: string;
  markerStrong: string;
  markerWeak: string;
  markerLabelStrong: string;
  markerLabelWeak: string;
  bedLine: string;
  bedFillTop: string;
  bedFillBottom: string;
}

const CHART_TOKENS: Record<keyof ChartPalette, string> = {
  grid: '--chart-grid',
  gridFaint: '--chart-grid-faint',
  axisText: '--chart-axis-text',
  signal: '--chart-signal',
  signalFillEdge: '--chart-signal-fill-edge',
  signalFillMid: '--chart-signal-fill-mid',
  markerStrong: '--chart-marker-strong',
  markerWeak: '--chart-marker-weak',
  markerLabelStrong: '--chart-marker-label-strong',
  markerLabelWeak: '--chart-marker-label-weak',
  bedLine: '--chart-bed-line',
  bedFillTop: '--chart-bed-fill-top',
  bedFillBottom: '--chart-bed-fill-bottom',
};

/**
 * Read the chart tokens out of the document.
 *
 * Called after `data-theme` has been written, never before: the point of
 * `getComputedStyle` here is that the cascade has already decided, and reading
 * a frame early returns the theme being replaced.
 */
function readChartPalette(): ChartPalette {
  const style = getComputedStyle(document.documentElement);
  const palette = {} as ChartPalette;
  for (const [key, token] of Object.entries(CHART_TOKENS)) {
    palette[key as keyof ChartPalette] = style.getPropertyValue(token).trim();
  }
  return palette;
}

class ThemeState {
  /** What the user asked for. Mirrored from the store, never written here. */
  preference = $state<Appearance>(DEFAULT_SETTINGS.appearance);

  /** What that currently resolves to. */
  effective = $state<EffectiveTheme>('dark');

  /**
   * Raw, not deep: the whole palette is replaced on every theme change, so
   * there is nothing for per-property reactivity to earn, and the drawing code
   * wants one stable object per frame rather than thirteen tracked reads.
   */
  chart = $state.raw<ChartPalette>({} as ChartPalette);

  #query: MediaQueryList | null = null;
  #onSystemChange: (() => void) | null = null;

  /**
   * Begin following the preference. Returns the function that stops.
   *
   * Both renderers call this once at mount. It is not a component effect
   * because the document element it writes to outlives every component, and a
   * theme that unmounted with a panel would be a theme that flickered.
   */
  start(): Unsubscribe {
    // The preference, for the Settings form and for the browser path below.
    // Subscribing hands back the stored value *and* calls back on later
    // changes; adopting only the callback would leave the app on its default
    // until something else happened to change a setting.
    const stopWatchingSettings = settingsStore.subscribe((settings) => {
      this.preference = settings.appearance;
      if (subscribeToMain === null) this.#applyResolved();
    });

    /*
     * Under Electron the effective theme is main's answer, not ours.
     *
     * `prefers-color-scheme` inside an Electron 43 renderer reports light on a
     * dark machine, whatever `nativeTheme.themeSource` is set to — measured,
     * not assumed. So the OS reading belongs to the main process, which
     * publishes what the preference resolves to and re-publishes when the OS
     * changes underneath a `system` preference.
     *
     * Fanned out rather than subscribed directly: the preload keeps one
     * handler slot per channel, so the last caller in a window would otherwise
     * displace every earlier one.
     */
    const stopWatchingMain = subscribeToMain?.((next) => this.#apply(next)) ?? null;

    if (stopWatchingMain === null) {
      // A plain browser, where the media query does work.
      this.#query = globalThis.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
      this.#onSystemChange = () => this.#applyResolved();
      this.#query?.addEventListener('change', this.#onSystemChange);
      this.#applyResolved();
    }

    return () => {
      stopWatchingSettings();
      stopWatchingMain?.();
      if (this.#onSystemChange !== null) {
        this.#query?.removeEventListener('change', this.#onSystemChange);
      }
      this.#query = null;
      this.#onSystemChange = null;
    };
  }

  /** Resolve here, from the preference and the browser's own media query. */
  #applyResolved(): void {
    this.#apply(resolveTheme(this.preference, this.#query?.matches ?? true));
  }

  #apply(next: EffectiveTheme): void {
    if (next === this.effective && this.chart.grid !== undefined) return;

    // `data-theme` is always written, including for dark. Selecting dark by the
    // absence of an attribute would make "not resolved yet" and "resolved to
    // dark" the same state, and only one of them should stop a flash.
    document.documentElement.dataset.theme = next;
    this.effective = next;
    this.chart = readChartPalette();
  }
}

/**
 * Main's theme publication, when there is a main process to ask.
 *
 * Null in the browser build, which is what selects the media-query path.
 */
const bridgeTheme = globalThis.window?.desktop?.theme;
const subscribeToMain: ((onChange: (theme: EffectiveTheme) => void) => Unsubscribe) | null =
  bridgeTheme ? fanOut((onChange) => bridgeTheme.subscribe(onChange)) : null;

export const theme = new ThemeState();
