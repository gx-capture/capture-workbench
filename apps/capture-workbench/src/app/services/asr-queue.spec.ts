import type {
  CaptureOperation,
  PartialCapture,
} from '@gx-capture/capture-workbench-ui';
import type { DesktopLibraryDetail, DesktopLibrarySummary } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import {
  buildLiveTranscriptLines,
  describeAsrDocument,
  describeAsrLiveCapture,
  sortAsrDocumentsOldestFirst,
  type AsrQueueView,
} from './asr-queue';
import { MAX_PLAYBACK_BYTES } from './recording-playback';

interface RowRun {
  readonly owned?: boolean;
  readonly cancelling?: boolean;
  readonly unstored?: boolean;
  readonly failureReason?: string;
}

function rowActions(row: AsrQueueView): readonly string[] {
  return [
    ...(row.canCancel ? [row.cancelling ? 'cancel (applying)' : 'cancel'] : []),
    ...(row.canStartAgain ? ['start again'] : []),
    ...(row.canView ? ['view'] : []),
  ];
}

function makeRecording(
  overrides: Partial<DesktopLibrarySummary> = {},
): DesktopLibrarySummary {
  return {
    documentId: 'a'.repeat(32),
    fileName: 'meeting.m4a',
    mediaType: 'audio/mp4',
    byteLength: 1024,
    createdAtMs: 100,
    updatedAtMs: 100,
    status: 'queued',
    ...overrides,
  };
}

