import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  type CaptureClient,
  type CaptureDocumentV1,
  type CaptureJobV1,
  type CaptureStructuringProvider,
  type RuntimeInstallationV1,
  type RawCaptureV1,
  type RuntimeReadyV1,
  type RuntimeRequirementV1,
  type StartRuntimeInstallationRequest,
} from '../contracts';
import { CaptureWorkbenchComponent } from './capture-angular';

const READY: RuntimeReadyV1 = {
  ready: true,
  service: 'capture-runtime',
  runtimeVersion: '0.1.0',
  apiVersion: '1.0',
  captureDocumentSchemaVersion: '1',
  capabilities: {
    captureKinds: ['pdf', 'image', 'audio'],
    structuringModes: ['runtime', 'host'],
    supportsCancellation: true,
    supportsRawDiagnostics: true,
    maxUploadBytes: 25_000_000,
  },
};

const RAW: RawCaptureV1 = {
  schemaVersion: '1',
  diagnosticOnly: true,
  source: {
    sha256: 'a'.repeat(64),
    fileName: 'scan.pdf',
    mediaType: 'application/pdf',
    bytes: 4,
  },
  segments: [
    {
      segmentId: 'segment-1',
      order: 0,
      locator: { kind: 'page', page: 1 },
      text: 'page one',
    },
  ],
  sourceText: 'page one',
  extractionEngine: {
    engine: 'windowsml',
    model: 'ocr-v1',
    digest: `sha256:${'b'.repeat(64)}`,
  },
  warnings: [],
  createdAt: '2026-07-20T00:00:00Z',
};

const DOCUMENT: CaptureDocumentV1 = {
  schemaVersion: '1',
  source: RAW.source,
  rawSegments: RAW.segments,
  blocks: [
    {
      blockId: 'block-1',
      order: 0,
      sourceSegmentId: 'segment-1',
      type: 'paragraph',
      locator: { kind: 'page', page: 1 },
      sourceText: 'page one',
      targetText: 'page one',
    },
  ],
  sourceText: 'page one',
  targetText: 'page one',
  extractionEngine: RAW.extractionEngine,
  structuringEngine: {
    engine: 'ollama',
    model: 'capture-test',
    digest: `sha256:${'c'.repeat(64)}`,
  },
  warnings: [],
  createdAt: RAW.createdAt,
  completedAt: '2026-07-20T00:00:01Z',
};

function job(
  status: CaptureJobV1['status'],
  stage: CaptureJobV1['stage'],
  structuringMode: CaptureJobV1['structuringMode'] = 'runtime',
): CaptureJobV1 {
  return {
    captureId: 'capture-1',
    status,
    stage,
    structuringMode,
    progress: status === 'completed' ? 1 : 0.7,
    source: RAW.source,
    createdAt: RAW.createdAt,
    updatedAt: RAW.createdAt,
  };
}

