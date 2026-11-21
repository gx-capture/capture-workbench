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
const CAPTURE_NOT_FOUND = 'Capture Runtime request was rejected with HTTP 404.';
// The simulated runtime's event log of one recording, as `[sequence, eventType, partialRevision]`:
// sequences start at 1 with `accepted` and are separate from partial revisions.
const RECORDING_EVENT_LOG: readonly RecordedEvent[] = [
  [1, 'accepted', null],
  [2, 'input_checkpoint', null],
  [3, 'segment', 1],
  [4, 'segment', 2],
  [5, 'segment', 3],
  [6, 'checkpoint', 3],
  [7, 'completed', null],
];

type RecordedEvent = readonly [sequence: number, eventType: string, partialRevision: number | null];
interface RecordedEventRead {
  readonly captureId: string;
  readonly lastEventId: number;
  readonly events: readonly RecordedEvent[];
}
/** What the recording journey of the simulated backend (fake-desktop.ts) gives a test. */
interface RecordingJourneyGlobal {
  readonly __TAURI_INTERNALS__: { readonly invoke: (command: string, args?: unknown) => Promise<unknown> };
  readonly __captureRecordingEventReads?: readonly RecordedEventRead[];
  readonly __captureRecordingHold?: (fromRevision: number | null) => void;
  readonly __captureRecordingHoldPartialAfterEmptyEvents?: () => void;
  readonly __captureRecordingHeldPartial?: { readonly emptyEventRead: number } | null;
  readonly __captureRecordingReleasePartial?: () => void;
  /** The states of the live card's lines that `watchLiveCardLines` recorded, consecutive repeats dropped. */
  __liveCardLineStates?: string[];
  __liveCardLineWatch?: MutationObserver;
}

/**
 * One command sent to the simulated host from the page. A failed command must
 * reject with its message as a plain string, as Tauri and the dev-host bridge do.
 */
async function hostCommand(page: Page, command: string, args: unknown): Promise<{
  readonly value?: unknown;
  readonly rejection?: string;
}> {
  return page.evaluate(async ([name, input]) => {
    const { invoke } = (globalThis as unknown as RecordingJourneyGlobal).__TAURI_INTERNALS__;
    try {
      return { value: await invoke(name, input) };
    } catch (error) {
      return { rejection: typeof error === 'string' ? error : `not a plain string: ${String(error)}` };
    }
  }, [command, args] as const);
}

/** Holds the simulated runtime's partial revisions from `fromRevision` on (null: none). */
async function holdRevisionsFrom(page: Page, fromRevision: number | null): Promise<void> {
  await page.evaluate((revision) => {
    const hold = (globalThis as unknown as RecordingJourneyGlobal).__captureRecordingHold;
    if (!hold) throw new Error('The simulated backend has no recording journey.');
    hold(revision);
  }, fromRevision);
}

/** The events reads answered for the capture so far, in order. */
async function eventReadsOf(page: Page, captureId: string): Promise<readonly RecordedEventRead[]> {
  return page.evaluate((id) => (
    (globalThis as unknown as RecordingJourneyGlobal).__captureRecordingEventReads ?? []
  ).filter((read) => read.captureId === id), captureId);
}

/** For each read, the last sequence the earlier replies gave (0 before any). */
function lastSequenceGivenBefore(reads: readonly RecordedEventRead[]): number[] {
  return reads.map((_, index) => Math.max(
    0,
    ...reads.slice(0, index).flatMap((read) => read.events.map(([sequence]) => sequence)),
  ));
}

/**
 * Records the states of the live card's lines from now on, as a mutation
 * observer delivers them. The lines are read once per delivery, so changes
 * the page makes within one task appear as the state they end in; a state
 * that lasts from one task to the next is recorded, whereas a poll could
 * sample around it. The checks below do not rest on that alone: they hold
 * the partial read, the only thing that could put lines back, so a card that
 * lost its lines stays without them and is recorded.
 */
async function watchLiveCardLines(page: Page, documentId: string): Promise<void> {
  await page.evaluate((id) => {
    const target = globalThis as unknown as RecordingJourneyGlobal;
    const read = (): string => {
      const card = document.querySelector(`[data-testid="asr-live-card"][data-document-id="${id}"]`);
      return card === null ? 'no card' : JSON.stringify(
        [...card.querySelectorAll('[data-testid="asr-live-line"] p')].map(
          (node) => (node.textContent ?? '').replace(/\s+/gu, ' ').trim(),
        ),
      );
    };
    const states = [read()];
    target.__liveCardLineStates = states;
    target.__liveCardLineWatch?.disconnect();
    target.__liveCardLineWatch = new MutationObserver(() => {
      const state = read();
      if (state !== states[states.length - 1]) states.push(state);
    });
    target.__liveCardLineWatch.observe(
      document.body,
      { subtree: true, childList: true, characterData: true, attributes: true },
    );
  }, documentId);
}

