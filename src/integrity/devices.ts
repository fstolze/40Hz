/**
 * What this stack will tell us about where the audio is going.
 *
 * Four readings, and **none of them supports a conclusion**. That is the point
 * of this module, and it was arrived at rather than assumed: render rate,
 * latency, and the browser's output-device label cannot establish that the path
 * is intact. The fourth — channel count — was built into a rule, shipped, and
 * then withdrawn when it turned out to describe our own graph rather than the
 * device. So all four are facts, carried with the wording that keeps them facts.
 * A reading that cannot say what a listener should do does not get to imply it.
 *
 * Expressed against minimal structural interfaces rather than `AudioContext`
 * and `MediaDevices`, like `capture-client.ts` — so the readings, the fallbacks
 * and above all the copy are driven in Node against fakes, and none of it
 * depends on a browser that would report whatever this machine happens to have.
 */

import { Serial } from '../lib/serial.ts';
import { timerSchedule, type Schedule } from '../lib/schedule.ts';

/** The slice of `AudioContext` this reads. */
export interface OutputContext {
  /** The rate the graph renders at. Not the hardware rate. */
  sampleRate: number;
  baseLatency: number;
  /** Absent on implementations that do not report it. */
  outputLatency?: number;
  destination: { maxChannelCount: number };
}

/** One entry from `enumerateDevices()`. */
export interface DeviceEntry {
  kind: string;
  deviceId: string;
  /** Empty until the page has been granted device permission. */
  label: string;
}

export type { Schedule } from '../lib/schedule.ts';

/**
 * How long to wait before reading the latency again.
 *
 * `outputLatency` is zero until audio has been rendering long enough for the
 * platform to have timed a callback — measured at 0 on a context that had just
 * started, and 24 ms on the same context a second later. Without a second look
 * the reading taken at `start()` is the only one ever taken, and the fact reads
 * "not available" for the whole session.
 *
 * Two seconds rather than the ~700 ms observed: the cost of waiting is that a
 * fact appears a second later, and the cost of being early is that it never
 * appears at all.
 */
export const LATENCY_SETTLE_MS = 2000;

/** The slice of `navigator.mediaDevices` this reads. */
export interface DeviceDirectory {
  enumerateDevices(): Promise<readonly DeviceEntry[]>;
}

export interface DefaultOutput {
  deviceId: string;
  /**
   * The device's name, or null when the browser withheld it.
   *
   * Null is recorded rather than the empty string the API returns, and the
   * finding says "not available" rather than omitting the device — a label is
   * withheld until the page has microphone permission, and prompting for a
   * microphone to read a speaker's name is a bad trade in an app whose history
   * is deliberately private.
   */
  label: string | null;
}

export interface DeviceObservations {
  /**
   * The rate the graph renders at, or null before a graph exists.
   *
   * **Not the hardware rate.** `graph.ts` already says the request is a hint
   * and the OS may resample regardless, so a mismatch here means our own
   * rendering differs from what we asked for — not that the device is running
   * at this rate.
   */
  renderRateHz: number | null;
  /** What was asked for. A parameter, so this module stays free of `graph.ts`. */
  requestedRateHz: number;
  /** Latency, which is not transport: no threshold here identifies Bluetooth. */
  baseLatencySeconds: number | null;
  outputLatencySeconds: number | null;
  /** From `context.destination`, or null before a graph exists. */
  maxChannelCount: number | null;
  /** The default `audiooutput` entry, or null when there was none to read. */
  defaultOutput: DefaultOutput | null;
  /**
   * Whether the directory could be consulted at all.
   *
   * Distinguishes "asked, and there is no default output" from "never asked",
   * which is the same distinction `checked` makes for a finding and matters
   * for the same reason.
   */
  outputsEnumerated: boolean;
}

/** Nothing observed yet: no graph, and no directory consulted. */
export function noObservations(requestedRateHz: number): DeviceObservations {
  return {
    renderRateHz: null,
    requestedRateHz,
    baseLatencySeconds: null,
    outputLatencySeconds: null,
    maxChannelCount: null,
    defaultOutput: null,
    outputsEnumerated: false,
  };
}

