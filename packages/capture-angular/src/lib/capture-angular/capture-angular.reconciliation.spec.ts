import { ComponentFixture, TestBed } from '@angular/core/testing';
import type {
  CaptureClient,
  CaptureJobV1,
  CaptureStructuringProvider,
} from '../contracts';
import { CaptureWorkbenchComponent } from './capture-angular';
import { DOCUMENT, RAW, fakeClient, job, selectFiles } from './capture-angular-test-support';

describe('CaptureWorkbenchComponent', () => {
  let fixture: ComponentFixture<CaptureWorkbenchComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CaptureWorkbenchComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(CaptureWorkbenchComponent);
  });

  it('reconciles a rejected failure report to an already completed job', async () => {
    const client = fakeClient({
      createCapture: vi.fn(async () =>
        job('running', 'awaiting_structuring', 'host'),
      ),
      reportStructuringFailure: vi.fn(async () => {
        throw new Error('report rejected');
      }),
      getCapture: vi.fn(async () => job('completed', 'completed', 'host')),
    });
    const provider: CaptureStructuringProvider = {
      structure: vi.fn(async () => {
        throw new Error('provider failed');
      }),
    };
    const completed = vi.fn();
    const failed = vi.fn();
    fixture.componentRef.setInput('client', client);
    fixture.componentRef.setInput('structuringProvider', provider);
    fixture.componentRef.setInput('config', {
      structuringMode: 'host',
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.componentInstance.completed.subscribe(completed);
    fixture.componentInstance.failed.subscribe(failed);
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();

    expect(client.getCapture).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(client.getResult).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(completed).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
  });

  it('reconciles a lost failure-report response to the runtime failed state', async () => {
    const failedJob: CaptureJobV1 = {
      ...job('failed', 'failed', 'host'),
      error: {
        code: 'host_provider_failed',
        message: 'provider failed',
        stage: 'structuring',
      },
    };
    const client = fakeClient({
      createCapture: vi.fn(async () =>
        job('running', 'awaiting_structuring', 'host'),
      ),
      reportStructuringFailure: vi.fn(async () => {
        throw new Error('response was lost');
      }),
      getCapture: vi.fn(async () => failedJob),
    });
    const provider: CaptureStructuringProvider = {
      structure: vi.fn(async () => {
        throw new Error('provider failed');
      }),
    };
    const completed = vi.fn();
    const failed = vi.fn();
    fixture.componentRef.setInput('client', client);
    fixture.componentRef.setInput('structuringProvider', provider);
    fixture.componentRef.setInput('config', {
      structuringMode: 'host',
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.componentInstance.completed.subscribe(completed);
    fixture.componentInstance.failed.subscribe(failed);
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();

    expect(client.cancelCapture).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: RAW,
        error: expect.objectContaining({ code: 'host_provider_failed' }),
      }),
    );
  });

  it('treats a lost commit response as completed after reconciliation', async () => {
    const client = fakeClient({
      createCapture: vi.fn(async () =>
        job('running', 'awaiting_structuring', 'host'),
      ),
      commitStructuredResult: vi.fn(async () => {
        throw new Error('commit response was lost');
      }),
      getCapture: vi.fn(async () => job('completed', 'completed', 'host')),
    });
    const provider: CaptureStructuringProvider = {
      structure: vi.fn(async () => DOCUMENT),
    };
    const completed = vi.fn();
    fixture.componentRef.setInput('client', client);
    fixture.componentRef.setInput('structuringProvider', provider);
    fixture.componentRef.setInput('config', {
      structuringMode: 'host',
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.componentInstance.completed.subscribe(completed);
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();

    expect(client.commitStructuredResult).toHaveBeenCalledOnce();
    expect(client.reportStructuringFailure).not.toHaveBeenCalled();
    expect(completed).toHaveBeenCalledOnce();
  });

  it('retries an unresolved commit with the same idempotency key', async () => {
    const commitStructuredResult = vi
      .fn<CaptureClient['commitStructuredResult']>()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(job('completed', 'completed', 'host'));
    const client = fakeClient({
      createCapture: vi.fn(async () =>
        job('running', 'awaiting_structuring', 'host'),
      ),
      getCapture: vi.fn(async () =>
        job('running', 'awaiting_structuring', 'host'),
      ),
      commitStructuredResult,
    });
    const provider: CaptureStructuringProvider = {
      structure: vi.fn(async () => DOCUMENT),
    };
    fixture.componentRef.setInput('client', client);
    fixture.componentRef.setInput('structuringProvider', provider);
    fixture.componentRef.setInput('config', {
      structuringMode: 'host',
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();

    expect(commitStructuredResult).toHaveBeenCalledTimes(2);
    const firstRequest = commitStructuredResult.mock.calls[0]?.[1];
    const retryRequest = commitStructuredResult.mock.calls[1]?.[1];
    expect(firstRequest?.clientRequestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(retryRequest?.clientRequestId).toBe(firstRequest?.clientRequestId);
  });

  it('cancels and confirms an awaiting job when failure reporting cannot complete', async () => {
    const getCapture = vi
      .fn<CaptureClient['getCapture']>()
      .mockResolvedValueOnce(job('running', 'awaiting_structuring', 'host'))
      .mockResolvedValueOnce(job('cancelled', 'cancelled', 'host'));
    const client = fakeClient({
      createCapture: vi.fn(async () =>
        job('running', 'awaiting_structuring', 'host'),
      ),
      reportStructuringFailure: vi.fn(async () => {
        throw new Error('report unavailable');
      }),
      getCapture,
      cancelCapture: vi.fn(async () => job('cancelled', 'cancelled', 'host')),
    });
    const provider: CaptureStructuringProvider = {
      structure: vi.fn(async () => {
        throw new Error('provider failed');
      }),
    };
    const canceled = vi.fn();
    const failed = vi.fn();
    fixture.componentRef.setInput('client', client);
    fixture.componentRef.setInput('structuringProvider', provider);
    fixture.componentRef.setInput('config', {
      structuringMode: 'host',
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.componentInstance.canceled.subscribe(canceled);
    fixture.componentInstance.failed.subscribe(failed);
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();

    expect(client.cancelCapture).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(getCapture).toHaveBeenCalledTimes(2);
    expect(canceled).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
  });

  it('surfaces an unknown reconciliation state without claiming completion', async () => {
    const getCapture = vi.fn(async () => {
      throw new Error('runtime unreachable');
    });
    const cancelCapture = vi.fn(async () => {
      throw new Error('runtime unreachable');
    });
    const reportStructuringFailure = vi.fn(async () => {
      throw new Error('runtime unreachable');
    });
    const client = fakeClient({
      createCapture: vi.fn(async () =>
        job('running', 'awaiting_structuring', 'host'),
      ),
      reportStructuringFailure,
      getCapture,
      cancelCapture,
    });
    const structure = vi.fn<CaptureStructuringProvider['structure']>(
      async () => {
        throw new Error('provider failed');
      },
    );
    const provider: CaptureStructuringProvider = { structure };
    const completed = vi.fn();
    const failed = vi.fn();
    const canceled = vi.fn();
    fixture.componentRef.setInput('client', client);
    fixture.componentRef.setInput('structuringProvider', provider);
    fixture.componentRef.setInput('config', {
      structuringMode: 'host',
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.componentInstance.completed.subscribe(completed);
    fixture.componentInstance.failed.subscribe(failed);
    fixture.componentInstance.canceled.subscribe(canceled);
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();

    expect(completed).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(canceled).not.toHaveBeenCalled();
    const task = fixture.componentInstance.tasks()[0];
    expect(task).toEqual(
      expect.objectContaining({
        status: 'reconciliation_required',
        stage: 'structuring',
        raw: RAW,
        captureId: 'capture-1',
        error: expect.objectContaining({
          code: 'host_reconciliation_unavailable',
          stage: 'structuring',
        }),
      }),
    );
    if (!task) throw new Error('Expected a reconciliation task.');
    await fixture.componentInstance.remove(task.id);
    expect(client.deleteCapture).not.toHaveBeenCalled();
    expect(fixture.componentInstance.tasks()).toHaveLength(1);
    expect(structure).toHaveBeenCalledOnce();
    expect(client.commitStructuredResult).not.toHaveBeenCalled();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.reconciliation-actions'),
    ).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.remove-action')).toBeNull();
  });

  it('reconciles an unknown job to completed without repeating provider work', async () => {
    const getCapture = vi
      .fn<CaptureClient['getCapture']>()
      .mockRejectedValueOnce(new Error('runtime unreachable'))
      .mockRejectedValueOnce(new Error('runtime unreachable'))
      .mockResolvedValueOnce(job('completed', 'completed', 'host'));
    const cancelCapture = vi
      .fn<CaptureClient['cancelCapture']>()
      .mockRejectedValueOnce(new Error('runtime unreachable'));
    const client = fakeClient({
      createCapture: vi.fn(async () =>
        job('running', 'awaiting_structuring', 'host'),
      ),
      reportStructuringFailure: vi.fn(async () => {
        throw new Error('runtime unreachable');
      }),
      getCapture,
      cancelCapture,
    });
    const structure = vi.fn<CaptureStructuringProvider['structure']>(
      async () => {
        throw new Error('provider failed');
      },
    );
    const completed = vi.fn();
    const failed = vi.fn();
    fixture.componentRef.setInput('client', client);
    fixture.componentRef.setInput('structuringProvider', { structure });
    fixture.componentRef.setInput('config', {
      structuringMode: 'host',
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.componentInstance.completed.subscribe(completed);
    fixture.componentInstance.failed.subscribe(failed);
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();
    const task = fixture.componentInstance.tasks()[0];
    if (!task) throw new Error('Expected a reconciliation task.');
    expect(task.status).toBe('reconciliation_required');

    await fixture.componentInstance.reconcile(task.id);

    expect(fixture.componentInstance.tasks()[0]?.status).toBe('completed');
    expect(completed).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
    expect(client.getResult).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(structure).toHaveBeenCalledOnce();
    expect(client.commitStructuredResult).not.toHaveBeenCalled();
  });

  it('reconciles an unknown job to the confirmed failed state', async () => {
    const failedJob: CaptureJobV1 = {
      ...job('failed', 'failed', 'host'),
      error: {
        code: 'host_provider_failed',
        message: 'provider failed',
        stage: 'structuring',
      },
    };
    const getCapture = vi
      .fn<CaptureClient['getCapture']>()
      .mockRejectedValueOnce(new Error('runtime unreachable'))
      .mockRejectedValueOnce(new Error('runtime unreachable'))
      .mockResolvedValueOnce(failedJob);
    const client = fakeClient({
      createCapture: vi.fn(async () =>
        job('running', 'awaiting_structuring', 'host'),
      ),
      reportStructuringFailure: vi.fn(async () => {
        throw new Error('runtime unreachable');
      }),
      getCapture,
      cancelCapture: vi.fn(async () => {
        throw new Error('runtime unreachable');
      }),
    });
    const structure = vi.fn<CaptureStructuringProvider['structure']>(
      async () => {
        throw new Error('provider failed');
      },
    );
    const completed = vi.fn();
    const failed = vi.fn();
    fixture.componentRef.setInput('client', client);
    fixture.componentRef.setInput('structuringProvider', { structure });
    fixture.componentRef.setInput('config', {
      structuringMode: 'host',
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.componentInstance.completed.subscribe(completed);
    fixture.componentInstance.failed.subscribe(failed);
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();
    const task = fixture.componentInstance.tasks()[0];
    if (!task) throw new Error('Expected a reconciliation task.');

    await fixture.componentInstance.reconcile(task.id);

    expect(fixture.componentInstance.tasks()[0]).toEqual(
      expect.objectContaining({ status: 'failed', stage: 'failed' }),
    );
    expect(completed).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({
        captureId: 'capture-1',
        raw: RAW,
        error: expect.objectContaining({ code: 'host_provider_failed' }),
      }),
    );
    expect(structure).toHaveBeenCalledOnce();
    expect(client.commitStructuredResult).not.toHaveBeenCalled();
  });

  it('cancels an unknown job and emits canceled only after confirmation', async () => {
    const getCapture = vi
      .fn<CaptureClient['getCapture']>()
      .mockRejectedValueOnce(new Error('runtime unreachable'))
      .mockRejectedValueOnce(new Error('runtime unreachable'))
      .mockResolvedValueOnce(job('cancelled', 'cancelled', 'host'));
    const cancelCapture = vi
      .fn<CaptureClient['cancelCapture']>()
      .mockRejectedValueOnce(new Error('runtime unreachable'))
      .mockResolvedValueOnce(job('cancelled', 'cancelled', 'host'));
    const client = fakeClient({
      createCapture: vi.fn(async () =>
        job('running', 'awaiting_structuring', 'host'),
      ),
      reportStructuringFailure: vi.fn(async () => {
        throw new Error('runtime unreachable');
      }),
      getCapture,
      cancelCapture,
    });
    const structure = vi.fn<CaptureStructuringProvider['structure']>(
      async () => {
        throw new Error('provider failed');
      },
    );
    const completed = vi.fn();
    const failed = vi.fn();
    const canceled = vi.fn();
    fixture.componentRef.setInput('client', client);
    fixture.componentRef.setInput('structuringProvider', { structure });
    fixture.componentRef.setInput('config', {
      structuringMode: 'host',
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.componentInstance.completed.subscribe(completed);
    fixture.componentInstance.failed.subscribe(failed);
    fixture.componentInstance.canceled.subscribe(canceled);
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();
    const task = fixture.componentInstance.tasks()[0];
    if (!task) throw new Error('Expected a reconciliation task.');

    await fixture.componentInstance.cancel(task.id);

    expect(fixture.componentInstance.tasks()[0]?.status).toBe('canceled');
    expect(cancelCapture).toHaveBeenCalledTimes(2);
    expect(getCapture).toHaveBeenCalledTimes(3);
    expect(canceled).toHaveBeenCalledOnce();
    expect(completed).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(structure).toHaveBeenCalledOnce();
    expect(client.commitStructuredResult).not.toHaveBeenCalled();
  });
});
