/**
 * What the app actually plays while a control is being dragged.
 *
 * Multiple rejected diagnoses began with "it sounds wrong while I move a slider", and
 * every other instrument here answers a different question. `npm run verify`
 * renders offline and measures a *settled* configuration. `graph-taps` measures
 * what the graph was asked to do, not what came out. The integrity capture tap
 * records real output — but it is told to discard on every configuration
 * change, by design, because a window straddling one describes settings that
 * were not in force while it played. That window is exactly the one in
 * question.
 *
 * So this drives a second instance of the same shipped capture worklet and
 * never sends it an epoch: the processor empties its ring only when told to, so
 * an unepoched instance records straight through a drag. No production code
 * changes — the module is already registered by the graph, and the node
 * carrying the finished mix is found by hooking `connect` before the app runs.
 *
 * ## What makes a number here trustworthy
 *
 * A count of dips means nothing on its own, and the first version of this tool
 * proved that twice over: it reported 281 dropouts on untouched audio because
 * it was detecting the 40 Hz pulse train, and it measured a window that
 * included its own tidying up. Three things guard it now.
 *
 * 1. **The measure steps over the intended gap.** One value per modulation
 *    period, and a peak rather than an RMS. This app's output is *supposed* to
 *    fall to near-silence forty times a second.
 * 2. **Every control is bracketed by its own still take, in its own launch.** A
 *    single stationary baseline only shows that still playback is accepted.
 *    Pairing each drag with a still take from the same graph instance is what
 *    separates "this control does it" from "this machine was busy".
 * 3. **The window is the drag and only the drag.** The capture is requested the
 *    instant the sweep ends and *before* the control is put back, because
 *    restoring it is itself a parameter jump — the largest in the take, and
 *    exactly the kind that produces the dips being counted.
 *
 * What it still cannot tell you is whether a dip is *audible*, or whether a
 * particular control legitimately moves the pulse peak. A difference from the
 * still take is a difference, not a diagnosis. To attribute one, disable the
 * suspected cause and watch the count move.
 *
 * ## The control that separates rate from distance
 *
 * `--rate` drives the sweep at a fixed number of input events per second
 * instead of at frame rate. The travel and the interval do not change with
 * it, only how finely the same gesture is sampled — so a count that holds
 * across rates belongs to the level moving, and one that climbs with them
 * belongs to the rescheduling. The master-ramp reproduction read 0, 0, 5, 14, 18
 * at 5, 10, 20, 40 and 60 events a second over an identical drag.
 *
 * Run it before concluding anything from a single column.
 *
 *   npm run build && node tools/audio-probe.ts [--seconds 8] [--control Carrier]
 *                                              [--rate 20]
 */

import { _electron as electron, type Page } from 'playwright';
import { join } from 'node:path';

const REPO = process.cwd();

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

const SECONDS = Number(arg('seconds', '8'));
/** Input events per second, or 0 for the frame rate — how a hand moves one. */
const RATE = Number(arg('rate', '0'));
/** Ring long enough for the whole take, plus room for the request to land. */
const RING_SECONDS = Math.ceil(SECONDS) + 6;
const CONTROLS = arg('control', 'Master,Carrier,Notch depth,Duty')
  .split(',')
  .map((c) => c.trim())
  .filter((c) => c !== '');

/**
 * Modulation is the measuring stick, so it cannot also be the thing measured.
 *
 * Every period boundary here comes from the modulation frequency. Sweeping it
 * from 30 to 58 Hz while slicing the recording into fixed 40 Hz windows puts
 * the boundaries out of step with the pulses and manufactures dips that are an
 * artefact of the arithmetic — at the slow end a window is shorter than a
 * period and can miss the pulse entirely. Measuring it properly needs
 * boundaries that follow the value over time. Refusing is better than reporting
 * a number that is wrong.
 */
const NOT_MEASURABLE = new Set(['Modulation']);

