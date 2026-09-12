<script lang="ts">
  import Segmented from './Segmented.svelte';
  import { engine } from '../lib/engine.svelte.ts';
  import { sessionClient } from '../lib/session-client.ts';
  import { clock, listeningTime } from '../lib/format.ts';
  import { sessionPhase } from '../lib/session-phase.ts';
  import { phaseAt, remainingSeconds } from '../../session/session.ts';
  import { durationChoices, durationLabel } from '../lib/durations.ts';
  import { listeningSecondsOnDay } from '../../session/history.ts';
  import { sessionAdvice } from '../../session/advice.ts';
  import { historyStore, settingsStore } from '../lib/stores.ts';
  import { integrity } from '../lib/integrity.svelte.ts';
  import { DEFAULT_SETTINGS, type Settings } from '../../session/settings.ts';
  import type { SessionSnapshot } from '../../session/coordinator.ts';
  import type { SessionRecord } from '../../session/session.ts';

  interface Props {
    /** The preset the session will record as its source. */
    presetId: string;
  }

  let { presetId }: Props = $props();

  let snapshot = $state<SessionSnapshot>({
    state: 'idle',
    session: null,
    edited: false,
    elapsedSeconds: 0,
  });
  const choices = durationChoices();
  let minutes = $state<number>(choices[Math.min(2, choices.length - 1)]);
  let history = $state<SessionRecord[]>([]);
  let settings = $state<Settings>({ ...DEFAULT_SETTINGS });
  let busy = $state(false);
  let error = $state<string | null>(null);

  /**
   * Advances the countdown on a monotonic clock, not a wall one.
   *
   * The coordinator measures elapsed time monotonically precisely so a clock
   * correction cannot desynchronise it from the audio envelope. Deriving the
   * display from `Date.now()` would put that drift straight back: the
   * countdown and phase would jump while the audio carried on unchanged.
   *
   * So the published elapsed is the anchor, advanced by this window's own
   * monotonic delta since it arrived.
   */
  let anchorMonotonic = $state(performance.now());
  let ticks = $state(0);

  const elapsed = $derived(
    ticks >= 0 ? snapshot.elapsedSeconds + (performance.now() - anchorMonotonic) / 1000 : 0,
  );
  const session = $derived(snapshot.session);
  const running = $derived(
    snapshot.state === 'session-active' || snapshot.state === 'session-ending',
  );
  // The pure helpers take a wall instant, so elapsed is expressed against the
  // session's own start rather than against whatever the clock now reads.
  const now = $derived(session === null ? Date.now() : session.startedAt + elapsed * 1000);
  const phase = $derived(session === null ? null : phaseAt(session, now));
  const remaining = $derived(session === null ? 0 : remainingSeconds(session, now));
  const today = $derived(listeningSecondsOnDay(history, now));
  /**
   * How far through, for the progress bar.
   *
   * Derived from the same published elapsed the countdown uses, so the bar and
   * the clock cannot disagree — and clamped, because `elapsed` advances on this
   * window's monotonic clock between publications and may briefly run past the
   * planned end while the fade is still landing.
   */
  const progress = $derived(
    session === null ? 0 : Math.min(1, Math.max(0, elapsed / session.plannedSeconds)),
  );
  // Advisory only: shown before a session and never while one runs, since a
  // reminder arriving mid-session has nothing to offer but interruption.
  const advice = $derived(running ? null : sessionAdvice(history, settings, now));

  // Segmented carries string values, so the minutes round-trip as text.
  /**
   * What the strip says is happening, in one place.
   *
   * The phase comes from `phaseAt`, which reads the session's own schedule —
   * this only chooses the words. Kept out of the markup so the idle and active
   * layouts cannot drift into describing the same state differently.
   */
  /**
   * One rule, shared with the tray popover.
   *
   * Both surfaces describe the same session, and deriving the words separately
   * is how they came to disagree during a stop. See `session-phase.ts`.
   */
  const view = $derived(sessionPhase(snapshot.state, session, now, elapsed, phase));
  const phaseLabel = $derived(view.label);
  const ending = $derived(view.ending);

  const durationOptions = choices.map((m) => ({
    value: String(m),
    label: durationLabel(m),
    title: m >= 1 ? `${m} minutes` : `${Math.round(m * 60)} seconds`,
  }));

  /**
   * Watch the log rather than refetching at moments that seem likely.
   *
   * Refetching when a session ended missed every other way it changes — a
   * record deleted in the history dialog stayed in the day's total, the
   * advisory and recall until the app restarted.
   */
  function watchHistory() {
    return historyStore.subscribe((records) => {
      history = records;
    });
  }

  async function begin() {
    if (busy) return;
    busy = true;
    error = null;
    try {
      await sessionClient.start({
        presetId,
        configuration: engine.currentConfiguration(),
        plannedSeconds: minutes * 60,
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function end() {
    if (busy) return;
    busy = true;
    error = null;
    try {
      await sessionClient.stop();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  /**
   * Report edits made while a session runs.
   *
   * Studio stays editable by decision, so the record has to say where the
   * session ended as well as where it began — and the checkpoint has to hold
   * the latest, or losing the renderer would record a stale configuration.
   *
   * Reported from here rather than from the engine, which cannot import the
   * client without a cycle. Compared by value, so a re-render is not an edit.
   */
  let lastReported: string | null = null;

  $effect(() => {
    if (!running || session === null) {
      lastReported = null;
      return;
    }
    // The baseline is what the session actually started with, taken from the
    // snapshot. Using the first configuration observed here instead would
    // swallow an edit made between audio starting and that snapshot arriving,
    // adopting it as the baseline rather than reporting it.
    lastReported ??= JSON.stringify(session.initialConfiguration);

    const configuration = engine.currentConfiguration();
    const signature = JSON.stringify(configuration);
    if (signature === lastReported) return;
    lastReported = signature;
    sessionClient.reportConfiguration(configuration);
  });

  /**
   * What the checks currently say, reported into the session that is running.
   *
   * Beside the configuration report and for the same structural reason: this
   * is where the running session and the live renderer state are both in
   * scope. It reads the same store the footer and the panel read, rather than
   * assembling findings of its own — one current view, however many things
   * consume it.
   *
   * It re-reports whenever that view changes, because everything that changes
   * it changes the answer: a device unplugged, the routing switched, a
   * measurement taken. The coordinator keeps the worst answer per id, so a
   * headset restored later does not erase the warning the listener heard —
   * which is exactly the difference between the two states, and why the panel
   * says its own is the current one.
   */
  let lastIntegrity: string | null = null;

  $effect(() => {
    if (!running || session === null) {
      lastIntegrity = null;
      return;
    }
    const findings = integrity.findings;
    const signature = JSON.stringify(findings);
    if (signature === lastIntegrity) return;
    lastIntegrity = signature;

    const sessionId = session.id;
    void sessionClient
      .reportIntegrity(sessionId, findings)
      .then((recorded) => {
        // Refused — the session ended, or the executor was replaced. Forget
        // the signature so the next real change is sent rather than skipped
        // as a repeat of something that was never recorded.
        //
        // Delivery only. A report that was not recorded says nothing about
        // whether the measurement is true, so nothing here touches the
        // findings: the panel goes on showing what the checks found.
        if (!recorded && lastIntegrity === signature) lastIntegrity = null;
      })
      .catch(() => {
        if (lastIntegrity === signature) lastIntegrity = null;
      });
  });
  $effect(() => {
    // Every one of these hands back the current value through the callback and
    // returns the function that stops watching. Stopping matters: without it
    // each subscription outlives its component, and in a window where several
    // components watch the same channel the last to subscribe would displace
    // the rest.
    const stop = [
      sessionClient.subscribe((update) => {
        snapshot = update.snapshot;
        // Re-anchor on every publish, so the display tracks the coordinator
        // rather than drifting away from it.
        anchorMonotonic = performance.now();
      }),
      watchHistory(),
      settingsStore.subscribe((update) => {
        settings = update;
      }),
    ];

    const tick = setInterval(() => {
      ticks += 1;
    }, 250);
    return () => {
      for (const unsubscribe of stop) unsubscribe();
      clearInterval(tick);
    };
  });
</script>

<!--
  Session is a state of Studio, not a fourth sound layer and not a
  destination — so it is a strip between the charts and the recipe rather than
  a panel among the mixer controls. The idle and active layouts are different
  arrangements of the same strip: the same heading, the same status line, and
  one primary action that changes which one it is.
-->
<section class="session" class:running aria-label="Session">
  <div class="lede">
    <h2>Session</h2>
    <p class="sub">A timed run of the current settings, recorded when it finishes.</p>
  </div>

  {#if running && session !== null}
    <div class="run-controls">
      <div class="timing">
        <div class="clock mono" class:ending>{clock(remaining)}</div>
        <div class="units">
          <span class="remaining">remaining</span>
          <span class="elapsed mono">{clock(elapsed)} elapsed</span>
        </div>
      </div>

      <!--
        Decorative, and marked as such: the same numbers are already stated as
        text beside it, so a screen reader gains nothing from a second reading.
      -->
      <div class="progress" aria-hidden="true">
        <span style="width: {progress * 100}%"></span>
      </div>
    </div>

    <button class="action end" onclick={end} disabled={busy}>Stop session</button>
  {:else}
    <div class="durations">
      <Segmented
        label="Duration (minutes)"
        options={durationOptions}
        value={String(minutes)}
        onchange={(v: string) => (minutes = Number(v))}
      />
    </div>
    <!-- Enabled during preview too: the coordinator stops preview as part of
         starting, which is what the status line below promises. -->
    <button
      class="action begin"
      onclick={begin}
      disabled={busy || (snapshot.state !== 'idle' && snapshot.state !== 'previewing')}
    >
      Start session
    </button>
  {/if}

  <!--
    Polite and atomic, and scoped to the discrete text only. The countdown is
    deliberately outside it: a live region wrapped around a value that changes
    every 250 ms would be read continuously and drown out everything else.
  -->
  <div class="status" role="status" aria-live="polite" aria-atomic="true">
    <span class="phase" class:live={running}>{phaseLabel}</span>
    {#if running && session !== null}
      <span class="indicator" class:on={view.stabilized}>
        <span class="dot"></span>
        {view.thresholdNote}
      </span>
    {:else if snapshot.state === 'previewing'}
      <span class="hint">Preview is running. Starting a session will take it over.</span>
    {:else}
      <span class="hint">When started: ramp in → stabilize → steady state → ramp out.</span>
    {/if}

    <span class="today">
      Listening time today <span class="mono">{listeningTime(today)}</span>
    </span>
  </div>

  {#if advice !== null}
    <p class="note advisory">{advice.message}</p>
  {/if}

  {#if error !== null}
    <p class="note error">{error}</p>
  {/if}
</section>

<style>
  /*
   * One strip, two arrangements. A grid rather than a flex row so the status
   * line can span the full width beneath the controls at every size, and so
   * the action stays at the end without being pushed out by a long phase
   * label.
   */
  /*
   * Four parts, and the layout says which is which.
   *
   * Named grid areas rather than a wrapping flex row, because the responsive
   * contract asks for genuinely different arrangements rather than one shape
   * reflowed: inline at the canonical width, status wrapping to its own row
   * near 1100, the duration and its action sharing a row below that, and a full
   * stack only when the width cannot carry even that. A flex row can only ever
   * produce one of those, which is what it did — the same two-row shape at
   * every size.
   *
   * The stack used to be the base *and* what the 900px desktop minimum got. A
   * layout audit measured the cost: the strip went from 129.5px to about 244px
   * and put Start session below the opening viewport, so the primary action at
   * the smallest supported size was reachable only by scrolling — while the
   * duration control and the button had room to share a row the whole time.
   *
   * So the stack is now reserved for widths the desktop window cannot reach at
   * all. It still has to exist: Studio runs standalone in a browser by design,
   * where the viewport can be anything.
   */
  .session {
    display: grid;
    grid-template-areas:
      'lede'
      'controls'
      'action'
      'status'
      'note';
    gap: 10px 18px;
    /*
     * Bottom, not centre.
     *
     * The three blocks that share the first row are different heights — a bare
     * lede, a labelled duration group, a button — and centring each in the row
     * gives three different baselines. Aligning to the end puts the control
     * boxes on one line, which is the line the eye follows across the row.
     */
    align-items: end;
    padding: 12px 14px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-left: 3px solid var(--signal);
    border-radius: var(--radius);
  }

  .lede {
    grid-area: lede;
  }

  /*
   * `.run-controls`, not `.running` — the root carries `class:running` too.
   *
   * Both elements matched `.running`, so the root section was handed
   * `grid-area: controls` and `display: flex` meant for its child. While
   * `.workspace` was a flex container that was inert: `grid-area` means
   * nothing to a flex item. When the workspace became a grid, the latent
   * collision became a defect — the named area resolved against a grid with no
   * such line, which manufactured implicit columns. Measured at the 1280
   * default: starting a session turned the workspace from one 1248px column
   * into `0px 646px 578px`, collapsing the charts to nothing and standing the
   * recipe and the strip side by side. `display: flex` on the root also
   * replaced the strip's own named-area layout for as long as it ran.
   *
   * A state class on a root and a layout class on a child must not share a
   * name. The root keeps `running` because it is genuinely a state — and
   * `check-layout.ts` now asserts the workspace geometry while it is set.
   */
  .durations,
  .run-controls {
    grid-area: controls;
  }

  /* Clock and bar side by side, the bar taking whatever is left. */
  .run-controls {
    display: flex;
    align-items: center;
    gap: 16px;
    min-width: 0;
  }

  .progress {
    flex: 1 1 120px;
  }

  .action {
    grid-area: action;
  }

  .status {
    grid-area: status;
  }

  /*
   * The duration and its action share a row as soon as there is width for it,
   * which at the 900px desktop minimum there always is.
   */
  @media (min-width: 760px) {
    .session {
      grid-template-areas:
        'lede lede'
        'controls action'
        'status status'
        'note note';
      grid-template-columns: minmax(0, 1fr) auto;
    }
  }

  /* Status wraps to its own row, but the rest goes inline. */
  @media (min-width: 1000px) {
    .session {
      grid-template-areas:
        'lede controls action'
        'status status status'
        'note note note';
      grid-template-columns: auto 1fr auto;
    }
  }

  /*
   * The canonical four-part inline row. The status sits in the same line as
   * the controls it describes rather than costing the workbench another band
   * of height.
   */
  @media (min-width: 1320px) {
    .session {
      grid-template-areas:
        'lede controls action status'
        'note note note note';
      /*
       * The status track is `1fr`, not `auto`.
       *
       * `auto` sizes to max-content, and the status is a sentence: at
       * "Listening time today under a minute" its max-content is 715px, which
       * the track then claimed at every width from 1320 up. The controls track
       * is `minmax(0, 1fr)` and so yielded — the duration chips were squeezed
       * from 430px to 220px and then straight under the Start session button,
       * with 45 and 60 unreachable. Prose should wrap before a control is
       * covered, and `1fr` is what makes the status the thing that gives.
       */
      grid-template-columns: auto minmax(0, 1fr) auto minmax(220px, 1fr);
    }
  }

  h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .sub {
    margin: 2px 0 0;
    font-size: 11px;
    color: var(--text-faint);
    line-height: 1.4;
    max-width: 30ch;
  }

  .durations {
    min-width: 220px;
  }

  /*
   * A 36px minimum on the segments themselves.
   *
   * The shared control renders at 28px, which is under both the compact target
   * and the project's dense-control minimum. Scoped here rather than changed
   * globally: the segmented control is used throughout the recipe, and its
   * sizing is deliberately local to this control.
   */
  .durations :global(button) {
    min-height: 36px;
  }

  .action {
    height: 42px;
    padding: 0 20px;
    font-weight: 500;
    justify-self: end;
  }

  .begin {
    border-color: var(--signal-strong);
    background: var(--signal-surface);
    color: var(--on-signal);
  }

  .begin:hover:not(:disabled) {
    background: var(--signal-surface-hover);
    border-color: var(--signal);
  }

  .end {
    border-color: var(--danger);
    background: var(--danger-surface);
    color: var(--danger);
  }

  .end:hover:not(:disabled) {
    background: var(--danger-surface-hover);
    color: var(--on-danger);
  }

  /*
   * Centred, not baseline-aligned.
   *
   * The units beside the clock are a two-line column — "remaining" over
   * "0:02 elapsed" — and `baseline` aligns the clock to the *first* of those.
   * So a 30px number sat at the top of a 48.5px box with the second line
   * hanging below it, and the countdown read as floating above the progress
   * bar and the Stop button it shares a row with: its centre was 12.5px above
   * theirs at the 1280 default.
   *
   * Baseline is the right instinct for two runs of text on one line and the
   * wrong one the moment either side is a stack.
   */
  .timing {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .clock {
    font-size: 30px;
    font-weight: 500;
    color: var(--signal);
    line-height: 1;
  }

  /* The fade is landing; the number is still the truth, so it changes colour
     rather than stopping. */
  .clock.ending {
    color: var(--warn);
  }

  .units {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 11px;
    color: var(--text-faint);
  }

  .progress {
    height: 4px;
    min-width: 120px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 2px;
    overflow: hidden;
  }

  .progress span {
    display: block;
    height: 100%;
    background: var(--signal);
  }

  /* Full width, always: the status is the part that must never be pushed off
     the strip when it wraps. `min-width: 0` so the track can actually be
     narrower than the sentence, which is the whole point of wrapping it. */
  .status {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px 16px;
    min-width: 0;
    font-size: 12px;
    color: var(--text-dim);
  }

  .phase {
    font-weight: 500;
    color: var(--text);
  }

  .phase.live {
    color: var(--signal);
  }

  .hint {
    color: var(--text-faint);
  }

  .indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-faint);
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-faint);
    flex: none;
  }

  .indicator.on .dot {
    background: var(--signal);
  }

  .today {
    margin-left: auto;
    color: var(--text-faint);
  }

  .note {
    grid-area: note;
    margin: 0;
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-dim);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
  }

  /* A reminder, not a refusal — it never disables Start. */
  .note.advisory {
    border-color: var(--warn);
    background: var(--warn-surface);
    color: var(--warn);
  }

  .note.error {
    border-color: var(--danger);
    color: var(--danger);
  }
</style>
