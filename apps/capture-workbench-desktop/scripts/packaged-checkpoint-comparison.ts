// Compares the checkpoint screenshots of a real-engine journey on the packaged
// Desktop App with their approved baselines (the spec's -snapshots folder).
import { existsSync } from 'node:fs';

import { expect, type Page, type TestInfo } from '@playwright/test';

import type { PackagedCheckpointComparison } from './packaged-journey-run.ts';
import { checkpointScreenshotMasks } from './packaged-workbench-session.ts';

export interface JourneyCheckpoint {
  readonly name: string;
  /** Matched with an approved baseline; otherwise saved for the reviewer only. */
  readonly compared: boolean;
}

export function comparedCheckpointNames(checkpoints: readonly JourneyCheckpoint[]): readonly string[] {
  return checkpoints.filter((checkpoint) => checkpoint.compared).map((checkpoint) => checkpoint.name);
}

/** Save the approval image Playwright omits when the baseline is absent. */
export async function captureMissingCheckpointBaseline(
  baseline: string,
  name: string,
  outputPath: (file: string) => string,
  save: (path: string) => Promise<unknown>,
): Promise<PackagedCheckpointComparison | undefined> {
  if (existsSync(baseline)) return undefined;
  await save(outputPath(`${name}-actual.png`));
  return { name, outcome: 'baseline missing' };
}

export interface JourneyCheckpointComparison {
  readonly outcomes: readonly PackagedCheckpointComparison[];
  readonly capture: (page: Page, name: string) => Promise<void>;
}

/** Collect outcomes while soft assertions let the journey reach every checkpoint. */
export function compareJourneyCheckpoints(
  checkpoints: readonly JourneyCheckpoint[],
  testInfo: TestInfo,
): JourneyCheckpointComparison {
  const known = new Map(checkpoints.map((checkpoint) => [checkpoint.name, checkpoint.compared]));
  const outcomes: PackagedCheckpointComparison[] = [];
  const capture: JourneyCheckpointComparison['capture'] = async (page, name) => {
    const compared = known.get(name);
    if (compared === undefined) throw new Error(`Unknown journey checkpoint: ${name}`);
    if (!compared) return;
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation: none !important;
          transition: none !important;
          caret-color: transparent !important;
        }
      `,
    });
    const screenshotOptions = {
      animations: 'disabled',
      caret: 'hide',
      fullPage: false,
      mask: checkpointScreenshotMasks(page),
      scale: 'css',
    } as const;
    const filename = `${name}.png`;
    const baseline = testInfo.snapshotPath(filename, { kind: 'screenshot' });
    const missing = await captureMissingCheckpointBaseline(
      baseline,
      name,
      (file) => testInfo.outputPath(file),
      (path) => page.screenshot({ ...screenshotOptions, path }),
    );
    if (missing) {
      outcomes.push(missing);
      return;
    }

    const errorsBefore = testInfo.errors.length;
    await expect.soft(page).toHaveScreenshot(filename, screenshotOptions);
    const differed = testInfo.errors.length > errorsBefore;
    outcomes.push({ name, outcome: differed ? 'differed' : 'matched' });
  };
  return { capture, outcomes };
}