const HOOK = `
  (() => {
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (target, ...rest) {
      try {
        if (target instanceof AudioDestinationNode) {
          window.__masterSource = this;
          window.__audioContext = this.context;
        }
      } catch {}
      return connect.call(this, target, ...rest);
    };
  })();
`;

interface Take {
  envelope: number[];
  maxStep: number;
  modulationHz: number;
}

async function until<T>(what: string, probe: () => Promise<T | null>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function record(
  page: Page,
  seconds: number,
  control: string | null,
  rate: number,
): Promise<Take> {
  return page.evaluate(
    async ({ seconds: take, control: name, ring, rate }) => {
      const hooked = window as unknown as {
        __audioContext?: AudioContext;
        __masterSource?: AudioNode;
      };
      const ctx = hooked.__audioContext;
      const source = hooked.__masterSource;
      if (ctx === undefined || source === undefined) throw new Error('no audio graph to tap');

      const named = (label: string) =>
        Array.from(document.querySelectorAll<HTMLInputElement>('input[type=range]')).find(
          (el) =>
            (document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() ??
              el.closest('.row')?.querySelector('label')?.textContent?.trim() ??
              el.getAttribute('aria-label') ??
              '') === label,
        );

      /*
       * Read before anything moves.
       *
       * This used to be read after the control was put back, which is right for
       * every control except the one that sets it: a Modulation sweep was
       * analysed at its restored 40 Hz while the recording swept 30–58 Hz.
       * Modulation is refused outright now, and reading up front means the
       * value is the one that was in force during the take.
       */
      const modulationHz = (() => {
        const value = Number(named('Modulation')?.value ?? 40);
        return Number.isFinite(value) && value > 0 ? value : 40;
      })();

      const node = new AudioWorkletNode(ctx, 'capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 2,
        channelCountMode: 'explicit',
        processorOptions: { seconds: ring },
      });
      source.connect(node);

      /*
       * Ask for more than the drag, then cut the drag out of it.
       *
       * The tap answers "the most recent N frames" as of when it processes the
       * request, and the request crosses a thread boundary — so the window's
       * ends are only ever approximately where the caller meant. Asking for a
       * second of slack and slicing by the audio clock makes the analysed
       * interval exact, which matters here because the analysis divides the
       * recording into 25 ms periods and a shifted start moves every boundary.
       *
       * `startedAt` has been on the reply all along, carried for exactly this:
       * "so the caller can decide whether the window overlapped something that
       * would make it meaningless". It was being ignored.
       */
      const wanted = Math.floor((take + 1) * ctx.sampleRate);
      const window_ = new Promise<{ left: Float32Array; right: Float32Array; startedAt: number }>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('capture never answered')),
            (take + 8) * 1000,
          );
          node.port.onmessage = (event: MessageEvent<unknown>) => {
            const reply = event.data as
              | {
                  type?: string;
                  ok?: boolean;
                  left?: Float32Array;
                  right?: Float32Array;
                  startedAt?: number;
                  reason?: string;
                }
              | undefined;
            if (reply?.type !== 'capture') return;
            clearTimeout(timer);
            if (reply.ok !== true || reply.left === undefined || reply.right === undefined) {
              reject(new Error(`capture refused: ${reply?.reason ?? 'unknown'}`));
              return;
            }
            resolve({ left: reply.left, right: reply.right, startedAt: reply.startedAt ?? 0 });
          };
        },
      );

      let restore: (() => void) | null = null;
      // On the audio clock, not `performance.now()`: the samples are indexed by
      // the former and the two drift. Both branches below set these before use.
      let dragFrom: number;
      let dragTo: number;

      if (name !== null) {
        const input = named(name);
        if (input === undefined) throw new Error(`no control named ${name}`);
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        const lo = Number(input.min || 0);
        const hi = Number(input.max || 1);
        /*
         * A quarter in from each end, and this time symmetric.
         *
         * It read 0.25 and 0.95 — five percent from the top — which
         * contradicted both the comment and the reason for having bounds.
         * Sweeping the whole travel takes Master to silence and pins the others
         * against their rails, and the defect is reported on ordinary movement.
         */
        const min = lo + (hi - lo) * 0.25;
        const max = lo + (hi - lo) * 0.75;
        const before = input.value;
        restore = () => {
          setter?.call(input, before);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };

        // A deliberate, hesitant sweep — the movement both defects are reported
        // on — driven at frame rate, which is how a hand moves a slider, or at
        // a fixed rate when one is asked for. The clock is `performance.now()`
        // either way, so the travel and the interval are the same in both.
        const start = performance.now();
        dragFrom = ctx.currentTime;
        await new Promise<void>((done) => {
          const step = () => {
            const t = (performance.now() - start) / (take * 1000);
            if (t >= 1) return done();
            const value = min + (max - min) * (0.5 - 0.5 * Math.cos(t * Math.PI * 2));
            setter?.call(input, String(value));
            input.dispatchEvent(new Event('input', { bubbles: true }));
            if (rate > 0) setTimeout(step, 1000 / rate);
            else requestAnimationFrame(step);
          };
          step();
        });
        dragTo = ctx.currentTime;
      } else {
        dragFrom = ctx.currentTime;
        await new Promise((r) => setTimeout(r, take * 1000));
        dragTo = ctx.currentTime;
      }

      /*
       * Asked for before the control is put back.
       *
       * The request names "the most recent `take` seconds" as of when the tap
       * processes it, so anything done between the sweep ending and the request
       * landing falls inside the measured window. Restoring the control is a
       * jump from the end of the sweep back to the middle — the largest single
       * parameter change in the whole take, and precisely the kind that makes
       * the dips being counted. It used to happen first.
       */
      node.port.postMessage({ type: 'capture', id: 1, frames: wanted });
      const { left: whole, right: wholeRight, startedAt } = await window_;
      restore?.();
      source.disconnect(node);
      node.port.postMessage({ type: 'stop' });

      // Cut out exactly the interval the control was moving in.
      const from = Math.max(0, Math.round((dragFrom - startedAt) * ctx.sampleRate));
      const to = Math.min(whole.length, Math.round((dragTo - startedAt) * ctx.sampleRate));
      if (to - from < ctx.sampleRate) {
        throw new Error(
          `the capture did not cover the drag: ${((to - from) / ctx.sampleRate).toFixed(2)}s of ${take}s`,
        );
      }
      const left = whole.subarray(from, to);
      const right = wholeRight.subarray(from, to);

      // One value per modulation period, and a peak rather than an RMS: the
      // entrainment envelope is meant to fall to near-silence forty times a
      // second, and a frame shorter than a period measures that instead.
      const hop = Math.max(64, Math.round(ctx.sampleRate / modulationHz));
      const envelope: number[] = [];
      for (let i = 0; i + hop <= left.length; i += hop) {
        let peak = 0;
        for (let j = 0; j < hop; j += 1) {
          const l = Math.abs(left[i + j] ?? 0);
          const r = Math.abs(right[i + j] ?? 0);
          if (l > peak) peak = l;
          if (r > peak) peak = r;
        }
        envelope.push(peak);
      }

      let maxStep = 0;
      for (let i = 1; i < left.length; i += 1) {
        const d = Math.abs((left[i] ?? 0) - (left[i - 1] ?? 0));
        if (d > maxStep) maxStep = d;
      }

      return { envelope, maxStep, modulationHz };
    },
    { seconds, control, ring: RING_SECONDS, rate },
  );
}