function finite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Exactly zero output latency, which is not a latency.
 *
 * Chromium derives `outputLatency` from real callback timing, so it reads 0
 * until audio has actually been rendering for a moment — measured here at 0 on
 * a context that had just started, and 24 ms on the same context a second
 * later. No real output path has zero latency, so this is the platform saying
 * "not yet", and showing it as a measurement would put a number on screen
 * nobody took. `baseLatency` is not treated this way: it is a property of the
 * graph's buffering and is meaningful immediately.
 */
function measuredLatency(value: number | undefined): number | null {
  const seconds = finite(value);
  return seconds === null || seconds === 0 ? null : seconds;
}

/** What a live context reports, folded into observations that had none. */
export function withContext(
  observations: DeviceObservations,
  context: OutputContext | null,
): DeviceObservations {
  if (context === null) return { ...observations };
  return {
    ...observations,
    renderRateHz: finite(context.sampleRate),
    baseLatencySeconds: finite(context.baseLatency),
    outputLatencySeconds: measuredLatency(context.outputLatency),
    maxChannelCount: finite(context.destination.maxChannelCount),
  };
}

/** What one look at the output directory produced. Nothing else. */
export interface OutputReading {
  outputsEnumerated: boolean;
  defaultOutput: DefaultOutput | null;
}

const NO_OUTPUTS: OutputReading = { outputsEnumerated: false, defaultOutput: null };

/**
 * The default output device, as the directory currently reports it.
 *
 * Deliberately answers a *reading* rather than a whole updated observation.
 * Enumeration is asynchronous, and a function that took the state, awaited,
 * and answered a modified copy of what it captured would put stale readings
 * back over anything that changed while it waited — which is exactly what
 * happened: the enumeration started at load resolved after the graph was
 * built and erased its channel count, rate and latency. Separating the read
 * from the merge is what makes the merge cheap enough to do against the
 * current state instead.
 *
 * Failure is not absence: a directory that throws reads as not enumerated, so
 * the fact says the device could not be read rather than claiming there is
 * none.
 */
export async function readOutputDevice(directory: DeviceDirectory | null): Promise<OutputReading> {
  if (directory === null) return { ...NO_OUTPUTS };

  let entries: readonly DeviceEntry[];
  try {
    entries = await directory.enumerateDevices();
  } catch {
    return { ...NO_OUTPUTS };
  }

  const outputs = entries.filter((entry) => entry.kind === 'audiooutput');
  // `default` is the entry the OS routes to, and it is the one the user would
  // recognise. Falling back to the first output rather than reporting none:
  // platforms that do not synthesise a `default` entry still have one device
  // in the list, and saying nothing there would read as nothing connected.
  const chosen = outputs.find((entry) => entry.deviceId === 'default') ?? outputs[0];

  return {
    outputsEnumerated: true,
    defaultOutput:
      chosen === undefined
        ? null
        : { deviceId: chosen.deviceId, label: chosen.label === '' ? null : chosen.label },
  };
}

/** Fold a reading into observations. Pure, so the caller chooses which ones. */
export function withOutputDevice(
  observations: DeviceObservations,
  reading: OutputReading,
): DeviceObservations {
  return {
    ...observations,
    outputsEnumerated: reading.outputsEnumerated,
    defaultOutput: reading.defaultOutput,
  };
}

/**
 * The live observations, and the two ways they change.
 *
 * Kept here rather than in the Svelte store that displays them, because both
 * of the defects this class exists to prevent are ordering defects, and
 * ordering is exactly what a component cannot be driven into:
 *
 * - **A refresh must not restore what it captured.** Enumeration is
 *   asynchronous. The read is done first and merged into the state as it is
 *   *when it lands*, so a graph built while the directory was being read keeps
 *   its channel count instead of being wiped back to nulls.
 * - **Refreshes are serialized**, so two device changes in quick succession
 *   cannot land out of order and leave the older answer showing.
 *
 * And the context is *retained*, not sampled once. `maxChannelCount` is the
 * only reading that supports a rule, and the whole point of watching
 * `devicechange` is that it moves — a headset unplugged mid-session leaves the
 * same context reporting a different destination. Reading it only when the
 * graph is built would update the device's name and nothing else.
 */
