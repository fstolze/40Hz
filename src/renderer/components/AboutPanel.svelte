<script lang="ts">
  /**
   * What this app is, and what it deliberately is not.
   *
   * The positioning line is not decoration. The research behind 40 Hz
   * entrainment includes neurodegeneration work, and repeating any of it here
   * would be a medical device claim — so this says what the app is for, in the
   * same words as the footer, and nothing about what it might do to anyone.
   *
   * The version comes through the bundler rather than the desktop bridge, so
   * Studio running standalone in a browser reports the same thing as the
   * packaged app.
   */
  const bridge = globalThis.window?.desktop;
  const versions = bridge?.versions;
</script>

<section>
  <p class="lede">
    <strong>40 Hz</strong>
    <span class="mono version">{__APP_VERSION__}</span>
  </p>
  <p>A focus and concentration tool built on 40 Hz auditory entrainment.</p>
  <p class="note">
    Not a medical device. It is not intended to diagnose, treat, cure, or prevent any condition, and
    nothing here is medical advice.
  </p>
</section>

<section>
  <h3>Your data stays here</h3>
  <p class="note">
    Audio is synthesized on this machine. Presets, session history, and settings are files on this
    computer, yours to delete. There is no account, no telemetry, and nothing is sent anywhere.
  </p>
</section>

<section>
  <h3>Build</h3>
  <p class="note mono">
    {__BUILD_COMMIT__} · {__BUILD_DATE__}
    {#if bridge !== undefined && bridge.packaged !== true}· development{/if}
  </p>
  {#if versions !== undefined}
    <p class="note mono">
      Electron {versions.electron} · Chromium {versions.chrome} · Node {versions.node}
    </p>
  {/if}
</section>

<p class="note copyright">© Frank Stolze · <span class="mono">frank@stolze.us</span></p>

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }

  p {
    margin: 0;
  }

  .lede {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 15px;
  }

  .version {
    color: var(--text-dim);
    font-size: 12px;
  }

  .note {
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.5;
  }

  .copyright {
    color: var(--text-dim);
    font-size: 12px;
  }
</style>
