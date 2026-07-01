import { expect, test } from '@playwright/test';

const ENDPOINT = 'http://localhost:4373';

// Repro for "replay cropped on the right": capture viewport is 1280 (fixture),
// the player container is narrower, so the replay must be scaled to FIT. Measure
// the mount box vs its scroll container — if the box is wider, it overflows/crops.
test('replay fits its container (no right crop)', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(`/?endpoint=${encodeURIComponent(ENDPOINT)}&id=session-demo`);
  await expect(page.locator('.bugzarv-replay iframe')).toBeAttached();
  await page.waitForTimeout(600); // let ResizeObserver + late rrweb sizing settle

  const m = await page.evaluate(() => {
    const scroll = document.querySelector('.bugzarv-replay-scroll') as HTMLElement | null;
    const iframe = document.querySelector('.bugzarv-replay iframe') as HTMLElement | null;
    return {
      scrollClientW: scroll?.clientWidth ?? -1,
      // RENDERED width (reflects the wrapper transform) — the true fit signal;
      // NOT fooled by overflow:hidden on the mount box.
      iframeRenderedW: Math.round(iframe?.getBoundingClientRect().width ?? -1),
    };
  });
  console.log('CROP-MEASURE', JSON.stringify(m));

  // The replayed page must be scaled to FIT — its rendered width must not exceed
  // the visible viewport (else it's clipped on the right). Regression guard for
  // the "scale from recorded viewport, not wrapper.offsetWidth" fix.
  expect(m.iframeRenderedW).toBeGreaterThan(0);
  expect(m.iframeRenderedW).toBeLessThanOrEqual(m.scrollClientW + 2);
});
