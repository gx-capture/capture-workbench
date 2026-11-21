import type { DesktopLibraryStatus, DesktopLibrarySummary } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { describeAsrDocument } from './asr-queue';
import { canCaptureAgain, committedTerminalStatus } from './capture-operation-status';
import { describeOcrDocument } from './ocr-queue';

const STATUSES: readonly DesktopLibraryStatus[] = [
  'queued', 'processing', 'persisting', 'recovery_required',
  'awaiting_confirmation', 'completed', 'failed', 'canceled',
];

function stored(overrides: Partial<DesktopLibrarySummary>): DesktopLibrarySummary {
  return {
    documentId: 'a'.repeat(32),
    fileName: 'file.pdf',
    mediaType: 'application/pdf',
    byteLength: 8,
    createdAtMs: 1,
    updatedAtMs: 1,
    status: 'queued',
    ...overrides,
  };
}

describe('committedTerminalStatus', () => {
  it.each(['completed', 'failed', 'canceled'] as const)(
    'is the stored status of a document stored as %s',
    (status) => {
      expect(committedTerminalStatus(stored({ status, stage: 'extracting', captureId: 'capture-1' })))
        .toBe(status);
    },
  );

  it.each([
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'canceled'],
    ['awaiting_structuring', 'awaiting_confirmation'],
  ] as const)('is named by the stage %s while only the runtime cleanup is pending', (stage, status) => {
    expect(committedTerminalStatus(stored({
      status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage, captureId: 'capture-1',
    }))).toBe(status);
  });

  it.each(['extracting', 'structuring', 'uploading', undefined] as const)(
    'is not guessed for a cleanup row whose stage %s is not terminal',
    (stage) => {
      expect(committedTerminalStatus(stored({
        status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage, captureId: 'capture-1',
      }))).toBeUndefined();
    },
  );

  it.each(['queued', 'processing', 'persisting', 'recovery_required', 'awaiting_confirmation'] as const)(
    'is unknown for a document stored as %s without a pending cleanup',
    (status) => {
      expect(committedTerminalStatus(stored({ status, stage: 'completed', captureId: 'capture-1' })))
        .toBeUndefined();
    },
  );
});

describe('canCaptureAgain', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  // Every stored state of a document without a runtime capture.
  const states = STATUSES.flatMap((status) => [undefined, 'capture_recovery_required', 'runtime_cleanup_failed']
    .flatMap((recoveryCode) => [false, true].map((hasRaw) => ({ status, recoveryCode, hasRaw }))));
  const offersRetryOrRestart = (userStatus: string): boolean =>
    userStatus === 'needs-attention' || userStatus === 'cancelled';

  it('holds exactly where the text recognition queue offers retry or restart', () => {
    const disagreements = states.filter((state) => {
      const document = stored(state);
      const row = describeOcrDocument({
        document, busy: false, ocrReady: true, installPercent: null,
      });
      return canCaptureAgain(document) !== offersRetryOrRestart(row.userStatus);
    });
    expect(disagreements).toEqual([]);
  });

  it('holds exactly where the recording queue offers retry or restart', () => {
    const disagreements = states
      // A recording is never stored as awaiting confirmation: that state ends an OCR checkpoint.
      .filter((state) => state.status !== 'awaiting_confirmation')
      .filter((state) => {
        const document = stored({ ...state, fileName: 'meeting.m4a', mediaType: 'audio/mp4' });
        const row = describeAsrDocument({
          document, busy: false, speechReady: true, installPercent: null,
        });
        return canCaptureAgain(document) !== offersRetryOrRestart(row.userStatus);
      });
    expect(disagreements).toEqual([]);
  });
});
