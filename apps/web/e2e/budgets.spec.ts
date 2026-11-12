// A11Y-03 target size, PERF-01 local action latency, PERF-05 shell load from the SW cache, PERF-06 bundle size
// (design.md §10.5, §12.7, §13.4). Measured on this machine's browsers, not the reference tablet.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { configureBeds, resetDb, setUpTablet, startApi, stopApi, swReady, unlock } from './support.ts';

test.beforeEach(async () => {
  await stopApi();
  await resetDb();
  await startApi();
});
test.afterAll(stopApi);

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1] ?? NaN;

/** Every visible control is at least 48 × 48 CSS px (glove-friendly, above WCAG 2.5.8). */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button, a[href], input, select')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width < 48 || r.height < 48)
      .map(({ el, r }) => `${el.tagName} "${el.getAttribute('aria-label') ?? el.textContent?.trim()}" ${Math.round(r.width)}×${Math.round(r.height)}`),
  );
}

test('A11Y-03: every control is at least 48 × 48 px', async ({ page }) => {
  await page.goto('/');
  expect(await smallTargets(page)).toEqual([]); // enroll
  await setUpTablet(page);
  expect(await smallTargets(page)).toEqual([]); // board, header, nav
  await configureBeds(page, 4);
  await page.getByRole('button', { name: 'Bed 1, empty' }).click();
  expect(await smallTargets(page)).toEqual([]); // bed sheet
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Lock' }).click();
  expect(await smallTargets(page)).toEqual([]); // PIN pad
});

test('PERF-01: a local change shows on the board in under 100 ms (p95)', async ({ page }, info) => {
  await setUpTablet(page);
  await configureBeds(page, 20);
  const samples: number[] = [];
  for (let bed = 1; bed <= 20; bed++) {
    const label = `Perf ${bed}`;
    await page.getByRole('button', { name: `Bed ${bed}, empty` }).click();
    await page.getByLabel('Patient name label').fill(label);
    // Timed inside the page: from the tap to the bed card's new name being in the DOM.
    samples.push(
      await page.evaluate(
        ([bedNo, name]) =>
          new Promise<number>((resolve) => {
            const button = [...document.querySelectorAll('button')].find((b) => b.textContent === `Admit to bed ${bedNo}`);
            const t0 = performance.now();
            const done = () => [...document.querySelectorAll('li button')].some((b) => b.getAttribute('aria-label')?.startsWith(`Bed ${bedNo}, ${name},`));
            const mo = new MutationObserver(() => done() && (mo.disconnect(), resolve(performance.now() - t0)));
            mo.observe(document.body, { subtree: true, childList: true, attributes: true });
            button?.click();
          }),
        [bed, label] as const,
      ),
    );
  }
  const result = p95(samples);
  info.annotations.push({ type: 'PERF-01 p95 ms', description: result.toFixed(1) });
  console.log(`PERF-01 ${info.project.name}: p95 ${result.toFixed(1)} ms, max ${Math.max(...samples).toFixed(1)} ms`);
  expect(result).toBeLessThan(100);
});

test('PERF-05: the app shell from the service worker cache paints in under 1.5 s (LCP)', async ({ page, browserName }, info) => {
  test.skip(browserName !== 'chromium', 'largest-contentful-paint is only exposed in Chromium');
  await setUpTablet(page);
  await swReady(page);
  await page.reload(); // now served by the service worker
  const lcp = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        new PerformanceObserver((list) => resolve(list.getEntries().at(-1)?.startTime ?? NaN)).observe({ type: 'largest-contentful-paint', buffered: true });
      }),
  );
  const fromSw = await page.evaluate(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).workerStart > 0);
  info.annotations.push({ type: 'PERF-05 LCP ms', description: lcp.toFixed(0) });
  console.log(`PERF-05 chromium: LCP ${lcp.toFixed(0)} ms, served by service worker: ${fromSw}`);
  expect(fromSw).toBe(true);
  expect(lcp).toBeLessThan(1500);
  await unlock(page);
});

test('PERF-06: initial JS ≤ 200 KB and CSS ≤ 30 KB gzipped', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'same build for every browser');
  const dist = new URL('../dist/', import.meta.url);
  const html = readFileSync(new URL('index.html', dist), 'utf8');
  const size = (re: RegExp) => [...html.matchAll(re)].reduce((n, m) => n + gzipSync(readFileSync(new URL(`.${m[1]}`, dist))).length, 0);
  const js = size(/<script[^>]+src="([^"]+)"/g);
  const css = size(/<link rel="stylesheet"[^>]+href="([^"]+)"/g);
  console.log(`PERF-06: JS ${(js / 1024).toFixed(1)} KB gzip, CSS ${(css / 1024).toFixed(1)} KB gzip`);
  expect(js).toBeLessThanOrEqual(200 * 1024);
  expect(css).toBeLessThanOrEqual(30 * 1024);
});
