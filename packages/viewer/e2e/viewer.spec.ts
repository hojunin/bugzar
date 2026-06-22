import { expect, test } from '@playwright/test';

// Same-origin endpoint: serve.mjs serves the fixtures under /reports/* on baseURL.
const ENDPOINT = 'http://localhost:4373';

test('session report: replay mounts + console error + network 500 + scrubber marker', async ({
  page,
}) => {
  await page.goto(`/?endpoint=${encodeURIComponent(ENDPOINT)}&id=session-demo`);

  // (a) the rrweb replay iframe mounts
  await expect(page.locator('.bugzarv-replay iframe')).toBeAttached();

  // (b) the Console tab (default) shows the captured error
  await expect(page.getByText(/payment declined/)).toBeVisible();

  // (c) the Network tab shows the failed request
  await page.getByRole('tab', { name: /network/i }).click();
  await expect(page.getByText('/api/checkout')).toBeVisible();
  await expect(page.getByText('500')).toBeVisible();

  // (c2) expanding the row reveals the General / Request / Response sections
  await page.getByRole('button', { name: /\/api\/checkout/ }).click();
  await expect(page.getByText('General')).toBeVisible();
  await expect(page.getByText('Request', { exact: true })).toBeVisible();
  await expect(page.getByText('Response', { exact: true })).toBeVisible();
  await expect(page.getByText(/Card was declined by issuer/)).toBeVisible();

  // (d) the scrubber carries an error marker per notable moment (console + network)
  await expect(page.locator('[data-testid="bugzarv-marker"]')).toHaveCount(2);
});

test('design report: annotation cards render', async ({ page }) => {
  await page.goto(`/?endpoint=${encodeURIComponent(ENDPOINT)}&id=design-demo`);

  await expect(page.getByText('.btn-buy')).toBeVisible();
  await expect(page.getByText(/wrong color/)).toBeVisible();
  await expect(page.getByText('.price')).toBeVisible();
  await expect(page.getByText(/BuyButton/)).toBeVisible();
});
