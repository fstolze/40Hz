<script lang="ts">
  /**
   * The global playback group: what is playing, how loud, and what bounds it.
   *
   * These describe the whole recipe rather than any one layer, which is why
   * they sit in the header beside the preset workflow instead of among the
   * mixer panels. Output ceiling and sample rate moved here from the footer
   * for the same reason — they are facts about the output, and they were
   * previously the quietest text on the screen.
   *
   * Preview and a session are different actions over one audio path. This
   * button is Preview: untimed and unrecorded. While a session is running it
   * ends that instead, because there is only one thing playing to stop.
   *
   * Both active states name what they stop — "Stop preview", "Stop session" —
   * so the two are never confused, and so the accessible name still says what
   * the control does when it is read out of its visual context. A bare "Stop"
   * relies on the reader already knowing which of the two is playing.
   *
   * They are the same length, which is why this costs no layout: "Stop session"
   * already fits the one-line header at 1280 and the wrapped header at the
   * 900 px minimum, so "Stop preview" does too.
   */
  import Play from 'phosphor-svelte/lib/Play';
  import Stop from 'phosphor-svelte/lib/Stop';
  import { engine } from '../lib/engine.svelte.ts';
  import { sessionClient } from '../lib/session-client.ts';
  import { percent } from '../lib/format.ts';
  import type { SessionSnapshot } from '../../session/coordinator.ts';

  const status = $derived(engine.status);
  let busy = $state(false);
  let snapshot = $state<SessionSnapshot>({
    state: 'idle',
    session: null,
    edited: false,
    elapsedSeconds: 0,
  });

  const inSession = $derived(
    snapshot.state === 'session-active' || snapshot.state === 'session-ending',
  );
  const previewing = $derived(snapshot.state === 'previewing');
  const active = $derived(inSession || previewing);

  /**
   * Exported so the Space shortcut runs the same path as the button.
   *
   * A shortcut that called `sessionClient` itself would be a second transport
   * with its own idea of `busy`, and the two would disagree the moment a
   * command was slow.
   */
  export async function toggle(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      if (active) {
        await sessionClient.stop();
      } else {
        await sessionClient.preview(engine.currentConfiguration());
      }
    } catch (error) {
      // An executor that is not ready yet, or a command that timed out. Left
      // uncaught this was an unhandled rejection and the button simply did
      // nothing, with no way for the user to know why.
      engine.reportError(error);
    } finally {
      busy = false;
    }
  }

  $effect(() =>
    sessionClient.subscribe((update) => {
      snapshot = update.snapshot;
    }),
  );
</script>

<div class="transport">
  <button class="play" class:running={active} disabled={busy} onclick={toggle}>
    {#if active}
      <Stop size={14} weight="fill" aria-hidden="true" />
    {:else}
      <Play size={14} weight="fill" aria-hidden="true" />
    {/if}
    {#if inSession}
      Stop session
    {:else if previewing}
      Stop preview
    {:else}
      Preview
    {/if}
  </button>

  <div class="master">
    <label for="master">Master</label>
    <!--
      The readout is the accessible value, as it is for every `Slider`.

      This one is hand-rolled rather than that component, so it did not get the
      change with the rest: it displayed "62%" and announced "0.62".
    -->
    <input
      id="master"
      type="range"
      min="0"
      max="1"
      step="0.01"
      value={engine.masterLevel}
      aria-valuetext={percent(engine.masterLevel)}
      oninput={(e) => engine.setMasterLevel(Number(e.currentTarget.value))}
    />
    <span class="mono value">{percent(engine.masterLevel)}</span>
  </div>

  <!--
    Read-only, and the engine's own effective ceiling rather than a number
    repeated here. It is what the headroom guarantee actually bounds the
    output to, so a display that could drift from it would be worse than none.
  -->
  <span class="ceiling">Ceiling <span class="mono">{Math.round(engine.ceiling * 100)}%</span></span>

  <!--
    Always present, because absence and omission look the same.

    The badge used to render only once a rate existed, so on a cold start the
    header simply had no sample-rate item — a reader could not tell whether the
    product had not measured yet or had never intended to show it, and the
    header changed width the moment audio started. Printing an assumed 48 kHz
    would be worse: no prototype sample-rate value may become production state,
    and the capability this fills is "actual context rate".

    So the slot says what is true: "not measured" until a context exists, the
    measured rate afterwards. The same answer the Envelope gives with "no
    signal" and integrity gives with "Not checked".
  -->
  <span
    class="badge mono"
    class:warn={status.sampleRateWarning !== null}
    class:unmeasured={status.sampleRate <= 0}
  >
    {#if status.sampleRate > 0}
      {(status.sampleRate / 1000).toFixed(1)} kHz
    {:else}
      not measured
    {/if}
  </span>
</div>

<style>
  .transport {
    display: flex;
    align-items: center;
    gap: 16px;
    flex: 1 1 auto;
    min-width: 0;
  }

  .play {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 116px;
    height: 42px;
    justify-content: center;
    padding: 0 18px;
    font-weight: 500;
    border-color: var(--signal-strong);
    background: var(--signal-surface);
    color: var(--on-signal);
    flex: none;
  }

  /*
   * Quieter than a measured rate, and never mistaken for the warning state:
   * this is the absence of a fact, not a problem with one.
   */
  .badge.unmeasured {
    color: var(--text-faint);
    font-style: italic;
  }

  .play:hover:not(:disabled) {
    background: var(--signal-surface-hover);
    border-color: var(--signal);
  }

  .play.running {
    background: var(--danger-surface);
    border-color: var(--danger);
    color: var(--danger);
  }

  .play.running:hover:not(:disabled) {
    background: var(--danger-surface-hover);
    color: var(--on-danger);
  }

  .master {
    display: flex;
    align-items: center;
    gap: 10px;
    /* Compresses to its minimum at the narrowest window rather than pushing
       the readouts out of the row. */
    min-width: 140px;
    flex: 1 1 190px;
  }

  .master label {
    font-size: 12px;
    color: var(--text-dim);
    white-space: nowrap;
  }

  .master .value {
    font-size: 12px;
    min-width: 38px;
    text-align: right;
    color: var(--text-dim);
  }

  .ceiling {
    font-size: 12px;
    color: var(--text-dim);
    white-space: nowrap;
    flex: none;
  }

  .badge {
    font-size: 11px;
    padding: 5px 9px;
    border-radius: 6px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    color: var(--text-faint);
    white-space: nowrap;
    flex: none;
  }

  .badge.warn {
    border-color: var(--warn);
    background: var(--warn-surface);
    color: var(--warn);
  }
</style>
