<script lang="ts">
  /**
   * The tray popover: start a session from a saved preset, or end the running
   * one. No mixer, by design — this is the surface for using the app rather
   * than building a sound, and everything adjustable lives in Studio.
   *
   * It never touches audio. The main process owns the coordinator and Studio
   * owns the graph; this window sends a start request and renders what comes
   * back.
   */
  import Segmented from '../components/Segmented.svelte';
  import { desktopSessionClient } from '../lib/session-bridge.ts';
  import { presetStore, historyStore, settingsStore } from '../lib/stores.ts';
  import { clock, listeningTime } from '../lib/format.ts';
  import { sessionPhase } from '../lib/session-phase.ts';
  import { durationChoices, durationLabel } from '../lib/durations.ts';
  // The threshold and the stabilization test now live behind `sessionPhase`,
  // which is what both surfaces read.
  import { phaseAt, remainingSeconds } from '../../session/session.ts';
  import { listeningSecondsOnDay, recentPresetIds } from '../../session/history.ts';
  import { sessionAdvice } from '../../session/advice.ts';
  import { DEFAULT_SETTINGS, type Settings } from '../../session/settings.ts';
  import { snapshotConfiguration } from '../../audio/configuration.ts';
  import type { SessionSnapshot } from '../../session/coordinator.ts';
  import type { SessionRecord } from '../../session/session.ts';
  import { BUILT_IN_PRESETS, DEFAULT_PRESET_ID, type Preset } from '../../audio/presets.ts';

  // This window only ever exists under Electron, but the bridge is still
  // optional at the type level, and a missing one should read as a message
  // rather than a blank window.
  const bridge = globalThis.window?.desktop ?? null;
  const client =
    bridge === null
      ? null
      : desktopSessionClient(
          bridge,
          // The popover has no controls and no graph, so it has neither edits
          // nor measurements to report — and could not report them anyway:
          // both need the executor generation, which only Studio holds. The
          // integrity answer is false rather than true for the same reason it
          // is false anywhere else: nothing was recorded.
          {
            reportConfiguration: () => {},
            reportIntegrity: () => Promise.resolve(false),
          },
          () => historyStore.list(),
        );

  let snapshot = $state<SessionSnapshot>({
    state: 'idle',
    session: null,
    edited: false,
    elapsedSeconds: 0,
  });
  /** Saved presets only; the built-in ones are code, not data. */
  let userPresets = $state<Preset[]>([]);
  const presets = $derived([...BUILT_IN_PRESETS, ...userPresets]);
  let presetId = $state<string>(DEFAULT_PRESET_ID);
  let history = $state<SessionRecord[]>([]);
  let settings = $state<Settings>({ ...DEFAULT_SETTINGS });
  /** Set once the user picks, so recall never overrides a deliberate choice. */
  let chosen = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  const choices = durationChoices();
  let minutes = $state<number>(choices[Math.min(2, choices.length - 1)]);
  const durationOptions = choices.map((m) => ({
    value: String(m),
    label: durationLabel(m),
    title: m >= 1 ? `${m} minutes` : `${Math.round(m * 60)} seconds`,
  }));

  /**
   * Advances the countdown on a monotonic clock, not a wall one.
   *
   * The coordinator measures elapsed time monotonically precisely so a clock
   * correction cannot desynchronise it from the audio envelope. Deriving the
   * display from `Date.now()` would put that drift straight back.
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
  const now = $derived(session === null ? Date.now() : session.startedAt + elapsed * 1000);
  const phase = $derived(session === null ? null : phaseAt(session, now));
  const view = $derived(sessionPhase(snapshot.state, session, now, elapsed, phase));
  const remaining = $derived(session === null ? 0 : remainingSeconds(session, now));
  const today = $derived(listeningSecondsOnDay(history, now));
  const selected = $derived(presets.find((p) => p.id === presetId) ?? null);
  const advice = $derived(running ? null : sessionAdvice(history, settings, now));

  /**
   * Whether the preset about to start needs one tone in each ear.
   *
   * The popover can start a remembered preset with Studio hidden, so a
   * binaural session can begin having passed no warning at all — the routing
   * control, where that warning lives, was never on screen. This is the line
   * that closes that path.
   *
   * It is guidance rather than the device finding itself. Only Studio holds an
   * AudioContext, so only Studio can ask a destination how many channels it
   * accepts; this window has no way to know, and wiring that answer through
   * main would be a standing channel for a fact this window would show at most
   * once per start. So it says what the routing needs, which is true whatever
   * the device turns out to be, and Studio says what the device gives.
   */
  const needsBothEars = $derived(selected?.params.twoToneMode === 'dichotic');

  /**
   * The last few presets actually run, newest first.
   *
   * Recall, not recommendation: what the user chose before, in the order they
   * chose it, rather than a frequency ranking — which would edge toward the
   * app having an opinion about what they should listen to.
   */
  const recent = $derived(
    recentPresetIds(history, 3)
      .map((id) => presets.find((p) => p.id === id))
      .filter((p): p is Preset => p !== undefined),
  );

  function adoptHistory(records: SessionRecord[]) {
    history = records;
    // Open on what they ran last, which is the common case for a tray popover
    // — but only until they say otherwise in this sitting.
    if (!chosen) {
      const [last] = recentPresetIds(history, 1);
      if (last !== undefined && presets.some((p) => p.id === last)) presetId = last;
    }
  }

  /**
   * Watch the log rather than refetching when a session ends.
   *
   * This window outlives every dialog in Studio, so a record deleted there
   * would otherwise stay in its listening total, its advisory and its recall
   * chips until the app restarted.
   */
  function watchHistory() {
    return historyStore.subscribe(adoptHistory);
  }

  function choose(id: string) {
    chosen = true;
    presetId = id;
  }

  function adoptPresets(saved: Preset[]) {
    userPresets = saved;
    // The selection may have been deleted in Studio since. Falling back to a
    // built-in rather than to the first saved one, which may not exist either.
    if (!presets.some((p) => p.id === presetId)) presetId = DEFAULT_PRESET_ID;
  }

  async function begin() {
    if (busy || client === null || selected === null) return;
    busy = true;
    error = null;
    try {
      await client.start({
        presetId: selected.id,
        // A preset carries exactly the three fields a configuration is, and
        // the snapshot detaches them so a later edit in Studio cannot reach
        // back into what this session recorded as its starting point.
        configuration: snapshotConfiguration(selected),
        plannedSeconds: minutes * 60,
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function end() {
    if (busy || client === null) return;
    busy = true;
    error = null;
    try {
      await client.stop();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    if (client === null) return;
    /**
     * Told when things change, rather than re-reading when shown.
     *
     * This window is created once at startup and hidden rather than closed, so
     * reading at mount would leave it showing whatever existed at launch for
     * the rest of the session. It cannot notice being shown either: Electron
     * fires neither `visibilitychange` nor `focus` for a window revealed with
     * `show()`, and `document.visibilityState` reads `visible` the entire time
     * it is hidden. So the main process says when.
     *
     * Each hands back the current value through the callback and returns the
     * function that stops watching.
     */
    const stop = [
      client.subscribe((update) => {
        snapshot = update.snapshot;
        // Re-anchor on every publish, so the display tracks the coordinator
        // rather than drifting away from it.
        anchorMonotonic = performance.now();
      }),
      presetStore.subscribe(adoptPresets),
      settingsStore.subscribe((update) => {
        settings = update;
      }),
      watchHistory(),
    ];

    // Separately, because this also runs the one-time import of presets saved
    // by an earlier version — and that import is itself a change, so the
    // subscription above delivers the result.
    void presetStore.list().then(adoptPresets);

    /**
     * Ask for a window as tall as the content.
     *
     * The content genuinely varies — a countdown, a picker, recall chips, an
     * advisory that may or may not be there — and any fixed height either pads
     * the short states or clips the long ones. Clipping is the worse failure:
     * the advisory is the message that must not be cut off.
     *
     * Measured on the document rather than a wrapper, so nothing inside can
     * stretch to the window and report the window back.
     */
    const report = () => {
      const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
      if (height > 0) void bridge?.windows.setPopoverHeight(height);
    };
    const observer = new ResizeObserver(report);
    observer.observe(document.documentElement);

    const tick = setInterval(() => {
      ticks += 1;
    }, 250);
    return () => {
      for (const unsubscribe of stop) unsubscribe();
      observer.disconnect();
      clearInterval(tick);
    };
  });
</script>

<div class="popover">
  <header>
    <h1>40 Hz</h1>
    <button class="link" onclick={() => bridge?.windows.showStudio()}>Studio</button>
  </header>

  {#if client === null}
    <p class="note">This window needs the desktop app.</p>
  {:else if running && session !== null}
    <div class="countdown mono" class:ending={view.ending}>{clock(remaining)}</div>
    <!-- The same words Studio shows, from the same function: these two
         surfaces described one session and disagreed during a stop. -->
    <div class="phase" role="status" aria-live="polite" aria-atomic="true">{view.label}</div>
    <button class="primary end" onclick={end} disabled={busy}>End session</button>
  {:else}
    <label class="field">
      <span>Preset</span>
      <select
        value={presetId}
        disabled={presets.length === 0}
        onchange={(e) => choose(e.currentTarget.value)}
      >
        {#each presets as preset (preset.id)}
          <option value={preset.id}>{preset.name}</option>
        {/each}
      </select>
    </label>

    {#if recent.length > 1}
      <div class="recent">
        {#each recent as preset (preset.id)}
          <button class="chip" class:on={preset.id === presetId} onclick={() => choose(preset.id)}>
            {preset.name}
          </button>
        {/each}
      </div>
    {/if}

    <Segmented
      label="Duration (minutes)"
      options={durationOptions}
      value={String(minutes)}
      onchange={(v: string) => (minutes = Number(v))}
    />

    <button
      class="primary"
      onclick={begin}
      disabled={busy ||
        selected === null ||
        (snapshot.state !== 'idle' && snapshot.state !== 'previewing')}
    >
      Start session
    </button>

    {#if needsBothEars}
      <p class="note advisory">
        Binaural routing: the beat exists only between the two ears. Wired stereo headphones, with
        spatial audio off.
      </p>
    {/if}

    {#if snapshot.state === 'previewing'}
      <p class="note">Preview is running in Studio. Starting a session will take it over.</p>
    {/if}
  {/if}

  {#if advice !== null}
    <p class="note advisory">{advice.message}</p>
  {/if}

  {#if error !== null}
    <p class="note error">{error}</p>
  {/if}

  <footer>
    <span>Listening time today</span>
    <span class="mono">{listeningTime(today)}</span>
  </footer>
</div>

<style>
  .popover {
    /* Natural height: the window is resized to fit this, not the reverse. */
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 16px;
    /* The window is frameless, so the panel draws its own edge. */
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    background: var(--bg-panel);
    overflow: hidden;
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  h1 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  .link {
    border: none;
    background: none;
    padding: 0;
    font-size: 12px;
    color: var(--text-dim);
  }

  .link:hover {
    background: none;
    color: var(--signal);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .field span {
    font-size: 13px;
    color: var(--text-dim);
  }

  .countdown {
    font-size: 40px;
    text-align: center;
    letter-spacing: 0.02em;
    color: var(--signal);
  }

  .countdown.ending {
    color: var(--text-dim);
  }

  .phase {
    text-align: center;
    font-size: 11px;
    color: var(--text-faint);
  }

  .primary {
    padding: 10px 16px;
    font-weight: 500;
    border-color: var(--signal-strong);
    background: var(--signal-surface);
    color: var(--on-signal);
  }

  .primary:hover:not(:disabled) {
    background: var(--signal-surface-hover);
    border-color: var(--signal);
  }

  .primary.end {
    background: var(--danger-surface);
    border-color: var(--danger);
    color: var(--danger);
  }

  .primary.end:hover:not(:disabled) {
    background: var(--danger-surface-hover);
    color: var(--on-danger);
  }

  .note {
    margin: 0;
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-dim);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
  }

  .note.error {
    border-color: var(--danger);
    color: var(--danger);
  }

  /* A reminder, not a refusal. */
  .note.advisory {
    border-color: var(--warn);
    background: var(--warn-surface);
    color: var(--warn);
  }

  .recent {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: -4px;
  }

  .chip {
    padding: 3px 10px;
    font-size: 11px;
    border-radius: 999px;
  }

  .chip.on {
    border-color: var(--signal-strong);
    background: var(--signal-soft);
    color: var(--signal);
  }

  footer {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding-top: 10px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-faint);
  }
</style>
