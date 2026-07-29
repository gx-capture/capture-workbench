import { ComponentFixture, TestBed } from '@angular/core/testing';
import type {
  CaptureClient,
  CaptureDocumentV1,
  CaptureJobV1,
  CaptureStructuringProvider,
} from '../../../contracts';
import { provideCaptureWorkbenchInputs } from '../../../contracts';
import { Subject, map, of, throwError } from 'rxjs';
import { CaptureWorkbenchComponent } from './capture-angular';
import {
  CaptureWorkbenchTestInputSource,
  DOCUMENT,
  captureWorkbenchRoot,
  createCaptureWorkbenchTestInputSource,
  fakeClient,
  job,
  selectFiles,
} from './capture-angular-test-support';

describe('CaptureWorkbenchComponent', () => {
  let fixture: ComponentFixture<CaptureWorkbenchComponent>;
  let inputSource: CaptureWorkbenchTestInputSource;

  beforeEach(async () => {
    inputSource = createCaptureWorkbenchTestInputSource();
    await TestBed.configureTestingModule({
      imports: [CaptureWorkbenchComponent],
      providers: [provideCaptureWorkbenchInputs(inputSource)],
    }).compileComponents();
    fixture = TestBed.createComponent(CaptureWorkbenchComponent);
  });

  it('emits a runtime-validated canonical result', async () => {
    const client = fakeClient();
    const completed = vi.fn();
    inputSource.client.set(client);
    inputSource.config.set({
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.componentInstance.completed.subscribe(completed);
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(client.createCapture).toHaveBeenCalledOnce();
    expect(client.getResult).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(completed).toHaveBeenCalledWith({
      taskId: expect.any(String),
      document: DOCUMENT,
    });
    expect(
      captureWorkbenchRoot(fixture).querySelector('.result-preview')
        ?.textContent,
    ).toContain('page one');
  });

  it('polls queued jobs through rxResource until completion without overlap', async () => {
    const createCapture = vi
      .fn<CaptureClient['createCapture']>()
      .mockReturnValue(of(job('queued', 'queued')));
    const getCapture = vi
      .fn<CaptureClient['getCapture']>()
      .mockReturnValueOnce(of(job('running', 'extracting')))
      .mockReturnValueOnce(of(job('completed', 'completed')));
    const client = fakeClient({ createCapture, getCapture });
    inputSource.client.set(client);
    inputSource.config.set({
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'queued.pdf')]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(getCapture).toHaveBeenCalledTimes(2);
    expect(getCapture.mock.invocationCallOrder[0]).toBeLessThan(
      getCapture.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    );
    expect(fixture.componentInstance.tasks()[0]?.status).toBe('completed');
    expect(client.getResult).toHaveBeenCalledOnce();
  });

  it('stops host polling at awaiting_structuring and does not poll after commit', async () => {
    const createCapture = vi
      .fn<CaptureClient['createCapture']>()
      .mockReturnValue(of(job('running', 'extracting', 'host')));
    const getCapture = vi
      .fn<CaptureClient['getCapture']>()
      .mockReturnValue(of(job('running', 'awaiting_structuring', 'host')));
    const structure = vi.fn(() => of(DOCUMENT));
    const client = fakeClient({ createCapture, getCapture });
    inputSource.client.set(client);
    inputSource.structuringProvider.set({ structure });
    inputSource.config.set({
      showRuntimeSetup: false,
      structuringMode: 'host',
      pollIntervalMs: 0,
    });
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'host.pdf')]);
    await fixture.whenStable();

    expect(getCapture).toHaveBeenCalledOnce();
    expect(structure).toHaveBeenCalledOnce();
    expect(client.commitStructuredResult).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(client.getResult).toHaveBeenCalledOnce());
  });

  it('preserves runtime progress while entering component-owned structuring', async () => {
    const structureResult = new Subject<CaptureDocumentV1>();
    const structure = vi.fn<CaptureStructuringProvider['structure']>(
      () => structureResult,
    );
    const initialJob = {
      ...job('running', 'awaiting_structuring', 'host'),
      progress: 0.95,
    };
    const client = fakeClient({
      createCapture: vi.fn(() => of(initialJob)),
    });
    inputSource.client.set(client);
    inputSource.structuringProvider.set({ structure });
    inputSource.config.set({
      showRuntimeSetup: false,
      structuringMode: 'host',
      hostStructuringOwner: 'component',
      pollIntervalMs: 0,
    });
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'host-progress.pdf')]);
    await vi.waitFor(() => expect(structure).toHaveBeenCalledOnce());

    expect(fixture.componentInstance.tasks()[0]?.progress).toBe(95);
    structureResult.next(DOCUMENT);
    structureResult.complete();
    await fixture.whenStable();
  });

  it('cancels an in-flight rxResource poll without applying a late result', async () => {
    const pendingPoll = new Subject<CaptureJobV1>();
    const createCapture = vi
      .fn<CaptureClient['createCapture']>()
      .mockReturnValue(of(job('queued', 'queued')));
    const getCapture = vi.fn<CaptureClient['getCapture']>(() =>
      pendingPoll.asObservable(),
    );
    const client = fakeClient({ createCapture, getCapture });
    inputSource.client.set(client);
    inputSource.config.set({
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'cancel.pdf')]);
    await vi.waitFor(() => expect(getCapture).toHaveBeenCalledOnce());
    const taskId = fixture.componentInstance.tasks()[0]?.id;
    if (!taskId) throw new Error('Expected a capture task.');

    fixture.componentInstance.store.cancel(taskId);
    pendingPoll.next(job('completed', 'completed'));
    pendingPoll.complete();
    await fixture.whenStable();

    expect(fixture.componentInstance.tasks()[0]?.status).toBe('canceled');
    expect(client.getResult).not.toHaveBeenCalled();
    expect(getCapture.mock.calls[0]?.[1]?.aborted).toBe(true);
  });

  it('retries an uncertain capture creation with the same request and file', async () => {
    const source = new File(['test'], 'scan.pdf', {
      type: 'application/pdf',
    });
    const createCapture = vi
      .fn<CaptureClient['createCapture']>()
      .mockReturnValueOnce(throwError(() => new TypeError('connection reset')))
      .mockReturnValueOnce(of(job('completed', 'completed')));
    const client = fakeClient({ createCapture });
    inputSource.client.set(client);
    inputSource.config.set({
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.detectChanges();

    selectFiles(fixture, [source]);
    await fixture.whenStable();

    expect(createCapture).toHaveBeenCalledTimes(2);
    const firstRequest = createCapture.mock.calls[0]?.[0];
    const retryRequest = createCapture.mock.calls[1]?.[0];
    expect(firstRequest).toBe(retryRequest);
    expect(firstRequest?.clientRequestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(retryRequest?.clientRequestId).toBe(firstRequest?.clientRequestId);
    expect(firstRequest?.file).toBe(source);
    expect(retryRequest?.file).toBe(source);
    expect(client.getCapture).not.toHaveBeenCalled();
    expect(client.getResult).toHaveBeenCalledOnce();
  });

  it('does not retry capture creation after an abort response', async () => {
    const createCapture = vi
      .fn<CaptureClient['createCapture']>()
      .mockReturnValueOnce(
        throwError(
          () => new DOMException('The operation was aborted.', 'AbortError'),
        ),
      );
    const client = fakeClient({ createCapture });
    inputSource.client.set(client);
    inputSource.config.set({
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();

    expect(createCapture).toHaveBeenCalledOnce();
    expect(client.getCapture).not.toHaveBeenCalled();
    expect(client.getResult).not.toHaveBeenCalled();
    expect(fixture.componentInstance.tasks()[0]?.status).toBe('canceled');
  });

  it('does not retry a plain domain error from a custom capture client', async () => {
    const createCapture = vi
      .fn<CaptureClient['createCapture']>()
      .mockReturnValueOnce(
        throwError(() => new Error('host validation rejected the request')),
      );
    const client = fakeClient({ createCapture });
    inputSource.client.set(client);
    inputSource.config.set({
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();

    expect(createCapture).toHaveBeenCalledOnce();
    expect(client.getCapture).not.toHaveBeenCalled();
    expect(fixture.componentInstance.tasks()[0]?.status).toBe('failed');
  });

  it('keeps later files queued and supports canceling them', async () => {
    const preprocessing = new Subject<void>();
    const release = (): void => {
      preprocessing.next();
      preprocessing.complete();
    };
    const client = fakeClient();
    inputSource.client.set(client);
    inputSource.preprocessor.set({
      preprocess: vi.fn(({ file }) => preprocessing.pipe(map(() => file))),
    });
    inputSource.config.set({
      concurrency: 1,
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['1'], 'one.pdf'),
      new File(['2'], 'two.pdf'),
    ]);
    const second = fixture.componentInstance.tasks()[1];
    expect(second?.status).toBe('queued');
    if (!second) throw new Error('Expected the second task to be queued.');
    fixture.componentInstance.store.cancel(second.id);
    expect(fixture.componentInstance.tasks()[1]?.status).toBe('canceled');

    release();
    await fixture.whenStable();
    expect(client.createCapture).toHaveBeenCalledOnce();
  });

  it('pauses OCR at review, sends only edits on confirm, and emits completion afterward', async () => {
    const confirmCapture = vi
      .fn<NonNullable<CaptureClient['confirmCapture']>>()
      .mockReturnValue(of(job('completed', 'completed', 'host')));
    const createCapture = vi
      .fn<CaptureClient['createCapture']>()
      .mockReturnValue(of(job('running', 'extracting', 'host')));
    const getCapture = vi
      .fn<CaptureClient['getCapture']>()
      .mockReturnValue(of(job('running', 'awaiting_structuring', 'host')));
    const reviewRequired = vi.fn();
    const completed = vi.fn();
    const client = fakeClient({ createCapture, getCapture, confirmCapture });
    inputSource.client.set(client);
    inputSource.config.set({
      showRuntimeSetup: false,
      structuringMode: 'host',
      hostStructuringOwner: 'client',
      reviewBeforeCommit: true,
      reviewEditable: true,
      pollIntervalMs: 0,
    });
    fixture.componentInstance.reviewRequired.subscribe(reviewRequired);
    fixture.componentInstance.completed.subscribe(completed);
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'review.pdf')]);
    await vi.waitFor(() =>
      expect(fixture.componentInstance.tasks()[0]?.status).toBe(
        'awaiting_confirmation',
      ),
    );
    fixture.detectChanges();

    expect(client.getRaw).toHaveBeenCalledOnce();
    expect(confirmCapture).not.toHaveBeenCalled();
    expect(reviewRequired).toHaveBeenCalledOnce();
    expect(completed).not.toHaveBeenCalled();
    const textarea = captureWorkbenchRoot(fixture).querySelector(
      '.ocr-review textarea',
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe('page one');
    const valueSetter = vi.spyOn(HTMLTextAreaElement.prototype, 'value', 'set');
    const defaultValueSetter = vi.spyOn(
      HTMLTextAreaElement.prototype,
      'defaultValue',
      'set',
    );
    textarea.value = 'page one corrected';
    valueSetter.mockClear();
    defaultValueSetter.mockClear();
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(valueSetter).not.toHaveBeenCalled();
    expect(defaultValueSetter).not.toHaveBeenCalled();
    (
      captureWorkbenchRoot(fixture).querySelector(
        '.ocr-review .primary',
      ) as HTMLButtonElement
    ).click();
    valueSetter.mockRestore();
    defaultValueSetter.mockRestore();

    await vi.waitFor(() => expect(confirmCapture).toHaveBeenCalledOnce());
    expect(confirmCapture.mock.calls[0]?.[1]).toMatchObject({
      clientRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      review: {
        reviewVersion: 1,
        edits: [{ segmentId: 'segment-1', reviewedText: 'page one corrected' }],
      },
    });
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
  });

  it('waits for review before component-owned host structuring', async () => {
    const structure = vi.fn<CaptureStructuringProvider['structure']>(() =>
      of(DOCUMENT),
    );
    const client = fakeClient({
      createCapture: vi.fn(() =>
        of(job('running', 'awaiting_structuring', 'host')),
      ),
    });
    inputSource.client.set(client);
    inputSource.structuringProvider.set({ structure });
    inputSource.config.set({
      showRuntimeSetup: false,
      structuringMode: 'host',
      hostStructuringOwner: 'component',
      reviewBeforeCommit: true,
      reviewEditable: true,
      pollIntervalMs: 0,
    });
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'component-review.pdf')]);
    await vi.waitFor(() =>
      expect(fixture.componentInstance.tasks()[0]?.status).toBe(
        'awaiting_confirmation',
      ),
    );
    expect(structure).not.toHaveBeenCalled();

    const taskId = fixture.componentInstance.tasks()[0]?.id;
    if (!taskId) throw new Error('Expected review task.');
    fixture.componentInstance.store.updateReview(
      taskId,
      'segment-1',
      'component corrected',
    );
    fixture.componentInstance.store.confirm(taskId);

    await vi.waitFor(() => expect(structure).toHaveBeenCalledOnce());
    expect(structure.mock.calls[0]?.[0]).toMatchObject({
      review: {
        reviewVersion: 1,
        edits: [
          { segmentId: 'segment-1', reviewedText: 'component corrected' },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(client.commitStructuredResult).toHaveBeenCalledOnce(),
    );
  });

  it('cancels a client-owned review while awaiting confirmation', async () => {
    const confirmCapture = vi
      .fn<NonNullable<CaptureClient['confirmCapture']>>()
      .mockReturnValue(of(job('completed', 'completed', 'host')));
    const cancelCapture = vi.fn(() =>
      of(job('cancelled', 'cancelled', 'host')),
    );
    const client = fakeClient({
      createCapture: vi.fn(() => of(job('running', 'extracting', 'host'))),
      getCapture: vi.fn(() =>
        of(job('running', 'awaiting_structuring', 'host')),
      ),
      cancelCapture,
      confirmCapture,
    });
    inputSource.client.set(client);
    inputSource.config.set({
      showRuntimeSetup: false,
      structuringMode: 'host',
      hostStructuringOwner: 'client',
      reviewBeforeCommit: true,
      reviewEditable: true,
      pollIntervalMs: 0,
    });
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'discard-review.pdf')]);
    await vi.waitFor(() =>
      expect(fixture.componentInstance.tasks()[0]?.status).toBe(
        'awaiting_confirmation',
      ),
    );

    (
      captureWorkbenchRoot(fixture).querySelector(
        '.ocr-review .secondary',
      ) as HTMLButtonElement
    ).click();
    await fixture.whenStable();

    expect(fixture.componentInstance.tasks()[0]?.status).toBe('canceled');
    expect(cancelCapture).toHaveBeenCalledOnce();
    expect(confirmCapture).not.toHaveBeenCalled();
  });

  it('rejects an empty review edit without confirming the capture', async () => {
    const confirmCapture = vi
      .fn<NonNullable<CaptureClient['confirmCapture']>>()
      .mockReturnValue(of(job('completed', 'completed', 'host')));
    const createCapture = vi
      .fn<CaptureClient['createCapture']>()
      .mockReturnValue(of(job('running', 'extracting', 'host')));
    const getCapture = vi
      .fn<CaptureClient['getCapture']>()
      .mockReturnValue(of(job('running', 'awaiting_structuring', 'host')));
    const client = fakeClient({ createCapture, getCapture, confirmCapture });
    inputSource.client.set(client);
    inputSource.config.set({
      showRuntimeSetup: false,
      structuringMode: 'host',
      hostStructuringOwner: 'client',
      reviewBeforeCommit: true,
      reviewEditable: true,
      pollIntervalMs: 0,
    });
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'review-invalid.pdf')]);
    await vi.waitFor(() =>
      expect(fixture.componentInstance.tasks()[0]?.status).toBe(
        'awaiting_confirmation',
      ),
    );
    const taskId = fixture.componentInstance.tasks()[0]?.id;
    if (!taskId) throw new Error('Expected review task.');
    fixture.componentInstance.store.updateReview(taskId, 'segment-1', '   ');
    fixture.componentInstance.store.confirm(taskId);

    expect(confirmCapture).not.toHaveBeenCalled();
    expect(fixture.componentInstance.tasks()[0]?.status).toBe(
      'awaiting_confirmation',
    );
    expect(fixture.componentInstance.tasks()[0]?.error?.code).toBe(
      'invalid_review',
    );
  });
});
