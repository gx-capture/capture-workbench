import type { DesktopLibraryStatus, DesktopLibrarySummary } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { describeAsrDocument } from './asr-queue';
import {
  canCaptureAgain,
  committedTerminalStatus,
  holdsTerminalData,
  isCaptureLost,
} from './capture-operation-status';
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

  it.each([
    ['PDF', { fileName: 'file.pdf', mediaType: 'application/pdf' }, 'a raw result', { hasRaw: true }, 'awaiting_confirmation'],
    ['PDF', { fileName: 'file.pdf', mediaType: 'application/pdf' }, 'a stored error', { errorCode: 'ocr_failed' }, 'awaiting_confirmation'],
    ['PDF', { fileName: 'file.pdf', mediaType: 'application/pdf' }, 'neither', {}, 'awaiting_confirmation'],
    ['image', { fileName: 'page.png', mediaType: 'image/png' }, 'a raw result', { hasRaw: true }, 'awaiting_confirmation'],
    ['image', { fileName: 'page.png', mediaType: 'image/png' }, 'a stored error', { errorCode: 'ocr_failed' }, 'awaiting_confirmation'],
    ['image', { fileName: 'page.png', mediaType: 'image/png' }, 'neither', {}, 'awaiting_confirmation'],
    ['recording', { fileName: 'meeting.m4a', mediaType: 'audio/mp4' }, 'a raw result', { hasRaw: true }, 'completed'],
    ['recording', { fileName: 'meeting.m4a', mediaType: 'audio/mp4' }, 'a stored error', { errorCode: 'speech_failed' }, 'failed'],
    ['recording', { fileName: 'meeting.m4a', mediaType: 'audio/mp4' }, 'neither', {}, undefined],
  ] as const)(
    'reads cleanup row of %s with stage awaiting_structuring and %s as %s',
    (_kind, media, _evidenceLabel, evidence, expected) => {
      expect(committedTerminalStatus(stored({
        ...media,
        status: 'recovery_required',
        recoveryCode: 'runtime_cleanup_failed',
        stage: 'awaiting_structuring',
        captureId: 'capture-1',
        ...evidence,
      }))).toBe(expected);
    },
  );

  // Earlier versions stored a refused unlink of a recording with the last
  // event's stage. The document's own data then says how the capture ended.
  it.each([
    ['a kept result', { hasRaw: true }, 'completed'],
    ['a terminal error', { errorCode: 'speech_failed' }, 'failed'],
    ['a terminal error beside older data', { errorCode: 'speech_failed', hasRaw: true }, 'failed'],
  ] as const)('is read from %s when the stage of a cleanup row is not terminal', (_evidence, evidence, status) => {
    expect(committedTerminalStatus(stored({
      status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage: 'extracting',
      captureId: 'capture-1', ...evidence,
    }))).toBe(status);
  });

  it.each(['extracting', 'structuring', 'uploading', undefined] as const)(
    'is not guessed for a cleanup row with the stage %s and neither a result nor an error',
    (stage) => {
      const row = stored({
        status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage, captureId: 'capture-1',
      });
      expect(committedTerminalStatus(row)).toBeUndefined();
      // Its terminal data is kept all the same: only the runtime cleanup is left.
      expect(holdsTerminalData(row)).toBe(true);
    },
  );

  // Earlier versions stored a capture they could not recover as failed with
  // capture_recovery_required: it holds no terminal data, so Retry reads its capture.
  it('is unknown for a failed document that still needs its capture recovered', () => {
    const row = stored({ status: 'failed', recoveryCode: 'capture_recovery_required', captureId: 'capture-1' });
    expect(committedTerminalStatus(row)).toBeUndefined();
    expect(holdsTerminalData(row)).toBe(false);
  });

  it('is the stored status of an OCR result that waits for confirmation', () => {
    const row = stored({ status: 'awaiting_confirmation', stage: 'awaiting_structuring', hasRaw: true, captureId: 'capture-1' });
    expect(committedTerminalStatus(row)).toBe('awaiting_confirmation');
    expect(holdsTerminalData(row)).toBe(true);
  });

  it.each(['queued', 'processing', 'persisting', 'recovery_required', 'awaiting_confirmation'] as const)(
    'is unknown for a document stored as %s without a result or a pending cleanup',
    (status) => {
      const row = stored({ status, stage: 'completed', captureId: 'capture-1' });
      expect(committedTerminalStatus(row)).toBeUndefined();
      expect(holdsTerminalData(row)).toBe(false);
    },
  );

  it.each(['processing', 'persisting', 'recovery_required'] as const)(
    'is unknown for a document stored as %s that only holds raw text of a capture that did not end',
    (status) => {
      const row = stored({ status, stage: 'structuring', hasRaw: true, captureId: 'capture-1' });
      expect(committedTerminalStatus(row)).toBeUndefined();
      expect(holdsTerminalData(row)).toBe(false);
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

describe('isCaptureLost', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  it.each(['failed', 'recovery_required'] as const)(
    'requires an absent capture link on a %s recovery row, regardless of previously saved raw data',
    (status) => {
      const recovery = { status, recoveryCode: 'capture_recovery_required', hasRaw: true };
      expect(isCaptureLost(stored({ ...recovery, captureId: 'capture-1' }))).toBe(false);
      expect(isCaptureLost(stored(recovery))).toBe(true);
    },
  );

  // Every stored state, with and without a runtime capture.
  const states = STATUSES.flatMap((status) => [undefined, 'capture_recovery_required', 'runtime_cleanup_failed', 'cancel_failed']
    .flatMap((recoveryCode) => [undefined, 'capture-1'].map((captureId) => ({ status, recoveryCode, captureId }))));

  it('holds exactly where the text recognition queue offers a restart', () => {
    const disagreements = states.filter((state) => {
      const document = stored(state);
      const row = describeOcrDocument({
        document, busy: false, ocrReady: true, installPercent: null,
      });
      return isCaptureLost(document) !== (row.userStatus === 'needs-attention' && row.interrupted);
    });
    expect(disagreements).toEqual([]);
  });

  it('holds exactly where the recording queue offers a restart', () => {
    const disagreements = states.filter((state) => {
      const document = stored({ ...state, fileName: 'meeting.m4a', mediaType: 'audio/mp4' });
      const row = describeAsrDocument({
        document, busy: false, speechReady: true, installPercent: null,
      });
      return isCaptureLost(document) !== (row.userStatus === 'needs-attention' && row.interrupted);
    });
    expect(disagreements).toEqual([]);
  });
});