export class DeviceReader {
  private observations: DeviceObservations;
  private context: OutputContext | null = null;
  private readonly directory: () => DeviceDirectory | null;
  private readonly refreshes = new Serial();
  private readonly schedule: Schedule;
  private listener: ((observations: DeviceObservations) => void) | null = null;

  /**
   * Bumped whenever playback starts or stops.
   *
   * A refresh reads the directory asynchronously and then merges *both* halves
   * — the reading and the live context. The context half is only valid if the
   * run it started in is still going: `outputLatency` returns to zero as a
   * context suspends, and this module records a zero as "not measured", so a
   * refresh landing just after a stop replaced a real measurement with an
   * artefact of stopping. Claimed before the await and rechecked after it, the
   * way every other generation in this repo is.
   */
  private run = 0;

  constructor(
    requestedRateHz: number,
    directory: () => DeviceDirectory | null,
    schedule: Schedule = timerSchedule(),
  ) {
    this.observations = noObservations(requestedRateHz);
    this.directory = directory;
    this.schedule = schedule;
  }

  get current(): DeviceObservations {
    return this.observations;
  }

  /**
   * Watch the readings.
   *
   * One listener, like the executor link's handlers: there is one display, and
   * a second subscriber would mean two views of a single current state. It is
   * how a reading taken on a timer reaches the surface at all.
   */
  onChange(listener: ((observations: DeviceObservations) => void) | null): void {
    this.listener = listener;
  }

  private publish(): DeviceObservations {
    this.listener?.(this.observations);
    return this.observations;
  }

  /**
   * Take the context to read from now on.
   *
   * Told rather than fetched: whoever builds the graph knows when there is one,
   * and this class has no business guessing.
   */
  observe(context: OutputContext | null): DeviceObservations {
    this.context = context;
    this.observations = withContext(this.observations, context);
    return this.publish();
  }

  /**
   * Take what a context reports, ask the directory again, and look once more
   * when the platform has settled.
   *
   * Called when playback starts, which is the one moment a reading is known to
   * be incomplete — and the one moment the user has just acted, so it is also
   * the cheapest place to correct anything that went stale unnoticed.
   *
   * The directory is re-read here rather than left to `devicechange`, because
   * that event does not fire for every change that matters: switching the
   * default sink on Linux (PipeWire) changes which device the audio goes to
   * without changing the set of devices, and Chromium reports nothing. The
   * panel then describes the device the user just stopped using. Windows fires
   * it and updates within seconds; this is what closes the gap elsewhere.
   */
  observeRunning(context: OutputContext): DeviceObservations {
    this.run += 1;
    const observations = this.observe(context);
    // Queued like every other refresh, so it cannot land out of order with a
    // device change that arrives at the same moment.
    void this.refresh();
    this.schedule.after(LATENCY_SETTLE_MS, () => {
      this.reread();
    });
    return observations;
  }

  /**
   * Called when playback stops: there is nothing left to settle.
   *
   * Not housekeeping. A settle that outlives the audio reads a context that is
   * suspending, whose output latency is on its way back to zero — so a stop
   * quick enough to beat the timer would replace a real measurement with the
   * absence this module records for "not measured yet".
   */
  stopSettling(): void {
    this.run += 1;
    this.schedule.cancel();
  }

  /**
   * Re-read the retained context, without touching the directory.
   *
   * Cheap and synchronous, for the readings that only become available once
   * audio has actually been rendering. `outputLatency` is the one that needs
   * it: Chromium derives it from callback timing, so a context reports zero
   * until it has been running for a moment, and the value taken the instant
   * playback starts is never the one worth showing.
   */
  reread(): DeviceObservations {
    this.observations = withContext(this.observations, this.context);
    return this.publish();
  }

