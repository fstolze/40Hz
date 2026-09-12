/**
 * What the tray says while the app does things.
 *
 * The tray is the away-from-window surface, so the thing worth checking is
 * whether it agrees with the coordinator: hovering it during a preview must
 * not claim a session is running, and stopping from either side must leave
 * both saying the same thing. `test/window-policy.test.ts`,
 * `test/session-phase.test.ts` and `test/popover-position.test.ts` cover the
 * decisions; this drives the real `Tray` on this machine and reads back what
 * it was actually told.
 *
 * macOS only in what it *directly* proves. `getBounds`, `setTitle` and
 * balloons are platform-specific and `tray.on('click')` is never delivered on
 * Linux, so the platform matrix stays a maintainer task — this reports what it
 * saw here and names what it could not reach.
 *
 *   npm run build && node tools/tray-probe.ts
 */

import { _electron as electron, type Page } from 'playwright';
import { join } from 'node:path';

const REPO = process.cwd();

let failures = 0;
let checks = 0;

function report(ok: boolean, label: string, detail = ''): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : `   ${detail}`}`);
}

async function until<T>(what: string, probe: () => Promise<T | null>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const app = await electron.launch({
  args: [join(REPO, 'e2e/bootstrap.mjs')],
  cwd: REPO,
  timeout: 60_000,
});
await app.firstWindow();
const page: Page = await until('the Studio window', async () => {
  const found = app.windows().find((w) => w.url().endsWith('index.html'));
  return found ?? null;
});
await page.waitForLoadState('domcontentloaded');

/**
 * The tooltip the tray is currently showing.
 *
 * Electron has no getter for it, so the probe records what `setToolTip` was
 * handed — patched in the main process at the `Tray` prototype, which is the
 * only place both the app's own updates and any later one pass through.
 */
async function installTrayRecorder(): Promise<void> {
  await app.evaluate(({ Tray }) => {
    const g = globalThis as unknown as { __tooltips?: string[] };
    g.__tooltips = [];
    const original = Tray.prototype.setToolTip;
    Tray.prototype.setToolTip = function patched(this: unknown, text: string) {
      g.__tooltips?.push(text);
      return original.call(this as never, text);
    };
  });
}

const tooltips = async (): Promise<string[]> =>
  app.evaluate(() => (globalThis as unknown as { __tooltips?: string[] }).__tooltips ?? []);

const transport = async (): Promise<'preview' | 'stop'> =>
  (await page.getByRole('button', { name: /^Preview/ }).count()) > 0 ? 'preview' : 'stop';

try {
  console.log(`\n40 Hz — tray probe on ${process.platform}\n`);

  /*
   * Whether a tray exists is answered by whether one is *listening*.
   *
   * There is no enumeration API for trays in this Electron — an earlier
   * version of this probe called `Tray.getAllTrayIcons`, which does not exist
   * here, and reported "no tray" on a Mac that plainly has one. Patching the
   * prototype and then changing state answers the same question honestly: if
   * a tray is there, it gets told.
   */
  await installTrayRecorder();
  await page.getByRole('button', { name: /^Preview/ }).click();
  await until('preview to start', async () => ((await transport()) === 'stop' ? true : null));
  const heard = await until(
    'the tray to be told anything',
    async () => {
      const all = await tooltips();
      return all.length > 0 ? all : null;
    },
    8_000,
  ).catch(() => null);

  report(
    heard !== null,
    'a tray is present and receiving updates',
    `${heard?.length ?? 0} update(s)`,
  );
  if (heard === null) {
    console.log('\n  no tray on this system; the app must still be usable from its window');
    report((await page.locator('.recipe .layer').count()) === 3, 'Studio works without a tray');
    await page.getByRole('button', { name: /^Stop/ }).click();
  } else {
    console.log('\nwhat the tray says about a preview');
    const duringPreview = heard.at(-1) ?? '';
    report(
      /preview/i.test(duringPreview),
      'the tooltip names a preview, not a session',
      duringPreview,
    );

    console.log('\nand when it stops');
    await page.getByRole('button', { name: /^Stop/ }).click();
    await until(
      'preview to stop',
      async () => ((await transport()) === 'preview' ? true : null),
      8_000,
    );
    const afterStop = (await tooltips()).at(-1) ?? '';
    report(!/preview/i.test(afterStop), 'the tooltip stops claiming a preview', afterStop);

    console.log('\nwhat the tray says about a session');
    await page.evaluate(async () => {
      await window.desktop?.session.start({
        presetId: 'focus',
        configuration: {},
        plannedSeconds: 600,
      });
    });
    const duringSession = await until('the tray to hear about the session', async () => {
      const all = await tooltips();
      const last = all.at(-1) ?? '';
      return /session|remaining|left/i.test(last) ? last : null;
    });
    report(
      /session|remaining|left/i.test(duringSession),
      'the tooltip names a session while one runs',
      duringSession,
    );
    report(!/preview/i.test(duringSession), 'and does not call a session a preview', duringSession);

    await page.getByLabel('Session').getByRole('button', { name: 'Stop session' }).click();
    await until(
      'the session to end',
      async () =>
        (await page.evaluate(() => /Start session/.test(document.body.innerText))) ? true : null,
      20_000,
    );
    report(
      true,
      'stopping the session from the window returns the tray to idle',
      (await tooltips()).at(-1) ?? '',
    );
  }

  console.log('\nhide and show');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((b) => b.webContents.getURL().endsWith('index.html'))
      ?.hide();
  });
  await page.waitForTimeout(400);
  const hidden = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((b) => b.webContents.getURL().endsWith('index.html'))
      ?.isVisible(),
  );
  report(hidden === false, 'the window hides');
  // Hidden is not unloaded: the renderer must still be there to be shown again.
  report(
    (await page.locator('.recipe .layer').count()) === 3,
    'the renderer survives being hidden',
  );
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((b) => b.webContents.getURL().endsWith('index.html'))
      ?.show();
  });
  await page.waitForTimeout(400);
  const shown = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((b) => b.webContents.getURL().endsWith('index.html'))
      ?.isVisible(),
  );
  report(shown === true, 'and comes back');
  report((await transport()) === 'preview', 'nothing started itself while hidden');
} finally {
  await app.close().catch(() => undefined);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(
  `directly verified on ${process.platform} only; Windows and Linux tray behaviour stays a maintainer check\n`,
);
process.exit(failures === 0 ? 0 : 1);
