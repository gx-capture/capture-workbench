import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideCaptureWorkbenchInputs } from '../../../contracts';
import type {
  CaptureClient,
  CaptureEventV2,
  CaptureStructuringProvider,
} from '../../../contracts';
import { Subject, of, throwError } from 'rxjs';
import { CaptureWorkbenchComponent } from './capture-angular';
import {
  CaptureWorkbenchTestInputSource,
  DOCUMENT,
  captureWorkbenchRoot,
  createCaptureWorkbenchTestInputSource,
  fakeClient,
  selectFiles,
  streamingEvent,
  streamingOperation,
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

  it('completes through the v2 streaming result boundary', async () => {
    const startStreamingCapture = vi.fn<
      NonNullable<CaptureClient['startStreamingCapture']>
    >(
      () => of(streamingOperation('completed')),
    );
    const client = fakeClient({ startStreamingCapture });
    const completed = vi.fn();
    inputSource.client.set(client);
    inputSource.config.set({ showRuntimeSetup: false });
    fixture.componentInstance.completed.subscribe(completed);
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(startStreamingCapture).toHaveBeenCalledOnce();
    expect(client.getStreamingResult).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(completed).toHaveBeenCalledWith({
      taskId: expect.any(String),
      document: DOCUMENT,
    });
    expect(
      captureWorkbenchRoot(fixture).querySelector('[data-testid="capture-result"]')
        ?.textContent,
    ).toContain('page one');
  });

  it('reduces v2 SSE progress without timer polling', async () => {
    const events = new Subject<CaptureEventV2>();
    const startStreamingCapture = vi.fn<
      NonNullable<CaptureClient['startStreamingCapture']>
    >(
      () => of(streamingOperation('extracting', 0.1)),
    );
    const captureEvents = vi.fn<NonNullable<CaptureClient['captureEvents']>>(() =>
      events.asObservable(),
    );
    const getStreamingCapture = vi.fn<
      NonNullable<CaptureClient['getStreamingCapture']>
    >(() =>
      of(streamingOperation('completed')),
    );
    const client = fakeClient({
      startStreamingCapture,
      captureEvents,
      getStreamingCapture,
    });
    inputSource.client.set(client);
    inputSource.config.set({ showRuntimeSetup: false, pollIntervalMs: 25_000 });
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'stream.pdf')]);
    await vi.waitFor(() => expect(captureEvents).toHaveBeenCalledOnce());

    events.next(streamingEvent('checkpoint', 'extracting', 0.55));
    fixture.detectChanges();
    expect(fixture.componentInstance.tasks()[0]?.progress).toBeCloseTo(55);

    events.next(streamingEvent('completed', 'completed', 1));
    await fixture.whenStable();

    expect(getStreamingCapture).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
  });

  it('reloads the v2 snapshot and reconnects SSE after resync_required', async () => {
    const firstEvents = new Subject<CaptureEventV2>();
    const secondEvents = new Subject<CaptureEventV2>();
    let streamIndex = 0;
    const captureEvents = vi.fn<NonNullable<CaptureClient['captureEvents']>>(() =>
      (streamIndex++ === 0 ? firstEvents : secondEvents).asObservable(),
    );
    const resyncedOperation = {
      ...streamingOperation('extracting', 0.4),
      lastEventSequence: 7,
    };
    const getStreamingCapture = vi
      .fn<NonNullable<CaptureClient['getStreamingCapture']>>()
      .mockReturnValueOnce(of(resyncedOperation))
      .mockReturnValueOnce(of(streamingOperation('completed')));
    const client = fakeClient({
      startStreamingCapture: vi.fn(() => of(streamingOperation('extracting', 0.1))),
      captureEvents,
      getStreamingCapture,
    });
    inputSource.client.set(client);
    inputSource.config.set({ showRuntimeSetup: false });
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'resync.pdf')]);
    await vi.waitFor(() => expect(captureEvents).toHaveBeenCalledOnce());

    firstEvents.next(streamingEvent('resync_required', 'resync'));
    await vi.waitFor(() => expect(captureEvents).toHaveBeenCalledTimes(2));

    expect(client.getStreamingCapture).toHaveBeenCalledTimes(1);
    expect(client.getStreamingPartial).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(captureEvents).toHaveBeenNthCalledWith(
      2,
      'capture-1',
      expect.objectContaining({ lastEventId: 7 }),
    );

    secondEvents.next(streamingEvent('completed', 'completed', 1));
    await fixture.whenStable();

    expect(client.getStreamingCapture).toHaveBeenCalledTimes(2);
    expect(client.getStreamingResult).toHaveBeenCalledOnce();
  });

  it('reloads the v2 snapshot and reconnects after a nonterminal SSE completion', async () => {
    const firstEvents = new Subject<CaptureEventV2>();
    const secondEvents = new Subject<CaptureEventV2>();
    let streamIndex = 0;
    const captureEvents = vi.fn<NonNullable<CaptureClient['captureEvents']>>(() =>
      (streamIndex++ === 0 ? firstEvents : secondEvents).asObservable(),
    );
    const recoveredOperation = {
      ...streamingOperation('extracting', 0.4),
      lastEventSequence: 7,
    };
    const getStreamingCapture = vi
      .fn<NonNullable<CaptureClient['getStreamingCapture']>>()
      .mockReturnValueOnce(of(recoveredOperation))
      .mockReturnValueOnce(of(streamingOperation('completed')));
    const client = fakeClient({
      startStreamingCapture: vi.fn(() => of(streamingOperation('extracting', 0.1))),
      captureEvents,
      getStreamingCapture,
    });
    inputSource.client.set(client);
    inputSource.config.set({ showRuntimeSetup: false });
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'stream-close.pdf')]);
    await vi.waitFor(() => expect(captureEvents).toHaveBeenCalledOnce());

    firstEvents.next(streamingEvent('checkpoint', 'extracting', 0.4));
    firstEvents.complete();
    await vi.waitFor(() => expect(captureEvents).toHaveBeenCalledTimes(2));

    expect(captureEvents).toHaveBeenNthCalledWith(
      2,
      'capture-1',
      expect.objectContaining({ lastEventId: 7 }),
    );
    secondEvents.next(streamingEvent('completed', 'completed', 1));
    await fixture.whenStable();

    expect(client.getStreamingResult).toHaveBeenCalledOnce();
  });

  it('reloads the v2 snapshot and reconnects after a recoverable SSE error', async () => {
    const secondEvents = new Subject<CaptureEventV2>();
    const captureEvents = vi
      .fn<NonNullable<CaptureClient['captureEvents']>>()
      .mockReturnValueOnce(throwError(() => new Error('stream reset')))
      .mockReturnValueOnce(secondEvents.asObservable());
    const recoveredOperation = {
      ...streamingOperation('extracting', 0.4),
      lastEventSequence: 7,
    };
    const getStreamingCapture = vi
      .fn<NonNullable<CaptureClient['getStreamingCapture']>>()
      .mockReturnValueOnce(of(recoveredOperation))
      .mockReturnValueOnce(of(streamingOperation('completed')));
    const client = fakeClient({
      startStreamingCapture: vi.fn(() => of(streamingOperation('extracting', 0.1))),
      captureEvents,
      getStreamingCapture,
    });
    inputSource.client.set(client);
    inputSource.config.set({ showRuntimeSetup: false });
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'stream-error.pdf')]);
    await vi.waitFor(() => expect(captureEvents).toHaveBeenCalledTimes(2));

    expect(captureEvents).toHaveBeenNthCalledWith(
      2,
      'capture-1',
      expect.objectContaining({ lastEventId: 7 }),
    );
    secondEvents.next(streamingEvent('completed', 'completed', 1));
    await fixture.whenStable();

    expect(client.getStreamingResult).toHaveBeenCalledOnce();
  });

  it('aborts a v2 SSE subscription on cancellation and ignores late events', async () => {
    const events = new Subject<CaptureEventV2>();
    const captureEvents = vi.fn<NonNullable<CaptureClient['captureEvents']>>(() =>
      events.asObservable(),
    );
    const client = fakeClient({
      startStreamingCapture: vi.fn(() => of(streamingOperation('extracting'))),
      captureEvents,
    });
    inputSource.client.set(client);
    inputSource.config.set({ showRuntimeSetup: false });
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'cancel.pdf')]);
    await vi.waitFor(() => expect(captureEvents).toHaveBeenCalledOnce());
    const taskId = fixture.componentInstance.tasks()[0]?.id;
    if (!taskId) throw new Error('Expected a capture task.');
    const streamSignal = captureEvents.mock.calls[0]?.[1]?.signal;

    fixture.componentInstance.store.cancel(taskId);
    events.next(streamingEvent('completed', 'completed', 1));
    await fixture.whenStable();

    expect(streamSignal?.aborted).toBe(true);
    expect(client.cancelStreamingCapture).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(fixture.componentInstance.tasks()[0]?.status).toBe('canceled');
    expect(client.getStreamingResult).not.toHaveBeenCalled();
  });

  it('keeps cancellation recoverable when the runtime cancel response fails', async () => {
    const events = new Subject<CaptureEventV2>();
    const captureEvents = vi.fn<NonNullable<CaptureClient['captureEvents']>>(() =>
      events.asObservable(),
    );
    const client = fakeClient({
      startStreamingCapture: vi.fn(() => of(streamingOperation('extracting'))),
      captureEvents,
      cancelStreamingCapture: vi.fn(() =>
        throwError(() => new Error('cancel transport failed')),
      ),
    });
    inputSource.client.set(client);
    inputSource.config.set({ showRuntimeSetup: false });
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'cancel-recovery.pdf')]);
    await vi.waitFor(() => expect(captureEvents).toHaveBeenCalledOnce());
    const taskId = fixture.componentInstance.tasks()[0]?.id;
    if (!taskId) throw new Error('Expected a capture task.');

    fixture.componentInstance.store.cancel(taskId);
    await vi.waitFor(() =>
      expect(fixture.componentInstance.tasks()[0]?.status).toBe('reconciliation_required'),
    );

    expect(fixture.componentInstance.tasks()[0]?.error).toMatchObject({
      code: 'capture_cancel_failed',
      stage: 'runtime',
      retryable: true,
    });
    expect(fixture.componentInstance.tasks()[0]?.status).not.toBe('canceled');
  });

  it('retries uncertain v2 start with the same request object', async () => {
    const source = new File(['test'], 'retry.pdf', { type: 'application/pdf' });
    const startStreamingCapture = vi
      .fn<NonNullable<CaptureClient['startStreamingCapture']>>()
      .mockReturnValueOnce(throwError(() => new TypeError('connection reset')))
      .mockReturnValueOnce(of(streamingOperation('completed')));
    const client = fakeClient({ startStreamingCapture });
    inputSource.client.set(client);
    inputSource.config.set({ showRuntimeSetup: false });
    fixture.detectChanges();

    selectFiles(fixture, [source]);
    await fixture.whenStable();

    expect(startStreamingCapture).toHaveBeenCalledTimes(2);
    const firstRequest = startStreamingCapture.mock.calls[0]?.[0];
    const retryRequest = startStreamingCapture.mock.calls[1]?.[0];
    expect(firstRequest).toBe(retryRequest);
    expect(firstRequest?.clientRequestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(firstRequest?.file).toBe(source);
  });

  it('uses v2 partial, commit, and result APIs for component-owned structuring', async () => {
    const structure = vi.fn<CaptureStructuringProvider['structure']>(() =>
      of(DOCUMENT),
    );
    const startStreamingCapture = vi.fn<
      NonNullable<CaptureClient['startStreamingCapture']>
    >(
      () => of(streamingOperation('awaiting_structuring', 0.7)),
    );
    const commitStreamingStructuredResult = vi.fn<
      NonNullable<CaptureClient['commitStreamingStructuredResult']>
    >(() => of(streamingOperation('completed')));
    const client = fakeClient({
      startStreamingCapture,
      commitStreamingStructuredResult,
    });
    const completed = vi.fn();
    inputSource.client.set(client);
    inputSource.structuringProvider.set({ structure });
    inputSource.config.set({
      showRuntimeSetup: false,
      structuringMode: 'host',
      hostStructuringOwner: 'component',
    });
    fixture.componentInstance.completed.subscribe(completed);
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'host.pdf')]);
    await fixture.whenStable();

    expect(client.getStreamingPartial).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(structure).toHaveBeenCalledOnce();
    expect(commitStreamingStructuredResult).toHaveBeenCalledWith(
      'capture-1',
      expect.objectContaining({ candidate: DOCUMENT }),
      expect.any(AbortSignal),
    );
    expect(client.getStreamingResult).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledOnce();
  });

  it('keeps component-owned review in the RxJS boundary before v2 commit', async () => {
    const structure = vi.fn<CaptureStructuringProvider['structure']>(() =>
      of(DOCUMENT),
    );
    const client = fakeClient({
      startStreamingCapture: vi.fn(() =>
        of(streamingOperation('awaiting_structuring', 0.7)),
      ),
    });
    const reviewRequired = vi.fn();
    inputSource.client.set(client);
    inputSource.structuringProvider.set({ structure });
    inputSource.config.set({
      showRuntimeSetup: false,
      structuringMode: 'host',
      hostStructuringOwner: 'component',
      reviewBeforeCommit: true,
      reviewEditable: true,
    });
    fixture.componentInstance.reviewRequired.subscribe(reviewRequired);
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'review.pdf')]);
    await vi.waitFor(() =>
      expect(fixture.componentInstance.tasks()[0]?.status).toBe(
        'awaiting_confirmation',
      ),
    );
    const taskId = fixture.componentInstance.tasks()[0]?.id;
    if (!taskId) throw new Error('Expected a review task.');

    fixture.componentInstance.store.updateReview(
      taskId,
      'segment-1',
      'page one corrected',
    );
    fixture.componentInstance.store.confirm(taskId);
    await fixture.whenStable();

    expect(reviewRequired).toHaveBeenCalledOnce();
    expect(structure).toHaveBeenCalledWith(
      expect.objectContaining({
        review: {
          reviewVersion: 1,
          edits: [
            { segmentId: 'segment-1', reviewedText: 'page one corrected' },
          ],
        },
      }),
    );
    expect(client.commitStreamingStructuredResult).toHaveBeenCalledOnce();
  });

  it('rejects client-owned review before starting a v2 capture', async () => {
    const startStreamingCapture = vi.fn<
      NonNullable<CaptureClient['startStreamingCapture']>
    >(() => of(streamingOperation('completed')));
    const client = fakeClient({ startStreamingCapture });
    inputSource.client.set(client);
    inputSource.config.set({
      showRuntimeSetup: false,
      structuringMode: 'host',
      hostStructuringOwner: 'client',
      reviewBeforeCommit: true,
    });
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'client-review.pdf')]);
    await fixture.whenStable();

    expect(startStreamingCapture).not.toHaveBeenCalled();
    expect(fixture.componentInstance.tasks()[0]).toMatchObject({
      status: 'failed',
      error: {
        code: 'review_requires_component_structuring',
      },
    });
  });
});
