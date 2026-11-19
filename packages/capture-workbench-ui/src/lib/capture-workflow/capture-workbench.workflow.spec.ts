import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideCaptureWorkbenchInputs } from '../contracts';
import type {
  CaptureClient,
  CaptureEvent,
  CaptureStructuringProvider,
} from '../contracts';
import { Subject, of, throwError } from 'rxjs';
import { CaptureWorkbenchComponent } from './capture-workbench.component';
import {
  CaptureWorkbenchTestInputSource,
  DOCUMENT,
  captureWorkbenchRoot,
  createCaptureWorkbenchTestInputSource,
  fakeClient,
  selectFiles,
  streamingEvent,
  streamingOperation,
} from '../testing/capture-test-support';

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
    const startCapture = vi.fn<
      NonNullable<CaptureClient['startCapture']>
    >(
      () => of(streamingOperation('completed')),
    );
    const client = fakeClient({ startCapture });
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

    expect(startCapture).toHaveBeenCalledOnce();
    expect(client.getResult).toHaveBeenCalledWith(
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

  it('sends the configured PDF pages with PDF captures only', async () => {
    const startCapture = vi.fn<
      NonNullable<CaptureClient['startCapture']>
    >(
      () => of(streamingOperation('completed')),
    );
    inputSource.client.set(fakeClient({ startCapture }));
    inputSource.config.set({ showRuntimeSetup: false, pdfPageNumbers: [2, 5] });
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();
    selectFiles(fixture, [
      new File(['image'], 'photo.png', { type: 'image/png' }),
    ]);
    await fixture.whenStable();

    expect(startCapture.mock.calls[0][0].pdfPageNumbers).toEqual([2, 5]);
    expect(startCapture.mock.calls[1][0]).not.toHaveProperty('pdfPageNumbers');
  });

  it('consumes v2 SSE stages without timer polling', async () => {
    const events = new Subject<CaptureEvent>();
    const startCapture = vi.fn<
      NonNullable<CaptureClient['startCapture']>
    >(
      () => of(streamingOperation('extracting', 0.1)),
    );
    const captureEvents = vi.fn<NonNullable<CaptureClient['captureEvents']>>(() =>
      events.asObservable(),
    );
    const getCapture = vi.fn<
      NonNullable<CaptureClient['getCapture']>
    >(() =>
      of(streamingOperation('completed')),
    );
    const client = fakeClient({
      startCapture,
      captureEvents,
      getCapture,
    });
    inputSource.client.set(client);
    inputSource.config.set({ showRuntimeSetup: false, pollIntervalMs: 25_000 });
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'stream.pdf')]);
    await vi.waitFor(() => expect(captureEvents).toHaveBeenCalledOnce());

    events.next(streamingEvent('checkpoint', 'extracting'));
    fixture.detectChanges();
    expect(fixture.componentInstance.tasks()[0]?.stage).toBe('extracting');

    events.next(streamingEvent('completed', 'completed'));
    await fixture.whenStable();

    expect(getCapture).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
  });

  it('reloads the v2 snapshot and reconnects SSE after resync_required', async () => {
    const firstEvents = new Subject<CaptureEvent>();
    const secondEvents = new Subject<CaptureEvent>();
    let streamIndex = 0;
    const captureEvents = vi.fn<NonNullable<CaptureClient['captureEvents']>>(() =>
      (streamIndex++ === 0 ? firstEvents : secondEvents).asObservable(),
    );
    const resyncedOperation = {
      ...streamingOperation('extracting', 0.4),
      lastEventSequence: 7,
    };
    const getCapture = vi
      .fn<NonNullable<CaptureClient['getCapture']>>()
      .mockReturnValueOnce(of(resyncedOperation))
      .mockReturnValueOnce(of(streamingOperation('completed')));
    const client = fakeClient({
      startCapture: vi.fn(() => of(streamingOperation('extracting', 0.1))),
      captureEvents,
      getCapture,
    });
    inputSource.client.set(client);
    inputSource.config.set({ showRuntimeSetup: false });
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'resync.pdf')]);
    await vi.waitFor(() => expect(captureEvents).toHaveBeenCalledOnce());

    firstEvents.next(streamingEvent('resync_required', 'resync'));
    await vi.waitFor(() => expect(captureEvents).toHaveBeenCalledTimes(2));

    expect(client.getCapture).toHaveBeenCalledTimes(1);
    expect(client.getPartial).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(captureEvents).toHaveBeenNthCalledWith(
      2,
      'capture-1',
      expect.objectContaining({ lastEventId: 7 }),
    );

    secondEvents.next(streamingEvent('completed', 'completed'));
    await fixture.whenStable();

    expect(client.getCapture).toHaveBeenCalledTimes(2);
    expect(client.getResult).toHaveBeenCalledOnce();
  });

  it('aborts a v2 SSE subscription on cancellation and ignores late events', async () => {
    const events = new Subject<CaptureEvent>();
    const captureEvents = vi.fn<NonNullable<CaptureClient['captureEvents']>>(() =>
      events.asObservable(),
    );
    const client = fakeClient({
      startCapture: vi.fn(() => of(streamingOperation('extracting'))),
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
    events.next(streamingEvent('completed', 'completed'));
    await fixture.whenStable();

    expect(streamSignal?.aborted).toBe(true);
    expect(client.cancelCapture).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(fixture.componentInstance.tasks()[0]?.status).toBe('canceled');
    expect(client.getResult).not.toHaveBeenCalled();
  });

  it('retries uncertain v2 start with the same request object', async () => {
    const source = new File(['test'], 'retry.pdf', { type: 'application/pdf' });
    const startCapture = vi
      .fn<NonNullable<CaptureClient['startCapture']>>()
      .mockReturnValueOnce(throwError(() => new TypeError('connection reset')))
      .mockReturnValueOnce(of(streamingOperation('completed')));
    const client = fakeClient({ startCapture });
    inputSource.client.set(client);
    inputSource.config.set({ showRuntimeSetup: false });
    fixture.detectChanges();

    selectFiles(fixture, [source]);
    await fixture.whenStable();

    expect(startCapture).toHaveBeenCalledTimes(2);
    const firstRequest = startCapture.mock.calls[0]?.[0];
    const retryRequest = startCapture.mock.calls[1]?.[0];
    expect(firstRequest).toBe(retryRequest);
    expect(firstRequest?.clientRequestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(firstRequest?.file).toBe(source);
  });

  it('uses v2 raw, commit, and result APIs for component-owned structuring', async () => {
    const structure = vi.fn<CaptureStructuringProvider['structure']>(() =>
      of(DOCUMENT),
    );
    const startCapture = vi.fn<
      NonNullable<CaptureClient['startCapture']>
    >(
      () => of(streamingOperation('awaiting_structuring', 0.7)),
    );
    const commitStructure = vi.fn<
      NonNullable<CaptureClient['commitStructure']>
    >(() => of(streamingOperation('completed')));
    const client = fakeClient({
      startCapture,
      commitStructure,
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

    expect(client.getRaw).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(structure).toHaveBeenCalledOnce();
    expect(commitStructure).toHaveBeenCalledWith(
      'capture-1',
      expect.objectContaining({ candidate: DOCUMENT }),
      expect.any(AbortSignal),
    );
    expect(client.getResult).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledOnce();
  });

  it('keeps component-owned review in the RxJS boundary before v2 commit', async () => {
    const structure = vi.fn<CaptureStructuringProvider['structure']>(() =>
      of(DOCUMENT),
    );
    const client = fakeClient({
      startCapture: vi.fn(() =>
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
    expect(client.commitStructure).toHaveBeenCalledOnce();
  });
});
