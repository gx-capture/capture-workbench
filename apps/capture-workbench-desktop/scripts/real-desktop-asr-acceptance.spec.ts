// Playwright wrapper for the real speech recognition journey on the packaged
// Desktop App (real-desktop-asr-journey.ts), in acceptance or baseline review
// mode. Each compared checkpoint of ASR_JOURNEY_CHECKPOINTS is matched with its
// approved baseline in real-desktop-asr-acceptance.spec.ts-snapshots/.
import { test } from '@playwright/test';

import { compareJourneyCheckpoints } from './packaged-checkpoint-comparison.ts';
import { assertPackagedSnapshotsAreNotUpdated } from './packaged-journey-run.ts';
import { ASR_JOURNEY_CHECKPOINTS, main } from './real-desktop-asr-journey.ts';

test('real speech recognition journey on the packaged Desktop App matches approved screenshots', async () => {
  const testInfo = test.info();
  assertPackagedSnapshotsAreNotUpdated(testInfo.config.updateSnapshots);
  // A cold speech install downloads about 10.5 GB before the first recording.
  test.setTimeout(3 * 60 * 60 * 1000);
  await main({ comparison: compareJourneyCheckpoints(ASR_JOURNEY_CHECKPOINTS, testInfo) });
});
