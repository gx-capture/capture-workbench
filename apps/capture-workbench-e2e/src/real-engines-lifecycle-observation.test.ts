import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cancellingWhileDeletePendingProblem,
  libraryWriteOf,
  predecessorShownAtStart,
  terminalWritesOf,
  turnProblem,
  type CancelTiming,
  type PageCommandRecord,
  type RowChangeRecord,
  type ShownRowRecord,
} from './real-engines-lifecycle-observation.ts';

function shownRow(documentId: string, status: string, flags: Partial<ShownRowRecord> = {}): ShownRowRecord {
  return {
    documentId, row: 'asr-queue-row', status, cancelling: false, interrupted: false, cancelled: false, restart: false,
    ...flags,
  };
}

function change(at: number, documentId: string, status: string, flags: Partial<ShownRowRecord> = {}): RowChangeRecord {
  return { ...shownRow(documentId, status, flags), at };
}

function write(
  sentAt: number,
  answeredAt: number | undefined,
  documentId: string,
  status: string,
  shown?: readonly ShownRowRecord[],
): PageCommandRecord {
  return {
    command: 'library_update_capture',
    sentAt,
    ...(answeredAt === undefined ? {} : { answeredAt }),
    documentId,
    write: { documentId, status, hasRaw: false, hasResult: false },
    ...(shown ? { shown } : {}),
  };
}

function create(sentAt: number, documentId: string, shown?: readonly ShownRowRecord[]): PageCommandRecord {
  return { command: 'runtime_create_capture', sentAt, answeredAt: sentAt + 5, documentId, ...(shown ? { shown } : {}) };
}

test('a library write keeps only the fields the checks read, never the raw text or the result', () => {
  assert.deepEqual(
    libraryWriteOf({ update: { documentId: 'd', status: 'completed', clearCaptureId: true, raw: { sourceText: 'private' }, result: {} } }),
    { documentId: 'd', status: 'completed', clearCaptureId: true, hasRaw: true, hasResult: true },
  );
  assert.equal(libraryWriteOf({ request: { documentId: 'd' } }), undefined);
  assert.equal(libraryWriteOf(null), undefined);
});

test('the terminal writes of a document are its completed, failed, cancelled and checkpoint writes', () => {
  const commands = [
    write(1, 2, 'd', 'queued'),
    write(3, 4, 'd', 'processing'),
    write(5, 6, 'other', 'completed'),
    write(7, 8, 'd', 'canceled'),
    write(9, 10, 'd', 'awaiting_confirmation'),
  ];
  assert.deepEqual(terminalWritesOf(commands, 'd').map((command) => command.write?.status), ['canceled', 'awaiting_confirmation']);
  assert.deepEqual(terminalWritesOf(commands, 'd', 4).map((command) => command.write?.status), ['awaiting_confirmation']);
});

/** A Cancel clicked at page time 150 on a page clock that reads as Node's, read exactly. */
const cancelAt150: CancelTiming = { cancelAt: 150, clock: { offsetMs: 0, toleranceMs: 0 } };

test('取消中 shown while the delete waits and 已取消 after its answer passes', () => {
  const changes = [
    change(100, 'r', 'processing'),
    change(210, 'r', 'processing', { cancelling: true }),
    change(900, 'r', 'cancelled', { cancelled: true, restart: true }),
  ];
  assert.equal(cancellingWhileDeletePendingProblem(changes, 'r', { sentAt: 200, answeredAt: 850 }, cancelAt150), undefined);
});

test('取消中 shown only after the delete was answered fails', () => {
  const changes = [change(900, 'r', 'processing', { cancelling: true }), change(950, 'r', 'cancelled', { cancelled: true })];
  assert.match(
    cancellingWhileDeletePendingProblem(changes, 'r', { sentAt: 200, answeredAt: 850 }, cancelAt150) ?? '',
    /did not show 取消中 before/u,
  );
});

test('已取消 shown before the delete was answered fails', () => {
  const changes = [
    change(210, 'r', 'processing', { cancelling: true }),
    change(300, 'r', 'cancelled', { cancelled: true }),
  ];
  assert.match(
    cancellingWhileDeletePendingProblem(changes, 'r', { sentAt: 200, answeredAt: 850 }, cancelAt150) ?? '',
    /did not show 已取消 after|before the runtime delete/u,
  );
});

test('an unanswered delete fails, and another row\'s 取消中 does not count', () => {
  assert.match(cancellingWhileDeletePendingProblem([], 'r', { sentAt: 200 }, cancelAt150) ?? '', /not answered/u);
  const changes = [change(210, 'other', 'processing', { cancelling: true }), change(900, 'r', 'cancelled', { cancelled: true })];
  assert.match(cancellingWhileDeletePendingProblem(changes, 'r', { sentAt: 200, answeredAt: 850 }, cancelAt150) ?? '', /取消中/u);
});

test('a 取消中 shown before the Cancel (an earlier attempt\'s) does not count for this Cancel', () => {
  const changes = [
    change(50, 'r', 'processing', { cancelling: true }),
    change(900, 'r', 'cancelled', { cancelled: true }),
  ];
  assert.match(
    cancellingWhileDeletePendingProblem(changes, 'r', { sentAt: 200, answeredAt: 850 }, cancelAt150) ?? '',
    /did not show 取消中 before/u,
  );
});

