import { expect, test } from '@playwright/test';

test('lists the three preview scenarios on /__preview', async ({ page }) => {
  await page.goto('/__preview');

  await expect(page.locator('a[href="/?scenario=ready"]')).toBeVisible();
  await expect(page.locator('a[href="/?scenario=first-run"]')).toBeVisible();
  await expect(page.locator('a[href="/?scenario=no-gpu"]')).toBeVisible();
});

test('serves the ready scenario with shell navigation, OCR dropzone, and history', async ({ page }) => {
  await page.goto('/?scenario=ready');

  const nav = page.getByRole('navigation', { name: '主要功能' });
  await expect(nav).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: '文件轉文字' })).toBeVisible();
  await expect(page.getByTestId('ocr-dropzone')).toBeVisible();

  await nav.getByRole('link', { name: '紀錄' }).click();
  await expect(page).toHaveURL(/\/history$/u);
  await expect(page.getByText('history.pdf')).toBeVisible();
});

test('shows first-run install progress on ?scenario=first-run&speed=20 and remembers the scenario across reloads', async ({ page }) => {
  await page.goto('/?scenario=first-run&speed=20');

  const card = page.getByTestId('first-run-card');
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: '要安裝哪些辨識功能？' })).toBeVisible();

  await card.getByTestId('first-run-install').click();
  await expect(page.getByTestId('ocr-install-progress')).toBeVisible();
  await expect(page.getByTestId('ocr-dropzone')).toBeVisible({ timeout: 15_000 });

  await page.reload();
  await expect(page.getByTestId('first-run-card')).toBeVisible();
});

test('returns 400 for an unknown preview scenario', async ({ page }) => {
  const response = await page.request.get('/?scenario=nope');
  expect(response.status()).toBe(400);
});
