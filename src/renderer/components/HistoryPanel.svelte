<script lang="ts">
  /**
   * The session log: what was run, and the means to remove any of it.
   *
   * A presentation over the production history, and nothing more. Records are
   * created only by the session coordinator — there is deliberately no renderer
   * path that appends one — and every figure on screen is derived from the
   * subscription's own list rather than from a second copy kept here. The
   * totals are computed from the same records the rows come from, so a summary
   * can never disagree with the list beneath it.
   *
   * History is private and device-local; that is the governing decision, and it
   * is why deletion is offered plainly rather than buried.
   */
  import Dialog from './Dialog.svelte';
  import HistoryRow from './HistoryRow.svelte';
  import { historyStore, presetStore } from '../lib/stores.ts';
  import { listeningTime } from '../lib/format.ts';
  import { listeningSecondsOnDay, recentSessions } from '../../session/history.ts';
  import { ambiguousIds, clearOutcome } from '../lib/history-view.ts';
  import { failureReason } from '../lib/errors.ts';
  import { tick } from 'svelte';
  import type { RecallOption } from '../lib/history-view.ts';
  import type { Preset } from '../../audio/presets.ts';
  import { nameablePresets } from '../../audio/presets.ts';
  import type { SessionRecord } from '../../session/session.ts';

  interface Props {
    /** Apply a recalled configuration and go to Studio. Owned by the shell. */
    onrecall: (option: RecallOption, record: SessionRecord) => void;
  }

  let { onrecall }: Props = $props();

  let records = $state<SessionRecord[]>([]);
  let userPresets = $state<Preset[]>([]);
  /**
   * Why a mutation did not happen, reported where the user is looking.
   *
   * Inside the dialog, never outside it: both deletions are confirmed, so a
   * failure always arrives while a modal's backdrop is over the rest of the
   * page — and a message rendered underneath it is visible, dimmed and
   * impossible to reach or dismiss. Only one of these dialogs is ever open, so
   * one message serves both.
   */
  let mutationError = $state<string | null>(null);
  /**
   * What just happened, for anything that cannot see the list change.
   *
   * "All mutations durable and announced" is a behavioural acceptance clause,
   * and only the failures were announced: a successful deletion moved focus to
   * a heading or a button that says nothing about what it did, and the row
   * simply vanished. A polite region says it once, without stealing focus from
   * wherever the deletion left it.
   */
  let announcement = $state('');
  let errorAlert = $state<HTMLElement | null>(null);
  let busy = $state(false);
  /** The record a confirmation is currently about, if any. */
  let confirmingDelete = $state<SessionRecord | null>(null);
  let confirmingClear = $state(false);
  let deleteDialog = $state<{ close: () => void } | null>(null);
  let clearDialog = $state<{ close: () => void } | null>(null);
  let clearButton = $state<HTMLButtonElement | null>(null);
  let heading = $state<HTMLElement | null>(null);

  /**
   * Whether to render the whole log rather than the most recent page.
   *
   * There has to be a way to reach an old record: this view offers to delete
   * any of it, and with only the newest twenty rendered the rest could be
   * removed only by clearing everything.
   */
  let showAll = $state(false);

  const PAGE = 20;
  const shown = $derived(recentSessions(records, showAll ? records.length : PAGE));
  const today = $derived(listeningSecondsOnDay(records, Date.now()));
  const presets = $derived(nameablePresets(userPresets));
  /*
   * Which rows cannot be told apart by name alone. Computed over the rendered
   * page rather than the whole log, because that is the set a voice user is
   * choosing between — and it is empty for every log the app itself wrote.
   */
  const ambiguous = $derived(ambiguousIds(shown));

  /**
   * Watch rather than read once.
   *
   * A session finishing while this view is open should appear in it, and a
   * deletion made here has to reach every other surface — both go through the
   * same subscription, which answers with the current list as it is installed.
   */
  $effect(() => historyStore.subscribe((next) => (records = next)));

  /*
   * The presets are watched too, but only to put a name to a record's id.
   * Nothing about a record is read from them: a preset that has since been
   * renamed, edited or deleted does not change what the session ran.
   */
  $effect(() => presetStore.subscribe((next) => (userPresets = next)));

  /**
   * Somewhere to stand after a row — or the whole log — has gone.
   *
   * The row's own Delete button cannot take focus back: the row it lived in has
   * just been removed. Clear cannot either once the list is empty, because it
   * is only rendered while there are records — which is exactly the case that
   * left focus on `<body>` after deleting the last row and after a successful
   * Clear. The heading is the one thing on this view that is always present, so
   * it is the end of the chain and it carries `tabindex="-1"` to be able to
   * hold focus at all.
   */
  async function focusAfterMutation(): Promise<void> {
    await tick();
    for (const candidate of [clearButton, heading]) {
      if (candidate === null || !candidate.isConnected) continue;
      candidate.focus();
      if (document.activeElement === candidate) return;
    }
  }

  /** Report a failed mutation inside the dialog, and move focus to it. */
  async function failMutation(message: string): Promise<void> {
    mutationError = message;
    await tick();
    errorAlert?.focus();
  }

  /**
   * A Clear that stopped part-way, reported as what it actually did.
   *
   * Records are removed one at a time, so a failure in the middle leaves every
   * earlier one permanently gone. "History was not cleared" describes an
   * operation that undid itself, and this one cannot: on a real `EACCES` part
   * way through forty records, four were destroyed and the message said none
   * were. That is the unannounced mutation this state prevents.
   *
   * So the count that already went leads, because it is the part the reader
   * cannot get back. It is announced as well as shown: the dialog can be
   * dismissed, and the fact that records were destroyed outlives it.
   */
  async function failPartialClear(deleted: number, total: number, cause: string | null) {
    const what = clearOutcome(deleted, total);
    announcement = what;
    await failMutation(cause === null ? what : `${what} ${cause}`);
  }

  async function removeOne(record: SessionRecord): Promise<void> {
    if (busy) return;
    busy = true;
    mutationError = null;
    try {
      const next = await historyStore.remove(record.id);
      if (next.some((r) => r.id === record.id)) {
        await failMutation('That session was not deleted. It is still in the stored history.');
        return;
      }
      records = next;
      deleteDialog?.close();
      confirmingDelete = null;
      announcement = `Session from ${new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(record.startedAt))} deleted. ${next.length} remaining.`;
      await focusAfterMutation();
    } catch (e) {
      await failMutation(`That session was not deleted. ${failureReason(e)}`);
    } finally {
      busy = false;
    }
  }

  async function clearAll(): Promise<void> {
    if (busy) return;
    busy = true;
    mutationError = null;
    // One at a time through the same path a single deletion takes. A purpose-built
    // bulk operation would be acceptable only if it were normalized,
    // sender-validated, announced and tested — a second route to the store that
    // behaves even slightly differently is a worse trade than the extra round
    // trips. What it costs instead is atomicity, which is why the two counters
    // below live outside the `try`: the failure handler needs both of them.
    //
    // The ids are captured first and the result judged against *those*. A
    // session completing while this runs arrives through the subscription and
    // repopulates the list, and a check for "the list is now empty" would then
    // report a failure about a record this never tried to delete — and would be
    // wrong about the ones it did.
    const targeted = records.map((r) => r.id);
    // Counted as it goes, because the count is what a failure has to report.
    // It cannot be reconstructed afterwards on the throwing path: the throw is
    // what ends the loop, and the list at that point is whatever the last
    // *successful* removal returned.
    let deleted = 0;
    try {
      for (const id of targeted) {
        records = await historyStore.remove(id);
        deleted += 1;
      }
      const survivors = records.filter((r) => targeted.includes(r.id));
      if (survivors.length > 0) {
        await failPartialClear(targeted.length - survivors.length, targeted.length, null);
        return;
      }
      clearDialog?.close();
      confirmingClear = false;
      // Says what it removed, not that the list is now empty: a session that
      // finished while this ran arrives through the subscription and is not
      // one of the targets, so "History is empty" would be a claim about the
      // list rather than about what this did.
      announcement = clearOutcome(targeted.length, targeted.length);
      await focusAfterMutation();
    } catch (e) {
      await failPartialClear(deleted, targeted.length, failureReason(e));
    } finally {
      busy = false;
    }
  }