test('a 已取消 shown before the Cancel (an earlier attempt\'s) is not one shown before this delete\'s answer', () => {
  const changes = [
    change(40, 'r', 'cancelled', { cancelled: true, restart: true }),
    change(210, 'r', 'processing', { cancelling: true }),
    change(900, 'r', 'cancelled', { cancelled: true, restart: true }),
  ];
  assert.equal(cancellingWhileDeletePendingProblem(changes, 'r', { sentAt: 200, answeredAt: 850 }, cancelAt150), undefined);
});

test('the row changes are read on the page clock: a page clock ahead of Node\'s is allowed for', () => {
  // The page's clock reads 5 s ahead of Node's: the delete Node saw answered at 850 was answered at 5850 on the page.
  const ahead: CancelTiming = { cancelAt: 5150, clock: { offsetMs: 5000, toleranceMs: 0 } };
  const inOrder = [
    change(5210, 'r', 'processing', { cancelling: true }),
    change(5900, 'r', 'cancelled', { cancelled: true }),
  ];
  assert.equal(cancellingWhileDeletePendingProblem(inOrder, 'r', { sentAt: 200, answeredAt: 850 }, ahead), undefined);
  const cancelledEarly = [
    change(5210, 'r', 'processing', { cancelling: true }),
    change(5300, 'r', 'cancelled', { cancelled: true }),
  ];
  assert.match(
    cancellingWhileDeletePendingProblem(cancelledEarly, 'r', { sentAt: 200, answeredAt: 850 }, ahead) ?? '',
    /did not show 已取消 after|before the runtime delete/u,
  );
});

test('a 已取消 within the clock tolerance of the delete\'s answer counts as after it', () => {
  const changes = [
    change(210, 'r', 'processing', { cancelling: true }),
    change(845, 'r', 'cancelled', { cancelled: true }),
  ];
  const tolerant: CancelTiming = { cancelAt: 150, clock: { offsetMs: 0, toleranceMs: 10 } };
  assert.equal(cancellingWhileDeletePendingProblem(changes, 'r', { sentAt: 200, answeredAt: 850 }, tolerant), undefined);
});

test('a turn passes when the successor starts after the stored outcome, with the predecessor shown done', () => {
  const commands = [
    write(10, 20, 'p', 'awaiting_confirmation'),
    write(30, 35, 's', 'processing', [shownRow('p', 'done')]),
    create(40, 's', [shownRow('p', 'done')]),
  ];
  assert.equal(turnProblem(commands, { predecessor: 'p', status: 'awaiting_confirmation', shownStatus: 'done', successor: 's' }), undefined);
});

test('a Start again of the successor before the outcome is not its start', () => {
  const commands = [
    write(5, 8, 's', 'queued', [shownRow('p', 'processing')]),
    write(10, 20, 'p', 'canceled'),
    create(40, 's', [shownRow('p', 'cancelled')]),
  ];
  assert.equal(turnProblem(commands, { predecessor: 'p', status: 'canceled', shownStatus: 'cancelled', successor: 's' }), undefined);
});

test('a successor started before the outcome was stored, or with the predecessor shown otherwise, fails', () => {
  const early = [
    write(10, 50, 'p', 'awaiting_confirmation'),
    create(40, 's', [shownRow('p', 'done')]),
  ];
  assert.match(turnProblem(early, { predecessor: 'p', status: 'awaiting_confirmation', shownStatus: 'done', successor: 's' }) ?? '',
    /started before/u);
  const shownProcessing = [
    write(10, 20, 'p', 'awaiting_confirmation'),
    create(40, 's', [shownRow('p', 'processing')]),
  ];
  assert.match(turnProblem(shownProcessing, { predecessor: 'p', status: 'awaiting_confirmation', shownStatus: 'done', successor: 's' }) ?? '',
    /showed processing/u);
  const notShown = [write(10, 20, 'p', 'awaiting_confirmation'), create(40, 's', [])];
  assert.match(turnProblem(notShown, { predecessor: 'p', status: 'awaiting_confirmation', shownStatus: 'done', successor: 's' }) ?? '',
    /did not show/u);
});

test('a turn whose predecessor row may be off the page passes on the stored order alone, and a shown row must still show the outcome', () => {
  const turn = {
    predecessor: 'p', status: 'awaiting_confirmation', shownStatus: 'done', successor: 's', predecessorRowOptional: true,
  } as const;
  const offPage = [write(10, 20, 'p', 'awaiting_confirmation'), create(40, 's', [shownRow('s', 'processing')])];
  assert.equal(turnProblem(offPage, turn), undefined);
  assert.equal(predecessorShownAtStart(offPage, turn), false);
  const shownProcessing = [write(10, 20, 'p', 'awaiting_confirmation'), create(40, 's', [shownRow('p', 'processing')])];
  assert.match(turnProblem(shownProcessing, turn) ?? '', /showed processing/u);
  const early = [write(10, 50, 'p', 'awaiting_confirmation'), create(40, 's', [])];
  assert.match(turnProblem(early, turn) ?? '', /started before/u);
  const shownDone = [write(10, 20, 'p', 'awaiting_confirmation'), create(40, 's', [shownRow('p', 'done')])];
  assert.equal(predecessorShownAtStart(shownDone, turn), true);
});

test('a turn without the predecessor\'s answered outcome or without a successor capture fails', () => {
  assert.match(turnProblem([write(10, undefined, 'p', 'completed'), create(40, 's')],
    { predecessor: 'p', status: 'completed', shownStatus: 'done', successor: 's' }) ?? '', /not answered/u);
  assert.match(turnProblem([write(10, 20, 'p', 'completed')],
    { predecessor: 'p', status: 'completed', shownStatus: 'done', successor: 's' }) ?? '', /not created/u);
});
