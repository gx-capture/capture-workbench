// The localhost preview (preview-server.ts): the dev server behind a proxy that
// supplies the simulated desktop backend. These tests never install the fake
// themselves; the page works only when the server injected it.
import { expect, test, type Locator, type Page } from '@playwright/test';

function ocrFirstRunOption(page: Page) {
  return page.locator('[data-testid="first-run-option"][data-requirement-id="text-recognition"]');
}

async function observeInstallProgress(progressContainer: Locator): Promise<void> {
  const label = progressContainer.getByTestId('install-progress-label');

  // Within the 2000 ms startDelay (before the fake answers), progress is already
  // visible and says 「正在準備安裝…」; a 1000 ms timeout proves it cannot wait
  // for runtime_start_installation to resolve.
  await expect(progressContainer).toBeVisible({ timeout: 1000 });
  await expect(label).toHaveText('正在準備安裝…', { timeout: 1000 });

  let maxPercent = -1;
  let sawInstalling = false;

  await expect
    .poll(
      async () => {
        const snapshot = await progressContainer.evaluateAll((els) => {
          const el = els[0];
          if (!el) return null;
          const labelEl = el.querySelector('[data-testid="install-progress-label"]');
          const barEl = el.querySelector('[data-testid="install-progress-bar"]');
          return {
            phase: barEl?.getAttribute('data-phase') ?? null,
            text: (labelEl?.textContent ?? '').trim(),
          };
        });
        if (snapshot === null) {
          return true;
        }
        if (snapshot.phase === 'downloading') {
          const match = /^正在下載 (\d+)%$/u.exec(snapshot.text);
          if (match) {
            const percent = Number(match[1]);
            if (percent < maxPercent) {
              throw new Error(
                `Displayed percentage decreased from ${maxPercent}% to ${percent}%`,
              );
            }
            maxPercent = percent;
          }
        } else if (
          snapshot.phase === 'installing' &&
          snapshot.text === '下載完成，正在安裝…'
        ) {
          sawInstalling = true;
        }
        return false;
      },
      { timeout: 25_000, intervals: [150] },
    )
    .toBe(true);

  expect(maxPercent).toBeGreaterThanOrEqual(0);
  expect(sawInstalling).toBe(true);
}

test('lists the three preview scenarios on /__preview', async ({ page }) => {
  await page.goto('/__preview');

  await expect(page.locator('a[href="/?scenario=ready"]')).toBeVisible();
  await expect(page.locator('a[href="/?scenario=first-run"]')).toBeVisible();
  await expect(page.locator('a[href="/?scenario=no-gpu"]')).toBeVisible();
});

test('serves the ready scenario with shell navigation, OCR dropzone, and history', async ({ page }) => {
  await page.goto('/?scenario=ready');

  const nav = page.getByRole('navigation', { name: '主要功能' });
  await expect(nav.getByTestId('runtime-status')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('heading', { level: 1, name: '文件轉文字' })).toBeVisible();
  await expect(page.getByTestId('ocr-dropzone')).toBeVisible();
  await expect(page.getByTestId('first-run-card')).toHaveCount(0);

  await nav.getByRole('link', { name: '紀錄' }).click();
  await expect(page).toHaveURL(/\/history$/u);
  await expect(page.getByText('history.pdf')).toBeVisible();
});

test('runs a first-run installation through its phases and starts over after a reload', async ({ page }) => {
  // speed=4: two seconds of preparing become half a second, the download five
  // seconds, the installation one and a half.
  await page.goto('/?scenario=first-run&speed=4');

  const card = page.getByTestId('first-run-card');
  await expect(card.getByRole('heading', { name: '要安裝哪些辨識功能？' })).toBeVisible();
  await expect(ocrFirstRunOption(page)).toBeVisible();

  await card.getByTestId('first-run-install').click();
  const progress = page.getByTestId('ocr-install-progress');
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute('data-requirement-id', 'text-recognition');
  await expect(progress).toHaveCount(0, { timeout: 30_000 });

  await page.getByRole('navigation', { name: '主要功能' }).getByRole('link', { name: '設定' }).click();
  await expect(
    page.locator('[data-testid="engine-row"][data-requirement-id="text-recognition"]'),
  ).toHaveAttribute('data-status', 'ready');

  // A load without the query keeps the scenario (cookie) and what the
  // application remembered: the simulated machine starts again with nothing
  // installed, and the card that was answered stays away.
  await page.goto('/settings/engines');
  await expect(
    page.locator('[data-testid="engine-row"][data-requirement-id="text-recognition"]'),
  ).toHaveAttribute('data-status', 'installable');
  await page.goto('/ocr');
  await expect(page.getByTestId('ocr-dropzone')).toBeVisible();
  await expect(page.getByTestId('first-run-card')).toHaveCount(0);

  // The scenario's link is a fresh start: the card is back.
  await page.goto('/?scenario=first-run');
  await expect(ocrFirstRunOption(page)).toBeVisible();
});