function fakeClient(overrides: Partial<CaptureClient> = {}): CaptureClient {
  return {
    getReady: vi.fn(async () => READY),
    getRequirements: vi.fn(async () => []),
    startInstallation: vi.fn(),
    getInstallation: vi.fn(),
    cancelInstallation: vi.fn(),
    createCapture: vi.fn(async () => job('completed', 'completed')),
    getCapture: vi.fn(async () => job('completed', 'completed')),
    cancelCapture: vi.fn(async () => job('cancelled', 'cancelled')),
    getRaw: vi.fn(async () => RAW),
    getResult: vi.fn(async () => DOCUMENT),
    commitStructuredResult: vi.fn(async () =>
      job('completed', 'completed', 'host'),
    ),
    reportStructuringFailure: vi.fn(async () =>
      job('failed', 'failed', 'host'),
    ),
    deleteCapture: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('CaptureWorkbenchComponent', () => {
  let fixture: ComponentFixture<CaptureWorkbenchComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CaptureWorkbenchComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(CaptureWorkbenchComponent);
  });

  it('applies source, size, and theme configuration', async () => {
    fixture.componentRef.setInput('client', fakeClient());
    fixture.componentRef.setInput('config', {
      width: '32rem',
      height: '24rem',
      theme: { accent: '#7c3aed' },
      enabledSources: ['image'],
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector(
      '.capture-workbench',
    ) as HTMLElement;
    const input = fixture.nativeElement.querySelector(
      'input[type=file]',
    ) as HTMLInputElement;
    expect(panel.style.width).toBe('32rem');
    expect(panel.style.height).toBe('24rem');
    expect(panel.style.getPropertyValue('--capture-accent')).toBe('#7c3aed');
    expect(input.accept).toContain('.png');
    expect(input.accept).not.toContain('.pdf');
  });

  it('emits a runtime-validated canonical result', async () => {
    const client = fakeClient();
    const completed = vi.fn();
    fixture.componentRef.setInput('client', client);
    fixture.componentRef.setInput('config', {
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
      fixture.nativeElement.querySelector('.result-preview').textContent,
    ).toContain('page one');
  });

  it('reports host structuring failure with raw diagnostics and never completes', async () => {
    const client = fakeClient({
      createCapture: vi.fn(async () =>
        job('running', 'awaiting_structuring', 'host'),
      ),
    });
    const structure = vi.fn<CaptureStructuringProvider['structure']>(
      async () => {
        throw { code: 'NOT VALID!', message: 'provider returned invalid JSON' };
      },
    );
    const provider: CaptureStructuringProvider = { structure };
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
    fixture.detectChanges();

    expect(client.reportStructuringFailure).toHaveBeenCalledWith(
      'capture-1',
      {
        code: 'host_provider_failed',
        message: 'provider returned invalid JSON',
      },
      expect.any(AbortSignal),
    );
    expect(structure).toHaveBeenCalledWith(
      expect.objectContaining({
        documentContract: expect.objectContaining({ schemaVersion: '1' }),
      }),
    );
    const request = structure.mock.calls[0]?.[0];
    expect(Object.isFrozen(request?.documentContract.jsonSchema ?? {})).toBe(
      true,
    );
    expect(completed).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'scan.pdf', raw: RAW }),
    );
    expect(
      fixture.nativeElement.querySelector('.raw-diagnostics').textContent,
    ).toContain('diagnostic only');
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

  it('lets a trusted host client own structuring without a browser provider', async () => {
    const client = fakeClient({
      createCapture: vi.fn(async () =>
        job('running', 'awaiting_structuring', 'host'),
      ),
      getCapture: vi.fn(async () => job('completed', 'completed', 'host')),
    });
    const completed = vi.fn();
    fixture.componentRef.setInput('client', client);
    fixture.componentRef.setInput('config', {
      structuringMode: 'host',
      hostStructuringOwner: 'client',
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.componentInstance.completed.subscribe(completed);
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();

    expect(client.getRaw).not.toHaveBeenCalled();
    expect(client.commitStructuredResult).not.toHaveBeenCalled();
    expect(client.reportStructuringFailure).not.toHaveBeenCalled();
    expect(client.getResult).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(completed).toHaveBeenCalledWith({
      taskId: expect.any(String),
      document: DOCUMENT,
    });
  });

  it('keeps later files queued and supports canceling them', async () => {
    let release!: () => void;
    const preprocessing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = fakeClient();
    fixture.componentRef.setInput('client', client);
    fixture.componentRef.setInput('preprocessor', {
      preprocess: vi.fn(async ({ file }) => {
        await preprocessing;
        return file;
      }),
    });
    fixture.componentRef.setInput('config', {
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
    fixture.componentInstance.cancel(second.id);
    expect(fixture.componentInstance.tasks()[1]?.status).toBe('canceled');

    release();
    await fixture.whenStable();
    expect(client.createCapture).toHaveBeenCalledOnce();
  });

  it('starts runtime installation only after explicit user action', async () => {
    const client = fakeClient({
      getReady: vi.fn(async () => ({ ...READY, ready: false })),
      getRequirements: vi.fn(
        async (): Promise<readonly RuntimeRequirementV1[]> => [
          {
            requirementId: 'ollama-runtime',
            kind: 'runtime',
            displayName: 'Ollama',
            status: 'installable',
            requiredFor: ['runtime'],
            installStrategy: 'winget',
          },
          {
            requirementId: 'capture-ollama-model',
            kind: 'model',
            displayName: 'Capture model',
            status: 'manual_action_required',
            requiredFor: ['runtime'],
            installStrategy: 'manual',
            detail: 'Open Ollama and pull the capture model.',
          },
          {
            requirementId: 'whisper-primary',
            kind: 'stt',
            displayName: 'Whisper',
            status: 'unavailable',
            requiredFor: ['audio'],
            installStrategy: 'none',
            detail: 'Whisper is unavailable.',
          },
        ],
      ),
      startInstallation: vi.fn(
        async (
          request: StartRuntimeInstallationRequest,
        ): Promise<RuntimeInstallationV1> => ({
          installationId: 'install-1',
          requirementId: request.requirementId,
          status: 'completed',
          progress: 1,
          createdAt: RAW.createdAt,
          updatedAt: RAW.createdAt,
          completedAt: RAW.createdAt,
        }),
      ),
    });
    fixture.componentRef.setInput('client', client);
    fixture.detectChanges();
    await fixture.componentInstance.refreshRuntime();
    fixture.detectChanges();

    expect(client.startInstallation).not.toHaveBeenCalled();
    const installButton = fixture.nativeElement.querySelector(
      '.runtime-card .primary',
    ) as HTMLButtonElement | null;
    expect(installButton).not.toBeNull();
    installButton?.click();
    await fixture.whenStable();
    expect(client.startInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        requirementId: 'ollama-runtime',
        consent: true,
      }),
      expect.any(AbortSignal),
    );
    expect(client.startInstallation).toHaveBeenCalledTimes(1);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'Manual action is required',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'unavailable on the current system',
    );
  });

  it('still performs a handshake when runtime setup UI is hidden', async () => {
    const client = fakeClient();
    fixture.componentRef.setInput('client', client);
    fixture.componentRef.setInput('config', { showRuntimeSetup: false });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(client.getReady).toHaveBeenCalledOnce();
    expect(client.getRequirements).toHaveBeenCalledOnce();
    expect(fixture.nativeElement.querySelector('.runtime-card')).toBeNull();
  });

  it('skips its handshake only with explicit hostManagedHandshake', async () => {
    const client = fakeClient();
    fixture.componentRef.setInput('client', client);
    fixture.componentRef.setInput('config', {
      showRuntimeSetup: false,
      hostManagedHandshake: true,
    });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(client.getReady).not.toHaveBeenCalled();
    expect(client.getRequirements).not.toHaveBeenCalled();
  });
});

function selectFiles(
  fixture: ComponentFixture<CaptureWorkbenchComponent>,
  files: readonly File[],
): void {
  const input = fixture.nativeElement.querySelector(
    'input[type=file]',
  ) as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change'));
}