/**
 * Periods whose pulse peak fell against their neighbours.
 *
 * A third, not a half: a 28–47 ms cascade handover spans one or two modulation
 * periods and attenuates rather than silencing them, so a threshold set for
 * "silence" steps over the defect being looked for. The local average excludes
 * the period itself, or a deep enough dip drags down the number it is compared
 * against, and it is symmetric so that a smooth ramp — which is what moving a
 * level looks like — averages out rather than reading as a fall.
 */
function describe(env: number[]): { dips: number; deepest: number } {
  const local = (i: number) => {
    const from = Math.max(0, i - 20);
    const to = Math.min(env.length, i + 21);
    let sum = 0;
    let n = 0;
    for (let j = from; j < to; j += 1) {
      if (j === i) continue;
      sum += env[j] ?? 0;
      n += 1;
    }
    return n === 0 ? 0 : sum / n;
  };

  let dips = 0;
  let deepest = 0;
  for (let i = 1; i < env.length - 1; i += 1) {
    const here = env[i] ?? 0;
    const around = local(i);
    if (around <= 1e-6) continue;
    const fall = 1 - here / around;
    if (fall > 0.33) {
      dips += 1;
      if (fall > deepest) deepest = fall;
    }
  }
  return { dips, deepest };
}

/**
 * One launch per control, and a still take beside every moving one.
 *
 * Takes used to run back to back in a single app: the noise, the oscillators,
 * the compressor and the filter chain all carried state from one take to the
 * next, and only the slider's value was put back. Duty's count then varied with
 * whatever had been dragged before it — between 32 and 92 — which is not a
 * property of Duty. A launch each costs a few seconds and removes the question.
 */
