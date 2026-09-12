/**
 * Studio's capture pass: the graph on one side, the current view on the other.
 *
 * A shell over `CaptureSchedule`, which owns every decision worth arguing
 * about — when a pass is worth taking, what a run of configuration changes
 * costs, and which results are still current when it lands. None of that is
 * here, because none of it can be driven into failure from a component.
 *
 * The graph is handed in rather than reached for, like the device readings:
 * the engine knows when there is one, and a module that guessed would be the
 * thing deciding when an AudioContext exists.
 */

import { CaptureSchedule } from '../../integrity/capture-schedule.ts';
import { timerSchedule } from '../../lib/schedule.ts';
import { MAX_MASTER_LEVEL, type EntrainmentGraph } from '../../audio/graph.ts';
import type { MeasurableOutput } from '../../integrity/capture-run.ts';
import { DEFAULT_PARAMS } from '../../audio/dsp/entrainment-core.ts';
import { integrity } from './integrity.svelte.ts';

/** Which producer these findings belong to, for whole-set replacement. */
const PRODUCER = 'capture';

let graph: EntrainmentGraph | null = null;

/** The graph as something measurable, or null when there is nothing to measure. */
function output(): MeasurableOutput | null {
  if (graph === null) return null;
  return {
    sampleRate: graph.context.sampleRate,
    capacityFrames: graph.captureCapacityFrames,
    // A function, so the schedule reads it when a window lands rather than
    // when the pass was planned — a fade beginning in between is exactly what
    // makes a master window unjudgeable.
    steadyPlayback: () => graph?.steadyPlayback ?? { from: Infinity, until: Infinity },
    entrainment: graph.entrainmentCapture,
    master: graph.masterCapture,
    // Passed rather than imported by the measurement, which is meant to run
    // anywhere; this is the layer that knows about the graph.
    ceiling: MAX_MASTER_LEVEL,
  };
}

const schedule = new CaptureSchedule(
  {
    output,
    // From the graph rather than from the UI's copy, for two reasons: the
    // checks compare a window against an offline render of the parameters
    // that produced it, and reading `engine.params` here would make every
    // caller's read of it a reactive dependency — which, called from inside a
    // component effect that also writes those parameters, is an update loop.
    params: () => graph?.currentParams ?? DEFAULT_PARAMS,
    now: () => graph?.context.currentTime ?? 0,
    record: (findings) => {
      integrity.record(PRODUCER, findings);
    },
    onError: (error) => {
      // Nobody is awaiting a pass. A measurement that failed is not worth
      // interrupting a session over, and the view simply keeps saying the
      // output has not been measured.
      console.warn('[integrity] a capture pass failed:', error);
    },
  },
  timerSchedule(),
);

/**
 * Playback started, or the configuration moved.
 *
 * Both are the same event to the schedule: what was measured is no longer
 * current, and a new pass belongs a whole window after playback settles.
 */
export function captureChanged(current: EntrainmentGraph | null): void {
  if (current !== graph) {
    graph = current;
    // Subscribed once per graph rather than called from each of the five
    // places a configuration can move. Every path that invalidates a window
    // already funnels through the graph's epoch, so a control added later is
    // covered without anyone remembering to wire it.
    current?.onEpoch((reason) => {
      if (reason === 'configuration') schedule.changed();
    });
  }
  schedule.changed();
}

/** Playback stopped. Nothing more to measure; nothing measured becomes untrue. */
export function captureStopped(): void {
  schedule.stopped();
}

/** What "Check app output now" runs. */
export async function captureNow(current: EntrainmentGraph | null): Promise<void> {
  graph = current;
  await schedule.runNow();
}
