<script lang="ts">
  /**
   * One session, as the record stores it.
   *
   * Every figure here is read from the record — never from whatever Studio
   * happens to be showing. A row that fell back to the live recipe would be
   * describing a session that never ran, and the two are hardest to tell apart
   * exactly when it matters, immediately after a recall.
   *
   * The row is not clickable. Recall and Delete are the actions, they say what
   * they do, and a row that quietly did one of them on click would make the
   * other unreachable by keyboard without a second affordance anyway.
   */
  import { clock } from '../lib/format.ts';
  import {
    OUTCOME,
    endpointChanges,
    integrityLabel,
    presetLabel,
    recallOptions,
    recipeSummary,
    type RecallOption,
  } from '../lib/history-view.ts';
  import type { Preset } from '../../audio/presets.ts';
  import type { SessionRecord } from '../../session/session.ts';

  interface Props {
    record: SessionRecord;
    /** For naming the preset a record ran, if it still exists. */
    presets: readonly Preset[];
    onrecall: (option: RecallOption, record: SessionRecord) => void;
    ondelete: (record: SessionRecord) => void;
    busy: boolean;
    /**
     * True when another rendered row carries the same preset and instant.
     *
     * Decided by the panel, which is the only thing that can see the other
     * rows. False for every log this app wrote — see `ambiguousIds`.
     */
    ambiguous: boolean;
  }

  let { record, presets, onrecall, ondelete, busy, ambiguous }: Props = $props();

  const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  /*
   * Seconds, for the spoken name only.
   *
   * The visible stamp stays to the minute — seconds are noise to read down a
   * list — but the accessible name has to single a row out, and twenty valid
   * sessions inside one minute collapsed to nine distinct names between them.
   * A voice user could not say which row they meant. The preset joins it,
   * because two sessions really can start in the same second.
   */
  const precise = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });

  const started = $derived(new Date(record.startedAt));
  const stamp = $derived(when.format(started));
  const preset = $derived(presetLabel(record, presets));
  const options = $derived(recallOptions(record));
  const integrity = $derived(integrityLabel(record));
  const summary = $derived(recipeSummary(record.initialConfiguration));
  const changes = $derived(endpointChanges(record));
  /*
   * Named for its own sake, because "Delete" repeated down a list of twenty
   * rows is the same word twenty times to anything that reads them aloud.
   *
   * The record id joins it only when the preset and the instant do not settle
   * which row this is — a file that has been hand-edited or merged can hold two
   * records the coordinator never could. Carrying the id unconditionally would
   * put an unspeakable token in every name to fix a case no ordinary log
   * reaches; carrying it never leaves two permanent deletions answering to one
   * name.
   */
  const named = $derived(
    ambiguous
      ? `${preset.name}, ${precise.format(started)}, ${record.id}`
      : `${preset.name}, ${precise.format(started)}`,
  );
</script>

