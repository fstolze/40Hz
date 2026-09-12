/**
 * Taking a window from each tap and turning it into findings.
 *
 * The last missing piece of `graph`: the taps, the window arithmetic and the
 * metrics were all built and proved offline, and nothing ever asked them for a
 * window. Until something did, the scope meant "we read a device property",
 * which is what the withdrawn stereo rule turned out to be worth.
 *
 * This owns the three decisions that are not measurement:
 *
 * - **How long a window to ask for.** Derived from the configuration by
 *   `captureFramesFor` and capped at what the ring holds, because a request
 *   longer than the ring is refused outright rather than answered short.
 * - **Whether the master window may be judged at all.** That tap sits after
 *   `envelopeGain`, so a ramp-in, a fade or a stop attenuates it legitimately.
 *   A window overlapping one shows a low peak from a graph doing exactly what
 *   it was told, so steadiness is checked *after* the window arrives — a fade
 *   can begin while one is being recorded. The entrainment tap is upstream of
 *   that gain and carries no such rule, which is why the two are asked
 *   separately rather than as one pass.
 * - **What to say when there is no window.** A refusal is reported as an
 *   unchecked finding naming the reason, never omitted: `graph` with nothing
 *   in it reads exactly like `graph` with nothing wrong.
 *
 * Expressed against a minimal source interface rather than `EntrainmentGraph`,
 * like every other module here, so the orderings and the refusals are driven in
 * Node against fakes.
 */

import { captureFramesFor, measureEntrainment, measureMaster } from './measure.ts';
import { uncheckedFinding, type Finding } from './findings.ts';
import { isSteady, type SteadyWindow } from '../audio/steady-window.ts';
import type { CaptureOutcome } from './capture-client.ts';
import type { EntrainmentParams } from '../audio/dsp/entrainment-core.ts';

/** The slice of a capture tap this needs. */
export interface CaptureSource {
  capture(frames: number): Promise<CaptureOutcome>;
}

export interface MeasurableOutput {
  sampleRate: number;
  /** The longest window either tap can answer. Requests are capped at it. */
  capacityFrames: number;
  /**
   * Steady playback as it stands *now*.
   *
   * A function rather than a value: it is read after each window arrives,
   * because a fade beginning during the wait is exactly what makes a window
   * unjudgeable.
   */
  steadyPlayback(): SteadyWindow;
  /** Pre-bed, pre-envelope. Null before the graph has taps. */
  entrainment: CaptureSource | null;
  /** Post-compressor, after the playback envelope. */
  master: CaptureSource | null;
  /** The peak the graph guarantees it will not exceed. */
  ceiling: number;
}

/** Why a window could not be measured, in the words a reader needs. */
const REFUSAL: Record<string, string> = {
  timeout:
    'No window arrived in the time it would take to record one, so the graph may not be rendering.',
  closed: 'Playback ended before a whole window had been recorded.',
  'epoch-changed':
    'The configuration changed while the window was being recorded, so it describes settings that are no longer in force.',
  'window-too-long': 'This configuration needs a longer window than the capture buffer holds.',
  'window-invalid': 'The window requested was not a usable length.',
  'too-many-pending': 'Too many windows were already outstanding.',
};

function refused(id: string, title: string, reason: string): Finding {
  return uncheckedFinding({
    id,
    scope: 'graph',
    title,
    detail: REFUSAL[reason] ?? `The capture was refused: ${reason}.`,
  });
}

/**
 * How long a window to ask for.
 *
 * The configuration decides it — a slow modulation needs more periods, and the
 * spectrum needs a fixed number of frames whatever the rate — and the ring
 * caps it. Capping rather than asking anyway is what turns "this check cannot
 * run here" into a window the metrics can degrade honestly from: they say
 * which checks the window was too short to support.
 */
export function windowFramesFor(params: EntrainmentParams, output: MeasurableOutput): number {
  return Math.min(captureFramesFor(params, output.sampleRate), output.capacityFrames);
}

