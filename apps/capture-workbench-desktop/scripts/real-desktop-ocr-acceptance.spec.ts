// Playwright wrapper for the real OCR journey on the packaged Desktop App
// (real-desktop-ocr-smoke.ts), in acceptance or baseline review mode. Every
// compared checkpoint of DESKTOP_OCR_CHECKPOINTS is matched with its approved
// baseline in real-desktop-ocr-acceptance.spec.ts-snapshots/; which ones are
// compared, and that no baseline is left without a checkpoint, is pinned in
// packaged-checkpoints.test.ts.
import { test } from '@playwright/test';

import { compareJourneyCheckpoints } from './packaged-checkpoint-comparison.ts';
import { assertPackagedSnapshotsAreNotUpdated } from './packaged-journey-run.ts';
import { DESKTOP_OCR_CHECKPOINTS, main } from './real-desktop-ocr-smoke.ts';

test('real Capture Workbench WebView2 golden journey matches approved screenshots', async () => {
  const testInfo = test.info();
  assertPackagedSnapshotsAreNotUpdated(testInfo.config.updateSnapshots);
  await main({ comparison: compareJourneyCheckpoints(DESKTOP_OCR_CHECKPOINTS, testInfo) });
});