test('a route loaded after a scenario change shows the new scenario, not a stored page', async ({ page }) => {
  await page.goto('/?scenario=first-run');
  await expect(page.getByTestId('first-run-card')).toBeVisible();
  await page.goto('/ocr');
  await expect(page.getByTestId('first-run-card')).toBeVisible();

  await page.goto('/?scenario=ready');
  await expect(page.getByTestId('ocr-dropzone')).toBeVisible();
  await page.goto('/ocr');
  await expect(page.getByTestId('ocr-dropzone')).toBeVisible();
  await expect(page.getByTestId('first-run-card')).toHaveCount(0);
});

test('shows preparing immediately and monotonic progress on the /ocr first-run card', async ({ page }) => {
  await page.goto('/?scenario=first-run&speed=4&startDelay=2000');

  const card = page.getByTestId('first-run-card');
  await expect(card).toBeVisible();
  await card.getByTestId('first-run-install').click();

  await observeInstallProgress(page.getByTestId('ocr-install-progress'));

  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('ocr-dropzone')).toContainText('支援 PDF、PNG、JPG，單檔最大 50 MiB');
});

test('shows preparing immediately and monotonic progress on the /settings/engines row', async ({ page }) => {
  await page.goto('/?scenario=first-run&speed=4&startDelay=2000');
  await page.goto('/settings/engines');

  const row = page.locator('[data-testid="engine-row"][data-requirement-id="text-recognition"]');
  await expect(row).toHaveAttribute('data-status', 'installable');
  await row.getByTestId('engine-row-install').click();

  await observeInstallProgress(row.getByTestId('engine-row-progress'));

  await expect(row).toHaveAttribute('data-status', 'ready');
  await expect(row.getByTestId('engine-row-status')).toContainText('已安裝');
  await expect(row.getByTestId('engine-row-remove')).toBeVisible();
});

test('shows preparing immediately and monotonic progress on the /asr engine card', async ({ page }) => {
  await page.goto('/?scenario=first-run&speed=4&startDelay=2000');
  await page.goto('/asr');

  const card = page.locator('[data-testid="engine-card"][data-requirement-id="speech-recognition"]');
  await expect(card).toHaveAttribute('data-status', 'installable');
  await card.getByTestId('engine-card-install').click();

  await observeInstallProgress(card.getByTestId('engine-card-progress'));

  await expect(page.getByTestId('asr-dropzone')).toBeVisible();
  await expect(page.getByTestId('asr-install-panel')).toHaveCount(0);
});

test('answers 400 for an unknown scenario, an invalid speed, or an invalid startDelay', async ({ page }) => {
  expect((await page.request.get('/?scenario=nope')).status()).toBe(400);
  expect((await page.request.get('/?speed=0')).status()).toBe(400);
  expect((await page.request.get('/?startDelay=-1')).status()).toBe(400);
  expect((await page.request.get('/?startDelay=abc')).status()).toBe(400);
});

async function assertPurposeFitsTwoLines(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      page.getByTestId('engine-row-purpose').evaluateAll((elements) =>
        elements.length === 3 &&
        elements.every((el) => {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const parsedLineHeight = Number.parseFloat(style.lineHeight);
          const fontSize = Number.parseFloat(style.fontSize);
          const lineHeight = Number.isFinite(parsedLineHeight)
            ? parsedLineHeight
            : fontSize * 1.5;
          return rect.height > 0 && rect.height <= lineHeight * 2 + 4;
        }),
      ),
    )
    .toBe(true);
}

async function assertDesktopEnginesLayout(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await assertPurposeFitsTwoLines(page);

  await expect
    .poll(async () =>
      page.getByTestId('engine-row-purpose').evaluateAll((elements) =>
        elements.length === 3 &&
        elements.every((el) => el.getBoundingClientRect().width >= 150),
      ),
    )
    .toBe(true);

  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

test('keeps engine purpose readable without horizontal overflow on /settings/engines', async ({ page }) => {
  for (const scenario of ['first-run', 'ready'] as const) {
    await page.goto(`/?scenario=${scenario}`);
    await page.goto('/settings/engines');
    await expect(page.getByTestId('engine-row')).toHaveCount(3);

    await assertDesktopEnginesLayout(page);

    await page.setViewportSize({ width: 1024, height: 768 });
    await assertPurposeFitsTwoLines(page);
  }
});
