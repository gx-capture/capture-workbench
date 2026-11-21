// The localhost preview (preview-server.ts): the dev server behind a proxy that
// supplies the simulated desktop backend. These tests never install the fake
// themselves; the page works only when the server injected it.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { previewScenarioConfig } from './preview-scenarios.ts';

function ocrFirstRunOption(page: Page) {
  return page.locator('[data-testid="first-run-option"][data-requirement-id="text-recognition"]');
}

/** What the page asked the simulated desktop backend so far (`installFakeDesktop` records it). */
async function fakeDesktopLog(page: Page): Promise<{
  readonly commands: readonly string[];
  readonly startedRequirementIds: readonly string[];
}> {
  return page.evaluate(() => {
    const target = globalThis as unknown as {
      readonly __captureInvokedCommands: readonly string[];
      readonly __captureStartedRequirementIds: readonly string[];
    };
    return {
      commands: [...target.__captureInvokedCommands],
      startedRequirementIds: [...target.__captureStartedRequirementIds],
    };
  });
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

test('links the ready, first-run and no-gpu scenarios on /__preview', async ({ page }) => {
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

test('stops the install queue when the user cancels while the runtime is still looking up a lost installation', async ({ page }) => {
  // The first status request of every installation answers "not found" and the
  // listing that resolves it takes 15 s to answer: the cancel must not wait for it.
  await page.goto('/?scenario=install-status-not-found-slow-listing');

  // Text recognition, then speech recognition: a queue of two.
  await page.getByTestId('first-run-checkbox-asr').check();
  await page.getByTestId('first-run-install').click();

  // The listing is pending once one was asked after the status request that answered 404.
  await expect
    .poll(
      async () => {
        const { commands } = await fakeDesktopLog(page);
        const firstStatusRequest = commands.indexOf('runtime_get_installation');
        return (
          firstStatusRequest >= 0 &&
          commands.indexOf('runtime_list_installations', firstStatusRequest) >= 0
        );
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  await page.getByTestId('ocr-install-cancel').click();

  // Far sooner than the listing answers, the card is gone and the next requirement never started.
  await expect(page.getByTestId('ocr-install-progress')).toHaveCount(0, { timeout: 5_000 });
  const { commands, startedRequirementIds } = await fakeDesktopLog(page);
  expect(commands).toContain('runtime_cancel_installation');
  expect(startedRequirementIds).toEqual(['text-recognition']);
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

// Sentences published one revision at a time by the recording journey in fake-desktop.ts.
const LIVE_TRANSCRIPT_LINES = [
  '這是第一句虛構逐字稿。',
  '這是第二句虛構逐字稿。',
  '這是第三句虛構逐字稿。',
] as const;
// The test holds revisions itself, so the speed only sets how long the
// unheld steps take; the waits below follow it.
const LIVE_TRANSCRIPT_SPEED = 1;
const LIVE_TRANSCRIPT_STEP_MS = previewScenarioConfig(
  'live-transcript',
  LIVE_TRANSCRIPT_SPEED,
  'synthetic-runtime-version',
  '',
).installOptions.installTimeline?.preparingMs ?? 0;
/** A wait that covers `steps` steps of the simulated runtime, plus a fixed margin. */
const liveTranscriptWaitMs = (steps: number): number => steps * LIVE_TRANSCRIPT_STEP_MS + 10_000;

/** Queue status, live-card lines, and completed empty event polls, read in one page turn. */
async function liveTranscriptSnapshot(page: Page, documentId: string): Promise<{
  readonly status: string | null;
  readonly lines: readonly string[];
  readonly emptyPolls: number;
}> {
  return page.evaluate((id) => {
    const row = document.querySelector(`[data-testid="asr-queue-row"][data-document-id="${id}"]`);
    const card = document.querySelector(`[data-testid="asr-live-card"][data-document-id="${id}"]`);
    const lines = [...(card?.querySelectorAll('[data-testid="asr-live-line"] p') ?? [])].map(
      (node) => (node.textContent ?? '').replace(/\s+/gu, ' ').trim(),
    );
    const emptyPolls = (
      globalThis as unknown as { readonly __captureRecordingEmptyEventPolls?: number }
    ).__captureRecordingEmptyEventPolls ?? 0;
    return { status: row?.getAttribute('data-user-status') ?? null, lines, emptyPolls };
  }, documentId);
}

/** Holds the simulated runtime's partial revisions from `fromRevision` on (null: none). */
async function holdRevisionsFrom(page: Page, fromRevision: number | null): Promise<void> {
  await page.evaluate((revision) => {
    const hold = (globalThis as unknown as {
      readonly __captureRecordingHold?: (fromRevision: number | null) => void;
    }).__captureRecordingHold;
    if (!hold) throw new Error('The simulated backend has no recording journey.');
    hold(revision);
  }, fromRevision);
}

/**
 * While the next revision is held, waits for two events polls that found
 * nothing new to complete (the second starts only after the Workbench handled
 * the first) and checks every sample in between: the card keeps exactly the
 * shown lines and the capture is still processing.
 */
async function expectCardKeptThroughEmptyPolls(
  page: Page,
  documentId: string,
  shown: readonly string[],
): Promise<void> {
  const before = (await liveTranscriptSnapshot(page, documentId)).emptyPolls;
  const departures: string[] = [];
  await expect.poll(async () => {
    const { status, lines, emptyPolls } = await liveTranscriptSnapshot(page, documentId);
    if (status !== 'processing' || JSON.stringify(lines) !== JSON.stringify(shown)) {
      departures.push(`${String(status)}: ${JSON.stringify(lines)}`);
    }
    return emptyPolls - before;
  }, { timeout: liveTranscriptWaitMs(1), intervals: [100] }).toBeGreaterThanOrEqual(2);
  expect(departures).toEqual([]);
}

/** The capture's events from the simulated runtime, read twice to resume after a cursor. */
async function recordingEventLog(page: Page, documentId: string): Promise<{
  readonly all: readonly (readonly [number, string, number | null])[];
  readonly resumed: readonly number[];
  readonly afterLast: number;
}> {
  return page.evaluate(async (id) => {
    interface Event { readonly sequence: number; readonly eventType: string; readonly partialRevision?: number | null }
    const { invoke } = (globalThis as unknown as {
      readonly __TAURI_INTERNALS__: { readonly invoke: (command: string, args?: unknown) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const detail = await invoke('library_get', { request: { documentId: id } }) as { readonly captureId?: string };
    const captureId = String(detail.captureId);
    const events = async (lastEventId: number | null): Promise<readonly Event[]> => (
      await invoke('runtime_get_capture_events', { input: { id: captureId, lastEventId } }) as readonly Event[]
    );
    const all = await events(null);
    const last = all.at(-1)?.sequence ?? 0;
    return {
      all: all.map((event) => [event.sequence, event.eventType, event.partialRevision ?? null] as const),
      resumed: (await events(last - 1)).map((event) => event.sequence),
      afterLast: (await events(last)).length,
    };
  }, documentId);
}

test('shows the live transcript growing across partial revisions while the recording is still processing', async ({ page }) => {
  test.setTimeout(2 * liveTranscriptWaitMs(LIVE_TRANSCRIPT_LINES.length + 4));
  // startDelay=0 publishes the first sentence as soon as the capture starts.
  await page.goto(`/?scenario=live-transcript&speed=${String(LIVE_TRANSCRIPT_SPEED)}&startDelay=0`);
  await page.goto('/asr');

  await expect(page.getByTestId('asr-choose-files')).toBeEnabled();
  // The first revision follows the simulated timeline; the test publishes the next ones.
  await holdRevisionsFrom(page, 2);
  await page.getByTestId('asr-choose-files').click();

  const row = page.getByTestId('asr-queue-row').filter({ hasText: 'sample-recording.mp3' });
  await expect(row).toHaveAttribute('data-document-id', /^[0-9a-f]{32}$/u);
  // The attribute was just asserted to be present.
  const documentId = String(await row.getAttribute('data-document-id'));

  const card = page.locator(`[data-testid="asr-live-card"][data-document-id="${documentId}"]`);
  const lineText = card.getByTestId('asr-live-line').locator('p');
  await expect(card).toBeVisible({ timeout: liveTranscriptWaitMs(1) });
  await expect(card).toHaveAttribute('data-document-id', documentId);
  await expect(lineText).toHaveText([LIVE_TRANSCRIPT_LINES[0]], { timeout: liveTranscriptWaitMs(1) });
  await expect(row).toHaveAttribute('data-user-status', 'processing');
  await expectCardKeptThroughEmptyPolls(page, documentId, LIVE_TRANSCRIPT_LINES.slice(0, 1));

  // Sequences start with `accepted`, are separate from partial revisions, and
  // a read after a sequence resumes right after it.
  expect(await recordingEventLog(page, documentId)).toEqual({
    all: [[1, 'accepted', null], [2, 'input_checkpoint', null], [3, 'segment', 1]],
    resumed: [3],
    afterLast: 0,
  });

  await holdRevisionsFrom(page, 3);
  await expect(lineText).toHaveText(LIVE_TRANSCRIPT_LINES.slice(0, 2), { timeout: liveTranscriptWaitMs(1) });
  await expect(row).toHaveAttribute('data-user-status', 'processing');
  await expectCardKeptThroughEmptyPolls(page, documentId, LIVE_TRANSCRIPT_LINES.slice(0, 2));

  // The third sentence, then structuring and completion, on the simulated timeline.
  await holdRevisionsFrom(page, null);
  await expect(row).toHaveAttribute('data-user-status', 'done', {
    timeout: liveTranscriptWaitMs(4),
  });
  await expect(page.getByTestId('asr-live-card')).toHaveCount(0);
  await row.getByTestId('asr-row-view').click();
  await expect(page).toHaveURL(new RegExp(`/history/${documentId}/content$`, 'u'));
  await expect(page.getByTestId('result-line-text')).toHaveText([...LIVE_TRANSCRIPT_LINES], {
    timeout: 15_000,
  });
});
