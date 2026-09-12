/**
 * Scripted drags against the real build, measuring main-thread jank.
 *
 * Block B of the ear test reported stuttering that appears only after a while,
 * on four controls that share no audio path — Master does not touch the notch
 * chain at all. A degradation common to all four is not a filter problem, so
 * this measures the thing they do share: the renderer's work per input event.
 *
 *   npm run build && node tools/jank-probe.ts [--label main]
 */
import { _electron as electron, type Page } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const at = process.argv.indexOf('--label');
const LABEL = at === -1 ? 'head' : (process.argv[at + 1] ?? 'head');

/** Each control, and how far to sweep it. */
const CONTROLS = ['Master', 'Soundscape level', 'Entrainment level', 'Duty'];
/** Long enough for "after a while" to happen. */
const SECONDS = 24;

async function main(): Promise<void> {
  const app = await electron.launch({
    args: [join(REPO, 'e2e/bootstrap.mjs')],
    cwd: REPO,
    timeout: 30_000,
  });
  await app.firstWindow();
  let studio: Page | null = null;
  for (let i = 0; i < 100 && studio === null; i += 1) {
    studio = app.windows().find((w) => w.url().endsWith('index.html')) ?? null;
    if (studio === null) await new Promise((r) => setTimeout(r, 200));
  }
  if (studio === null) throw new Error('Studio never appeared');
  await studio.waitForLoadState('domcontentloaded');
  await studio.waitForTimeout(1500);

  // Preview on, so the audio graph is actually running.
  await studio.getByRole('button', { name: /Preview/ }).click();
  await studio.waitForTimeout(2500);

  for (const label of CONTROLS) {
    const result = await studio.evaluate(
      async ({ name, seconds }) => {
        // Master is `<label for="master">` in the header, not a `.row` label,
        // so both shapes have to be matched — and Master is the one control in
        // this block that touches neither the parameters nor the notch chain,
        // which makes it the most diagnostic of the four.
        const input = Array.from(document.querySelectorAll<HTMLInputElement>('input')).find(
          (el) => {
            const row = el.closest('.row')?.querySelector('label')?.textContent?.trim();
            const forLabel = el.id
              ? document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim()
              : undefined;
            return row === name || forLabel === name || el.getAttribute('aria-label') === name;
          },
        );
        if (!input) return { error: `no control named ${name}` };

        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        const min = Number(input.min || 0);
        const max = Number(input.max || 1);

        const longTasks: number[] = [];
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration);
        });
        try {
          observer.observe({ entryTypes: ['longtask'] });
        } catch {
          /* not supported; frame gaps still tell the story */
        }

        const frameGaps: number[] = [];
        const heap = () =>
          (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
            ?.usedJSHeapSize ?? 0;
        const heapStart = heap();

        // Halves, so "early" and "late" can be compared within one run.
        const start = performance.now();
        const end = start + seconds * 1000;
        let last = start;
        let i = 0;
        const early: number[] = [];
        const late: number[] = [];

        await new Promise<void>((resolve) => {
          const step = (now: number) => {
            frameGaps.push(now - last);
            (now - start < (seconds * 1000) / 2 ? early : late).push(now - last);
            last = now;
            // A slow sweep: ~2.5 s per traverse, which is how a person moves a
            // slider deliberately.
            const t = (now - start) / 2500;
            const value = min + (max - min) * (0.5 - 0.5 * Math.cos(t * Math.PI * 2));
            setter?.call(input, String(value));
            input.dispatchEvent(new Event('input', { bubbles: true }));
            i += 1;
            if (now < end) requestAnimationFrame(step);
            else resolve();
          };
          requestAnimationFrame(step);
        });
        observer.disconnect();

        const worst = (xs: number[]) => Math.round(Math.max(...xs));
        const over = (xs: number[], ms: number) => xs.filter((x) => x > ms).length;
        return {
          name,
          changes: i,
          heapGrowthMB: Math.round(((heap() - heapStart) / 1048576) * 10) / 10,
          longTasks: longTasks.length,
          longTaskMs: Math.round(longTasks.reduce((a, b) => a + b, 0)),
          worstFrameEarly: worst(early),
          worstFrameLate: worst(late),
          framesOver50msEarly: over(early, 50),
          framesOver50msLate: over(late, 50),
        };
      },
      { name: label, seconds: SECONDS },
    );
    console.log(LABEL, JSON.stringify(result));
    await studio.waitForTimeout(1000);
  }

  await app.close();
}

await main();
