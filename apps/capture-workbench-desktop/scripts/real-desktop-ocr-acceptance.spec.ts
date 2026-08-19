import { expect, test } from '@playwright/test';

import { main } from './real-desktop-ocr-smoke.ts';

test('real Capture Workbench WebView2 golden journey matches approved screenshots', async () => {
  await main({
    checkpoint: async (page, name) => {
      // Installation has an intentionally moving progress indicator. Keep its
      // artifact for the journey, but only diff visual checkpoints after the
      // UI has reached a stable state.
      if (name === '01-core-install-started' || name === '02-document-processing') return;
      await page.addStyleTag({
        content: `
          *, *::before, *::after {
            animation: none !important;
            transition: none !important;
            caret-color: transparent !important;
          }
        `,
      });
      await expect(page).toHaveScreenshot(`${name}.png`, {
        animations: 'disabled',
        fullPage: false,
        mask: [
          page.locator('time'),
          page.locator('.dynamic-id'),
          page.locator('.document-copy strong'),
          page.locator('.detail-heading h2'),
          page.locator('.detail-heading p:last-child'),
          page.locator('.review-block pre'),
          page.locator('.provenance dd'),
        ],
      });
    },
  });
});
