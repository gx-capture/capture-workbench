import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RUNTIME_VERSION, type CaptureOcrProjection } from '@gx-capture/capture-runtime-client';
import type {
  CaptureOperation,
  CaptureRequirementId,
  OcrComputePreflight,
  RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import { defer, lastValueFrom, of, Subject, throwError, type Observable, type Subscription } from 'rxjs';
import type { DesktopLibrarySummary, OcrEvidenceV1 } from '../contracts';
import { DesktopCaptureService, type DesktopCaptureHost } from './desktop-capture.service';
import { isInterrupted } from './capture-operation-status';
import { DesktopLibraryService, type DesktopSourceSelection } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { LibraryStore } from './library.store';
import { desktopMessages } from '../i18n/desktop-messages';

type CaptureUpdate = Parameters<DesktopLibraryService['updateCapture']>[0];

const PDF_ID = 'a'.repeat(32);
const RECORDING_ID = 'b'.repeat(32);
const WRITE_FAILED = 'Capture library index cannot be written.';

const ocrRaw = { sourceText: 'OCR text' };
const transcriptRaw = { sourceText: 'spoken words' };
const structuredResult = { targetText: 'structured transcript' };
const transcriptRawResult = () => ({
  operation: recordingOperation('capture-1', 'completed'), raw: transcriptRaw, result: structuredResult,
});

const READY: readonly RuntimeRequirement[] = [
  requirement('text-recognition', 'ready'),
  requirement('speech-recognition', 'ready'),
];

describe('DesktopCaptureService', () => {
  describe('R1: a capture belongs to the app run that started it', () => {
    it('never starts or reads a queued row that still carries a link', async () => {
      const test = setup([pdf({ captureId: 'capture-earlier-run' })]);

      await admitAndSettle(test);

      expect(test.runtime.createCapture).not.toHaveBeenCalled();
      expect(test.runtime.getCapture).not.toHaveBeenCalled();
      expect(test.library.updateCapture).not.toHaveBeenCalled();
    });

    it('asks the runtime once to delete the capture of every linked row it does not own, and stores nothing', async () => {
      const test = setup([
        pdf({ status: 'processing', captureId: 'capture-old-ocr' }),
        recording({ status: 'failed', captureId: 'capture-old-recording' }),
        pdf({ documentId: 'c'.repeat(32), status: 'queued' }),
      ]);

      await finish(test.service.deleteLinkedRuntimeCaptures$());

      expect(test.runtime.deleteCapture.mock.calls.map(([id]) => id).sort())
        .toEqual(['capture-old-ocr', 'capture-old-recording']);
      expect(test.library.updateCapture).not.toHaveBeenCalled();
      expect(test.runtime.getCapture).not.toHaveBeenCalled();
    });

    it('deletes the capture of a row a decision is reading, which may decline', async () => {
      const test = setup([pdf({ status: 'failed', captureId: 'capture-old' })]);
      const decision = test.library.holdNextRead();
      test.service.startAgain$(PDF_ID, test.host).subscribe();
      // The decision declines: another window stored a result meanwhile.
      test.library.rows.set(PDF_ID, pdf({ status: 'awaiting_confirmation', hasRaw: true, captureId: 'capture-old' }));

      await finish(test.service.deleteLinkedRuntimeCaptures$());
      decision.answer();
      await settle();

      expect(test.runtime.deleteCapture.mock.calls.map(([id]) => id)).toEqual(['capture-old']);
      expect(test.library.updateCapture).not.toHaveBeenCalled();
    });

    it('does not delete the capture this run created', async () => {
      const test = setup([recording()]);
      test.runtime.getCapture.mockReturnValueOnce(new Subject<CaptureOperation>());
      admit(test);
      expect(test.library.rows.get(RECORDING_ID)?.captureId).toBe('capture-1');

      await finish(test.service.deleteLinkedRuntimeCaptures$());

      expect(test.runtime.deleteCapture).not.toHaveBeenCalled();
    });

    it('sends no runtime delete while the runtime is not ready', () => {
      const test = setup([pdf({ status: 'processing', captureId: 'capture-old' })], { ready: false });

      test.service.deleteRuntimeCapture('capture-old');

      expect(test.runtime.deleteCapture).not.toHaveBeenCalled();
    });

    it('ends ownership only when the list shows the outcome of the attempt’s last write', async () => {
      const test = setup([recording()]);
      const status = new Subject<CaptureOperation>();
      test.runtime.getCapture.mockReturnValueOnce(status);
      admit(test);
      // The list read after the link write answers: the row is shown processing and linked.
      TestBed.tick();
      expect(shown(test, RECORDING_ID)).toMatchObject({ status: 'processing', captureId: 'capture-1' });

      // Every later list read is held: only the written summaries reach the list.
      test.library.holdReads();
      status.next(recordingOperation('capture-1', 'completed'));
      status.complete();
      TestBed.tick();

      expect(test.service.busyIds().has(RECORDING_ID)).toBe(false);
      expect(shown(test, RECORDING_ID)).toMatchObject({ status: 'completed', hasRaw: true });
      expect(isInterrupted(shown(test, RECORDING_ID), false)).toBe(false);
    });

    it('ends ownership only when the list shows the outcome, also for a row the list does not show yet', async () => {
      const test = setup([]);
      // Imported while every list reload is held: the displayed list has not seen the row.
      test.library.holdListReloads();
      test.library.rows.set(RECORDING_ID, recording());
      const status = new Subject<CaptureOperation>();
      test.runtime.getCapture.mockReturnValueOnce(status);
      admit(test);
      expect(shown(test, RECORDING_ID)).toMatchObject({ status: 'processing', captureId: 'capture-1' });

      status.next(recordingOperation('capture-1', 'completed'));
      status.complete();
      TestBed.tick();

      expect(test.service.busyIds().has(RECORDING_ID)).toBe(false);
      expect(shown(test, RECORDING_ID)).toMatchObject({ status: 'completed', hasRaw: true });
    });

    it('shows a failed terminal write as interrupted once the attempt has ended', async () => {
      const test = setup([recording()]);
      test.library.failWrites((update) => update.status === 'completed' || update.status === 'failed');

      await admitAndSettle(test);
      TestBed.tick();

      expect(test.service.busyIds().has(RECORDING_ID)).toBe(false);
      expect(test.library.rows.get(RECORDING_ID)).toMatchObject({ status: 'processing', captureId: 'capture-1' });
      expect(isInterrupted(shown(test, RECORDING_ID), test.service.busyIds().has(RECORDING_ID))).toBe(true);
    });

    it('shows the live lines of a recording only while this run captures it', async () => {
      const test = setup([recording()]);
      const status = new Subject<CaptureOperation>();
      test.runtime.getPartial.mockReturnValueOnce(of(partial('capture-1')));
      test.runtime.getCapture.mockReturnValueOnce(status);
      admit(test);
      expect(test.service.streamingPartials().get(RECORDING_ID)).toMatchObject({ captureId: 'capture-1' });

      status.error(new Error('status read failed'));
      await settle();

      expect(test.service.busyIds().has(RECORDING_ID)).toBe(false);
      expect(test.service.streamingPartials().has(RECORDING_ID)).toBe(false);
    });
  });

  describe('R2: Cancel is a delete at the runtime', () => {
    it('stores a waiting row cancelled without a runtime request', async () => {
      const test = setup([pdf()]);

      await finish(test.service.cancel$(PDF_ID, test.host));

      expect(test.library.writes()).toEqual([
        { documentId: PDF_ID, status: 'canceled', stage: 'cancelled', clearCaptureId: true },
      ]);
      expect(test.library.rows.get(PDF_ID)).toMatchObject({ status: 'canceled', stage: 'cancelled' });
      expect(runtimeRequests(test)).toEqual([]);
    });

    it('stores cancelled a waiting row whose start decision is reading it, and does not start it', async () => {
      const test = setup([pdf()]);
      // The admission's first read picks the row; the second, its decision's, is held.
      const read = test.library.holdNextRead(1);
      admit(test);
      expect(test.service.isDocumentClaimed(PDF_ID)).toBe(true);

      await finish(test.service.cancel$(PDF_ID, test.host));
      read.answer();
      await settle();

      expect(test.library.writes()).toEqual([
        { documentId: PDF_ID, status: 'canceled', stage: 'cancelled', clearCaptureId: true },
      ]);
      expect(runtimeRequests(test)).toEqual([]);
    });

    it('stores cancelled a waiting row picked by a read the cancel overtook, and does not start it', async () => {
      const test = setup([pdf()]);
      test.library.holdNextRead();
      admit(test);

      await finish(test.service.cancel$(PDF_ID, test.host));
      // The admission's read was sent before the cancel: an answer of it still says waiting.
      test.library.heldReads.shift()?.next([pdf()]);
      await settle();

      expect(test.library.writes()).toEqual([
        { documentId: PDF_ID, status: 'canceled', stage: 'cancelled', clearCaptureId: true },
      ]);
      expect(runtimeRequests(test)).toEqual([]);
    });

    it('sends no create when the cancel arrives while the first write is in flight', async () => {
      const test = setup([pdf()]);
      test.library.holdNextWrite();
      admit(test);

      await finish(test.service.cancel$(PDF_ID, test.host));
      test.library.releaseHeldWrite();
      await settle();

      expect(test.runtime.createCapture).not.toHaveBeenCalled();
      expect(test.runtime.cancelUpload).not.toHaveBeenCalled();
      expect(test.library.rows.get(PDF_ID)).toMatchObject({ status: 'canceled', captureId: undefined });
    });

    it('cancels the upload, deletes a capture whose id still arrives, and never links it', async () => {
      const test = setup([pdf()]);
      const created = new Subject<CaptureOperation>();
      test.runtime.createCapture.mockReturnValueOnce(created);
      admit(test);

      await finish(test.service.cancel$(PDF_ID, test.host));
      await finish(test.service.cancel$(PDF_ID, test.host));
      expect(test.runtime.cancelUpload).toHaveBeenCalledOnce();
      created.next(ocrOperation('capture-late', 'extracting'));
      created.complete();
      await settle();

      expect(test.runtime.deleteCapture).toHaveBeenCalledExactlyOnceWith('capture-late');
      expect(test.library.writes().some((update) => update.captureId !== undefined)).toBe(false);
      expect(test.library.rows.get(PDF_ID)).toMatchObject({ status: 'canceled', stage: 'cancelled', captureId: undefined });
      expect(test.runtime.getCapture).not.toHaveBeenCalled();
    });

    it.each([
      ['the cancelled upload', 'Upload was cancelled.'],
      ['any other create failure', 'Capture Runtime is unreachable.'],
    ])('stores cancelled, not failed, when the create answers %s after a cancel', async (_case, message) => {
      const test = setup([pdf()]);
      const created = new Subject<CaptureOperation>();
      test.runtime.createCapture.mockReturnValueOnce(created);
      admit(test);

      await finish(test.service.cancel$(PDF_ID, test.host));
      created.error(new Error(message));
      await settle();

      expect(test.library.rows.get(PDF_ID)).toMatchObject({ status: 'canceled', stage: 'cancelled', errorCode: undefined });
      expect(test.runtime.deleteCapture).not.toHaveBeenCalled();
    });

    it('deletes a running capture at once, abandons the held read, and stores cancelled only after the delete answered', async () => {
      const test = setup([recording()]);
      const status = new Subject<CaptureOperation>();
      const deleted = new Subject<void>();
      test.runtime.getCapture.mockReturnValueOnce(status);
      test.runtime.deleteCapture.mockReturnValueOnce(deleted);
      admit(test);
      const writesBefore = test.library.writes().length;

      await finish(test.service.cancel$(RECORDING_ID, test.host));
      expect(test.runtime.deleteCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
      // A late answer of the status read changes nothing.
      status.next(recordingOperation('capture-1', 'completed'));
      expect(test.runtime.getResult).not.toHaveBeenCalled();
      expect(test.library.writes()).toHaveLength(writesBefore);
      // The recording keeps its slot while the runtime stops the worker.
      expect(test.service.busyIds().has(RECORDING_ID)).toBe(true);

      deleted.next();
      deleted.complete();
      await settle();

      expect(test.library.writes().slice(writesBefore)).toEqual([
        { documentId: RECORDING_ID, status: 'canceled', stage: 'cancelled', clearCaptureId: true },
      ]);
      expect(test.library.rows.get(RECORDING_ID)).toMatchObject({ status: 'canceled', captureId: undefined, hasRaw: false });
      expect(test.runtime.deleteCapture).toHaveBeenCalledOnce();
      expect(test.runtime.getRaw).not.toHaveBeenCalled();
      expect(test.service.busyIds().has(RECORDING_ID)).toBe(false);
    });

    it.each([
      ['a recording’s result read', 'getResult', () => recording(), transcriptRawResult],
      ['an OCR checkpoint’s raw text read', 'getRaw', () => pdf(), () => ocrRaw],
      ['an OCR checkpoint’s projection read', 'getOcr', () => pdf(), () => ocrProjection('capture-1', 'completed')],
    ] as const)('stores only cancelled when %s answers after the Cancel', async (_case, read, row, reply) => {
      const test = setup([row()]);
      const held = new Subject<unknown>();
      (test.runtime[read] as unknown as { mockReturnValueOnce: (value: Observable<unknown>) => void })
        .mockReturnValueOnce(held);
      admit(test);
      expect(held.observed).toBe(true);
      const writesBefore = test.library.writes().length;

      await finish(test.service.cancel$(row().documentId, test.host));
      held.next(reply());
      held.complete();
      await settle();

      expect(test.library.writes().slice(writesBefore)).toEqual([
        { documentId: row().documentId, status: 'canceled', stage: 'cancelled', clearCaptureId: true },
      ]);
      expect(test.library.rows.get(row().documentId)).toMatchObject({ status: 'canceled', hasRaw: false });
    });

    it('shows that a cancel is being applied from the Cancel until the attempt has ended', async () => {
      const test = setup([recording()]);
      const deleted = new Subject<void>();
      test.runtime.getCapture.mockReturnValueOnce(new Subject<CaptureOperation>());
      test.runtime.deleteCapture.mockReturnValueOnce(deleted);
      admit(test);
      expect(test.service.cancellingIds().has(RECORDING_ID)).toBe(false);

      await finish(test.service.cancel$(RECORDING_ID, test.host));
      expect(test.service.cancellingIds().has(RECORDING_ID)).toBe(true);

      deleted.next();
      deleted.complete();
      await settle();
      expect(test.library.rows.get(RECORDING_ID)?.status).toBe('canceled');
      expect(test.service.cancellingIds().has(RECORDING_ID)).toBe(false);
    });

    it('stores cancelled without the link when the runtime delete fails', async () => {
      const test = setup([recording()]);
      test.runtime.getCapture.mockReturnValueOnce(new Subject<CaptureOperation>());
      test.runtime.deleteCapture.mockReturnValueOnce(throwError(() => new Error('Capture Runtime is not ready.')));
      admit(test);

      await finish(test.service.cancel$(RECORDING_ID, test.host));

      expect(test.library.rows.get(RECORDING_ID)).toMatchObject({ status: 'canceled', captureId: undefined });
      expect(test.runtime.deleteCapture).toHaveBeenCalledOnce();
    });

    it('sends the delete at once while the link write is in flight, and stores cancelled only after that write settled', async () => {
      const test = setup([recording()]);
      test.library.holdNextWrite((update) => update.captureId !== undefined);
      admit(test);
      expect(test.library.held).toHaveLength(1);

      await finish(test.service.cancel$(RECORDING_ID, test.host));
      expect(test.runtime.deleteCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
      expect(test.library.writes().map((update) => update.status)).toEqual(['processing', 'processing']);

      test.library.releaseHeldWrite();
      await settle();

      expect(test.library.writes().map((update) => update.status)).toEqual(['processing', 'processing', 'canceled']);
      expect(test.library.rows.get(RECORDING_ID)).toMatchObject({ status: 'canceled', captureId: undefined });
      expect(test.runtime.getCaptureEvents).not.toHaveBeenCalled();
    });

    it('does nothing once the terminal write has been sent', async () => {
      const test = setup([recording()]);
      test.library.holdNextWrite((update) => update.status === 'completed');
      admit(test);
      expect(test.library.held).toHaveLength(1);

      await finish(test.service.cancel$(RECORDING_ID, test.host));
      expect(test.runtime.deleteCapture).not.toHaveBeenCalled();
      test.library.releaseHeldWrite();
      await settle();

      expect(test.library.rows.get(RECORDING_ID)).toMatchObject({ status: 'completed', hasRaw: true });
      expect(test.library.writes().map((update) => update.status)).toEqual(['processing', 'processing', 'completed']);
      expect(test.runtime.deleteCapture).toHaveBeenCalledOnce();
    });

    it('ignores a cancel for a document the library is deleting', async () => {
      const test = setup([pdf()]);
      const removed = new Subject<void>();
      test.service.claimDocumentForDeletion$(PDF_ID, () => removed).subscribe();

      await finish(test.service.cancel$(PDF_ID, test.host));

      expect(test.library.updateCapture).not.toHaveBeenCalled();
      removed.complete();
    });
  });

  describe('the options stored with a recording', () => {
    it.each([
      ['the stored choice when speakers can be told apart', { identifySpeakers: true }, true, true],
      ['no speakers when the stored choice is off', { identifySpeakers: false }, true, false],
      ['no speakers when the row stores no choice', undefined, true, false],
      ['no speakers when they cannot be told apart', { identifySpeakers: true }, false, false],
    ] as const)('asks the runtime for %s', async (_case, captureOptions, speakersReady, expected) => {
      const requirements = signal([
        ...READY,
        requirement('speaker-diarization', speakersReady ? 'ready' : 'installable'),
      ]);
      const test = setup([recording(captureOptions ? { captureOptions } : {})], { requirements });

      await admitAndSettle(test);

      expect(test.runtime.startRecordingCapture).toHaveBeenCalledWith(expect.objectContaining({
        documentId: RECORDING_ID, identifySpeakers: expected,
      }));
    });
  });

  describe('R3: one terminal write; cleanup is not tracked', () => {
    it('stores a finished recording with its result and without the link in one write, then deletes the capture without waiting', async () => {
      const test = setup([recording({ captureOptions: { spokenLanguage: 'ja', identifySpeakers: false } })]);
      const deleted = new Subject<void>();
      test.runtime.deleteCapture.mockReturnValueOnce(deleted);

      await admitAndSettle(test);

      expect(test.runtime.startRecordingCapture).toHaveBeenCalledWith(expect.objectContaining({
        documentId: RECORDING_ID, structuringMode: 'runtime', spokenLanguage: 'ja', identifySpeakers: false,
      }));
      expect(test.library.writes()).toEqual([
        { documentId: RECORDING_ID, status: 'processing', stage: 'uploading', clearCaptureId: true },
        { documentId: RECORDING_ID, captureId: 'capture-1', status: 'processing', stage: 'extracting' },
        {
          documentId: RECORDING_ID, status: 'completed', stage: 'completed', clearCaptureId: true,
          raw: transcriptRaw, result: structuredResult,
        },
      ]);
      // The attempt has ended although the runtime delete has not answered.
      expect(test.service.busyIds().has(RECORDING_ID)).toBe(false);
      expect(test.runtime.deleteCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
      deleted.error(new Error('Capture Runtime is not ready.'));
      expect(test.library.writes()).toHaveLength(3);
    });

    it('stores an OCR checkpoint with raw text and completed evidence, without the link, in one write', async () => {
      const test = setup([pdf({ captureOptions: { pdfPageNumbers: [1] } })]);
      test.runtime.createCapture.mockReturnValueOnce(of(ocrOperation('capture-1', 'extracting')));
      test.runtime.getCapture.mockReturnValueOnce(of(ocrOperation('capture-1', 'awaiting_structuring')));

      await admitWithTimers(test, 700);

      expect(test.runtime.createCapture).toHaveBeenCalledWith(PDF_ID, expect.any(String), [1]);
      expect(test.runtime.getResult).not.toHaveBeenCalled();
      const writes = test.library.writes();
      expect(writes.map((update) => update.status)).toEqual(['processing', 'processing', 'awaiting_confirmation']);
      expect(writes[2]).toEqual({
        documentId: PDF_ID,
        status: 'awaiting_confirmation',
        stage: 'awaiting_structuring',
        clearCaptureId: true,
        raw: ocrRaw,
        ocrEvidence: expect.objectContaining({
          schemaVersion: 1,
          captureId: 'capture-1',
          status: 'completed',
          sourceSha256: 'a'.repeat(64),
          provenance: expect.objectContaining({ workerSha256: 'f'.repeat(64) }),
        }),
      });
      expect(test.library.rows.get(PDF_ID)).toMatchObject({
        status: 'awaiting_confirmation', captureId: undefined, hasRaw: true,
      });
      expect(test.runtime.deleteCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
    });

    it('fails an OCR capture the runtime reports completed: the host structures it, so the runtime never completes it', async () => {
      const test = setup([pdf()]);
      test.runtime.createCapture.mockReturnValueOnce(of(ocrOperation('capture-1', 'completed')));

      await admitAndSettle(test);

      expect(test.library.writes()).toEqual([
        { documentId: PDF_ID, status: 'processing', stage: 'uploading', clearCaptureId: true },
        { documentId: PDF_ID, captureId: 'capture-1', status: 'processing', stage: 'completed' },
        {
          documentId: PDF_ID, status: 'failed', stage: 'failed', clearCaptureId: true,
          errorCode: 'capture_failed',
          errorMessage: 'Capture Runtime returned unsupported terminal status: completed',
        },
      ]);
      expect(test.runtime.getRaw).not.toHaveBeenCalled();
      expect(test.runtime.getOcr).not.toHaveBeenCalled();
      expect(test.runtime.getResult).not.toHaveBeenCalled();
      expect(test.library.evidence.has(PDF_ID)).toBe(false);
      expect(test.runtime.deleteCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
    });

    it('saves nothing of a capture the runtime ended as failed', async () => {
      const test = setup([pdf()]);
      test.runtime.createCapture.mockReturnValueOnce(of(ocrOperation('capture-1', 'failed', {
        error: { code: 'ocr_worker_failed', message: 'worker failed' },
      })));

      await admitAndSettle(test);

      expect(lastWrite(test)).toEqual({
        documentId: PDF_ID, status: 'failed', stage: 'failed', clearCaptureId: true,
        errorCode: 'ocr_worker_failed', errorMessage: 'worker failed',
      });
      expect(test.runtime.getRaw).not.toHaveBeenCalled();
      expect(test.runtime.getOcr).not.toHaveBeenCalled();
      expect(test.library.rows.get(PDF_ID)).toMatchObject({ status: 'failed', hasRaw: false });
      expect(test.runtime.deleteCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
    });

    it('saves no raw text while a capture reports structuring', async () => {
      const test = setup([pdf()]);
      test.runtime.createCapture.mockReturnValueOnce(of(ocrOperation('capture-1', 'structuring')));
      test.runtime.getCapture.mockReturnValueOnce(of(ocrOperation('capture-1', 'cancelled')));

      await admitWithTimers(test, 700);

      expect(test.library.writes().some((update) => update.raw !== undefined)).toBe(false);
      expect(test.runtime.getRaw).not.toHaveBeenCalled();
      expect(test.library.rows.get(PDF_ID)).toMatchObject({ status: 'canceled', stage: 'cancelled' });
    });

    it.each<[string, () => Record<string, unknown>, Partial<OcrComputePreflight>?]>([
      ['the OCR read fails', () => ({ getOcr: vi.fn(() => throwError(() => new Error('OCR transport failed'))) })],
      ['the projection names another contract set', () => ({
        getOcr: vi.fn((id: string) => of({ ...ocrProjection(id, 'completed'), contractSetSha256: 'b'.repeat(64) })),
      })],
      ['a page of the projection failed', () => ({ getOcr: vi.fn((id: string) => of(ocrProjection(id, 'failed'))) })],
      ['the raw text is missing', () => ({ getRaw: vi.fn(() => of(null)) })],
      ['the OCR worker identity is unknown', () => ({}), { workerSha256: undefined }],
    ])('stores a failure without raw or evidence when %s at the checkpoint', async (_case, runtime, compute) => {
      const test = setup([pdf()], { runtime: runtime(), compute });

      await admitAndSettle(test);

      const terminal = lastWrite(test);
      expect(terminal).toMatchObject({ status: 'failed', errorCode: 'capture_failed', clearCaptureId: true });
      expect(terminal).not.toHaveProperty('raw');
      expect(terminal).not.toHaveProperty('ocrEvidence');
      expect(test.library.evidence.has(PDF_ID)).toBe(false);
      expect(test.runtime.deleteCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
    });

    it('stores nothing about a runtime delete that fails after the terminal write', async () => {
      const test = setup([recording()]);
      test.runtime.deleteCapture.mockReturnValueOnce(throwError(() => new Error('Capture Runtime is not ready.')));

      await admitAndSettle(test);

      expect(test.library.writes().map((update) => update.status)).toEqual(['processing', 'processing', 'completed']);
      expect(test.library.rows.get(RECORDING_ID)).toMatchObject({ status: 'completed', captureId: undefined });
      expect(test.host.setMessage).not.toHaveBeenCalled();
    });
  });

  describe('R4: a failure ends the attempt', () => {
    it('ends with a failure, deletes the capture and reads nothing more when a status read fails', async () => {
      const test = setup([recording()]);
      test.runtime.getCapture.mockReturnValueOnce(throwError(() => new Error('status read failed')));

      await admitAndSettle(test);

      expect(lastWrite(test)).toEqual({
        documentId: RECORDING_ID, status: 'failed', stage: 'failed', clearCaptureId: true,
        errorCode: 'capture_failed', errorMessage: 'status read failed',
      });
      expect(test.runtime.getCapture).toHaveBeenCalledOnce();
      expect(test.runtime.deleteCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
    });

    it('keeps a failed terminal write’s error for the row and tries nothing again by itself', async () => {
      vi.useFakeTimers();
      try {
        const test = setup([recording()]);
        test.library.failWrites((update) => update.status === 'completed');

        admit(test);
        await vi.advanceTimersByTimeAsync(60_000);

        // Shown on the row, not as a general message as well.
        expect(test.service.unstoredOutcomes().get(RECORDING_ID)).toBe(WRITE_FAILED);
        expect(test.host.setMessage).not.toHaveBeenCalled();
        // Exactly three writes: the start, the link, and the one terminal write that failed.
        expect(test.library.writes().map((update) => update.status)).toEqual(['processing', 'processing', 'completed']);
        expect(test.runtime.startRecordingCapture).toHaveBeenCalledOnce();
        expect(test.runtime.getResult).toHaveBeenCalledOnce();
        expect(test.service.busyIds().has(RECORDING_ID)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps a failed OCR checkpoint write’s error for the row, deletes the capture and writes nothing more', async () => {
      const test = setup([pdf()]);
      test.library.failWrites((update) => update.status === 'awaiting_confirmation');

      await admitAndSettle(test);
      await vi.waitFor(() => expect(test.service.busyIds().has(PDF_ID)).toBe(false));

      expect(test.service.unstoredOutcomes().get(PDF_ID)).toBe(WRITE_FAILED);
      // Exactly three writes: the start, the link, and the one checkpoint write that failed.
      expect(test.library.writes().map((update) => update.status))
        .toEqual(['processing', 'processing', 'awaiting_confirmation']);
      expect(test.library.rows.get(PDF_ID)).toMatchObject({ status: 'processing', captureId: 'capture-1', hasRaw: false });
      expect(test.runtime.createCapture).toHaveBeenCalledOnce();
      expect(test.runtime.deleteCapture).toHaveBeenCalledExactlyOnceWith('capture-1');
    });

    it('keeps the admission from picking again a row whose failure could not be stored', async () => {
      const test = setup([pdf()]);
      test.library.failWrites(() => true);

      const admission = admit(test);
      await settle();
      expect(test.library.rows.get(PDF_ID)?.status).toBe('queued');
      expect(test.service.unstoredOutcomes().get(PDF_ID)).toBe(WRITE_FAILED);
      expect(test.host.setMessage).not.toHaveBeenCalled();
      const writes = test.library.writes().length;

      test.library.failWrites(undefined);
      admission.look();
      await settle();
      expect(test.library.writes()).toHaveLength(writes);
      expect(test.runtime.createCapture).not.toHaveBeenCalled();
    });

    it('keeps the admission from starting a waiting row whose cancel could not be stored', async () => {
      const test = setup([pdf()]);
      test.library.failWrites((update) => update.status === 'canceled');

      await expect(finish(test.service.cancel$(PDF_ID, test.host))).rejects.toThrow(WRITE_FAILED);
      test.library.failWrites(undefined);
      await admitAndSettle(test);

      expect(test.library.rows.get(PDF_ID)?.status).toBe('queued');
      expect(test.runtime.createCapture).not.toHaveBeenCalled();
      // The page where the Cancel was given shows its error; the row keeps none.
      expect(test.service.unstoredOutcomes().has(PDF_ID)).toBe(true);
      expect(test.service.unstoredOutcomes().get(PDF_ID)).toBeNull();
    });

    it('keeps the error of the admission’s failed read of the stored row for that row, and the next one starts', async () => {
      const nextId = 'c'.repeat(32);
      const test = setup([pdf({ createdAtMs: 1 }), pdf({ documentId: nextId, createdAtMs: 2 })]);
      // The admission's look at the list answers; its read of the stored row fails.
      const read = test.library.holdNextRead(1);

      admit(test);
      read.fail(new Error('library unreadable'));
      await settle();

      expect(test.service.unstoredOutcomes().get(PDF_ID)).toBe('library unreadable');
      expect(test.host.setMessage).not.toHaveBeenCalled();
      expect(test.runtime.createCapture.mock.calls.map(([id]) => id)).toEqual([nextId]);

      await finish(test.service.startAgain$(PDF_ID, test.host));
      expect(test.service.unstoredOutcomes().has(PDF_ID)).toBe(false);
    });

    it.each([
      ['its own read', 0],
      ['the read of the start decision it reached', 1],
    ] as const)('remembers a cancel when %s fails: the row is never started, the next one is', async (_case, skip) => {
      const nextId = 'c'.repeat(32);
      const test = setup([pdf({ createdAtMs: 1 }), pdf({ documentId: nextId, createdAtMs: 2 })]);
      const read = test.library.holdNextRead(skip);
      if (skip === 0) {
        test.service.cancel$(PDF_ID, test.host).subscribe({ error: () => undefined });
        read.fail(new Error('library unreadable'));
        admit(test);
      } else {
        admit(test);
        test.service.cancel$(PDF_ID, test.host).subscribe();
        read.fail(new Error('library unreadable'));
      }
      await settle();

      expect(test.library.rows.get(PDF_ID)?.status).toBe('queued');
      expect(test.runtime.createCapture.mock.calls.map(([id]) => id)).toEqual([nextId]);
    });

    it.each(['Start again', 'Cancel'] as const)(
      'lets the user’s %s act on a row neither of whose writes could be stored',
      async (action) => {
        const test = setup([pdf()]);
        test.library.failWrites(() => true);
        await admitAndSettle(test);
        // Stored `queued` still, and passed by: shown as needing attention, not as waiting.
        expect(test.library.rows.get(PDF_ID)?.status).toBe('queued');
        expect(test.service.unstoredOutcomes().has(PDF_ID)).toBe(true);
        expect(test.libraryStore.canDelete(PDF_ID)).toBe(true);
        test.library.failWrites(undefined);

        if (action === 'Start again') {
          await finish(test.service.startAgain$(PDF_ID, test.host));
          expect(test.service.unstoredOutcomes().has(PDF_ID)).toBe(false);
          expect(test.runtime.createCapture).toHaveBeenCalledOnce();
          expect(test.library.rows.get(PDF_ID)?.status).toBe('awaiting_confirmation');
        } else {
          await finish(test.service.cancel$(PDF_ID, test.host));
          expect(test.service.unstoredOutcomes().has(PDF_ID)).toBe(false);
          expect(test.library.rows.get(PDF_ID)?.status).toBe('canceled');
          expect(test.runtime.createCapture).not.toHaveBeenCalled();
        }
      },
    );

    it('lets Start again capture a row whose earlier attempt this run could not record', async () => {
      const test = setup([pdf()]);
      // The first write is stored, its failure record is not: the row stays processing.
      test.library.failWrites((update) => update.captureId !== undefined || update.status === 'failed');

      await admitAndSettle(test);
      expect(test.library.rows.get(PDF_ID)?.status).toBe('processing');
      expect(test.service.unstoredOutcomes().get(PDF_ID)).toBe(WRITE_FAILED);

      test.library.failWrites(undefined);
      await finish(test.service.startAgain$(PDF_ID, test.host));

      // The user's Start again is stored: the row keeps no error of the earlier attempt.
      expect(test.service.unstoredOutcomes().has(PDF_ID)).toBe(false);
      expect(test.runtime.createCapture).toHaveBeenCalledTimes(2);
      expect(test.library.rows.get(PDF_ID)?.status).toBe('awaiting_confirmation');
    });
  });

  describe('R5: Start again only for a row without a raw result', () => {
    it.each<[string, Partial<DesktopLibrarySummary>, boolean]>([
      ['failed', { status: 'failed', errorCode: 'capture_failed' }, true],
      ['cancelled', { status: 'canceled', stage: 'cancelled' }, true],
      ['interrupted while processing', { status: 'processing', captureId: 'capture-old' }, true],
      ['interrupted before the link was written', { status: 'processing' }, true],
      ['interrupted while queued with a link', { status: 'queued', captureId: 'capture-old' }, true],
      ['an earlier version’s recovery row', { status: 'recovery_required', recoveryCode: 'capture_recovery_required' }, true],
      ['an earlier version’s failed cleanup of a failure', {
        status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage: 'failed', errorCode: 'ocr_failed',
      }, true],
      ['a checkpoint without raw text', { status: 'awaiting_confirmation' }, true],
      ['failed, holding raw text', { status: 'failed', hasRaw: true }, false],
      ['cancelled, holding raw text', { status: 'canceled', hasRaw: true }, false],
      ['interrupted, holding raw text', { status: 'processing', captureId: 'capture-old', hasRaw: true }, false],
      ['waiting', { status: 'queued' }, false],
      ['completed', { status: 'completed', hasRaw: true }, false],
      ['a checkpoint with raw text', { status: 'awaiting_confirmation', hasRaw: true }, false],
      ['an earlier version’s failed cleanup of a result', {
        status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage: 'awaiting_structuring', hasRaw: true,
      }, false],
    ])('%s: starts again %s', async (_case, stored, starts) => {
      const test = setup([pdf({ errorMessage: 'earlier failure', ...stored })]);

      await finish(test.service.startAgain$(PDF_ID, test.host));

      // Waiting again as a fresh import is: no link, no error; the admission starts it.
      expect(test.library.writes()).toEqual(starts
        ? [{ documentId: PDF_ID, status: 'queued', stage: 'uploading', clearCaptureId: true }]
        : []);
      if (starts) {
        expect(test.library.rows.get(PDF_ID)).toMatchObject({
          status: 'queued', stage: 'uploading', captureId: undefined, errorCode: undefined, errorMessage: undefined,
        });
      }
      expect(test.runtime.createCapture).not.toHaveBeenCalled();
    });

    it('never captures a queued row that holds a raw result, as an earlier version’s Start again left it', async () => {
      const test = setup([pdf({ status: 'queued', hasRaw: true })]);

      await admitAndSettle(test);
      await finish(test.service.startAgain$(PDF_ID, test.host));

      expect(test.runtime.createCapture).not.toHaveBeenCalled();
      expect(test.library.updateCapture).not.toHaveBeenCalled();
      expect(isInterrupted(shown(test, PDF_ID), false)).toBe(true);
    });

    it('decides from the stored row, not from the list the caller showed', async () => {
      const test = setup([pdf({ status: 'failed' })]);
      // Another window stored the result meanwhile; this list still shows the failure.
      test.library.rows.set(PDF_ID, pdf({ status: 'awaiting_confirmation', hasRaw: true }));
      expect(shown(test, PDF_ID).status).toBe('failed');

      await finish(test.service.startAgain$(PDF_ID, test.host));

      expect(test.library.updateCapture).not.toHaveBeenCalled();
    });

    it('deletes the capture an old link names without waiting, then the admission captures with the stored options', async () => {
      const test = setup([recording({
        status: 'processing', captureId: 'capture-old',
        captureOptions: { spokenLanguage: 'en', identifySpeakers: false },
      })]);
      test.runtime.deleteCapture.mockReturnValueOnce(new Subject<void>());
      admit(test);

      await finish(test.service.startAgain$(RECORDING_ID, test.host));

      expect(test.runtime.deleteCapture.mock.calls[0]).toEqual(['capture-old']);
      expect(test.runtime.startRecordingCapture).toHaveBeenCalledWith(expect.objectContaining({ spokenLanguage: 'en' }));
      expect(test.library.writes().slice(0, 2)).toEqual([
        { documentId: RECORDING_ID, status: 'queued', stage: 'uploading', clearCaptureId: true },
        { documentId: RECORDING_ID, status: 'processing', stage: 'uploading', clearCaptureId: true },
      ]);
      expect(test.library.rows.get(RECORDING_ID)).toMatchObject({ status: 'completed', captureId: undefined });
    });

    it('stores new evidence over the failed evidence an earlier version kept', async () => {
      const test = setup([pdf({ status: 'failed' })]);
      test.library.evidence.set(PDF_ID, { status: 'failed', captureId: 'capture-old' } as unknown as OcrEvidenceV1);
      admit(test);

      await finish(test.service.startAgain$(PDF_ID, test.host));

      expect(test.library.rows.get(PDF_ID)).toMatchObject({ status: 'awaiting_confirmation', hasRaw: true });
      expect(test.library.evidence.get(PDF_ID)).toMatchObject({ status: 'completed', captureId: 'capture-1' });
    });

    it('keeps the failed evidence when the host refuses its replacement, and shows the row interrupted', async () => {
      // The runtime advertises a page scope the stored row does not name: the
      // host checks the stored scope (all pages from 1), so it refuses page 2 alone.
      const test = setup([pdf({ status: 'failed' })], {
        runtime: {
          pdfPageNumbers: signal<readonly number[] | undefined>([2]),
          getOcr: vi.fn((id: string) => {
            const projection = ocrProjection(id, 'completed');
            return of({ ...projection, pages: projection.pages.map((page) => ({ ...page, page: 2 })) });
          }),
        },
      });
      const failed = { status: 'failed', captureId: 'capture-old' } as unknown as OcrEvidenceV1;
      test.library.evidence.set(PDF_ID, failed);
      admit(test);

      await finish(test.service.startAgain$(PDF_ID, test.host));

      expect(test.runtime.createCapture).toHaveBeenCalledWith(PDF_ID, expect.any(String), [2]);
      expect(test.service.unstoredOutcomes().get(PDF_ID)).toBe('OCR evidence pages do not match the requested pages.');
      expect(test.host.setMessage).not.toHaveBeenCalled();
      expect(test.library.evidence.get(PDF_ID)).toBe(failed);
      expect(test.library.rows.get(PDF_ID)).toMatchObject({ status: 'processing', hasRaw: false });
      expect(isInterrupted(test.library.rows.get(PDF_ID) as DesktopLibrarySummary, false)).toBe(true);
    });

    it('stores cancelled instead when a cancel arrives while its stored row is read', async () => {
      const test = setup([pdf({ status: 'failed' })]);
      const read = test.library.holdNextRead();
      const startAgain = finish(test.service.startAgain$(PDF_ID, test.host));

      await finish(test.service.cancel$(PDF_ID, test.host));
      read.answer();
      await startAgain;

      expect(test.runtime.createCapture).not.toHaveBeenCalled();
      expect(test.library.rows.get(PDF_ID)?.status).toBe('canceled');
    });

    it('remembers a cancel given while a Start again reads the stored row and that read fails', async () => {
      const nextId = 'c'.repeat(32);
      const test = setup([pdf({ createdAtMs: 1 }), pdf({ documentId: nextId, createdAtMs: 2 })]);
      const read = test.library.holdNextRead();
      const startAgain = lastValueFrom(test.service.startAgain$(PDF_ID, test.host), { defaultValue: undefined });

      await finish(test.service.cancel$(PDF_ID, test.host));
      read.fail(new Error('library unreadable'));
      await expect(startAgain).rejects.toThrow('library unreadable');
      await admitAndSettle(test);

      expect(test.library.rows.get(PDF_ID)?.status).toBe('queued');
      expect(test.service.unstoredOutcomes().has(PDF_ID)).toBe(true);
      expect(test.runtime.createCapture.mock.calls.map(([id]) => id)).toEqual([nextId]);
    });
  });

  describe('claims', () => {
    it('claims a document from the subscription on, decides once while it is read, and frees it when declined', async () => {
      const test = setup([pdf({ status: 'completed', hasRaw: true })]);
      const read = test.library.holdNextRead();
      const entry = test.service.startAgain$(PDF_ID, test.host);
      expect(test.service.isDocumentClaimed(PDF_ID)).toBe(false);

      const decided = finish(entry);
      test.service.startAgain$(PDF_ID, test.host).subscribe();
      test.service.cancel$(PDF_ID, test.host).subscribe();
      expect(test.service.isDocumentClaimed(PDF_ID)).toBe(true);
      expect(test.library.heldReads).toHaveLength(1);

      read.answer();
      await decided;
      expect(test.service.isDocumentClaimed(PDF_ID)).toBe(false);
    });

    it('frees the document when its stored state cannot be read', async () => {
      const test = setup([pdf({ status: 'failed' })]);
      const read = test.library.holdNextRead();
      const decided = lastValueFrom(test.service.startAgain$(PDF_ID, test.host), { defaultValue: undefined });

      read.fail(new Error('library unreadable'));

      await expect(decided).rejects.toThrow('library unreadable');
      expect(test.service.isDocumentClaimed(PDF_ID)).toBe(false);
    });

    it('declines every capture entry while the library deletes the document', async () => {
      const test = setup([pdf({ status: 'failed' }), pdf({ documentId: 'c'.repeat(32) })]);
      const waitingId = 'c'.repeat(32);
      const removed = new Subject<void>();
      test.service.claimDocumentForDeletion$(PDF_ID, () => removed).subscribe();
      test.service.claimDocumentForDeletion$(waitingId, () => removed).subscribe();

      await finish(test.service.startAgain$(PDF_ID, test.host));
      await finish(test.service.cancel$(waitingId, test.host));
      await admitAndSettle(test);

      expect(test.library.updateCapture).not.toHaveBeenCalled();
      expect(test.service.isDocumentClaimed(PDF_ID)).toBe(true);
      removed.complete();
      expect(test.service.isDocumentClaimed(PDF_ID)).toBe(false);
    });

    it('does not let a deletion claim a document while its capture runs', async () => {
      const test = setup([recording()]);
      test.runtime.getCapture.mockReturnValueOnce(new Subject<CaptureOperation>());
      admit(test);
      const remove = vi.fn(() => of(undefined));

      await finish(test.service.claimDocumentForDeletion$(RECORDING_ID, remove));

      expect(remove).not.toHaveBeenCalled();
    });
  });

  describe('R6: one capture at a time, in order', () => {
    it('captures three imported documents, a PDF, a recording and a PDF, one after the other in import order', async () => {
      const test = setup([]);
      // How many documents this run owns when each runtime capture is created.
      const owned: number[] = [];
      test.runtime.createCapture.mockImplementation(() => {
        owned.push(test.service.busyIds().size);
        return of(ocrOperation('capture-1', 'awaiting_structuring'));
      });
      test.runtime.startRecordingCapture.mockImplementation(() => {
        owned.push(test.service.busyIds().size);
        return of(recordingOperation('capture-1', 'extracting'));
      });
      test.library.holdNextWrite((update) => update.status === 'awaiting_confirmation');
      const admission = admit(test);

      await finish(test.service.addSelections$(
        [selection('first.pdf'), selection('second.m4a'), selection('third.pdf')],
        test.host,
      ));
      const [firstId, secondId, thirdId] = test.library.imported;
      // The list changes while the first attempt runs.
      admission.look();
      await settle();

      // The first attempt's last write has not answered: nothing else starts.
      expect(test.library.held.map(({ update }) => update.documentId)).toEqual([firstId]);
      expect(test.runtime.createCapture.mock.calls.map(([id]) => id)).toEqual([firstId]);
      expect(test.runtime.startRecordingCapture).not.toHaveBeenCalled();
      expect([...test.service.busyIds()]).toEqual([firstId]);

      test.library.releaseHeldWrite();
      await settle();

      expect(test.runtime.startRecordingCapture).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ documentId: secondId }),
      );
      expect(test.runtime.createCapture.mock.calls.map(([id]) => id)).toEqual([firstId, thirdId]);
      expect(test.runtime.startRecordingCapture.mock.invocationCallOrder[0])
        .toBeLessThan(test.runtime.createCapture.mock.invocationCallOrder[1]);
      expect(owned).toEqual([1, 1, 1]);
      expect([firstId, secondId, thirdId].map((id) => test.library.rows.get(id)?.status))
        .toEqual(['awaiting_confirmation', 'completed', 'awaiting_confirmation']);
      expect(test.service.busyIds().size).toBe(0);
    });

    it('passes by a document whose feature is not ready and starts it when the feature becomes ready', async () => {
      const requirements = signal<readonly RuntimeRequirement[]>([
        requirement('text-recognition', 'ready'),
        requirement('speech-recognition', 'installable'),
      ]);
      const test = setup([recording({ createdAtMs: 1 }), pdf({ createdAtMs: 2 })], { requirements });

      const admission = admit(test);
      await settle();

      expect(test.runtime.createCapture.mock.calls.map(([id]) => id)).toEqual([PDF_ID]);
      expect(test.runtime.startRecordingCapture).not.toHaveBeenCalled();
      expect(test.library.rows.get(RECORDING_ID)?.status).toBe('queued');

      requirements.set(READY);
      admission.look();
      await settle();

      expect(test.runtime.startRecordingCapture).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ documentId: RECORDING_ID }),
      );
      expect(test.library.rows.get(RECORDING_ID)?.status).toBe('completed');
    });

    it('stores an interrupted row waiting on Start again while another capture runs, and starts it in its turn', async () => {
      const test = setup([
        recording({ createdAtMs: 1 }),
        pdf({ createdAtMs: 2, status: 'processing', captureId: 'capture-old' }),
      ]);
      const status = new Subject<CaptureOperation>();
      test.runtime.getCapture.mockReturnValueOnce(status);
      admit(test);
      expect(test.service.busyIds().has(RECORDING_ID)).toBe(true);

      await finish(test.service.startAgain$(PDF_ID, test.host));

      expect(test.runtime.deleteCapture).toHaveBeenCalledExactlyOnceWith('capture-old');
      expect(test.library.rows.get(PDF_ID)).toMatchObject({ status: 'queued', captureId: undefined });
      expect(test.runtime.createCapture).not.toHaveBeenCalled();

      status.next(recordingOperation('capture-1', 'completed'));
      status.complete();
      await settle();

      expect(test.runtime.createCapture.mock.calls.map(([id]) => id)).toEqual([PDF_ID]);
      expect(test.library.rows.get(PDF_ID)?.status).toBe('awaiting_confirmation');
    });

    it('stores a waiting row cancelled while another capture runs, and its turn never comes', async () => {
      const test = setup([recording({ createdAtMs: 1 }), pdf({ createdAtMs: 2 })]);
      const status = new Subject<CaptureOperation>();
      test.runtime.getCapture.mockReturnValueOnce(status);
      admit(test);

      await finish(test.service.cancel$(PDF_ID, test.host));
      expect(test.library.rows.get(PDF_ID)).toMatchObject({ status: 'canceled', stage: 'cancelled' });
      // Only the recording's own attempt is touched at the runtime.
      expect(test.runtime.deleteCapture).not.toHaveBeenCalled();

      status.next(recordingOperation('capture-1', 'completed'));
      status.complete();
      await settle();

      expect(test.runtime.createCapture).not.toHaveBeenCalled();
      expect(test.library.writes().filter((update) => update.documentId === PDF_ID)).toEqual([
        { documentId: PDF_ID, status: 'canceled', stage: 'cancelled', clearCaptureId: true },
      ]);
    });

    it('neither loops on a row whose start could not be stored nor stops the next one', async () => {
      const nextId = 'c'.repeat(32);
      const test = setup([pdf({ createdAtMs: 1 }), pdf({ documentId: nextId, createdAtMs: 2 })]);
      test.library.failWrites((update) => update.documentId === PDF_ID);

      const admission = admit(test);
      await settle();
      admission.look();
      await settle();

      expect(test.library.writes().filter((update) => update.documentId === PDF_ID).map((update) => update.status))
        .toEqual(['processing', 'failed']);
      expect(test.library.rows.get(PDF_ID)?.status).toBe('queued');
      expect(test.runtime.createCapture.mock.calls.map(([id]) => id)).toEqual([nextId]);
      expect(test.library.rows.get(nextId)?.status).toBe('awaiting_confirmation');
    });

    it('asks for a missing feature when a dropped file is imported, and leaves it waiting', async () => {
      const test = setup([], { requirements: signal([requirement('text-recognition', 'ready')]) });
      admit(test);

      await finish(test.service.addSelections$([selection('meeting.m4a')], test.host));

      const [documentId] = test.library.imported;
      expect(test.host.requestedRequirements().has('speech-recognition')).toBe(true);
      expect(test.host.setMessage).toHaveBeenCalledOnce();
      expect(test.host.selectedId()).toBe(documentId);
      expect(test.library.rows.get(documentId)?.status).toBe('queued');
      expect(test.runtime.startRecordingCapture).not.toHaveBeenCalled();
    });

    it('asks for text recognition for a dropped document while the requirement list does not name it', async () => {
      const test = setup([], { requirements: signal([]) });
      admit(test);

      await finish(test.service.addSelections$([selection('scan.pdf')], test.host));

      const [documentId] = test.library.imported;
      expect(test.host.requestedRequirements().has('text-recognition')).toBe(true);
      expect(test.host.setMessage).toHaveBeenCalledExactlyOnceWith(desktopMessages().needsSetup);
      expect(test.library.rows.get(documentId)?.status).toBe('queued');
      expect(test.runtime.createCapture).not.toHaveBeenCalled();
    });
  });

  describe('following a capture of this run', () => {
    it.each([
      ['the stored page numbers', { pdfPageNumbers: [3, 7] }, [3, 7]],
      ['an earlier version’s stored page count', { pdfPageCount: 2 }, [1, 2]],
    ] as const)('starts a PDF with %s', async (_case, captureOptions, pages) => {
      const test = setup([pdf({ captureOptions })]);

      await admitAndSettle(test);

      expect(test.runtime.createCapture).toHaveBeenCalledWith(PDF_ID, expect.any(String), pages);
    });

    it('starts a PDF with the page scope the runtime advertises when the stored options name none', async () => {
      const test = setup([pdf()], { runtime: { pdfPageNumbers: signal<readonly number[] | undefined>([1]) } });

      await admitAndSettle(test);

      expect(test.runtime.createCapture).toHaveBeenCalledWith(PDF_ID, expect.any(String), [1]);
    });

    it('fails a capture whose source identity changes while it runs', async () => {
      const test = setup([pdf()]);
      test.runtime.createCapture.mockReturnValueOnce(of(ocrOperation('capture-1', 'extracting')));
      test.runtime.getCapture.mockReturnValueOnce(of(ocrOperation('capture-1', 'awaiting_structuring', {
        source: { sha256: 'c'.repeat(64), fileName: 'fixture.pdf', mediaType: 'application/pdf', bytes: 12 },
      })));

      await admitWithTimers(test, 700);

      expect(test.library.rows.get(PDF_ID)).toMatchObject({
        status: 'failed', errorMessage: 'OCR evidence identity mismatch: capture source changed.',
      });
      expect(test.runtime.getOcr).not.toHaveBeenCalled();
    });

    it('shows the page progress of a running OCR capture and forgets it at the end', async () => {
      const test = setup([pdf()]);
      const status = new Subject<CaptureOperation>();
      test.runtime.createCapture.mockReturnValueOnce(of(ocrOperation('capture-1', 'extracting', { pagesDone: 1, pagesTotal: 3 })));
      test.runtime.getCapture.mockReturnValueOnce(status);
      vi.useFakeTimers();
      try {
        admit(test);
        expect(test.service.oneShotOperations().get(PDF_ID)).toMatchObject({ pagesDone: 1, pagesTotal: 3 });
        vi.advanceTimersByTime(700);
        status.next(ocrOperation('capture-1', 'failed'));
        status.complete();
      } finally {
        vi.useRealTimers();
      }
      await settle();

      expect(test.service.oneShotOperations().has(PDF_ID)).toBe(false);
      expect(test.library.rows.get(PDF_ID)?.status).toBe('failed');
    });

    it('polls a recording until it ends, reading only the events after the last one seen', async () => {
      const test = setup([recording()]);
      test.runtime.getCaptureEvents
        .mockReturnValueOnce(of([{ sequence: 4 }]))
        .mockReturnValueOnce(of([]));
      test.runtime.getCapture.mockReturnValueOnce(of(recordingOperation('capture-1', 'extracting')));

      await admitWithTimers(test, 500);

      expect(test.runtime.getCaptureEvents.mock.calls.map(([, after]) => after)).toEqual([0, 4]);
      expect(test.library.rows.get(RECORDING_ID)?.status).toBe('completed');
    });
  });
});

function setup(
  documents: readonly DesktopLibrarySummary[],
  options: {
    readonly ready?: boolean;
    readonly runtime?: Record<string, unknown>;
    readonly compute?: Partial<OcrComputePreflight>;
    readonly requirements?: () => readonly RuntimeRequirement[];
  } = {},
) {
  const library = durableLibrary(documents);
  const runtime = runtimeDouble(options);
  TestBed.configureTestingModule({
    providers: [
      { provide: DesktopLibraryService, useValue: library },
      { provide: DesktopRuntimeClientService, useValue: runtime },
    ],
  });
  const service = TestBed.inject(DesktopCaptureService);
  const libraryStore = TestBed.inject(LibraryStore);
  const host: DesktopCaptureHost = {
    selectedId: libraryStore.selectedId,
    requestedRequirements: signal<ReadonlySet<CaptureRequirementId>>(new Set()),
    requirements: () => options.requirements?.() ?? READY,
    refreshDocuments: () => libraryStore.refreshDocuments(),
    applyDocumentState: (summary) => libraryStore.applyDocumentState(summary),
    setMessage: vi.fn(),
  };
  TestBed.tick();
  library.list.mockClear();
  return { service, library, runtime, host, libraryStore };
}

/**
 * The library as the host stores it: one row per document. A write sets
 * status, stage, error and recovery fields from the update (an omitted one is
 * cleared), sets or clears the link (both together are refused), keeps raw
 * once written, and checks evidence: its status must equal the update's, or
 * be `completed` on an `awaiting_confirmation` checkpoint; completed evidence
 * must cover the stored page scope (all pages from 1 when none is stored)
 * and is write-once, failed evidence can be replaced. A refused write
 * changes nothing. The host lists the newest document first.
 */
function durableLibrary(initial: readonly DesktopLibrarySummary[]) {
  const rows = new Map(initial.map((row) => [row.documentId, row]));
  const evidence = new Map<string, OcrEvidenceV1>();
  const held: { readonly update: CaptureUpdate; readonly reply: Subject<DesktopLibrarySummary> }[] = [];
  const heldReads: Subject<readonly DesktopLibrarySummary[]>[] = [];
  const imported: string[] = [];
  let holdWhen: ((update: CaptureUpdate) => boolean) | undefined;
  let failWhen: ((update: CaptureUpdate) => boolean) | undefined;
  let holdAllReads = false;
  let holdReloads = false;
  /** Service reads (no abort signal) to let through before the one that is held, or undefined. */
  let holdServiceReadAfter: number | undefined;

  const store = (update: CaptureUpdate): DesktopLibrarySummary => {
    if (update.clearCaptureId && update.captureId !== undefined) {
      throw new Error('Capture library update cannot set and clear a runtime identifier together.');
    }
    const current = rows.get(update.documentId);
    if (!current) throw new Error('Capture library document was not found.');
    const incoming = update.ocrEvidence;
    if (incoming) {
      const matches = incoming.status === update.status
        || (update.status === 'awaiting_confirmation' && incoming.status === 'completed');
      if (!matches) throw new Error('OCR evidence status must match the terminal library update.');
      // `validate_evidence_requested_pages`: completed evidence covers the stored page scope.
      if (incoming.status === 'completed') {
        const options = current.captureOptions;
        const requested = options?.pdfPageNumbers
          ?? (options?.pdfPageCount ? Array.from({ length: options.pdfPageCount }, (_, index) => index + 1) : undefined);
        const pages = incoming.pages.map((page) => page.page);
        const covered = requested
          ? JSON.stringify(pages) === JSON.stringify(requested)
          : pages.every((page, index) => page === index + 1);
        if (!covered) throw new Error('OCR evidence pages do not match the requested pages.');
      }
      const existing = evidence.get(update.documentId);
      if (existing?.status === 'completed' && JSON.stringify(existing) !== JSON.stringify(incoming)) {
        throw new Error('OCR evidence is write-once and conflicts with existing evidence.');
      }
      // The host's `validate_current_provenance` is not repeated: `buildOcrEvidence`
      // refuses an earlier provenance before anything is written.
    }
    const next: DesktopLibrarySummary = {
      documentId: current.documentId,
      fileName: current.fileName,
      mediaType: current.mediaType,
      byteLength: current.byteLength,
      createdAtMs: current.createdAtMs,
      updatedAtMs: current.updatedAtMs + 1,
      captureOptions: current.captureOptions,
      status: update.status,
      stage: update.stage,
      captureId: update.clearCaptureId ? undefined : update.captureId ?? current.captureId,
      errorCode: update.errorCode,
      errorMessage: update.errorMessage,
      hasRaw: update.raw !== undefined || current.hasRaw === true,
    };
    if (incoming) evidence.set(update.documentId, incoming);
    rows.set(update.documentId, next);
    return next;
  };

  // The host lists the newest document first; `rows` keeps import order.
  const listed = (): readonly DesktopLibrarySummary[] => [...rows.values()].reverse();
  // The list store's reloads pass an abort signal; the capture service's reads do not.
  const list = vi.fn((_query?: string, _status?: string, abortSignal?: AbortSignal):
    Observable<readonly DesktopLibrarySummary[]> => {
    const serviceRead = abortSignal === undefined;
    let hold = holdAllReads || (holdReloads && !serviceRead);
    if (serviceRead && holdServiceReadAfter !== undefined) {
      if (holdServiceReadAfter === 0) {
        holdServiceReadAfter = undefined;
        hold = true;
      } else {
        holdServiceReadAfter -= 1;
      }
    }
    if (hold) {
      const reply = new Subject<readonly DesktopLibrarySummary[]>();
      heldReads.push(reply);
      return reply;
    }
    return defer(() => of(listed()));
  });
  const updateCapture = vi.fn((update: CaptureUpdate): Observable<DesktopLibrarySummary> => {
    if (failWhen?.(update)) return throwError(() => new Error(WRITE_FAILED));
    if (holdWhen?.(update)) {
      holdWhen = undefined;
      const reply = new Subject<DesktopLibrarySummary>();
      held.push({ update, reply });
      return reply;
    }
    return defer(() => of(store(update)));
  });

  return {
    rows,
    evidence,
    held,
    heldReads,
    imported,
    list,
    updateCapture,
    get: vi.fn((documentId: string) => defer(() => of(rows.get(documentId)))),
    importSelection: vi.fn((selection: DesktopSourceSelection) => defer(() => {
      const documentId = String(imported.length + 1).repeat(32);
      imported.push(documentId);
      const row = pdf({
        documentId, fileName: selection.fileName, mediaType: selection.mediaType, createdAtMs: 10 + imported.length,
      });
      rows.set(documentId, row);
      return of(row);
    })),
    writes: (): readonly CaptureUpdate[] => updateCapture.mock.calls.map(([update]) => update),
    holdNextWrite: (match: (update: CaptureUpdate) => boolean = () => true) => { holdWhen = match; },
    releaseHeldWrite: () => {
      const next = held.shift();
      if (!next) throw new Error('No write is held.');
      next.reply.next(store(next.update));
      next.reply.complete();
    },
    failWrites: (match: ((update: CaptureUpdate) => boolean) | undefined) => { failWhen = match; },
    holdReads: () => { holdAllReads = true; },
    /** Holds the list store's reloads: the displayed list stays as it is. */
    holdListReloads: () => { holdReloads = true; },
    /** Holds the capture service's next read, or the one after `skip` reads. */
    holdNextRead: (skip = 0) => {
      holdServiceReadAfter = skip;
      return {
        answer: () => {
          const reply = heldReads.shift();
          reply?.next(listed());
          reply?.complete();
        },
        fail: (error: Error) => heldReads.shift()?.error(error),
      };
    },
  };
}

function runtimeDouble(options: {
  readonly ready?: boolean;
  readonly runtime?: Record<string, unknown>;
  readonly compute?: Partial<OcrComputePreflight>;
}) {
  const ready = options.ready ?? true;
  const defaults = {
    ready: signal(ready),
    started: signal(ready),
    ocrCompute: signal<OcrComputePreflight | null>({
      apiVersion: '2.0',
      schemaVersion: '1',
      service: 'capture-runtime',
      runtimeVersion: RUNTIME_VERSION,
      contractSetVersion: '2',
      contractSetSha256: 'a'.repeat(64),
      workerSha256: 'f'.repeat(64),
      mode: 'gpu',
      adapterClass: 'dedicated',
      reasonCode: null,
      userNoticeRequired: false,
      noticeCode: null,
      ...options.compute,
    }),
    pdfPageNumbers: signal<readonly number[] | undefined>(undefined),
    cancelUpload: vi.fn<(clientRequestId: string) => Observable<void>>(() => of(undefined)),
    createCapture: vi.fn<(
      documentId: string,
      clientRequestId: string,
      pages?: readonly number[],
    ) => Observable<CaptureOperation>>(() => of(ocrOperation('capture-1', 'awaiting_structuring'))),
    startRecordingCapture: vi.fn<(input: Record<string, unknown>) => Observable<CaptureOperation>>(() =>
      of(recordingOperation('capture-1', 'extracting'))),
    getCapture: vi.fn((captureId: string): Observable<CaptureOperation> =>
      of(recordingOperation(captureId, 'completed'))),
    getCaptureEvents: vi.fn<(captureId: string, after?: number) => Observable<readonly { readonly sequence: number }[]>>(
      () => of([])),
    getPartial: vi.fn<(captureId: string) => Observable<unknown>>(() => of(null)),
    getResult: vi.fn((captureId: string): Observable<unknown> => of({
      operation: recordingOperation(captureId, 'completed'), raw: transcriptRaw, result: structuredResult,
    })),
    getRaw: vi.fn<(captureId: string) => Observable<unknown>>(() => of(ocrRaw)),
    getOcr: vi.fn((captureId: string): Observable<unknown> => of(ocrProjection(captureId, 'completed'))),
    deleteCapture: vi.fn<(captureId: string) => Observable<void>>(() => of(undefined)),
  };
  return Object.assign(defaults, options.runtime) as typeof defaults;
}

/** The row the list shows, as a queue or History reads it. */
function shown(test: ReturnType<typeof setup>, documentId: string): DesktopLibrarySummary {
  const row = test.libraryStore.allDocuments().find((document) => document.documentId === documentId);
  if (!row) throw new Error(`The list does not show ${documentId}.`);
  return row;
}

function lastWrite(test: ReturnType<typeof setup>): CaptureUpdate | undefined {
  const writes = test.library.writes();
  return writes[writes.length - 1];
}

function runtimeRequests(test: ReturnType<typeof setup>): readonly string[] {
  const { runtime } = test;
  return Object.entries({
    cancelUpload: runtime.cancelUpload,
    createCapture: runtime.createCapture,
    startRecordingCapture: runtime.startRecordingCapture,
    getCapture: runtime.getCapture,
    deleteCapture: runtime.deleteCapture,
  }).filter(([, request]) => request.mock.calls.length > 0).map(([name]) => name);
}

function finish(entry: Observable<void>): Promise<void> {
  return lastValueFrom(entry, { defaultValue: undefined }).then(() => settle());
}

const admissions: Subscription[] = [];
afterEach(() => admissions.splice(0).forEach((subscription) => subscription.unsubscribe()));

/**
 * Runs the admission as the app shell does and lets it look once. `look()`
 * stands for a change of the document list, the requirements or the
 * runtime's readiness.
 */
function admit(test: ReturnType<typeof setup>): { readonly look: () => void } {
  const changes = new Subject<void>();
  admissions.push(test.service.admitWaiting$(test.host, changes).subscribe());
  changes.next();
  return { look: () => changes.next() };
}

/** Runs the admission and lets what it started settle. */
async function admitAndSettle(test: ReturnType<typeof setup>): Promise<void> {
  admit(test);
  await settle();
}

/** Runs the admission while its capture waits for poll timers of `pollMs`. */
async function admitWithTimers(test: ReturnType<typeof setup>, pollMs: number): Promise<void> {
  vi.useFakeTimers();
  try {
    admit(test);
    for (let poll = 0; poll < 5 && test.service.busyIds().size > 0; poll += 1) {
      await vi.advanceTimersByTimeAsync(pollMs);
    }
  } finally {
    vi.useRealTimers();
  }
  await settle();
}

/** OCR evidence is hashed through a Promise: let it answer on real timers. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 25));
}

function pdf(overrides: Partial<DesktopLibrarySummary> = {}): DesktopLibrarySummary {
  return {
    documentId: PDF_ID,
    fileName: 'fixture.pdf',
    mediaType: 'application/pdf',
    byteLength: 12,
    createdAtMs: 1,
    updatedAtMs: 1,
    status: 'queued',
    stage: 'uploading',
    hasRaw: false,
    ...overrides,
  };
}

function recording(overrides: Partial<DesktopLibrarySummary> = {}): DesktopLibrarySummary {
  return pdf({ documentId: RECORDING_ID, fileName: 'meeting.m4a', mediaType: 'audio/mp4', ...overrides });
}

function selection(fileName: string): DesktopSourceSelection {
  const mediaType = fileName.endsWith('.m4a') ? 'audio/mp4' : 'application/pdf';
  return { selectionToken: fileName.padEnd(32, '0'), fileName, byteLength: 16, mediaType };
}

function requirement(requirementId: CaptureRequirementId, status: RuntimeRequirement['status']): RuntimeRequirement {
  return {
    requirementId,
    displayName: requirementId,
    status,
    kind: requirementId,
    requiredFor: ['capture'],
    installStrategy: 'runtime-catalog',
    detail: null,
    downloadBytes: null,
  } as RuntimeRequirement;
}

function partial(captureId: string) {
  return {
    protocolVersion: '2', captureId, revision: 1, sourceText: 'live words', updatedAt: '2026-07-20T00:00:00Z',
    source: { sha256: 'a'.repeat(64), fileName: 'meeting.m4a', mediaType: 'audio/mp4', bytes: 16 },
  };
}

function ocrOperation(
  captureId: string,
  status: CaptureOperation['status'],
  overrides: Partial<CaptureOperation> = {},
): CaptureOperation {
  return {
    protocolVersion: '2',
    ingestionId: 'ingestion-1',
    kind: 'pdf',
    partialRevision: 0,
    lastEventSequence: 0,
    createdAt: '2026-07-20T00:00:00Z',
    updatedAt: '2026-07-20T00:00:00Z',
    source: { sha256: 'a'.repeat(64), fileName: 'fixture.pdf', mediaType: 'application/pdf', bytes: 12 },
    captureId,
    status,
    ...overrides,
  };
}

function recordingOperation(captureId: string, status: CaptureOperation['status']): CaptureOperation {
  return ocrOperation(captureId, status, {
    kind: 'recording',
    source: { sha256: 'b'.repeat(64), fileName: 'meeting.m4a', mediaType: 'audio/mp4', bytes: 16 },
  });
}

function ocrProjection(captureId: string, status: 'completed' | 'failed'): CaptureOcrProjection {
  const provenance = {
    status: 'resolved' as const,
    engine: 'text-recognition' as const,
    model: 'ppocrv6-traditional-multilingual',
    modelDigest: `sha256:${'d'.repeat(64)}`,
    device: 'RTX4060',
    profileId: 'profile-1',
    profileSpecSha256: 'e'.repeat(64),
  };
  const raster = { width: 1200, height: 800, scale: 1, coordinateSystem: 'pixel' as const };
  const page = status === 'completed'
    ? {
      page: 1,
      status: 'recognized' as const,
      raster,
      text: 'OCR text',
      boxes: [{
        polygon: [{ x: 100, y: 120 }, { x: 220, y: 120 }, { x: 220, y: 160 }, { x: 100, y: 160 }],
        text: 'OCR text',
        confidence: 0.875,
      }],
      confidence: 0.875,
      provenance,
    }
    : {
      page: 1,
      status: 'failed' as const,
      raster,
      provenance,
      failure: { code: 'ocr_worker_failed', message: 'worker failed' },
    };
  return {
    apiVersion: '2.0',
    schemaVersion: '3',
    captureId,
    status,
    source: { sha256: 'a'.repeat(64), fileName: 'fixture.pdf', mediaType: 'application/pdf', bytes: 12 },
    pages: [page],
    processedPageCount: 1,
    runtimeVersion: RUNTIME_VERSION,
    contractSetSha256: 'a'.repeat(64),
    provenance,
    ...(status === 'failed' ? { failure: { code: 'ocr_worker_failed', message: 'worker failed' } } : {}),
    createdAt: '2026-07-20T00:00:00Z',
  };
}
