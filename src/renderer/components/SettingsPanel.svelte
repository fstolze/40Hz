<script lang="ts">
  /**
   * The settings form.
   *
   * The daily threshold is an **advisory**: it warns and never restricts, per
   * the governing decision that this app reminds rather than gates. The copy
   * has to say so plainly, because a number with a limit's shape will be read
   * as a limit unless it is told otherwise.
   */
  import { settingsStore } from '../lib/stores.ts';
  import { listeningTime } from '../lib/format.ts';
  import { DEFAULT_SETTINGS, type Appearance, type Settings } from '../../session/settings.ts';
  import Segmented from './Segmented.svelte';
  import AboutPanel from './AboutPanel.svelte';

  let settings = $state<Settings>({ ...DEFAULT_SETTINGS });
  let error = $state<string | null>(null);

  // `setLoginItemSettings` is macOS and Windows only. On Linux autostart is a
  // `.desktop` file, which is a packaging concern — so the control is absent
  // rather than present and quietly ineffective.
  const bridge = globalThis.window?.desktop;
  const platform = bridge?.platform;
  const isDesktop = platform !== undefined;
  const supportedPlatform = platform === 'darwin' || platform === 'win32';
  const packaged = bridge?.packaged === true;
  /**
   * Offered only where checking it does something.
   *
   * Not in development: the executable there is Electron itself, so there is
   * nothing meaningful to register. It used to offer the control and promise
   * the preference would apply to an installed build, which was untrue — the
   * installed build reads the OS at startup and corrects the file, so the
   * stored `true` was overwritten before it ever took effect.
   */
  const canLaunchAtLogin = supportedPlatform && packaged;

  /**
   * Offered only where it decides anything.
   *
   * On Linux closing always quits, because a constructed tray there is not
   * evidence of a visible one and hiding behind a tray that never appeared
   * strands a running session. A checkbox that cannot change that would be a
   * control quietly doing nothing.
   */
  const canCloseToTray = supportedPlatform;

  const APPEARANCE_OPTIONS: { value: Appearance; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ];

  /** Minutes in the picker. 0 is offered as an explicit "off". */
  const ADVISORY_CHOICES = [0, 30, 60, 90, 120, 180, 240];
  const COOLDOWN_CHOICES = [0, 15, 30, 60, 120];

  /**
   * The offered minutes, plus whatever is stored if it is not one of them.
   *
   * A stored value with no matching option leaves the select blank, which
   * reads as "unset" for a setting that is very much set. Values from another
   * version, or from a hand-edited file, are exactly the case.
   */
  function choices(offered: number[], seconds: number): number[] {
    const minutes = seconds / 60;
    if (offered.includes(minutes)) return offered;
    return [...offered, minutes].sort((a, b) => a - b);
  }

  const advisoryChoices = $derived(choices(ADVISORY_CHOICES, settings.dailyAdvisorySeconds));
  const cooldownChoices = $derived(choices(COOLDOWN_CHOICES, settings.cooldownSeconds));

  async function apply(next: Settings) {
    // Optimistic, so the control does not lag the click; the store answers
    // with the values it actually kept and this adopts those. They can differ
    // from what was asked — normalization clamps, and launch at login reports
    // what the OS did rather than what was requested.
    const previous = settings;
    settings = next;
    error = null;
    try {
      settings = await settingsStore.save(next);
    } catch (e) {
      // Put the control back. Leaving the optimistic value showing would have
      // the form claim a setting is in force when the write was refused and
      // the stored value is still the old one.
      settings = previous;
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // The current values arrive through the callback, so this panel is correct
  // from its first frame — it mounts when the dialog opens, long after
  // anything that might have changed them. Unsubscribing on teardown is what
  // stops each opening leaving another listener behind.
  $effect(() =>
    settingsStore.subscribe((update) => {
      settings = update;
    }),
  );
</script>

<section>
  <h3>Appearance</h3>
  <p class="note">
    System follows your operating system and changes with it. Light and Dark stay where you put
    them.
  </p>
  <Segmented
    label="Colour scheme"
    options={APPEARANCE_OPTIONS}
    value={settings.appearance}
    onchange={(v: Appearance) => apply({ ...settings, appearance: v })}
  />
</section>

<section>
  <h3>Daily listening advisory</h3>
  <p class="note">
    A reminder, not a limit. Nothing stops when you reach it — you are told, and you decide.
  </p>
  <label>
    <span>Remind me after</span>
    <select
      value={String(settings.dailyAdvisorySeconds / 60)}
      onchange={(e) =>
        apply({ ...settings, dailyAdvisorySeconds: Number(e.currentTarget.value) * 60 })}
    >
      {#each advisoryChoices as minutes (minutes)}
        <option value={String(minutes)}>
          {minutes === 0 ? 'Never' : listeningTime(minutes * 60)}
        </option>
      {/each}
    </select>
  </label>
</section>

<section>
  <h3>Between sessions</h3>
  <p class="note">
    Suggests a pause after a session ends. Off unless you want to pace yourself deliberately.
  </p>
  <label>
    <span>Suggest waiting</span>
    <select
      value={String(settings.cooldownSeconds / 60)}
      onchange={(e) => apply({ ...settings, cooldownSeconds: Number(e.currentTarget.value) * 60 })}
    >
      {#each cooldownChoices as minutes (minutes)}
        <option value={String(minutes)}>
          {minutes === 0 ? 'No suggestion' : listeningTime(minutes * 60)}
        </option>
      {/each}
    </select>
  </label>
</section>

{#if isDesktop}
  <section>
    <h3>Closing the window</h3>
    {#if canCloseToTray}
      <label class="check">
        <input
          type="checkbox"
          checked={settings.closeToTray}
          onchange={(e) => apply({ ...settings, closeToTray: e.currentTarget.checked })}
        />
        <span>Keep 40 Hz running in the tray when I close the window</span>
      </label>
      <p class="note">
        {#if settings.closeToTray}
          Closing hides the window. Sessions keep playing, and the tray icon brings it back.
        {:else}
          Closing quits 40 Hz. A session still playing is finished and recorded first, not dropped.
        {/if}
      </p>
    {:else}
      <p class="note">
        Closing the window quits 40 Hz on this platform. Whether a tray icon appears depends on the
        desktop environment, and hiding behind one that never appeared would leave a session playing
        with no way to reach it.
      </p>
    {/if}
  </section>

  <section>
    <h3>Startup</h3>
    {#if canLaunchAtLogin}
      <label class="check">
        <input
          type="checkbox"
          checked={settings.launchAtLogin}
          onchange={(e) => apply({ ...settings, launchAtLogin: e.currentTarget.checked })}
        />
        <span>Start 40 Hz when I log in</span>
      </label>
      <p class="note">Opens the app, never a session. Nothing plays until you start it.</p>
    {:else if supportedPlatform}
      <p class="note">
        Starting at login is set on the installed app. This is a development build, which runs
        Electron rather than 40 Hz, so there is nothing here to register.
      </p>
    {:else}
      <p class="note">
        Starting at login is not available on this platform. Add the app to your desktop
        environment's startup programs instead.
      </p>
    {/if}
  </section>
{/if}

<!--
  About lives here rather than as a destination of its own.
  
  It is infrequent supporting information — a version string and a data
  statement — and a global navigation slot spent on it is a slot not spent on
  Studio or History. Composed as the existing panel rather than copied, so the
  version, build and legal facts still have exactly one owner.
-->
<section class="about">
  <h3>About</h3>
  <AboutPanel />
</section>

{#if error !== null}
  <p class="note error">{error}</p>
{/if}

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  h3 {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: 0.02em;
  }

  label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    font-size: 13px;
    color: var(--text-dim);
  }

  label.check {
    justify-content: flex-start;
  }

  .note {
    margin: 0;
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-faint);
  }

  .note.error {
    color: var(--danger);
  }

  /* Separated from the preferences above it: everything before this is a
     control, and this is a statement. */
  .about {
    gap: 12px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }
</style>
