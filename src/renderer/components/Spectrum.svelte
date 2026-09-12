<script lang="ts">
  /**
   * The mix at the master output, on a log frequency axis.
   *
   * The analyser, the FFT and the trace are unchanged. What changed is the
   * annotation: the three rules used to be labelled `−f`, `fc` and `+f`, which
   * asked the reader to know the notation and — because `fc` was drawn at the
   * marker's own x — rendered the carrier as `f|c`, bisected by its own rule.
   * They now carry the actual frequencies, laid out by
   * `spectrum-markers.ts` so the placement rules can be tested away from a
   * canvas, and the rules start below the label band so no text is crossed.
   */
  import { engine } from '../lib/engine.svelte.ts';
  import { theme, type ChartPalette } from '../lib/theme.svelte.ts';
  import {
    SPECTRUM_MAX_HZ,
    SPECTRUM_MIN_HZ,
    freqToX,
    spectrumAnnotation,
    type SpectrumAnnotation,
  } from '../../audio/analysis/spectrum-markers.ts';

  let canvas: HTMLCanvasElement;
  let host: HTMLDivElement;

  const MIN_HZ = SPECTRUM_MIN_HZ;
  const MAX_HZ = SPECTRUM_MAX_HZ;
  /** Label text size in CSS pixels, before the device pixel ratio. */
  const LABEL_PX = 11;

  // The caption is DOM text rather than canvas text: it is prose, it must wrap,
  // and a screen reader should be able to read it.
  const caption = $derived(
    spectrumAnnotation(
      { carrierHz: engine.params.carrierHz, modulationHz: engine.params.modulationHz },
      0,
      () => 0,
    ).caption,
  );

  $effect(() => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let frame = 0;
    let buffer: Uint8Array<ArrayBuffer> | null = null;

    const observer = new ResizeObserver(() => resize(ctx));
    observer.observe(host);
    resize(ctx);

    /*
     * The annotation is recomputed only when something it depends on moves.
     *
     * Laying out the markers means building strings, allocating, and asking
     * the canvas to measure three labels — cheap once, but this runs sixty
     * times a second and the answer changes only when a parameter, the width,
     * or the pixel ratio does. Studio also stays mounted while History is
     * showing, so without this the work continues in a view nobody is looking
     * at.
     */
    let cacheKey = '';
    let cached: SpectrumAnnotation | null = null;

    const annotationFor = (carrierHz: number, modulationHz: number, width: number, dpr: number) => {
      const key = `${carrierHz}|${modulationHz}|${width}|${dpr}`;
      if (key !== cacheKey || cached === null) {
        // Measured through the canvas at the size it will actually be drawn,
        // so collision decisions match what the user sees at any pixel ratio.
        ctx.font = `${LABEL_PX * dpr}px ui-monospace, monospace`;
        cached = spectrumAnnotation(
          { carrierHz, modulationHz },
          width,
          (text) => ctx.measureText(text).width,
        );
        cacheKey = key;
      }
      return cached;
    };

    const draw = () => {
      frame = requestAnimationFrame(draw);

      // Nothing to draw into while Studio is hidden behind History, and the
      // analyser read is the expensive part. The loop itself keeps running, so
      // there is still exactly one owner of it.
      if (host.offsetParent === null) return;

      const graph = engine.graph;
      const { width, height } = canvas;
      // Taken per frame, outside Svelte's tracking, so a theme change is
      // picked up by the next frame without re-running the effect that owns
      // the analyser and the ResizeObserver.
      const palette = theme.chart;
      const dpr = window.devicePixelRatio || 1;

      const annotation = annotationFor(
        engine.params.carrierHz,
        engine.params.modulationHz,
        width,
        dpr,
      );
      // Rules begin below the labels rather than running through them.
      const labelBand = annotation.rows * LABEL_PX * 1.45 * dpr + 4 * dpr;

      ctx.clearRect(0, 0, width, height);

      if (!graph) {
        drawMarkers(ctx, width, height, dpr, palette, annotation, labelBand);
        return;
      }

      const analyser = graph.analyser;
      if (!buffer || buffer.length !== analyser.frequencyBinCount) {
        buffer = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(buffer);

      const rate = graph.context.sampleRate;
      const binHz = rate / analyser.fftSize;

      ctx.beginPath();
      ctx.moveTo(0, height);
      let started = false;
      for (let bin = 1; bin < buffer.length; bin++) {
        const freq = bin * binHz;
        if (freq < MIN_HZ) continue;
        if (freq > MAX_HZ) break;
        const x = freqToX(freq, width);
        const y = height - (buffer[bin] / 255) * height * 0.95;
        if (!started) {
          ctx.lineTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.lineTo(width, height);
      ctx.closePath();

      const fill = ctx.createLinearGradient(0, 0, 0, height);
      fill.addColorStop(0, palette.bedFillTop);
      fill.addColorStop(1, palette.bedFillBottom);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = palette.bedLine;
      ctx.lineWidth = Math.max(1, dpr);
      ctx.stroke();

      drawMarkers(ctx, width, height, dpr, palette, annotation, labelBand);
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
    ctx.textBaseline = 'top';
  }

  /**
   * The carrier and both sidebands, where they appear in the plotted signal.
   *
   * Spectral references, not filter targets: `notchFrequencies` floors its
   * three at 20 Hz, so the two lists genuinely differ at a low carrier.
   */
  function drawMarkers(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    dpr: number,
    palette: ChartPalette,
    annotation: SpectrumAnnotation,
    labelBand: number,
  ) {
    ctx.font = `${LABEL_PX * dpr}px ui-monospace, monospace`;
    const lineHeight = LABEL_PX * 1.45 * dpr;

    for (const marker of annotation.markers) {
      const strong = marker.role === 'carrier';
      const x = Math.round(marker.x) + 0.5;

      ctx.strokeStyle = strong ? palette.markerStrong : palette.markerWeak;
      ctx.lineWidth = dpr;
      ctx.setLineDash(strong ? [] : [3 * dpr, 3 * dpr]);
      ctx.beginPath();
      ctx.moveTo(x, labelBand);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.setLineDash([]);

      // Centred over the rule, on the row the layout gave it. A grouped
      // annotation repeats one label across its markers, so it is drawn once —
      // on the first, because a grouped set need not contain a carrier at all.
      if (annotation.grouped && marker !== annotation.markers[0]) continue;
      ctx.fillStyle = strong ? palette.markerLabelStrong : palette.markerLabelWeak;
      ctx.textAlign = 'center';
      ctx.fillText(marker.label, marker.labelX, marker.row * lineHeight + 2 * dpr);
    }
    ctx.textAlign = 'left';

    // Decade rules for orientation.
    ctx.strokeStyle = palette.grid;
    ctx.fillStyle = palette.axisText;
    ctx.lineWidth = dpr;
    for (const freq of [100, 1000, 10000]) {
      const x = Math.round(freqToX(freq, width)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, height - 14 * dpr);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.fillText(freq >= 1000 ? `${freq / 1000}k` : `${freq}`, x + 3 * dpr, height - 14 * dpr);
    }
  }
</script>

<div class="spectrum">
  <header>
    <h2>Spectrum</h2>
    <span class="hint">master bus · log scale</span>
  </header>
  <div class="canvas-host" bind:this={host}>
    <canvas bind:this={canvas}></canvas>
  </div>
  <p class="caption">{caption}</p>
</div>

<style>
  .spectrum {
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

  .hint {
    font-size: 11px;
    color: var(--text-faint);
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
