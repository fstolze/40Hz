/**
 * What Studio currently knows about where its audio is going.
 *
 * A thin reactive shell over `DeviceReader`, which owns the readings, their
 * wording, and every rule about ordering and timing. Deliberately thin: the
 * defects this has had were all ordering defects — a slow enumeration
 * restoring the state it captured, a device change that could not move the one
 * reading a rule depends on, a delayed read that outlived the audio it was
 * about — and logic that lives in a `.svelte.ts` module cannot be driven into
 * failure by the Node suite. What is left here is subscribing to the reader
 * and publishing what it says.
 *
 * The context is passed in rather than reached for, so the dependency runs one
 * way: the engine tells this what it built. The reverse would be a cycle, and
 * this module would then be the thing deciding when an AudioContext exists.
 */

import {
  DeviceReader,
  deviceFacts,
  type DeviceDirectory,
  type DeviceFact,
  type DeviceObservations,
  type OutputContext,
} from '../../integrity/devices.ts';
import { PREFERRED_SAMPLE_RATE } from '../../audio/graph.ts';

/**
 * The browser's device directory, or null where there is none.
 *
 * Absent is a real case rather than defensive: `navigator.mediaDevices` is
 * undefined outside a secure context, and the difference between "no output
 * device" and "never asked" is one this whole subsystem is built to keep.
 * Resolved per call, since a reader outlives any one look.
 */
function directory(): DeviceDirectory | null {
  const media = globalThis.navigator?.mediaDevices;
  return media === undefined ? null : { enumerateDevices: () => media.enumerateDevices() };
}

class DeviceState {
  private readonly reader = new DeviceReader(PREFERRED_SAMPLE_RATE, directory);

  observations = $state<DeviceObservations>(this.reader.current);

  constructor() {
    // Every path publishes through here, including the one that fires on a
    // timer with no caller waiting on it — which is the only way a reading
    // taken after playback settles reaches the screen.
    this.reader.onChange((observations) => {
      this.observations = observations;
    });
  }

  /** The three readings that are facts, phrased where they are defined. */
  get facts(): DeviceFact[] {
    return deviceFacts(this.observations);
  }

  /** Take what a newly built context reports. */
  observe(context: OutputContext | null): void {
    this.reader.observe(context);
  }

  /** Take what a running context reports, and look again once it has settled. */
  observeRunning(context: OutputContext): void {
    this.reader.observeRunning(context);
  }

  /** Called when playback stops, before a settle can read a suspending context. */
  stopSettling(): void {
    this.reader.stopSettling();
  }

  /**
   * Re-read the context and the output directory.
   *
   * Both, on every device change: the destination the context reports is what
   * `maxChannelCount` comes from, and a headset unplugged mid-session changes
   * it without changing anything else about the graph.
   */
  async refresh(): Promise<void> {
    await this.reader.refresh();
  }
}

export const devices = new DeviceState();

/**
 * Watch for devices appearing and disappearing.
 *
 * Started once at module load rather than by a component: a headset unplugged
 * while the integrity dialog happens to be closed is exactly the change worth
 * noticing, and a listener that only runs while something is watching would
 * miss it.
 *
 * It does not catch everything. Chromium fires this for a change in the *set*
 * of devices; switching the default sink on Linux changes where the audio goes
 * without changing that set, and nothing arrives. That is why playback
 * starting re-reads the directory too.
 */
const media = globalThis.navigator?.mediaDevices;
if (media !== undefined) {
  void devices.refresh();
  media.addEventListener('devicechange', () => {
    void devices.refresh();
  });
}
