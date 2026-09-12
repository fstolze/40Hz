<script lang="ts">
  import { engine } from '../lib/engine.svelte.ts';
  import { theme, type ChartPalette } from '../lib/theme.svelte.ts';
  import { isFinitePcm, modulationReadout } from '../../audio/analysis/readout.ts';

  let canvas: HTMLCanvasElement;
  let host: HTMLDivElement;
  let measuredIndex = $state(0);
  let measuredDepthDb = $state(0);
  /**
   * What the scope can say right now.
   *
   * `invalid` is a state of its own because it is not "no signal" and it is
   * certainly not a measurement: with samples that are not numbers, the binning
   * loop's sentinels survive untouched and the trace it draws from them is a
   * full-scale envelope that was never played.
   */
  let signal = $state<'none' | 'reading' | 'invalid'>('none');

  const COLUMNS = 320;

  $effect(() => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let frame = 0;
    let buffer: Float32Array<ArrayBuffer> | null = null;

    const observer = new ResizeObserver(() => resize(ctx));
    observer.observe(host);
    resize(ctx);

    const upper = new Float32Array(COLUMNS);
    const lower = new Float32Array(COLUMNS);

    /**
     * How often the readout is recalculated.
     *
     * The envelope costs a transform of the whole buffer — 1.1 ms measured,
     * which is 7% of a core at sixty frames a second — and a figure that
     * changes sixty times a second is harder to read than one that changes six.
     * The trace still redraws every frame; only the number is throttled.
     *
     * Keyed on the frame clock rather than a frame count. A count is reset
     * whenever this effect re-runs, and if that happens more often than the
     * count is reached the readout is recalculated *never* — which is exactly
     * what happened, leaving 0.0% under a plainly modulated trace. A timestamp
     * costs one immediate recalculation per re-run instead.
     */
    const READOUT_INTERVAL_MS = 150;
    let readoutAt = 0;

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);

      const analyser = engine.graph?.entrainmentAnalyser;
      const { width, height } = canvas;
      const dpr = window.devicePixelRatio || 1;

      /*
       * Read once per frame, not once per effect run.
       *
       * The trace already redraws on every animation frame, so taking the
       * current palette here is what makes a theme change appear without
       * tearing down the loop, the analyser, or the observer. Reading it from
       * an rAF callback is deliberately outside Svelte's tracking, so a new
       * palette does not re-run the effect and restart the animation.
       */
      const palette = theme.chart;

      ctx.clearRect(0, 0, width, height);
      drawGrid(ctx, width, height, dpr, palette);

      if (!analyser) {
        signal = 'none';
        return;
      }

      if (!buffer || buffer.length !== analyser.fftSize) {
        buffer = new Float32Array(analyser.fftSize);
      }
      // Float rather than byte. The byte view quantises to steps of 1/128, and
      // at the levels the quieter presets run at that step is a large part of
      // the signal — which is how a column of near-silence came back with a
      // *negative* maximum and the readout reported 775%.
      analyser.getFloatTimeDomainData(buffer);

      // Before binning, not after measuring. The binning loop starts each
      // column at `hi = -1, lo = 1` and only moves them on a true comparison,
      // so samples that are not numbers leave those sentinels in place and the
      // trace drawn from them is a full-scale envelope nothing produced.
      if (!isFinitePcm(buffer)) {
        signal = 'invalid';
        measuredIndex = 0;
        measuredDepthDb = 0;
        return;
      }

      // Bin the waveform into columns, keeping the extremes in each bin. The
      // outline of those extremes is the amplitude envelope.
      const per = Math.floor(buffer.length / COLUMNS);
      let peak = 0;
      for (let c = 0; c < COLUMNS; c++) {
        let hi = -1;
        let lo = 1;
        const start = c * per;
        for (let i = 0; i < per; i++) {
          const v = buffer[start + i];
          if (v > hi) hi = v;
          if (v < lo) lo = v;
        }
        upper[c] = hi;
        lower[c] = lo;
        peak = Math.max(peak, Math.abs(hi), Math.abs(lo));
      }

      if (peak <= 0.002) {
        signal = 'none';
        measuredIndex = 0;
        measuredDepthDb = 0;
      } else if (now - readoutAt >= READOUT_INTERVAL_MS) {
        readoutAt = now;
        const readout = modulationReadout(buffer, engine.status.sampleRate || 48000);
        // The buffer was checked above, so anything but a reading here means
        // the measurement itself could not conclude — too short a window, or
        // an envelope that would not resolve. Neither is a number to show.
        signal = readout.kind === 'reading' ? 'reading' : 'invalid';
        measuredIndex = readout.index;
        measuredDepthDb = readout.depthDb;
      } else {
        signal = 'reading';
      }

      drawEnvelope(ctx, upper, lower, width, height, palette);
    };

    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  });

  function resize(ctx: CanvasRenderingContext2D) {
    const dpr = window.devicePixelRatio || 1;
    const rect = host.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.lineJoin = 'round';
  }

  function drawGrid(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    dpr: number,
    palette: ChartPalette,
  ) {
    const mid = height / 2;
    ctx.strokeStyle = palette.grid;
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();

    // One vertical rule per modulation period, so the 25 ms grid is visible.
    const analyser = engine.graph?.entrainmentAnalyser;
    const rate = engine.graph?.context.sampleRate;
    if (!analyser || !rate) return;
    const spanSeconds = analyser.fftSize / rate;
    const periods = spanSeconds * engine.params.modulationHz;
    if (periods < 2 || periods > 60) return;

    ctx.strokeStyle = palette.gridFaint;
    for (let p = 1; p < periods; p++) {
      const x = Math.round((p / periods) * width) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }

  function drawEnvelope(
    ctx: CanvasRenderingContext2D,
    upper: Float32Array,
    lower: Float32Array,
    width: number,
    height: number,
    palette: ChartPalette,
  ) {
    const mid = height / 2;
    const scale = mid * 0.92;
    const step = width / (COLUMNS - 1);

    ctx.beginPath();
    for (let c = 0; c < COLUMNS; c++) {
      const x = c * step;
      const y = mid - upper[c] * scale;
      if (c === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let c = COLUMNS - 1; c >= 0; c--) {
      ctx.lineTo(c * step, mid - lower[c] * scale);
    }
    ctx.closePath();

    const fill = ctx.createLinearGradient(0, 0, 0, height);
    fill.addColorStop(0, palette.signalFillEdge);
    fill.addColorStop(0.5, palette.signalFillMid);
    fill.addColorStop(1, palette.signalFillEdge);
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.strokeStyle = palette.signal;
    ctx.lineWidth = Math.max(1, (window.devicePixelRatio || 1) * 1.1);
    ctx.stroke();
  }
</script>

<div class="scope">
  <header>
    <h2>Envelope</h2>
    <div class="readout">
      {#if signal === 'reading'}
        <span class="mono">{(measuredIndex * 100).toFixed(1)}%</span>
        <span class="sep">·</span>
        <span class="mono">
          {measuredDepthDb >= 60 ? '>60' : measuredDepthDb.toFixed(1)} dB
        </span>
      {:else if signal === 'invalid'}
        <span class="idle">signal not readable</span>
      {:else}
        <span class="idle">no signal</span>
      {/if}
    </div>
  </header>
  <div class="canvas-host" bind:this={host}>
    <canvas bind:this={canvas}></canvas>
  </div>
  <p class="caption">
    Entrainment path before the bed is mixed in. Vertical rules mark one modulation period ({(
      1000 / engine.params.modulationHz
    ).toFixed(1)} ms).
  </p>
</div>

<style>
  .scope {
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
  }

  /* Level two per the typography contract; the size is set here, not by the
     tag, so the visual weight is unchanged. */
  h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }

  .readout {
    font-size: 12px;
    color: var(--signal);
  }

  .sep {
    color: var(--text-faint);
    margin: 0 4px;
  }

  .idle {
    color: var(--text-faint);
    font-size: 12px;
  }

  .canvas-host {
    flex: 1;
    min-height: 120px;
    position: relative;
  }

  canvas {
    position: absolute;
    inset: 0;
    display: block;
  }

  .caption {
    margin: 0;
    padding: 8px 14px;
    font-size: 11px;
    color: var(--text-faint);
    border-top: 1px solid var(--border);
  }
</style>