</script>

<h2 bind:this={heading} tabindex="-1">Session history</h2>
<!--
  Polite, and outside the dialogs.

  A successful deletion is announced here rather than by moving focus somewhere
  that explains it: focus goes where the user can carry on working, and this
  says what changed. `aria-atomic` so the whole sentence is read rather than the
  diff between two announcements.
-->
<p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
<p class="note">Kept on this machine only, and never sent anywhere.</p>

{#if records.length > 0}
  <!--
    A summary, not a scorecard.

    Two figures, both derived from the records below rather than accumulated
    anywhere: how much was listened to today, and how many sessions are stored.
    History deliberately rules out streaks, effectiveness and "dose", and a metric
    tile is the shape those arrive in.
  -->
  <dl class="summary">
    <div>
      <dt>Today</dt>
      <dd class="mono">{listeningTime(today)}</dd>
    </div>
    <div>
      <dt>Sessions recorded</dt>
      <dd class="mono">{records.length}</dd>
    </div>
  </dl>
{/if}

{#if records.length === 0}
  <!--
    The empty state says how the list fills, because that is the one question
    it can answer. No sample data, no invitation to "get started", and no claim
    about what sessions do — History is a log, and an empty log means nothing
    has been recorded yet.
  -->
  <div class="empty">
    <h3>No sessions recorded yet</h3>
    <p>
      A session is recorded when it finishes — whether it runs to the end or you stop it early.
      Preview is not recorded, because nothing is being timed.
    </p>
    <p class="quiet">
      Start one from the Session strip in Studio, or from the tray. Records stay on this machine.
    </p>
  </div>
{:else}
  <ul class="records">
    {#each shown as record (record.id)}
      <HistoryRow
        {record}
        {presets}
        {busy}
        {onrecall}
        ambiguous={ambiguous.has(record.id)}
        ondelete={(target) => {
          mutationError = null;
          confirmingDelete = target;
        }}
      />
    {/each}
  </ul>

  {#if records.length > PAGE}
    <button class="more" onclick={() => (showAll = !showAll)}>
      {showAll
        ? `Show the ${PAGE} most recent`
        : `Show all ${records.length} — the ${PAGE} most recent are listed`}
    </button>
  {/if}

  <div class="clear">
    <button
      bind:this={clearButton}
      class="danger"
      onclick={() => {
        mutationError = null;
        confirmingClear = true;
      }}
    >
      Delete all history
    </button>
  </div>
{/if}

<!--
  Both destructive actions confirm, and both name what they are about.

  Both destructive history actions require explicit confirmation. The same
  native `<dialog>` the preset deletion uses supplies the focus trap, Escape,
  and the return of focus to whatever opened it — except that a per-row invoker
  is usually gone by the time the dialog closes, which is what
  `focusAfterDialog` covers.
-->
<Dialog
  bind:this={deleteDialog}
  title="Delete session"
  open={confirmingDelete !== null}
  onclose={() => {
    confirmingDelete = null;
    mutationError = null;
  }}
>
  <p class="confirm">
    Delete the session from
    <strong>
      {confirmingDelete === null
        ? ''
        : new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(new Date(confirmingDelete.startedAt))}
    </strong>? This cannot be undone.
  </p>
  {#if mutationError !== null}
    <p class="mutation-error" role="alert" tabindex="-1" bind:this={errorAlert}>{mutationError}</p>
  {/if}
  <div class="confirm-actions">
    <button onclick={() => deleteDialog?.close()} disabled={busy}>Cancel</button>
    <button
      class="danger"
      disabled={busy}
      onclick={() => confirmingDelete !== null && removeOne(confirmingDelete)}
    >
      Delete session
    </button>
  </div>
</Dialog>

<Dialog
  bind:this={clearDialog}
  title="Delete all history"
  open={confirmingClear}
  onclose={() => {
    confirmingClear = false;
    mutationError = null;
  }}
>
  <p class="confirm">
    Delete all <strong>{records.length}</strong> recorded sessions? This cannot be undone, and it does
    not change the recipe Studio is currently set to.
  </p>
  {#if mutationError !== null}
    <p class="mutation-error" role="alert" tabindex="-1" bind:this={errorAlert}>{mutationError}</p>
  {/if}
  <div class="confirm-actions">
    <button onclick={() => clearDialog?.close()} disabled={busy}>Cancel</button>
    <button class="danger" onclick={clearAll} disabled={busy}>Delete everything</button>
  </div>
</Dialog>

<style>
  /*
   * Announced, not shown.
   *
   * The same visually-hidden rule `Tuner` defines for its own label. Both are
   * scoped, so this is a second copy rather than a shared one — promoting it
   * into `app.css` would be a global style change, so it stays scoped here.
   */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }

  h2 {
    margin: 0 0 4px;
    font-size: 15px;
    font-weight: 600;
  }

  /* Focused only programmatically, so it must not become a tab stop or draw a
     ring when the pointer lands on it. */
  h2:focus {
    outline: none;
  }

  h2:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }

  .mutation-error {
    margin: 0 0 16px;
    padding: 10px 12px;
    max-width: 46ch;
    border: 1px solid var(--danger);
    border-radius: var(--radius);
    background: var(--danger-surface);
    color: var(--text);
    font-size: 13px;
  }

  .note {
    margin: 0 0 14px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-faint);
  }

  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 28px;
    margin: 0 0 16px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--border);
  }

  .summary > div {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  dt {
    font-size: 11px;
    color: var(--text-faint);
  }

  dd {
    margin: 0;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }

  .records {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }

  .empty {
    padding: 28px 24px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius);
    background: var(--bg-panel);
    max-width: 62ch;
  }

  .empty h3 {
    margin: 0 0 8px;
    font-size: 15px;
    font-weight: 600;
  }

  .empty p {
    margin: 0 0 8px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--text-dim);
  }

  .empty .quiet {
    margin: 0;
    color: var(--text-faint);
  }

  .more {
    margin-top: 12px;
    min-height: 36px;
    font-size: 12px;
  }

  .clear {
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }

  .clear .danger,
  .confirm-actions .danger {
    color: var(--on-danger);
    background: var(--danger);
    border-color: var(--danger);
    min-height: 36px;
  }

  .confirm {
    margin: 0 0 16px;
    max-width: 46ch;
  }

  .confirm strong {
    color: var(--text);
  }

  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .confirm-actions button {
    min-height: 36px;
  }
</style>