/**
 * How far past the earliest usable moment to aim.
 *
 * Landing exactly on the boundary loses to either side of it: the tap answers
 * on a render-quantum boundary, and whoever schedules the pass is working from
 * a wall clock while `steady.from` is on the audio clock. Measured on a real
 * graph, a pass aimed exactly at the boundary came back with a window starting
 * 98 ms before it — the context clock does not advance while a context is
 * suspended or resuming, so the two drift apart by however long that took.
 *
 * The caller re-checks on waking and reschedules, so this is not what makes
 * the schedule correct — it is what stops it needing a second hop every time.
 */
const BOUNDARY_MARGIN_SECONDS = 0.25;

/**
 * How long to wait before a pass can produce a judgeable master window.
 *
 * A tap answers with the **most recent** `frames` — a request answered at T
 * spans `[T - seconds, T]`. So asking the moment steadiness opens returns a
 * window reaching back through the whole ramp, which the steadiness check then
 * correctly refuses: the naive schedule would never measure the master bus at
 * all. The earliest usable moment is therefore `steady.from + seconds`, when
 * the most recent window lies entirely inside steady playback.
 *
 * Null when it cannot fit — a session or an interval too short for a whole
 * window before the fade begins, or nothing steady in prospect. Null is the
 * honest answer there, and better than a pass whose only possible outcome is a
 * refusal.
 *
 * The alternative would be to epoch the master ring when steadiness opens and
 * let the tap defer until it has filled. That works too; it puts the knowledge
 * in the graph rather than in the caller, and the graph epochs both taps
 * together, so it would delay the entrainment window for a rule that only
 * applies to one of them.
 */
export function passDelaySeconds(
  steady: SteadyWindow,
  now: number,
  seconds: number,
): number | null {
  if (!Number.isFinite(steady.from)) return null;

  const earliest = steady.from + seconds + BOUNDARY_MARGIN_SECONDS;
  const at = Math.max(now, earliest);
  // The window ends at `at`; it has to end before the fade does.
  if (at > steady.until) return null;

  return at - now;
}

/**
 * Measure both taps once.
 *
 * Both are asked at the same time rather than one after the other: they are
 * separate rings fed by the same graph, and serializing them would mean the
 * second window describes a later stretch of audio than the first for no
 * reason.
 */
export async function runCaptureChecks(
  output: MeasurableOutput,
  params: EntrainmentParams,
): Promise<Finding[]> {
  const { entrainment, master, sampleRate } = output;
  if (entrainment === null || master === null) {
    return [
      uncheckedFinding({
        id: 'graph-capture',
        scope: 'graph',
        title: 'App output not measured',
        detail:
          'The capture taps are not built in this session, so no window of real output can be taken.',
      }),
    ];
  }

  const frames = windowFramesFor(params, output);
  const seconds = frames / sampleRate;

  const [fromEntrainment, fromMaster] = await Promise.all([
    entrainment.capture(frames),
    master.capture(frames),
  ]);

  const findings: Finding[] = [];

  if (fromEntrainment.ok) {
    findings.push(
      ...measureEntrainment(
        { left: fromEntrainment.left, right: fromEntrainment.right, sampleRate },
        params,
      ),
    );
  } else {
    findings.push(
      refused('graph-entrainment-window', 'Entrainment path not measured', fromEntrainment.reason),
    );
  }

  if (!fromMaster.ok) {
    findings.push(refused('graph-master-window', 'Master output not measured', fromMaster.reason));
    return findings;
  }

  // Read now, not before the request: the window is only judgeable if nothing
  // moved the boundary while it was being recorded, and a fade scheduled
  // during the wait does exactly that.
  if (!isSteady(output.steadyPlayback(), fromMaster.startedAt, seconds)) {
    findings.push(
      uncheckedFinding({
        id: 'graph-master-window',
        scope: 'graph',
        title: 'Master output not measured',
        detail:
          'The window overlapped a ramp, a fade or a stop. This tap sits after the playback envelope, so the level there is meant to change at those moments — measuring across one would report the envelope as a fault.',
      }),
    );
    return findings;
  }

  findings.push(
    ...measureMaster(
      { left: fromMaster.left, right: fromMaster.right, sampleRate },
      { ceiling: output.ceiling, modulationHz: params.modulationHz },
    ),
  );
  return findings;
}