<li class="record">
  <div class="head">
    <time class="when" datetime={started.toISOString()}>{stamp}</time>
    <span class="preset" class:missing={preset.missing} title={preset.id}>{preset.name}</span>
    <!--
      Every state is a word.

      The visual acceptance asks for these to be distinguishable without colour,
      so each one says what it is and colour only reinforces it. That is also
      what makes them survive the row wrapping at the minimum width, where a
      dot or a stripe would have nowhere to sit.
    -->
    <span class="badge outcome" data-outcome={record.completionReason}>
      {OUTCOME[record.completionReason] ?? record.completionReason}
    </span>
    {#if record.edited}
      <span class="badge" title="The recipe changed while this session ran">Edited</span>
    {/if}
    <!--
      The coverage is on the row, not in a tooltip.

      What was examined is half the answer — a clean verdict over an empty
      coverage means nothing ran — and hiding it behind hover put that half out
      of reach of anyone not using a mouse. `integrityLabel` now reports "Not
      checked" whenever the coverage is empty, whatever verdict was stored, so
      the two can no longer contradict each other here.
    -->
    <span
      class="badge"
      data-integrity={integrity.coverage === null ? 'unknown' : record.integrityStatus}
    >
      {integrity.verdict}{#if integrity.coverage !== null}<span class="scopes"
          >&nbsp;· {integrity.coverage}</span
        >{/if}
    </span>
  </div>

  <div class="recipes">
    <p class="recipe">
      {#if changes.length > 0}<span class="endpoint">Started</span>{/if}
      {#each summary as piece, i (piece)}<span>{piece}</span>{#if i < summary.length - 1}<span
            class="sep"
            aria-hidden="true">·</span
          >{/if}{/each}
    </p>
    {#if changes.length > 0}
      <!--
        What actually changed, rather than the same headline figures twice.

        Two summaries were rendered before this, and for a session that moved
        only its duty they were identical — so the row offered a choice between
        two endpoints while giving the reader nothing to choose on. Naming the
        fields that differ is the whole point of exposing both.
      -->
      <p class="recipe changed">
        <span class="endpoint">Changed</span>
        {#each changes as change (change.label)}<span class="change"
            >{change.label} {change.from} → {change.to}</span
          >{/each}
      </p>
    {/if}
  </div>

  <p class="timing mono">
    {clock(record.actualSeconds)} of {clock(record.plannedSeconds)} planned
  </p>

  <div class="actions">
    {#each options as option (option.label)}
      <!--
        The accessible name opens with the visible label.

        It did not, and the flow tests could not find the button by its own
        text — which is the same failure a speech-input user hits when they say
        "recall recipe" and nothing happens. The name has to contain the label
        it shows; the longer explanation belongs in the title.
      -->
      <button
        onclick={() => onrecall(option, record)}
        disabled={busy}
        title={option.description}
        aria-label="{option.label} — {named}"
      >
        {option.label}
      </button>
    {/each}
    <button
      class="delete"
      onclick={() => ondelete(record)}
      disabled={busy}
      aria-label="Delete {named}"
    >
      Delete
    </button>
  </div>
</li>

<style>
  /*
   * Named areas, so the row has three arrangements rather than one that
   * squeezes. Wide: identity and actions on one line with the detail beneath.
   * Narrow: everything stacks, and the actions keep their full width rather
   * than being pushed off the edge — a destructive control that leaves the
   * window is the failure this layout exists to avoid.
   */
  .record {
    display: grid;
    grid-template-areas:
      'head'
      'recipe'
      'timing'
      'actions';
    gap: 6px 16px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-panel);
  }

  .head {
    grid-area: head;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px 10px;
    min-width: 0;
  }

  .when {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }

  .preset {
    font-size: 13px;
    color: var(--text-dim);
    /* A long saved name is truncated rather than allowed to push the badges
       off the row. The full name stays available as the title. */
    max-width: 22ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /*
   * The fallback is not user data, so it does not take the truncation the way
   * a saved name does — it was being clipped to "Preset no longer savea",
   * which is a worse answer than the one it was trying to give. Shortened as
   * well, so the cap is nowhere near it.
   */
  .preset.missing {
    max-width: none;
    color: var(--text-faint);
    font-style: italic;
  }

  .badge {
    padding: 1px 6px;
    border: 1px solid var(--border-strong);
    border-radius: 3px;
    background: var(--bg-raised);
    color: var(--text-dim);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  /* Colour reinforces the word; it never carries the meaning alone. */
  .badge[data-outcome='interrupted'],
  .badge[data-integrity='failed'] {
    border-color: var(--danger);
    color: var(--danger);
  }

  .badge[data-integrity='warning'] {
    border-color: var(--warn);
    color: var(--warn);
  }

  .recipes {
    grid-area: recipe;
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .endpoint {
    color: var(--text-faint);
    font-variant: small-caps;
    letter-spacing: 0.03em;
  }

  .recipe {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    margin: 0;
    font-size: 12px;
    color: var(--text-dim);
  }

  .sep {
    color: var(--text-faint);
  }

  .scopes {
    color: var(--text-faint);
    font-weight: 400;
  }

  .changed {
    gap: 4px 12px;
  }

  .change {
    white-space: nowrap;
  }

  .timing {
    grid-area: timing;
    margin: 0;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--text-faint);
  }

  .actions {
    grid-area: actions;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 2px;
  }

  .actions button {
    min-height: 36px;
    font-size: 12px;
    padding: 6px 12px;
  }

  .actions .delete {
    color: var(--danger);
    border-color: var(--border-strong);
  }

  .actions .delete:hover:not(:disabled) {
    border-color: var(--danger);
  }

  /*
   * From here the row reads as two columns: everything about the session on
   * the left, the actions held to the right where they line up down the list
   * and can be found without reading each row.
   *
   * The stacked arrangement above this is not dead code, though the desktop
   * window cannot reach it — its minimum is 900px, comfortably past this
   * breakpoint. Studio also runs standalone in a browser, where the window can
   * be any width at all, and that is the case the stack is for.
   */
  @media (min-width: 860px) {
    .record {
      grid-template-areas:
        'head actions'
        'recipe actions'
        'timing actions';
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: start;
    }

    .actions {
      justify-content: flex-end;
      margin-top: 0;
      align-self: center;
    }
  }
</style>
