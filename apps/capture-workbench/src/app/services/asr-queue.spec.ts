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
} from './asr-queue';
import { MAX_PLAYBACK_BYTES } from './recording-playback';

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
      'tie-a.wav',
      'tie-b.mp4',
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
        byteLength: MAX_PLAYBACK_BYTES + 1,
      }),
      detail,
      busy: false,
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
      busy: false,
      speechReady: true,
      installPercent: null,
    });
    expect(interruptedView.userStatus).toBe('needs-attention');
    expect(interruptedView.interrupted).toBe(true);
    expect(interruptedView.statusText).toBe('已中斷');
  });
});