async function measure(control: string): Promise<{ still: Take; moved: Take }> {
  const app = await electron.launch({
    args: [join(REPO, 'e2e/bootstrap.mjs')],
    cwd: REPO,
    timeout: 60_000,
  });
  try {
    await app.firstWindow();
    const page = await until('the Studio window', async () => {
      const found = app.windows().find((w) => w.url().endsWith('index.html'));
      return found ?? null;
    });
    await page.addInitScript(HOOK);
    // The hook must be in place before the graph is built, and the graph is
    // built on first play — so a reload is enough, and cheaper than relaunching.
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(800);

    await page.getByRole('button', { name: /^Preview/ }).click();
    await until('preview to start', async () =>
      (await page.getByRole('button', { name: /^Stop/ }).count()) > 0 ? true : null,
    );
    await page.waitForTimeout(2000);

    const still = await record(page, SECONDS, null, RATE);
    const moved = await record(page, SECONDS, control, RATE);

    const stop = page.getByRole('button', { name: /^Stop/ });
    if ((await stop.count()) > 0) await stop.click();
    await page.waitForTimeout(2500);
    return { still, moved };
  } finally {
    await app.close().catch(() => undefined);
  }
}

const refused = CONTROLS.filter((c) => NOT_MEASURABLE.has(c));
const measurable = CONTROLS.filter((c) => !NOT_MEASURABLE.has(c));

console.log(
  `\n40 Hz — audio probe   ${SECONDS}s takes, one launch per control, ` +
    `${RATE > 0 ? `${RATE} input events/s` : 'driven at frame rate'}\n`,
);
console.log(`recorded from the master bus, post-compressor — what actually leaves,`);
console.log(`each control paired with a still take from the same launch\n`);
console.log(`  ${'control'.padEnd(14)}${'still'.padStart(10)}${'moving'.padStart(10)}   deepest`);

for (const control of measurable) {
  const { still, moved } = await measure(control);
  const s = describe(still.envelope);
  const m = describe(moved.envelope);
  console.log(
    `  ${control.padEnd(14)}${String(s.dips).padStart(10)}${String(m.dips).padStart(10)}   ` +
      `${(m.deepest * 100).toFixed(0)}%`,
  );
}

for (const control of refused) {
  console.log(`  ${control.padEnd(14)}${'refused'.padStart(20)}   period boundaries come from it`);
}

console.log(
  `\nthis is exploratory plumbing, not a gate: there is no acceptance threshold here and no\n` +
    `number below is evidence of a defect. read across a row, never across runs. a still take\n` +
    `above 0 means the machine, not the app. a moving take that differs from its own still take\n` +
    `is a difference, not a diagnosis — disabling refreshBedChain entirely left these counts\n` +
    `unchanged, so they are not the cascade rebuild.\n`,
);
