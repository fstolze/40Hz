/**
 * Studio engine state.
 *
 * Owns the EntrainmentGraph lifecycle and mirrors its parameters into reactive
 * state the UI binds to. The graph is created lazily on first start, because
 * an AudioContext may not be resumed before a user gesture.
 */

import {
  EntrainmentGraph,
  PREFERRED_SAMPLE_RATE,
  MAX_MASTER_LEVEL,
  type SessionTiming,
} from '../../audio/graph.ts';
import {
  DEFAULT_MASTER_LEVEL,
  DEFAULT_SOUNDSCAPE,
  snapshotConfiguration,
  type SessionConfiguration,
  type SoundscapeOptions,
} from '../../audio/configuration.ts';
import { DEFAULT_PARAMS, type EntrainmentParams } from '../../audio/dsp/entrainment-core.ts';
import type { Preset } from '../../audio/presets.ts';
import { devices } from './devices.svelte.ts';
import { captureChanged, captureStopped } from './capture-driver.ts';

/** Worklet URLs, resolved against the document base so file:// works in Electron. */
function workletUrl(name: string): string {
  return new URL(`worklets/${name}.js`, document.baseURI).href;
}

export interface EngineStatus {
  ready: boolean;
  running: boolean;
  sampleRate: number;
  /** Set when the context is not at the rate we asked for. */
  sampleRateWarning: string | null;
  error: string | null;
}

class EngineState {
  params = $state<EntrainmentParams>({ ...DEFAULT_PARAMS });
  soundscape = $state<SoundscapeOptions>({ ...DEFAULT_SOUNDSCAPE });
  masterLevel = $state(DEFAULT_MASTER_LEVEL);
  status = $state<EngineStatus>({
    ready: false,
    running: false,
    sampleRate: 0,
    sampleRateWarning: null,
    error: null,
  });

  #graph: EntrainmentGraph | null = null;

  get graph(): EntrainmentGraph | null {
    return this.#graph;
  }

  get analyser(): AnalyserNode | null {
    return this.#graph?.analyser ?? null;
  }

  /** Ceiling applied on top of the UI control, for display. */
  get ceiling(): number {
    return MAX_MASTER_LEVEL;
  }

  async ensure(): Promise<EntrainmentGraph> {
    if (this.#graph) return this.#graph;

    const graph = await EntrainmentGraph.create({
      entrainmentWorkletUrl: workletUrl('entrainment-processor'),
      noiseWorkletUrl: workletUrl('noise-processor'),
      notchWorkletUrl: workletUrl('notch-processor'),
      captureWorkletUrl: workletUrl('capture-processor'),
    });

    this.#graph = graph;
    graph.setParams(this.params);
    graph.setSoundscape(this.soundscape);
    graph.setMasterLevel(this.masterLevel, 0);

    // The destination exists now, so the one device reading that supports a
    // rule can finally be taken. Told rather than fetched: this module owns
    // when a context exists, and nothing else should have to guess.
    devices.observe(graph.context);

    const rate = graph.context.sampleRate;
    this.status = {
      ...this.status,
      ready: true,
      sampleRate: rate,
      sampleRateWarning: graph.sampleRateMatchesPreference
        ? null
        : `Running at ${rate} Hz, not the requested ${PREFERRED_SAMPLE_RATE} Hz. ` +
          `The engine is correct at either rate, but ${PREFERRED_SAMPLE_RATE} keeps the ` +
          `25 ms modulation period aligned to whole samples.`,
    };

    return graph;
  }

  /**
   * Begin untimed playback.
   *
   * Rethrows rather than only recording the error. The coordinator publishes
   * `previewing` on the strength of this resolving, so swallowing a failure
   * here would claim audio that never started.
   */
  async start(): Promise<void> {
    try {
      const graph = await this.ensure();
      await graph.start();
      // Read now, and again once the context has been running long enough for
      // the platform to know its own output latency — which it does not at
      // this instant, however long it has been since the graph was built.
      devices.observeRunning(graph.context);
      // Steady playback has just been scheduled, so a measurement of it is
      // now worth taking — a whole window after the ramp, which the schedule
      // works out for itself.
      captureChanged(graph);
      this.status = { ...this.status, running: true, error: null };
    } catch (err) {
      this.status = { ...this.status, error: describeError(err) };
      throw err;
    }
  }

  /**
   * Stop playback, fading over `rampSeconds`.
   *
   * Rethrows rather than only recording the error: the coordinator decides
   * whether it may release ownership of the audio, and it can only decide that
   * if a failure reaches it.
   */
  async stop(rampSeconds?: number): Promise<void> {
    if (!this.#graph) return;
    // Nothing to settle once the audio is going away, and a reading taken
    // against a suspended context would replace a real latency with a zero.
    devices.stopSettling();
    captureStopped();
    this.status = { ...this.status, running: false };
    try {
      await this.#graph.stop(rampSeconds);
    } catch (err) {
      this.status = { ...this.status, error: describeError(err) };
      throw err;
    }
  }

  async toggle(): Promise<void> {
    if (this.status.running) await this.stop();
    else await this.start();
  }

  setParams(next: Partial<EntrainmentParams>): void {
    this.params = { ...this.params, ...next };
    this.#graph?.setParams(this.params);
  }

  setSoundscape(next: Partial<SoundscapeOptions>): void {
    this.soundscape = { ...this.soundscape, ...next };
    this.#graph?.setSoundscape(this.soundscape);
  }

  setMasterLevel(level: number): void {
    this.masterLevel = level;
    this.#graph?.setMasterLevel(level);
  }

  /** Everything needed to reproduce what is playing. */
  currentConfiguration(): SessionConfiguration {
    return snapshotConfiguration({
      params: this.params,
      soundscape: this.soundscape,
      masterLevel: this.masterLevel,
    });
  }

  applyConfiguration(configuration: SessionConfiguration): void {
    this.params = { ...configuration.params };
    this.soundscape = { ...configuration.soundscape };
    this.masterLevel = configuration.masterLevel;
    this.#graph?.setParams(this.params);
    this.#graph?.setSoundscape(this.soundscape);
    this.#graph?.setMasterLevel(this.masterLevel);
  }

  /**
   * Begin a timed session, resolving with the wall-clock instant audio began.
   *
   * Null when the start was superseded. The coordinator anchors its monotonic
   * reference to what comes back, so this is taken as close to the scheduling
   * as possible rather than before it.
   */
  async startSession(timing: SessionTiming): Promise<number | null> {
    try {
      const graph = await this.ensure();
      const startedAt = await graph.startSession(timing);
      if (startedAt === null) return null;
      devices.observeRunning(graph.context);
      captureChanged(graph);
      this.status = { ...this.status, running: true, error: null };
      return Date.now();
    } catch (err) {
      this.status = { ...this.status, error: describeError(err) };
      throw err;
    }
  }

  applyPreset(preset: Preset): void {
    this.params = { ...preset.params };
    this.soundscape = { ...preset.soundscape };
    this.masterLevel = preset.masterLevel;
    this.#graph?.setParams(this.params);
    this.#graph?.setSoundscape(this.soundscape);
    this.#graph?.setMasterLevel(this.masterLevel);
  }

  /** Surface a failure in the banner App already shows. */
  reportError(error: unknown): void {
    this.status = { ...this.status, error: describeError(error) };
  }

  dismissError(): void {
    this.status = { ...this.status, error: null };
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export const engine = new EngineState();