/** From now on the partial read that follows the next empty events reply is not answered. */
async function holdPartialReadAfterNextEmptyEventsReply(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = globalThis as unknown as RecordingJourneyGlobal;
    if (!target.__captureRecordingHoldPartialAfterEmptyEvents) {
      throw new Error('The simulated backend has no recording journey.');
    }
    target.__captureRecordingHoldPartialAfterEmptyEvents();
  });
}

/** Answers the partial read that is being held. */
async function releaseHeldPartialRead(page: Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as unknown as RecordingJourneyGlobal).__captureRecordingReleasePartial?.();
  });
}

/**
 * Waits until a partial read is held after an empty events reply, then checks
 * the card while it waits: the Workbench's last events read used the last
 * sequence it was given and got no event, and since the watch started the
 * card showed the given lines only. Returns how many events reads were
 * answered for the capture.
 */
async function expectCardKeptWhilePartialReadIsHeld(
  page: Page,
  documentId: string,
  captureId: string,
  shown: readonly string[],
): Promise<number> {
  // Waiting only: the assertions below do not depend on when this is seen.
  await expect.poll(async () => page.evaluate(() => (
    (globalThis as unknown as RecordingJourneyGlobal).__captureRecordingHeldPartial ?? null
  )), { timeout: liveTranscriptWaitMs(1) }).not.toBeNull();

  const observed = await page.evaluate(async (id) => {
    // Two frames: the page has rendered whatever the empty reply caused.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const target = globalThis as unknown as RecordingJourneyGlobal;
    const row = document.querySelector(`[data-testid="asr-queue-row"][data-document-id="${id}"]`);
    return {
      held: target.__captureRecordingHeldPartial ?? null,
      lineStates: [...(target.__liveCardLineStates ?? [])],
      status: row?.getAttribute('data-user-status') ?? null,
    };
  }, documentId);
  const reads = await eventReadsOf(page, captureId);
  const lastGiven = Math.max(0, ...reads.flatMap((read) => read.events.map(([sequence]) => sequence)));

  // The held partial read follows the last events read.
  expect(observed.held).toEqual({ emptyEventRead: reads.length - 1 });
  expect(reads[reads.length - 1]).toEqual({ captureId, lastEventId: lastGiven, events: [] });
  expect(observed.lineStates).toEqual([JSON.stringify(shown)]);
  expect(observed.status).toBe('processing');
  return reads.length;
}

/**
 * Empty events replies leave the published lines on the card, with the exact
 * order of events under the test's control:
 *
 * 1. the next revision is held, so the simulated runtime has nothing new;
 * 2. the Workbench's next events read is answered with an empty batch, and
 *    the partial read the Workbench sends after it is not answered;
 * 3. while that read waits, nothing can put lines back on the card, so the
 *    card's recorded states must be the shown lines only;
 * 4. the read is answered and the very next events read is again answered
 *    empty, with the partial read after it held and the card checked again.
 *
 * So the card kept its lines through two consecutive empty replies. A card
 * that clears on an empty reply, the first or a repeated one, and restores
 * itself from the next partial read stays empty during step 3 or 4 and fails
 * here. The second partial read is left held: the caller releases it and the
 * next revision.
 */
