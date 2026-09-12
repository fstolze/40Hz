<script lang="ts">
  import { integrity } from '../lib/integrity.svelte.ts';
  import {
    PANEL_SCOPES,
    SCOPE_LABELS,
    findingsInScope,
    isCheckable,
  } from '../../integrity/summary.ts';
  import { devices } from '../lib/devices.svelte.ts';
  import { engine } from '../lib/engine.svelte.ts';
  import { captureNow } from '../lib/capture-driver.ts';

  const findings = $derived(integrity.findings);
  const summary = $derived(integrity.summary);

  let checking = $state(false);

  /**
   * Measure the app's own output, now.
   *
   * Named for what it can actually do. These taps end before
   * `AudioContext.destination`, so a pass says nothing about the output
   * device, the system mix, or delivery — and the panel below says so for
   * each of those scopes in its own words.
   */
  async function checkNow(): Promise<void> {
    checking = true;
    try {
      await captureNow(engine.graph);
    } finally {
      checking = false;
    }
  }
</script>

<div class="integrity">
  <p class="headline" class:warn={summary.escalated}>{summary.headline}</p>

  <div class="actions">
    <button
      class="check"
      onclick={() => void checkNow()}
      disabled={checking || !engine.status.running}
    >
      {checking ? 'Checking…' : 'Check app output now'}
    </button>
    {#if !engine.status.running}
      <!--
        `running`, not `ready`: a graph outlives the audio it played, so a
        button gated on readiness stays live after a stop and measures a ring
        that is winding down — or waits out the whole window plus its grace
        against a suspended context before answering that it timed out.
      -->
      <span class="why">Nothing is playing, so there is no output to measure.</span>
    {/if}
  </div>

  <!--
    The sentence that keeps the two states apart. The panel shows what the
    checks say now; a session's record keeps the worst result seen while it ran,
    and the two are allowed to disagree — a fault the user has since fixed is
    history, not a current fault. Without this line a reader would reasonably
    take one for the other.
  -->
  <p class="note">
    Current checks are shown here. Session history retains the worst result observed during each
    session.
  </p>

  {#each PANEL_SCOPES as scope (scope)}
    {@const inScope = findingsInScope(findings, scope)}
    <section>
      <h3>
        {SCOPE_LABELS[scope]}
        {#if !isCheckable(scope)}
          <span class="tag">no checker exists</span>
        {:else if inScope.every((finding) => !finding.checked)}
          <span class="tag">not checked</span>
        {/if}
      </h3>

      {#if inScope.length === 0}
        <!--
          A scope with nothing in it at all. Saying so beats leaving a gap that
          reads as a pass, which is the failure this whole subsystem exists to
          avoid.
        -->
        <p class="finding unknown"><span class="what">Nothing has reported on this yet.</span></p>
      {:else}
        {#each inScope as finding (finding.id)}
          <p class="finding {finding.checked ? finding.status : 'unknown'}">
            <span class="what">{finding.title}</span>
            <span class="why">{finding.detail}</span>
          </p>
        {/each}
      {/if}
    </section>
  {/each}

  <section>
    <h3>Device</h3>
    <!-- Facts, not verdicts: none of these supports a conclusion on its own. -->
    <dl class="facts">
      {#each devices.facts as fact (fact.id)}
        <div>
          <dt>{fact.label}</dt>
          <dd>
            <span class="mono">{fact.value}</span>
            {#if fact.note}<span class="why">{fact.note}</span>{/if}
          </dd>
        </div>
      {/each}
    </dl>
  </section>
</div>

<style>
  .integrity {
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-width: 560px;
  }

  .headline {
    margin: 0;
    font-size: 13px;
    color: var(--text);
  }

  .headline.warn {
    color: var(--warn);
  }

  .actions {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }

  .check {
    font-size: 12px;
    padding: 5px 12px;
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

  section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  h3 {
    margin: 0;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .tag {
    text-transform: none;
    letter-spacing: 0;
    color: var(--text-dim);
  }

  .finding {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-left-width: 3px;
    border-radius: var(--radius);
    background: var(--bg-input);
  }

  .finding.ok {
    border-left-color: var(--signal);
  }

  .finding.warning,
  .finding.failed {
    border-left-color: var(--warn);
  }

  .finding.unknown {
    border-left-color: var(--border);
  }

  .what {
    font-size: 12px;
    color: var(--text);
  }

  .why {
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-dim);
  }

  .facts {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
  }

  .facts > div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-input);
  }

  dt {
    font-size: 11px;
    color: var(--text-faint);
  }

  dd {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    font-size: 12px;
  }
</style>
