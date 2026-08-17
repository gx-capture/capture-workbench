import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { CaptureHelpersService } from '../../../capture-helpers';
import { DEFAULT_CAPTURE_WORKBENCH_CONFIG } from '../../../constants/workbench';
import type {
  CaptureClient,
  CaptureEvent,
  CaptureOperation,
  CaptureStructuringProvider,
} from '../../../contracts';
import { CaptureReconciliationService } from '../capture-reconciliation/capture-reconciliation.service';
import { CaptureWorkbenchStoreHelpers } from '../capture-workbench-store/capture-workbench-store-helpers';
import {
  DOCUMENT,
  PARTIAL,
  fakeClient,
  streamingEvent,
  streamingOperation,
} from '../../components/capture-angular/capture-angular-test-support';
import { CaptureWorkflowService } from './capture-workflow.service';

describe('CaptureWorkflowService', () => {
  let workflow: CaptureWorkflowService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        CaptureWorkflowService,
        CaptureReconciliationService,
        CaptureHelpersService,
        CaptureWorkbenchStoreHelpers,
      ],
    });
    workflow = TestBed.inject(CaptureWorkflowService);
  });

  function configure(
    client: CaptureClient,
    overrides: Partial<typeof DEFAULT_CAPTURE_WORKBENCH_CONFIG> = {},
    structuringProvider: CaptureStructuringProvider | null = null,
  ): void {
    workflow.configure({
      config: () => ({ ...DEFAULT_CAPTURE_WORKBENCH_CONFIG, ...overrides }),
      client: () => client,
      structuringProvider: () => structuringProvider,
      preprocessor: () => null,
    });
  }

  it('keeps queued captures behind the configured concurrency limit', async () => {
    const firstEvents = new Subject<CaptureEvent>();
    const secondEvents = new Subject<CaptureEvent>();
    let streamIndex = 0;
    const startStreamingCapture = vi.fn(() =>
      of(streamingOperation('extracting')),
    );
    const captureEvents = vi.fn<NonNullable<CaptureClient['captureEvents']>>(
      () => (streamIndex++ === 0 ? firstEvents : secondEvents).asObservable(),
    );
    const client = fakeClient({ startStreamingCapture, captureEvents });
    configure(client, { concurrency: 1 });

    workflow.enqueueFiles([
      new File(['first'], 'first.pdf', { type: 'application/pdf' }),
      new File(['second'], 'second.pdf', { type: 'application/pdf' }),
    ]);

    await vi.waitFor(() => expect(captureEvents).toHaveBeenCalledOnce());
    expect(startStreamingCapture).toHaveBeenCalledOnce();
    expect(workflow.tasks().map((task) => task.status)).toEqual([
      'processing',
      'queued',
    ]);

    firstEvents.next(streamingEvent('completed', 'completed'));
    await vi.waitFor(() => expect(startStreamingCapture).toHaveBeenCalledTimes(2));
    expect(workflow.tasks().map((task) => task.status)).toEqual([
      'completed',
      'processing',
    ]);

    secondEvents.next(streamingEvent('completed', 'completed'));
    await vi.waitFor(() =>
      expect(workflow.tasks().map((task) => task.status)).toEqual([
        'completed',
        'completed',
      ]),
    );
    expect(client.getStreamingResult).toHaveBeenCalledTimes(2);
  });

  it('completes a capture through the public workflow facade', async () => {
    const client = fakeClient({
      startStreamingCapture: vi.fn(() => of(streamingOperation('completed'))),
    });
    const completed = vi.fn();
    workflow.events.subscribe((event) => {
      if (event.type === 'completed') completed(event.event);
    });
    configure(client);

    workflow.enqueueFiles([
      new File(['pdf'], 'scan.pdf', { type: 'application/pdf' }),
    ]);

    await vi.waitFor(() =>
      expect(workflow.tasks()[0]).toEqual(
        expect.objectContaining({ status: 'completed', stage: 'completed' }),
      ),
    );
    expect(client.startStreamingCapture).toHaveBeenCalledOnce();
    expect(client.getStreamingResult).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({ document: DOCUMENT }),
    );
  });

  it('resynchronizes the public workflow after a resync_required event', async () => {
    const firstEvents = new Subject<CaptureEvent>();
    const secondEvents = new Subject<CaptureEvent>();
    let streamIndex = 0;
    const captureEvents = vi.fn<NonNullable<CaptureClient['captureEvents']>>(
      () => (streamIndex++ === 0 ? firstEvents : secondEvents).asObservable(),
    );
    const getStreamingCapture = vi
      .fn<NonNullable<CaptureClient['getStreamingCapture']>>()
      .mockReturnValueOnce(
        of({ ...streamingOperation('extracting', 0.4), lastEventSequence: 7 }),
      )
      .mockReturnValueOnce(of(streamingOperation('completed')));
    const client = fakeClient({
      startStreamingCapture: vi.fn(() =>
        of(streamingOperation('extracting', 0.1)),
      ),
      captureEvents,
      getStreamingCapture,
      getStreamingPartial: vi.fn(() => of(PARTIAL)),
    });
    configure(client);

    workflow.enqueueFiles([new File(['pdf'], 'resync.pdf')]);
    await vi.waitFor(() => expect(captureEvents).toHaveBeenCalledOnce());

    firstEvents.next(streamingEvent('resync_required', 'resync'));
    await vi.waitFor(() => expect(captureEvents).toHaveBeenCalledTimes(2));
    expect(client.getStreamingPartial).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(captureEvents).toHaveBeenNthCalledWith(
      2,
      'capture-1',
      expect.objectContaining({ lastEventId: 7 }),
    );

    secondEvents.next(streamingEvent('completed', 'completed'));
    await vi.waitFor(() =>
      expect(workflow.tasks()[0]?.status).toBe('completed'),
    );
    expect(client.getStreamingResult).toHaveBeenCalledOnce();
  });

  it('cancels an active capture and ignores a late terminal event', async () => {
    const events = new Subject<CaptureEvent>();
    const captureEvents = vi.fn<NonNullable<CaptureClient['captureEvents']>>(
      () => events.asObservable(),
    );
    const client = fakeClient({
      startStreamingCapture: vi.fn(() =>
        of(streamingOperation('extracting')),
      ),
      captureEvents,
    });
    const canceled = vi.fn();
    workflow.events.subscribe((event) => {
      if (event.type === 'canceled') canceled(event.task);
    });
    configure(client);

    workflow.enqueueFiles([new File(['pdf'], 'cancel.pdf')]);
    await vi.waitFor(() => expect(captureEvents).toHaveBeenCalledOnce());
    const taskId = workflow.tasks()[0]?.id;
    if (!taskId) throw new Error('Expected a capture task.');
    const streamSignal = captureEvents.mock.calls[0]?.[1]?.signal;

    workflow.cancel(taskId);
    expect(workflow.tasks()[0]).toEqual(
      expect.objectContaining({ status: 'canceled', stage: 'cancelled' }),
    );
    expect(streamSignal?.aborted).toBe(true);
    expect(client.cancelStreamingCapture).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(canceled).toHaveBeenCalledWith(
      expect.objectContaining({ id: taskId, status: 'canceled' }),
    );

    events.next(streamingEvent('completed', 'completed'));
    await vi.waitFor(() =>
      expect(workflow.tasks()[0]?.status).toBe('canceled'),
    );
    expect(client.getStreamingResult).not.toHaveBeenCalled();
  });

  it('retries an uncertain start through the public enqueue seam', async () => {
    const source = new File(['pdf'], 'retry.pdf', { type: 'application/pdf' });
    const startStreamingCapture = vi
      .fn<NonNullable<CaptureClient['startStreamingCapture']>>()
      .mockReturnValueOnce(throwError(() => new TypeError('connection reset')))
      .mockReturnValueOnce(of(streamingOperation('completed')));
    const client = fakeClient({ startStreamingCapture });
    configure(client);

    workflow.enqueueFiles([source]);
    await vi.waitFor(() =>
      expect(workflow.tasks()[0]?.status).toBe('completed'),
    );

    expect(startStreamingCapture).toHaveBeenCalledTimes(2);
    const firstRequest = startStreamingCapture.mock.calls[0]?.[0];
    const retryRequest = startStreamingCapture.mock.calls[1]?.[0];
    expect(firstRequest).toBe(retryRequest);
    expect(firstRequest?.file).toBe(source);
    expect(firstRequest?.clientRequestId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('removes a completed capture through the configured client seam', async () => {
    const client = fakeClient({
      startStreamingCapture: vi.fn(() =>
        of(streamingOperation('completed')),
      ),
    });
    configure(client);

    workflow.enqueueFiles([new File(['pdf'], 'remove.pdf')]);
    await vi.waitFor(() =>
      expect(workflow.tasks()[0]?.status).toBe('completed'),
    );
    const taskId = workflow.tasks()[0]?.id;
    if (!taskId) throw new Error('Expected a completed capture task.');

    workflow.remove(taskId);
    await vi.waitFor(() => expect(workflow.tasks()).toHaveLength(0));

    expect(client.deleteStreamingCapture).toHaveBeenCalledWith('capture-1');
  });

  it('holds host structuring for review and completes after confirmation', async () => {
    const structure = vi.fn<CaptureStructuringProvider['structure']>(() =>
      of(DOCUMENT),
    );
    const client = fakeClient({
      startStreamingCapture: vi.fn(() =>
        of(streamingOperation('awaiting_structuring', 0.7)),
      ),
    });
    const reviewRequired = vi.fn();
    workflow.events.subscribe((event) => {
      if (event.type === 'review-required') reviewRequired(event.task);
    });
    configure(
      client,
      {
        structuringMode: 'host',
        hostStructuringOwner: 'component',
        reviewBeforeCommit: true,
        reviewEditable: true,
      },
      { structure },
    );

    workflow.enqueueFiles([new File(['pdf'], 'review.pdf')]);
    await vi.waitFor(() =>
      expect(workflow.tasks()[0]?.status).toBe('awaiting_confirmation'),
    );
    const taskId = workflow.tasks()[0]?.id;
    if (!taskId) throw new Error('Expected a review task.');

    workflow.updateReview(taskId, 'segment-1', 'page one corrected');
    expect(workflow.tasks()[0]?.review).toEqual({
      reviewVersion: 1,
      edits: [
        { segmentId: 'segment-1', reviewedText: 'page one corrected' },
      ],
    });

    workflow.confirm(taskId);
    await vi.waitFor(() =>
      expect(workflow.tasks()[0]?.status).toBe('completed'),
    );

    expect(reviewRequired).toHaveBeenCalledWith(
      expect.objectContaining({ id: taskId, status: 'awaiting_confirmation' }),
    );
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
    expect(workflow.tasks()[0]?.result).toEqual(DOCUMENT);
  });

  it('publishes a failed terminal operation without fetching a result', async () => {
    const failedOperation: CaptureOperation = {
      ...streamingOperation('failed'),
      error: {
        code: 'capture_failed',
        message: 'Capture failed in the runtime.',
        stage: 'runtime',
        retryable: true,
      },
    };
    const client = fakeClient({
      startStreamingCapture: vi.fn(() => of(failedOperation)),
    });
    const failed = vi.fn();
    workflow.events.subscribe((event) => {
      if (event.type === 'failed') failed(event.event);
    });
    configure(client);

    workflow.enqueueFiles([new File(['pdf'], 'failed.pdf')]);
    await vi.waitFor(() =>
      expect(workflow.tasks()[0]?.status).toBe('failed'),
    );

    expect(workflow.tasks()[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({
          code: 'capture_failed',
          message: 'Capture failed in the runtime.',
          retryable: true,
        }),
      }),
    );
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: 'failed.pdf',
        error: expect.objectContaining({ code: 'capture_failed' }),
      }),
    );
    expect(client.getStreamingResult).not.toHaveBeenCalled();
  });
});