async function expectCardKeptThroughTwoEmptyEventsReplies(
  page: Page,
  documentId: string,
  captureId: string,
  shown: readonly string[],
): Promise<void> {
  const readsBefore = (await eventReadsOf(page, captureId)).length;
  await holdPartialReadAfterNextEmptyEventsReply(page);
  const readsAtFirst = await expectCardKeptWhilePartialReadIsHeld(page, documentId, captureId, shown);
  // The first empty reply answered a read the Workbench sent after this check began.
  expect(readsAtFirst).toBeGreaterThan(readsBefore);
  // Armed again before the held read is answered: the next events read cannot slip by.
  await holdPartialReadAfterNextEmptyEventsReply(page);
  await releaseHeldPartialRead(page);
  const readsAtSecond = await expectCardKeptWhilePartialReadIsHeld(page, documentId, captureId, shown);
  // One more events read, also empty: nothing was published or read in between.
  expect(readsAtSecond).toBe(readsAtFirst + 1);
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
  await watchLiveCardLines(page, documentId);
  const stored = await hostCommand(page, 'library_get', { request: { documentId } });
  expect(stored.value).toMatchObject({ status: 'processing', captureId: expect.stringMatching(/^capture-recording-/u) });
  const captureId = (stored.value as { readonly captureId: string }).captureId;
  expect(await hostCommand(page, 'runtime_get_capture', { input: { id: captureId } }))
    .toMatchObject({ value: { status: 'extracting' } });

  await expectCardKeptThroughTwoEmptyEventsReplies(page, documentId, captureId, LIVE_TRANSCRIPT_LINES.slice(0, 1));
  // What the Workbench itself read so far: the log from its start, each event once.
  expect((await eventReadsOf(page, captureId)).flatMap((read) => read.events))
    .toEqual(RECORDING_EVENT_LOG.slice(0, 3));

  // The held read is answered first, then the second sentence is published.
  await releaseHeldPartialRead(page);
  await holdRevisionsFrom(page, 3);
  await expect(lineText).toHaveText(LIVE_TRANSCRIPT_LINES.slice(0, 2), { timeout: liveTranscriptWaitMs(1) });
  await expect(row).toHaveAttribute('data-user-status', 'processing');
  // The Workbench resumed right after the last sequence it had: the second sentence alone.
  await expect.poll(() => eventReadsOf(page, captureId), { timeout: liveTranscriptWaitMs(1) })
    .toContainEqual({ captureId, lastEventId: 3, events: [RECORDING_EVENT_LOG[3]] });
  await watchLiveCardLines(page, documentId);
  await expectCardKeptThroughTwoEmptyEventsReplies(page, documentId, captureId, LIVE_TRANSCRIPT_LINES.slice(0, 2));

  // The third sentence, then structuring and completion, on the simulated timeline.
  await releaseHeldPartialRead(page);
  await holdRevisionsFrom(page, null);
  await expect(row).toHaveAttribute('data-user-status', 'done', {
    timeout: liveTranscriptWaitMs(4),
  });
  await expect(page.getByTestId('asr-live-card')).toHaveCount(0);
  // From the two sentences to its end the card never lost a line: it left
  // as it was or after it showed the third sentence too (at high speeds the
  // recording can complete between two reads of the Workbench).
  const twoLines = JSON.stringify(LIVE_TRANSCRIPT_LINES.slice(0, 2));
  expect([
    [twoLines, 'no card'],
    [twoLines, JSON.stringify(LIVE_TRANSCRIPT_LINES), 'no card'],
  ]).toContainEqual(await page.evaluate(() => (
    (globalThis as unknown as RecordingJourneyGlobal).__liveCardLineStates ?? []
  )));

  // Every events request of the Workbench used the last sequence it was given,
  // and together they read the runtime's log once, in order, with all three
  // sentences.
  const reads = await eventReadsOf(page, captureId);
  const received = reads.flatMap((read) => read.events);
  expect(reads.map((read) => read.lastEventId)).toEqual(lastSequenceGivenBefore(reads));
  expect(received).toEqual(RECORDING_EVENT_LOG.slice(0, received.length));
  expect(received.length).toBeGreaterThanOrEqual(5);

  // The library holds the raw transcript and, apart from it, the structured result.
  const kept = await hostCommand(page, 'library_get', { request: { documentId } });
  expect(kept.value).toMatchObject({
    status: 'completed',
    raw: { sourceText: LIVE_TRANSCRIPT_LINES.join('\n') },
    result: {
      targetText: LIVE_TRANSCRIPT_LINES.join('\n'),
      blocks: LIVE_TRANSCRIPT_LINES.map((line, order) => ({ type: 'transcript', order, targetText: line })),
      structuringEngine: { engine: 'structuring-runtime' },
    },
  });
  expect(kept.value).not.toHaveProperty('captureId');
  // The Workbench deleted the runtime capture after it kept the result, and
  // the runtime no longer knows it.
  expect(await hostCommand(page, 'runtime_get_capture', { input: { id: captureId } }))
    .toEqual({ rejection: CAPTURE_NOT_FOUND });
  // The finished recording stays finished: nothing reads the deleted capture again.
  await expect(row).toHaveAttribute('data-user-status', 'done');

  await row.getByTestId('asr-row-view').click();
  await expect(page).toHaveURL(new RegExp(`/history/${documentId}/content$`, 'u'));
  await expect(page.getByTestId('result-line-text')).toHaveText([...LIVE_TRANSCRIPT_LINES], {
    timeout: 15_000,
  });
});