describe('ASR queue selectors', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  it('renders text-only partials without segments and empty partials without source text', () => {
    const partial = { captureId: 'cap-1', revision: 1 } as PartialCapture;
    expect(buildLiveTranscriptLines({ ...partial, sourceText: ' transcript ' }, 2000))
      .toEqual([{ segmentId: 'partial-0', timeLabel: '0:02', speaker: null,
        text: 'transcript', partial: true }]);
    expect(buildLiveTranscriptLines({ ...partial, segments: [] }, 2000)).toEqual([]);
    expect(buildLiveTranscriptLines(partial, 2000)).toEqual([]);
  });

  it('keeps only recordings ordered oldest first with import-order tie-breaking', () => {
    const ordered = sortAsrDocumentsOldestFirst([
      makeRecording({ documentId: '1'.repeat(32), fileName: 'newer.mp3', createdAtMs: 300 }),
      makeRecording({ documentId: '2'.repeat(32), fileName: 'scan.pdf', mediaType: 'application/pdf', createdAtMs: 50 }),
      makeRecording({ documentId: '3'.repeat(32), fileName: 'tie-a.wav', mediaType: 'audio/wav', createdAtMs: 200 }),
      makeRecording({ documentId: '4'.repeat(32), fileName: 'tie-b.mp4', mediaType: 'video/mp4', createdAtMs: 200 }),
      makeRecording({ documentId: '5'.repeat(32), fileName: 'oldest.m4a', createdAtMs: 100 }),
    ]);

    expect(ordered.map((item) => item.fileName)).toEqual([
      'oldest.m4a',
      'tie-b.mp4',
      'tie-a.wav',
      'newer.mp3',
    ]);
  });

  it('describes live partial transcript progress and marks only the last timed line partial', () => {
    const document = makeRecording({ status: 'processing', captureId: 'cap-1' });
    const operation = {
      captureId: 'cap-1',
      status: 'extracting',
      coveredUntilMs: 724_000,
      durationMs: 2_490_000,
      progress: 0.29,
    } as unknown as CaptureOperation;
    const partial = {
      captureId: 'cap-1',
      revision: 4,
      coveredUntilMs: 724_000,
      sourceText: 'line one\npartial tail',
      segments: [
        {
          segmentId: 'seg-1',
          order: 0,
          text: '好，那我們開始。',
          locator: { kind: 'time', startMs: 0, endMs: 41_000 },
        },
        {
          segmentId: 'seg-2',
          order: 1,
          text: '我覺得先跑完驗收比較保險……',
          locator: { kind: 'time', startMs: 724_000, endMs: 728_000 },
        },
      ],
    } as unknown as PartialCapture;

    const live = describeAsrLiveCapture({ document, operation, partial });
    expect(live.heardLabel).toBe('已聽到 12:04／41:30');
    expect(live.percent).toBe(29);
    expect(live.partialRevision).toBe(4);
    expect(live.lines).toEqual([
      { segmentId: 'seg-1', timeLabel: '0:00', speaker: null, text: '好，那我們開始。', partial: false },
      { segmentId: 'seg-2', timeLabel: '12:04', speaker: null, text: '我覺得先跑完驗收比較保險……', partial: true },
    ]);
  });

  // A row is shown from the stored document and "this run owns it" only.
  // Actions: Cancel, Start again, View (with exports on a finished row).
  it.each<[string, Partial<DesktopLibrarySummary>, RowRun, string, string, readonly string[], string]>([
    ['waiting', { status: 'queued' }, {}, 'waiting', '等待中', ['cancel'], ''],
    ['waiting, its start or cancel not stored in this run', { status: 'queued' }, { unstored: true },
      'needs-attention', '需要處理', ['start again'], ''],
    ['waiting, its start not stored because the read of its stored row failed', { status: 'queued' },
      { unstored: true, failureReason: 'library unreadable' }, 'needs-attention', '需要處理', ['start again'], 'library unreadable'],
    ['left processing by this run’s failed result write', { status: 'processing', captureId: 'capture-1' },
      { unstored: true, failureReason: 'the disk is full' }, 'needs-attention', '已中斷', ['start again'], 'the disk is full'],
    ['started by this run', { status: 'queued' }, { owned: true }, 'processing', '處理中', ['cancel'], ''],
    ['captured by this run', { status: 'processing', captureId: 'capture-1' }, { owned: true },
      'processing', '處理中', ['cancel'], ''],
    ['being cancelled by this run', { status: 'processing', captureId: 'capture-1' }, { owned: true, cancelling: true },
      'processing', '取消中', ['cancel (applying)'], ''],
    ['left processing by another run', { status: 'processing', captureId: 'capture-1' }, {},
      'needs-attention', '已中斷', ['start again'], ''],
    ['left processing before its link was written', { status: 'processing' }, {},
      'needs-attention', '已中斷', ['start again'], ''],
    ['an earlier version’s persisting row', { status: 'persisting', captureId: 'capture-1' }, {},
      'needs-attention', '已中斷', ['start again'], ''],
    ['waiting with a link', { status: 'queued', captureId: 'capture-1' }, {},
      'needs-attention', '已中斷', ['start again'], ''],
    ['waiting with a raw result', { status: 'queued', hasRaw: true }, {},
      'needs-attention', '已中斷', ['view'], ''],
    ['a checkpoint with raw text', { status: 'awaiting_confirmation', hasRaw: true }, {},
      'needs-attention', '已中斷', ['view'], ''],
    ['a checkpoint without raw text', { status: 'awaiting_confirmation' }, {},
      'needs-attention', '已中斷', ['start again'], ''],
    ['completed', { status: 'completed', hasRaw: true }, {}, 'done', '完成', ['view'], ''],
    ['failed', { status: 'failed', errorMessage: 'broken' }, {}, 'needs-attention', '需要處理', ['start again'], 'broken'],
    ['failed with an earlier version’s raw result', { status: 'failed', hasRaw: true }, {},
      'needs-attention', '需要處理', ['view'], ''],
    ['an earlier version’s recovery failure', {
      status: 'failed', recoveryCode: 'capture_recovery_required', errorMessage: 'lost',
    }, {}, 'needs-attention', '已中斷', ['start again'], ''],
    ['cancelled', { status: 'canceled' }, {}, 'cancelled', '已取消', ['start again'], ''],
    ['an earlier version’s recovery row', {
      status: 'recovery_required', captureId: 'capture-1', recoveryCode: 'capture_recovery_required',
    }, {}, 'needs-attention', '已中斷', ['start again'], ''],
    ['an earlier version’s failed cleanup after a failure', {
      status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage: 'failed',
      errorMessage: 'broken',
    }, {}, 'needs-attention', '需要處理', ['start again'], 'broken'],
    ['an earlier version’s failed cleanup after completion', {
      status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage: 'completed', hasRaw: true,
    }, {}, 'done', '完成', ['view'], ''],
  ])('shows a row %s', (_case, stored, run, userStatus, statusText, actions, errorMessage) => {
    const described = describeAsrDocument({
      document: makeRecording(stored),
      owned: run.owned ?? false,
      cancelling: run.cancelling,
      unstored: run.unstored,
      failureReason: run.failureReason,
      speechReady: true,
      installPercent: null,
    });

    expect([described.userStatus, described.statusText, rowActions(described)]).toEqual([userStatus, statusText, actions]);
    expect(described.interrupted).toBe(statusText === '已中斷');
    expect(described.errorMessage).toBe(errorMessage);
  });

  it.each<[string, Partial<DesktopLibrarySummary>, string, string]>([
    ['done', { status: 'completed', stage: 'completed', hasRaw: true }, '完成', ''],
    ['cancelled', { status: 'canceled', stage: 'cancelled' }, '已取消', ''],
    ['failed as stored', { status: 'failed', errorCode: 'capture_failed', errorMessage: 'broken' }, '需要處理', 'broken'],
  ])('shows a row shown %s with this run’s reason by what is stored', (_case, stored, statusText, errorMessage) => {
    const described = describeAsrDocument({
      document: makeRecording(stored),
      owned: false,
      unstored: true,
      failureReason: 'the disk is full',
      speechReady: true,
      installPercent: null,
    });

    expect([described.statusText, described.failureReason, described.errorMessage])
      .toEqual([statusText, null, errorMessage]);
  });

  it('offers the text export of an earlier version’s row whose cleanup failed after completion', () => {
    const described = describeAsrDocument({
      document: makeRecording({
        status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage: 'completed', hasRaw: true,
      }),
      owned: false,
      speechReady: true,
      installPercent: null,
    });

    expect(described).toMatchObject({ userStatus: 'done', statusText: '完成', canView: true, canExport: true });
  });

  it('maps user statuses, speaker counts, exportability, and playback unavailability notes', () => {
    const detail = {
      ...makeRecording({ status: 'completed' }),
      raw: {
        sourceText: 'hi',
        segments: [
          {
            segmentId: 'seg-1',
            order: 0,
            text: 'hi',
            locator: { kind: 'time', startMs: 0, endMs: 3160_000 },
          },
        ],
      },
      result: {
        targetText: 'hi',
        speakers: [
          { speakerId: 'SPEAKER_00' },
          { speakerId: 'SPEAKER_01' },
          { speakerId: 'SPEAKER_02' },
        ],
        blocks: [],
      },
    } as unknown as DesktopLibraryDetail;

    const doneView = describeAsrDocument({
      document: makeRecording({
        status: 'completed',
        hasRaw: true,
        durationMs: 3160_000,
        byteLength: MAX_PLAYBACK_BYTES + 1,
      }),
      detail,
      owned: false,
      speechReady: true,
      installPercent: null,
    });
    expect(doneView.userStatus).toBe('done');
    expect(doneView.statusText).toBe('完成');
    expect(doneView.durationLabel).toBe('52:40');
    expect(doneView.speakerCount).toBe(3);
    expect(doneView.playbackUnavailable).toBe(true);
    expect(doneView.canExport).toBe(true);

    const interruptedView = describeAsrDocument({
      document: makeRecording({ status: 'processing', captureId: undefined }),
      owned: false,
      speechReady: true,
      installPercent: null,
    });
    expect(interruptedView.userStatus).toBe('needs-attention');
    expect(interruptedView.interrupted).toBe(true);
    expect(interruptedView.statusText).toBe('已中斷');
  });
});