  /** Re-read both the context and the directory, newest state wins. */
  async refresh(): Promise<DeviceObservations> {
    // Claimed here, not inside the queued work: the queue itself is an await.
    // Taken there, a refresh kicked off by `observeRunning` would read the
    // generation only once its turn came round — by which time a stop has
    // already happened and bumped it, so the check would compare a stopped
    // run against itself and pass. The guard-before-an-await rule, in the very
    // commit that added the guard.
    const run = this.run;
    return this.refreshes.run(async () => {
      const reading = await readOutputDevice(this.directory());
      // The directory reading is merged whatever happened while it was in
      // flight: a device list does not stop being true because playback ended.
      // The context is re-read only if the run is the one this started in —
      // otherwise the only thing that changed about it is that it is winding
      // down, and reading that would report an artefact as a measurement.
      const base =
        run === this.run ? withContext(this.observations, this.context) : this.observations;
      this.observations = withOutputDevice(base, reading);
      return this.publish();
    });
  }
}

/**
 * A reading, and the words that keep it a reading.
 *
 * Presentation renders these; it does not phrase them. The wording is the
 * substance — "graph render rate" rather than "sample rate", latency reported
 * as latency rather than read as transport — and an earlier draft of this step
 * proposed a "Bluetooth proxy" fitted to one machine's latency figure, which
 * is the guess this project has already made twice.
 */
export interface DeviceFact {
  id: string;
  label: string;
  value: string;
  /** Why the number is less than it looks, where that is not obvious. */
  note?: string;
}

const UNAVAILABLE = 'not available';

function hz(value: number): string {
  return `${Math.round(value).toLocaleString('en-US')} Hz`;
}

function ms(value: number): string {
  return `${(value * 1000).toFixed(1)} ms`;
}

/** The three readings that are facts, in the order a reader wants them. */
export function deviceFacts(observations: DeviceObservations): DeviceFact[] {
  const { renderRateHz, requestedRateHz, baseLatencySeconds, outputLatencySeconds } = observations;

  const rate: DeviceFact = {
    id: 'render-rate',
    label: 'Graph render rate',
    value: renderRateHz === null ? UNAVAILABLE : hz(renderRateHz),
    note:
      renderRateHz === null
        ? 'Nothing has played yet.'
        : renderRateHz === requestedRateHz
          ? `The rate we asked for. It is not the hardware rate — the system may resample below this.`
          : `We asked for ${hz(requestedRateHz)}. The engine is correct at either rate, and this is what we render at, not what the hardware runs at.`,
  };

  const latency: DeviceFact = {
    id: 'latency',
    label: 'Reported latency',
    value:
      baseLatencySeconds === null && outputLatencySeconds === null
        ? UNAVAILABLE
        : [
            baseLatencySeconds === null ? null : `${ms(baseLatencySeconds)} base`,
            outputLatencySeconds === null ? null : `${ms(outputLatencySeconds)} output`,
          ]
            .filter((part): part is string => part !== null)
            .join(' · '),
    // The whole reason this is a fact and not a rule.
    note: 'Latency only. It does not identify Bluetooth, spatial processing, or any other stage in the path.',
  };

  const channels: DeviceFact = {
    id: 'output-channels',
    label: 'Output channels',
    value:
      observations.maxChannelCount === null ? UNAVAILABLE : String(observations.maxChannelCount),
    // The fact that used to be a rule. It read 2 for a mono speakerphone, a
    // one-channel sink, a headset in its hands-free profile, and with Windows'
    // Mono audio setting on — which sums the channels outright. So it says what
    // our own destination will accept, and nothing about what is delivered.
    note: 'What this app’s output accepts. The system can still combine the channels below this point — a mono-audio setting, a hands-free Bluetooth profile — without changing this number.',
  };

  const device: DeviceFact = {
    id: 'output-device',
    label: 'Output device',
    value: !observations.outputsEnumerated
      ? UNAVAILABLE
      : observations.defaultOutput === null
        ? 'none reported'
        : (observations.defaultOutput.label ?? 'default output'),
    note:
      observations.outputsEnumerated && observations.defaultOutput?.label === null
        ? 'The system withholds device names until a page has microphone permission, which this app does not ask for.'
        : undefined,
  };

  return [rate, latency, channels, device].map((fact) =>
    fact.note === undefined ? { id: fact.id, label: fact.label, value: fact.value } : fact,
  );
}