test('the simulated runtime never reuses a recording capture id and publishes nothing after a delete', async ({ page }) => {
  await page.goto(`/?scenario=live-transcript&speed=${String(LIVE_TRANSCRIPT_SPEED)}&startDelay=0`);
  // No queue page: only this test starts captures and reads them.
  await page.goto('/settings/engines');
  await expect(page.getByTestId('engine-row')).toHaveCount(3);

  const picked = await hostCommand(page, 'library_select_sources', { request: { kind: 'recordings' } });
  const { selectionToken } = (picked.value as { readonly selections: readonly { readonly selectionToken: string }[] })
    .selections[0];
  const imported = await hostCommand(page, 'library_import_selection', { request: { selectionToken } });
  const { documentId } = imported.value as { readonly documentId: string };
  const startCapture = async (): Promise<{ readonly captureId: string; readonly lastEventSequence: number }> => (
    (await hostCommand(page, 'runtime_start_recording_capture', { input: { documentId } })).value
  ) as { readonly captureId: string; readonly lastEventSequence: number };
  const captureAnswer = (id: string) => hostCommand(page, 'runtime_get_capture', { input: { id } });

  // No revision is published, so an events read after the last event waits.
  await holdRevisionsFrom(page, 1);
  const first = await startCapture();
  expect(first.lastEventSequence).toBe(2);
  const answeredAfterDelete = await page.evaluate(async ([id, lastEventId]) => {
    const target = globalThis as unknown as RecordingJourneyGlobal;
    const { invoke } = target.__TAURI_INTERNALS__;
    const waiting = invoke('runtime_get_capture_events', { input: { id, lastEventId } });
    await invoke('runtime_delete_capture', { input: { id } });
    // The first revision is due from now on: a capture that still ran would publish it.
    target.__captureRecordingHold?.(null);
    return waiting;
  }, [first.captureId, first.lastEventSequence] as const);
  expect(answeredAfterDelete).toEqual([]);
  expect(await eventReadsOf(page, first.captureId))
    .toEqual([{ captureId: first.captureId, lastEventId: 2, events: [] }]);
  expect(await captureAnswer(first.captureId)).toEqual({ rejection: CAPTURE_NOT_FOUND });
  expect(await hostCommand(page, 'runtime_get_partial', { input: { id: first.captureId } }))
    .toEqual({ rejection: CAPTURE_NOT_FOUND });
  expect(await hostCommand(page, 'runtime_get_capture_events', { input: { id: first.captureId, lastEventId: 0 } }))
    .toEqual({ rejection: CAPTURE_NOT_FOUND });

  // Another recording starts: its id is new and the deleted one stays unknown.
  const second = await startCapture();
  expect(second.captureId).not.toBe(first.captureId);
  expect(await captureAnswer(first.captureId)).toEqual({ rejection: CAPTURE_NOT_FOUND });
  expect(await captureAnswer(second.captureId)).toMatchObject({ value: { captureId: second.captureId } });

  // A reload keeps the library and restarts the simulated runtime: the ids of
  // captures it no longer has stay unknown, whatever starts afterwards.
  await page.reload();
  await expect(page.getByTestId('engine-row')).toHaveCount(3);
  expect(await hostCommand(page, 'library_get', { request: { documentId } }))
    .toMatchObject({ value: { documentId } });
  const third = await startCapture();
  expect([first.captureId, second.captureId]).not.toContain(third.captureId);
  expect(await captureAnswer(first.captureId)).toEqual({ rejection: CAPTURE_NOT_FOUND });
  expect(await captureAnswer(second.captureId)).toEqual({ rejection: CAPTURE_NOT_FOUND });
  expect(await captureAnswer(third.captureId)).toMatchObject({ value: { captureId: third.captureId } });
});

test('the simulated library stores the raw and the structured result each on its own', async ({ page }) => {
  await page.goto('/?scenario=live-transcript');
  await page.goto('/settings/engines');
  await expect(page.getByTestId('engine-row')).toHaveCount(3);

  const picked = await hostCommand(page, 'library_select_sources', { request: { kind: 'recordings' } });
  const { selectionToken } = (picked.value as { readonly selections: readonly { readonly selectionToken: string }[] })
    .selections[0];
  const imported = await hostCommand(page, 'library_import_selection', { request: { selectionToken } });
  const { documentId } = imported.value as { readonly documentId: string };
  const update = (fields: Record<string, unknown>) => hostCommand(page, 'library_update_capture', {
    update: { documentId, status: 'completed', stage: 'completed', ...fields },
  });
  const storedResults = async (): Promise<unknown> => {
    const { raw, result } = (await hostCommand(page, 'library_get', { request: { documentId } }))
      .value as { readonly raw?: unknown; readonly result?: unknown };
    return { raw, result };
  };

  await update({ raw: { sourceText: 'first raw' }, result: { targetText: 'first result' } });
  expect(await storedResults()).toEqual({ raw: { sourceText: 'first raw' }, result: { targetText: 'first result' } });
  // A raw without a result replaces the raw only.
  await update({ raw: { sourceText: 'second raw' } });
  expect(await storedResults()).toEqual({ raw: { sourceText: 'second raw' }, result: { targetText: 'first result' } });
  // A result without a raw replaces the result only.
  await update({ result: { targetText: 'second result' } });
  expect(await storedResults()).toEqual({ raw: { sourceText: 'second raw' }, result: { targetText: 'second result' } });
});
