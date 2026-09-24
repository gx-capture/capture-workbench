import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { CaptureOcrProjection } from '@gx-capture/capture-runtime-client';
import type { CaptureOperation, OcrComputePreflight } from '@gx-capture/capture-workbench-ui';
import { EMPTY, finalize, of, Subject, throwError } from 'rxjs';
import type { DesktopLibraryDetail, DesktopLibrarySummary } from '../contracts';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopWorkspaceStore } from './desktop-workspace.store';

const summary: DesktopLibrarySummary = {
  documentId: 'a'.repeat(32),
  fileName: 'fixture.pdf',
  mediaType: 'application/pdf',
  byteLength: 12,
  createdAtMs: 1,
  updatedAtMs: 1,
  status: 'queued',
  stage: 'uploading',
};

const runningJob = job({
  captureId: 'capture-1',
  status: 'running',
  stage: 'extracting',
});
const completedJob = job({
  captureId: 'capture-1',
  status: 'completed',
  stage: 'completed',
});
const cancelledJob = job({
  captureId: 'capture-1',
  status: 'cancelled',
  stage: 'cancelled',
});
const raw = { sourceText: 'OCR text' };
const result = { targetText: 'translated text' };
const failedOcrCaptureIds = new Set([
  'capture-terminal-error',
  'capture-double-write',
]);

describe('DesktopWorkspaceStore', () => {
  it('retains a terminal model installation identity for UI and Tauri diagnostics', () => {
    const failedInstallation = {
      installationId: 'model-installation-1',
      optionId: 'qwen3.5-0.8b-v1',
      status: 'failed' as const,
      progress: 0.1,
      error: {
        code: 'installation_failed',
        message: 'Runtime model installation failed.',
        stage: 'runtime',
      },
      createdAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-20T00:00:01Z',
      completedAt: '2026-07-20T00:00:01Z',
    };
    const startModelInstallation = vi.fn(() => of(failedInstallation));
    const store = initializeStore(
      libraryStub(),
      runtimeStub({ startModelInstallation }),
    );
    store.selectModelOption('qwen3.5-0.8b-v1');

    store.installSelectedModel();
    TestBed.tick();

    expect(startModelInstallation).toHaveBeenCalledWith({
      clientRequestId: expect.any(String),
      optionId: 'qwen3.5-0.8b-v1',
      consent: true,
    });
    expect(store.activeModelInstallation()).toEqual(failedInstallation);
    expect(store.installing()).toBe(false);
    expect(store.message()).toContain('installation_failed');
  });

  it('does not offer or start installation for unavailable catalog requirements', () => {
    const startInstallation = vi.fn();
    const store = initializeStore(
      libraryStub(),
      runtimeStub({
        getRequirements: vi.fn(() => of([
          {
            requirementId: 'windowsml-ocr',
            displayName: 'WindowsML OCR',
            status: 'unavailable',
            kind: 'engine',
            requiredFor: ['capture'],
            installStrategy: 'none',
            detail: 'No catalog artifact is available.',
          },
        ])),
        startInstallation,
      }),
    );

    expect(store.state()).toBe('needs-setup');
    expect(store.installableCoreRequirements()).toEqual([]);
    store.installCoreRequirements();

    expect(startInstallation).not.toHaveBeenCalled();
  });

  it('allows core installation while worker-owned OCR preflight is pending', () => {
    const startInstallation = vi.fn((request: { requirementId: string }) =>
      of({
        installationId: `install-${request.requirementId}`,
        requirementId: request.requirementId,
        status: 'completed' as const,
        progress: 1,
        createdAt: '2026-07-20T00:00:00Z',
        updatedAt: '2026-07-20T00:00:00Z',
        completedAt: '2026-07-20T00:00:00Z',
      }),
    );
    const store = initializeStore(
      libraryStub(),
      runtimeStub({
        ready: signal(false),
        started: signal(true),
        ocrCompute: signal(null),
        getRequirements: vi.fn(() => of([
          {
            requirementId: 'windowsml-ocr',
            displayName: 'WindowsML OCR',
            status: 'installable',
            kind: 'engine',
            requiredFor: ['capture'],
            installStrategy: 'runtime-catalog',
          },
        ])),
        startInstallation,
      }),
    );

    expect(store.state()).toBe('needs-setup');
    store.installCoreRequirements();
    TestBed.tick();

    expect(startInstallation).toHaveBeenCalledWith({
      clientRequestId: expect.any(String),
      requirementId: 'windowsml-ocr',
      consent: true,
    });
  });

  it('redacts bearer credentials from runtime errors shown to the host UI', () => {
    const store = initializeStore(
      libraryStub(),
      runtimeStub({
        getRequirements: vi.fn(() =>
          throwError(() => new Error('Bearer secret-token')),
        ),
      }),
    );

    expect(store.message()).toBe('Bearer [redacted]');
    expect(store.message()).not.toContain('secret-token');
  });

  it('installs OCR before Whisper through one sequential consent action', () => {
    const startInstallation = vi.fn((request: { requirementId: string }) =>
      of({
        installationId: `install-${request.requirementId}`,
        requirementId: request.requirementId,
        status: 'completed' as const,
        progress: 1,
        createdAt: '2026-07-20T00:00:00Z',
        updatedAt: '2026-07-20T00:00:00Z',
        completedAt: '2026-07-20T00:00:00Z',
      }),
    );
    const store = initializeStore(
      libraryStub(),
      runtimeStub({
        getRequirements: vi.fn(() => of([
          {
            requirementId: 'whisper-primary',
            displayName: 'Whisper',
            status: 'installable',
            kind: 'model',
            requiredFor: ['audio'],
            installStrategy: 'runtime-catalog',
          },
          {
            requirementId: 'windowsml-ocr',
            displayName: 'WindowsML OCR',
            status: 'installable',
            kind: 'engine',
            requiredFor: ['capture'],
            installStrategy: 'runtime-catalog',
          },
        ])),
        startInstallation,
      }),
    );
    store.requestedRequirements.set(new Set(['whisper-primary']));

    store.installCoreRequirements();
    TestBed.tick();

    expect(startInstallation.mock.calls.map(([request]) => request.requirementId)).toEqual([
      'windowsml-ocr',
      'whisper-primary',
    ]);
  });

  it('polls queued and running installations until the first terminal status', () => {
    const observedStatuses: string[] = [];
    const startInstallation = vi.fn(() => {
      observedStatuses.push('queued');
      return of({
        installationId: 'install-windowsml-ocr',
        requirementId: 'windowsml-ocr' as const,
        status: 'queued' as const,
        progress: 0,
        createdAt: '2026-07-20T00:00:00Z',
        updatedAt: '2026-07-20T00:00:00Z',
      });
    });
    const getInstallation = vi.fn(() => {
      const status = getInstallation.mock.calls.length === 1 ? 'running' : 'completed';
      observedStatuses.push(status);
      return of({
        installationId: 'install-windowsml-ocr',
        requirementId: 'windowsml-ocr' as const,
        status,
        progress: status === 'completed' ? 1 : 0.5,
        createdAt: '2026-07-20T00:00:00Z',
        updatedAt: '2026-07-20T00:00:00Z',
        ...(status === 'completed' ? { completedAt: '2026-07-20T00:00:00Z' } : {}),
      });
    });
    const store = initializeStore(
      libraryStub(),
      runtimeStub({
        getRequirements: vi.fn(() => of([{
          requirementId: 'windowsml-ocr',
          displayName: 'WindowsML OCR',
          status: 'installable',
          kind: 'engine',
          requiredFor: ['capture'],
          installStrategy: 'runtime-catalog',
        }])),
        startInstallation,
        getInstallation,
      }),
    );

    vi.useFakeTimers();
    try {
      store.installCoreRequirements();
      expect(observedStatuses).toEqual(['queued']);

      vi.advanceTimersByTime(1_500);
      TestBed.tick();

      expect(observedStatuses).toEqual(['queued', 'running', 'completed']);
      expect(getInstallation).toHaveBeenCalledTimes(2);
      expect(store.installing()).toBe(false);
      expect(store.activeInstallation()?.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not require Ollama for OCR setup', () => {
    const library = libraryStub();
    const client = runtimeStub({
      getRequirements: vi.fn(() => of([
        {
          requirementId: 'windowsml-ocr',
          displayName: 'WindowsML OCR',
          status: 'installable',
          kind: 'engine',
          requiredFor: ['capture'],
          installStrategy: 'automatic',
        },
        {
          requirementId: 'ollama-runtime',
          displayName: 'Ollama',
          status: 'missing',
          kind: 'runtime',
          requiredFor: ['structuring'],
          installStrategy: 'winget',
        },
      ])),
    });

    const store = initializeStore(library, client);

    expect(store.state()).toBe('needs-setup');
    expect(store.coreMissing().map((item) => item.requirementId)).toEqual([
      'windowsml-ocr',
    ]);
  });

  it('allows an OCR-ready import when host structuring is unavailable', () => {
    const createSource = vi.fn(() => of(summary));
    const startInstallation = vi.fn();
    const startModelInstallation = vi.fn();
    const store = initializeStore(
      libraryStub({ createSource }),
      runtimeStub({
        startInstallation,
        startModelInstallation,
        getRequirements: vi.fn(() => of([
          {
            requirementId: 'windowsml-ocr',
            displayName: 'WindowsML OCR',
            status: 'ready',
            kind: 'engine',
            requiredFor: ['capture'],
            installStrategy: 'none',
          },
          {
            requirementId: 'ollama-runtime',
            displayName: 'Ollama',
            status: 'unavailable',
            kind: 'runtime',
            requiredFor: ['structuring'],
            installStrategy: 'none',
          },
        ])),
        getModelOptions: vi.fn(() => of([{
          optionId: 'qwen3.5-0.8b-v1',
          displayName: 'Qwen 3.5 0.8B',
          modelReference: 'qwen3.5:0.8b',
          expectedDigest: null,
          expectedBytes: null,
          profileId: 'capture-workbench-qwen3.5-0.8b-structure-v1',
          profileSpecSha256: 'b'.repeat(64),
          status: 'not-installed' as const,
        }])),
      }),
    );

    expect(store.state()).toBe('ready');
    expect(store.coreMissing()).toEqual([]);

    store.addSourcePaths([String.raw`C:\private\scan.pdf`]);
    TestBed.tick();

    expect(startInstallation).not.toHaveBeenCalled();
    expect(startModelInstallation).not.toHaveBeenCalled();
    expect(createSource).toHaveBeenCalledWith(String.raw`C:\private\scan.pdf`);
  });

  it('restores the exact ready message after readiness resources resolve', () => {
    const store = initializeStore(libraryStub(), runtimeStub());

    expect(store.state()).toBe('ready');
    expect(store.message()).toBe(
      'Capture Runtime 已準備完成，可以開始處理文件。',
    );
  });

  it('asks for Whisper only when an allowed audio source is selected', () => {
    const library = libraryStub({
      createSource: vi.fn(() =>
        of({
          ...summary,
          fileName: 'voice.wav',
          mediaType: 'audio/wav',
        }),
      ),
    });
    const client = runtimeStub({
      getRequirements: vi.fn(() => of([{
        requirementId: 'whisper-primary',
        displayName: 'Whisper',
        status: 'missing',
        kind: 'model',
        requiredFor: ['audio'],
        installStrategy: 'automatic',
      }])),
    });
    const store = initializeStore(library, client);

    store.addSourcePaths([String.raw`C:\private\voice.wav`]);
    TestBed.tick();

    expect(store.state()).toBe('needs-setup');
    expect(store.coreMissing().map((item) => item.requirementId)).toEqual([
      'whisper-primary',
    ]);
    expect(store.message()).toBe('請先安裝缺少的本機處理需求。');
    expect(library.createSource).toHaveBeenCalledOnce();
  });

  it('persists the runtime ID before terminal data and clears it only after DELETE', async () => {
    const events: string[] = [];
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      events.push(
        `library:${String(update['status'])}:${String(update['clearCaptureId'] ?? false)}`,
      );
      return of({ ...summary, ...update, updatedAtMs: 2 } as DesktopLibrarySummary);
    });
    const deleteCapture = vi.fn(() => {
      events.push('runtime:delete');
      return of(undefined);
    });
    const library = libraryStub({
      list: vi.fn(() => of<readonly DesktopLibrarySummary[]>([summary])),
      updateCapture,
    });
    const client = runtimeStub({
      createCapture: vi.fn(() => of(completedJob)),
      deleteCapture,
    });
    const store = initializeStore(library, client);

    store.retry(summary.documentId);
    TestBed.tick();
    await settleCaptureLifecycle();

    expect(client.createCapture).toHaveBeenCalledWith(
      summary.documentId,
      expect.any(String),
      undefined,
    );
    const updates = captureUpdates(updateCapture);
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'processing',
        captureId: 'capture-1',
      }),
      expect.objectContaining({
        status: 'persisting',
        captureId: 'capture-1',
      }),
      expect.objectContaining({
        status: 'completed',
        captureId: 'capture-1',
        raw,
        result,
      }),
      expect.objectContaining({
        status: 'completed',
        clearCaptureId: true,
      }),
    ]));
    expect(events.indexOf('library:completed:false')).toBeLessThan(
      events.indexOf('runtime:delete'),
    );
    expect(events.indexOf('runtime:delete')).toBeLessThan(
      events.indexOf('library:completed:true'),
    );
    expect(deleteCapture).toHaveBeenCalledWith('capture-1');
  });

  it('reads OCR before the terminal atomic update and persists privacy-safe evidence', async () => {
    const events: string[] = [];
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      events.push(`library:${String(update['status'])}:${String(update['clearCaptureId'] ?? false)}`);
      return of({ ...summary, ...update } as DesktopLibrarySummary);
    });
    const getOcr = vi.fn((captureId: string) => {
      events.push(`runtime:ocr:${captureId}`);
      return of(ocrProjection(captureId, 'completed'));
    });
    const deleteCapture = vi.fn((captureId: string) => {
      events.push(`runtime:delete:${captureId}`);
      return of(undefined);
    });
    const store = initializeStore(
      libraryStub({ updateCapture }),
      runtimeStub({ getOcr, deleteCapture }),
    );

    store.retry(summary.documentId);
    TestBed.tick();
    await settleCaptureLifecycle();

    const terminalUpdate = captureUpdates(updateCapture).find(
      (update) => update['status'] === 'completed' && update['ocrEvidence'] !== undefined,
    );
    expect(terminalUpdate).toEqual(expect.objectContaining({
      captureId: 'capture-1',
      raw,
      result,
      ocrEvidence: expect.objectContaining({
        schemaVersion: 1,
        captureId: 'capture-1',
        status: 'completed',
        sourceSha256: 'a'.repeat(64),
        provenance: expect.objectContaining({ workerSha256: 'f'.repeat(64) }),
      }),
    }));
    expect(events.indexOf('runtime:ocr:capture-1')).toBeGreaterThan(
      events.indexOf('library:persisting:false'),
    );
    expect(events.indexOf('runtime:ocr:capture-1')).toBeLessThan(
      events.indexOf('library:completed:false'),
    );
    expect(events.indexOf('library:completed:false')).toBeLessThan(
      events.indexOf('runtime:delete:capture-1'),
    );
  });

  it('persists failed partial OCR pages and typed failures before cleanup', async () => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update } as DesktopLibrarySummary));
    const getOcr = vi.fn((captureId: string) =>
      of(ocrProjection(captureId, 'failed')));
    const deleteCapture = vi.fn(() => of(undefined));
    const terminal = job({
      captureId: 'capture-terminal-error',
      status: 'failed',
      stage: 'failed',
      error: { code: 'terminal_error', message: 'terminal evidence' },
    });
    const store = initializeStore(
      libraryStub({ updateCapture }),
      runtimeStub({ createCapture: vi.fn(() => of(terminal)), getOcr, deleteCapture }),
    );

    store.retry(summary.documentId);
    TestBed.tick();
    await settleCaptureLifecycle();

    const terminalUpdate = captureUpdates(updateCapture).find(
      (update) => update['status'] === 'failed' && update['ocrEvidence'] !== undefined,
    );
    expect(terminalUpdate).toEqual(expect.objectContaining({
      captureId: 'capture-terminal-error',
      raw,
      errorCode: 'terminal_error',
      ocrEvidence: expect.objectContaining({
        status: 'failed',
        pages: [expect.objectContaining({
          status: 'failed',
          failure: expect.objectContaining({ code: 'ocr_worker_failed' }),
        })],
      }),
    }));
    expect(getOcr).toHaveBeenCalledWith('capture-terminal-error');
    expect(deleteCapture).toHaveBeenCalledWith('capture-terminal-error');
  });

  it('retains a zero-page failed OCR projection as readable evidence', async () => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update } as DesktopLibrarySummary));
    const base = ocrProjection('capture-zero-page', 'failed');
    const unavailableProvenance = {
      status: 'unavailable' as const,
      profileId: 'profile-1',
      profileSpecSha256: 'e'.repeat(64),
      reason: 'worker_crashed' as const,
    };
    const zeroPage: CaptureOcrProjection = {
      ...base,
      source: null,
      pageCount: 0,
      pages: [],
      provenance: unavailableProvenance,
      failure: { code: 'ocr_worker_failed', message: 'OCR failed' },
    };
    const terminal = job({
      captureId: 'capture-zero-page',
      status: 'failed',
      stage: 'failed',
      error: { code: 'terminal_error', message: 'terminal evidence' },
    });
    const deleteCapture = vi.fn(() => of(undefined));
    const store = initializeStore(
      libraryStub({ updateCapture }),
      runtimeStub({
        createCapture: vi.fn(() => of(terminal)),
        getOcr: vi.fn(() => of(zeroPage)),
        deleteCapture,
      }),
    );

    store.retry(summary.documentId);
    TestBed.tick();
    await settleCaptureLifecycle();

    expect(captureUpdates(updateCapture)).toContainEqual(expect.objectContaining({
      status: 'failed',
      captureId: 'capture-zero-page',
      ocrEvidence: expect.objectContaining({
        pageCount: 0,
        pages: [],
        provenance: expect.objectContaining({ status: 'unavailable' }),
      }),
    }));
    expect(deleteCapture).toHaveBeenCalledWith('capture-zero-page');
  });

  it.each([
    ['getOcr error', () => throwError(() => new Error('OCR transport failed'))],
    ['identity mismatch', () => of({
      ...ocrProjection('capture-identity-mismatch', 'completed'),
      contractSha256: 'b'.repeat(64),
    } as CaptureOcrProjection)],
    ['malformed projection', () => of({
      ...ocrProjection('capture-malformed', 'completed'),
      pages: [{}],
    } as unknown as CaptureOcrProjection)],
  ])('keeps the runtime job for %s before terminal commit', async (_case, getOcrFactory) => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update } as DesktopLibrarySummary));
    const deleteCapture = vi.fn(() => of(undefined));
    const captureId = _case === 'getOcr error'
      ? 'capture-1'
      : _case === 'identity mismatch'
        ? 'capture-identity-mismatch'
        : 'capture-malformed';
    const terminal = job({ captureId, status: 'completed', stage: 'completed' });
    const getOcr = vi.fn(getOcrFactory);
    const store = initializeStore(
      libraryStub({ updateCapture }),
      runtimeStub({ createCapture: vi.fn(() => of(terminal)), getOcr, deleteCapture }),
    );

    store.retry(summary.documentId);
    TestBed.tick();
    await settleCaptureLifecycle();

    expect(captureUpdates(updateCapture)).toContainEqual(expect.objectContaining({
      status: 'recovery_required',
      captureId,
    }));
    expect(captureUpdates(updateCapture).some(
      (update) => update['clearCaptureId'] === true && update['status'] !== 'processing',
    )).toBe(false);
    expect(deleteCapture).not.toHaveBeenCalled();
  });

  it('keeps the runtime job when host OCR readiness lacks the worker identity', async () => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update } as DesktopLibrarySummary));
    const getOcr = vi.fn(() => of(ocrProjection('capture-1', 'completed')));
    const deleteCapture = vi.fn(() => of(undefined));
    const store = initializeStore(
      libraryStub({ updateCapture }),
      runtimeStub({
        ocrCompute: signal<OcrComputePreflight | null>({
          apiVersion: '2.0',
          schemaVersion: '1',
          service: 'capture-runtime',
          runtimeVersion: '0.4.2',
          contractSetVersion: '2',
          contractSha256: 'a'.repeat(64),
          workerSha256: undefined,
          mode: 'gpu-dml',
          adapterClass: 'dedicated',
          reasonCode: null,
          userNoticeRequired: false,
          noticeCode: null,
        }),
        getOcr,
        deleteCapture,
      }),
    );

    store.retry(summary.documentId);
    TestBed.tick();
    await settleCaptureLifecycle();

    expect(getOcr).toHaveBeenCalledWith('capture-1');
    expect(captureUpdates(updateCapture)).toContainEqual(expect.objectContaining({
      status: 'recovery_required',
      captureId: 'capture-1',
    }));
    expect(deleteCapture).not.toHaveBeenCalled();
  });

  it('uses an explicit native acceptance PDF page scope while keeping the default unbounded', () => {
    const createCapture = vi.fn(() => of(completedJob));
    const store = initializeStore(
      libraryStub({
        list: vi.fn(() => of<readonly DesktopLibrarySummary[]>([summary])),
      }),
      runtimeStub({
        pdfPageNumbers: signal<readonly number[]>([1]),
        createCapture,
      }),
    );

    store.retry(summary.documentId);
    TestBed.tick();

    expect(createCapture).toHaveBeenCalledWith(
      summary.documentId,
      expect.any(String),
      [1],
    );
  });

  it('publishes raw during structuring before the terminal result is committed', async () => {
    const structuringJob = job({
      captureId: 'capture-1',
      status: 'structuring',
    });
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update } as DesktopLibrarySummary));
    const getRaw = vi.fn(() => of(raw));
    const store = initializeStore(
      libraryStub({ updateCapture }),
      runtimeStub({
        createCapture: vi.fn(() => of(structuringJob)),
        getCapture: vi.fn(() => of(completedJob)),
        getRaw,
      }),
    );

    vi.useFakeTimers();
    try {
      store.retry(summary.documentId);
      vi.advanceTimersByTime(700);
      TestBed.tick();
      vi.useRealTimers();
      await settleCaptureLifecycle();

      const updates = captureUpdates(updateCapture);
      const rawUpdates = updates.filter((update) => 'raw' in update);
      const resultIndex = updates.findIndex(
        (update) => update['status'] === 'completed' && 'result' in update,
      );

      expect(rawUpdates).toHaveLength(1);
      expect(rawUpdates[0]).toEqual(expect.objectContaining({
        documentId: summary.documentId,
        captureId: 'capture-1',
        status: 'processing',
        stage: 'structuring',
        raw,
      }));
      expect(rawUpdates[0]).not.toHaveProperty('result');
      expect(resultIndex).toBeGreaterThan(updates.indexOf(rawUpdates[0]));
      expect(updates[resultIndex]).toEqual(expect.objectContaining({
        status: 'completed',
        captureId: 'capture-1',
        result,
      }));
      expect(updates[resultIndex]).not.toHaveProperty('raw');
      expect(getRaw).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling at awaiting_structuring and durably commits OCR before runtime cleanup', async () => {
    const captureId = 'capture-ocr-first';
    const created = job({ captureId, status: 'created', stage: 'created' });
    const extracting = job({ captureId, status: 'extracting', stage: 'extracting' });
    const awaitingStructuring = job({
      captureId,
      status: 'awaiting_structuring',
      stage: 'awaiting_structuring',
    });
    const events: string[] = [];
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      const evidence = update['ocrEvidence'];
      if (
        evidence !== undefined
        && typeof evidence === 'object'
        && evidence !== null
        && (evidence as { status?: unknown }).status !== update['status']
      ) {
        return throwError(() => new Error('native OCR evidence status validation failed'));
      }
      return of({ ...summary, ...update } as DesktopLibrarySummary).pipe(
        finalize(() => {
          if (update['ocrEvidence'] !== undefined) {
            events.push('library:durable-awaiting-write:complete');
          }
          if (update['clearCaptureId'] === true && update['status'] === 'awaiting_confirmation') {
            events.push('library:clearCaptureId:complete');
          }
        }),
      );
    });
    const getCapture = vi.fn(() => {
      if (getCapture.mock.calls.length === 1) return of(extracting);
      if (getCapture.mock.calls.length === 2) return of(awaitingStructuring);
      return throwError(() => new Error('poll after awaiting_structuring is forbidden'));
    });
    const getRaw = vi.fn(() => of(raw).pipe(
      finalize(() => events.push('runtime:getRaw:complete')),
    ));
    const getOcr = vi.fn(() => of(ocrProjection(captureId, 'completed')).pipe(
      finalize(() => events.push('runtime:getOcr:complete')),
    ));
    const getResult = vi.fn(() => of(result));
    const deleteCapture = vi.fn(() => of(undefined).pipe(
      finalize(() => events.push('runtime:delete:complete')),
    ));
    const startModelInstallation = vi.fn();
    const store = initializeStore(
      libraryStub({
        list: vi.fn(() => of<readonly DesktopLibrarySummary[]>([summary])),
        updateCapture,
      }),
      runtimeStub({
        createCapture: vi.fn(() => of(created)),
        getCapture,
        getRaw,
        getOcr,
        getResult,
        deleteCapture,
        startModelInstallation,
      }),
    );

    vi.useFakeTimers();
    try {
      store.retry(summary.documentId);
      TestBed.tick();
      for (let index = 0; index < 3; index += 1) {
        vi.advanceTimersByTime(700);
        TestBed.tick();
        for (let microtask = 0; microtask < 5; microtask += 1) {
          await Promise.resolve();
        }
      }
      vi.useRealTimers();
      await settleCaptureLifecycle();

      const updates = captureUpdates(updateCapture);
      const evidenceUpdate = updates.find((update) => update['ocrEvidence'] !== undefined);
      expect(evidenceUpdate).toEqual(expect.objectContaining({
        documentId: summary.documentId,
        captureId,
        status: 'completed',
        stage: 'awaiting_structuring',
        raw,
        ocrEvidence: expect.objectContaining({
          schemaVersion: 1,
          captureId,
        }),
      }));
      const confirmationUpdate = updates.find(
        (update) => update['status'] === 'awaiting_confirmation' && update['clearCaptureId'] === true,
      );
      expect(confirmationUpdate).toEqual(expect.objectContaining({
        documentId: summary.documentId,
        status: 'awaiting_confirmation',
        stage: 'awaiting_structuring',
        clearCaptureId: true,
      }));
      expect(confirmationUpdate).not.toHaveProperty('captureId');
      expect(confirmationUpdate).not.toHaveProperty('ocrEvidence');
      expect(getCapture).toHaveBeenCalledTimes(2);
      expect(getRaw).toHaveBeenCalledOnce();
      expect(getOcr).toHaveBeenCalledOnce();
      expect(evidenceUpdate).not.toHaveProperty('result');
      expect(getResult).not.toHaveBeenCalled();
      expect(startModelInstallation).not.toHaveBeenCalled();
      expect(deleteCapture).toHaveBeenCalledOnce();
      expect(deleteCapture).toHaveBeenCalledWith(captureId);
      const rawIndex = events.indexOf('runtime:getRaw:complete');
      const ocrIndex = events.indexOf('runtime:getOcr:complete');
      const durableIndex = events.indexOf('library:durable-awaiting-write:complete');
      const deleteIndex = events.indexOf('runtime:delete:complete');
      const clearIndex = events.indexOf('library:clearCaptureId:complete');
      expect(rawIndex).toBeLessThan(ocrIndex);
      expect(ocrIndex).toBeLessThan(durableIndex);
      expect(durableIndex).toBeLessThan(deleteIndex);
      expect(deleteIndex).toBeLessThan(clearIndex);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains the runtime job when awaiting OCR durability fails before cleanup', async () => {
    const captureId = 'capture-ocr-first-durable-failure';
    const created = job({ captureId, status: 'created', stage: 'created' });
    const extracting = job({ captureId, status: 'extracting', stage: 'extracting' });
    const awaitingStructuring = job({
      captureId,
      status: 'awaiting_structuring',
      stage: 'awaiting_structuring',
    });
    const events: string[] = [];
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      if (update['ocrEvidence'] !== undefined) {
        events.push('library:durable-awaiting-write:failed');
        return throwError(() => new Error('durable awaiting write failed'));
      }
      return of({ ...summary, ...update } as DesktopLibrarySummary).pipe(
        finalize(() => {
          if (update['clearCaptureId'] === true && update['status'] === 'awaiting_confirmation') {
            events.push('library:clearCaptureId:complete');
          }
        }),
      );
    });
    const getCapture = vi.fn(() => {
      if (getCapture.mock.calls.length === 1) return of(extracting);
      if (getCapture.mock.calls.length === 2) return of(awaitingStructuring);
      return throwError(() => new Error('poll after awaiting_structuring is forbidden'));
    });
    const getRaw = vi.fn(() => of(raw).pipe(
      finalize(() => events.push('runtime:getRaw:complete')),
    ));
    const getOcr = vi.fn(() => of(ocrProjection(captureId, 'completed')).pipe(
      finalize(() => events.push('runtime:getOcr:complete')),
    ));
    const deleteCapture = vi.fn(() => of(undefined));
    const store = initializeStore(
      libraryStub({
        list: vi.fn(() => of<readonly DesktopLibrarySummary[]>([summary])),
        updateCapture,
      }),
      runtimeStub({
        createCapture: vi.fn(() => of(created)),
        getCapture,
        getRaw,
        getOcr,
        deleteCapture,
      }),
    );

    vi.useFakeTimers();
    try {
      store.retry(summary.documentId);
      TestBed.tick();
      for (let index = 0; index < 3; index += 1) {
        vi.advanceTimersByTime(700);
        TestBed.tick();
        for (let microtask = 0; microtask < 5; microtask += 1) {
          await Promise.resolve();
        }
      }
      vi.useRealTimers();
      await settleCaptureLifecycle();

      const updates = captureUpdates(updateCapture);
      expect(getCapture).toHaveBeenCalledTimes(2);
      expect(getRaw).toHaveBeenCalledOnce();
      expect(getOcr).toHaveBeenCalledOnce();
      expect(events).toContain('library:durable-awaiting-write:failed');
      expect(events.indexOf('runtime:getRaw:complete')).toBeLessThan(
        events.indexOf('runtime:getOcr:complete'),
      );
      expect(events.indexOf('runtime:getOcr:complete')).toBeLessThan(
        events.indexOf('library:durable-awaiting-write:failed'),
      );
      expect(updates).toContainEqual(expect.objectContaining({
        documentId: summary.documentId,
        captureId,
        status: 'recovery_required',
      }));
      expect(updates.some(
        (update) => update['clearCaptureId'] === true && update['status'] !== 'processing',
      )).toBe(false);
      expect(deleteCapture).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['failed OCR projection', (captureId: string) => ocrProjection(captureId, 'failed')],
    ['completed projection with a failed page', (captureId: string) => ({
      ...ocrProjection(captureId, 'completed'),
      pages: [ocrProjection(captureId, 'failed').pages[0]],
    })],
  ] as const)(
    'fails closed at the OCR checkpoint for %s',
    async (_case, projectionFactory) => {
      const captureId = `capture-ocr-checkpoint-${_case.replace(/ /g, '-')}`;
      const created = job({ captureId, status: 'created', stage: 'created' });
      const extracting = job({ captureId, status: 'extracting', stage: 'extracting' });
      const awaitingStructuring = job({
        captureId,
        status: 'awaiting_structuring',
        stage: 'awaiting_structuring',
      });
      const updateCapture = vi.fn((update: Record<string, unknown>) =>
        of({ ...summary, ...update } as DesktopLibrarySummary));
      const getCapture = vi.fn(() => {
        if (getCapture.mock.calls.length === 1) return of(extracting);
        if (getCapture.mock.calls.length === 2) return of(awaitingStructuring);
        return throwError(() => new Error('poll after awaiting_structuring is forbidden'));
      });
      const getRaw = vi.fn(() => of(raw));
      const getOcr = vi.fn(() => of(projectionFactory(captureId)));
      const deleteCapture = vi.fn(() => of(undefined));
      const store = initializeStore(
        libraryStub({
          list: vi.fn(() => of<readonly DesktopLibrarySummary[]>([summary])),
          updateCapture,
        }),
        runtimeStub({
          createCapture: vi.fn(() => of(created)),
          getCapture,
          getRaw,
          getOcr,
          deleteCapture,
        }),
      );

      vi.useFakeTimers();
      try {
        store.retry(summary.documentId);
        TestBed.tick();
        for (let index = 0; index < 3; index += 1) {
          vi.advanceTimersByTime(700);
          TestBed.tick();
          for (let microtask = 0; microtask < 5; microtask += 1) {
            await Promise.resolve();
          }
        }
        vi.useRealTimers();
        await settleCaptureLifecycle();

        const updates = captureUpdates(updateCapture);
        expect(getCapture).toHaveBeenCalledTimes(2);
        expect(getRaw).toHaveBeenCalledOnce();
        expect(getOcr).toHaveBeenCalledOnce();
        expect(updates).toContainEqual(expect.objectContaining({
          documentId: summary.documentId,
          captureId,
          status: 'recovery_required',
        }));
        expect(updates.some((update) => update['status'] === 'awaiting_confirmation')).toBe(false);
        expect(updates.some(
          (update) => update['clearCaptureId'] === true && update['status'] !== 'processing',
        )).toBe(false);
        expect(deleteCapture).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(['processing', 'persisting'] as const)(
    'resumes a retained runtime job after restart from %s without creating a replacement',
    async (status) => {
      const retained = {
        ...summary,
        status,
        stage: status === 'processing' ? 'extracting' : 'completed',
        captureId: 'capture-restart',
      } satisfies DesktopLibrarySummary;
      const terminal = job({
        ...completedJob,
        captureId: 'capture-restart',
      });
      const createCapture = vi.fn(() => of(completedJob));
      const getCapture = vi.fn(() => of(terminal));
      const deleteCapture = vi.fn(() => of(undefined));
      const library = libraryStub({
        list: vi.fn(() => of([retained])),
        get: vi.fn(() => of(retained as DesktopLibraryDetail)),
      });
      const store = initializeStore(
        library,
        runtimeStub({ createCapture, getCapture, deleteCapture }),
      );

      store.retry(retained.documentId);
      TestBed.tick();
      await settleCaptureLifecycle();

      expect(createCapture).not.toHaveBeenCalled();
      expect(getCapture).toHaveBeenCalledWith('capture-restart');
      expect(deleteCapture).toHaveBeenCalledWith('capture-restart');
    },
  );

  it.each([
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['canceled', 'cancelled'],
  ] as const)(
    'retries only cleanup after restart when %s terminal data is already committed',
    (status, stage) => {
      const retained = {
        ...summary,
        status,
        stage,
        captureId: 'capture-committed',
        errorCode: status === 'completed' ? undefined : 'terminal_error',
        errorMessage: status === 'completed' ? undefined : 'terminal evidence',
      } satisfies DesktopLibrarySummary;
      const createCapture = vi.fn(() => of(completedJob));
      const getCapture = vi.fn(() => of(completedJob));
      const getRaw = vi.fn(() => of(raw));
      const deleteCapture = vi.fn(() => of(undefined));
      const updateCapture = vi.fn((update: Record<string, unknown>) =>
        of({ ...retained, ...update } as DesktopLibrarySummary));
      const store = initializeStore(
        libraryStub({
          list: vi.fn(() => of([retained])),
          get: vi.fn(() => of(retained as DesktopLibraryDetail)),
          updateCapture,
        }),
        runtimeStub({ createCapture, getCapture, getRaw, deleteCapture }),
      );

      store.retry(retained.documentId);
      TestBed.tick();

      expect(createCapture).not.toHaveBeenCalled();
      expect(getCapture).not.toHaveBeenCalled();
      expect(getRaw).not.toHaveBeenCalled();
      expect(deleteCapture).toHaveBeenCalledWith('capture-committed');
      expect(captureUpdates(updateCapture)).toContainEqual(
        expect.objectContaining({
          status,
          clearCaptureId: true,
          errorCode: retained.errorCode,
          errorMessage: retained.errorMessage,
        }),
      );
    },
  );

  it('remembers repeated cancel clicks before create resolves and sends one independent request', () => {
    const created = new Subject<CaptureOperation>();
    const cancelCapture = vi.fn(() => of(cancelledJob));
    const getCapture = vi.fn(() => of(completedJob));
    const library = libraryStub();
    const client = runtimeStub({
      createCapture: vi.fn(() => created),
      cancelCapture,
      getCapture,
    });
    const store = initializeStore(library, client);

    store.retry(summary.documentId);
    store.cancel(summary.documentId);
    store.cancel(summary.documentId);
    created.next(runningJob);
    created.complete();
    TestBed.tick();

    expect(cancelCapture).toHaveBeenCalledOnce();
    expect(cancelCapture).toHaveBeenCalledWith('capture-1');
    expect(getCapture).not.toHaveBeenCalled();
  });

  it('interrupts an in-flight poll and sends cancellation immediately', () => {
    const polled = new Subject<CaptureOperation>();
    const cancelCapture = vi.fn(() => of(cancelledJob));
    const getCapture = vi.fn(() => polled);
    const client = runtimeStub({
      createCapture: vi.fn(() => of(runningJob)),
      cancelCapture,
      getCapture,
    });
    const store = initializeStore(libraryStub(), client);

    vi.useFakeTimers();
    try {
      store.retry(summary.documentId);
      vi.advanceTimersByTime(700);
      expect(getCapture).toHaveBeenCalledWith('capture-1');
      expect(cancelCapture).not.toHaveBeenCalled();

      store.cancel(summary.documentId);
      TestBed.tick();

      expect(cancelCapture).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets an already-terminal runtime response win a cancel/complete race', async () => {
    const created = new Subject<CaptureOperation>();
    const cancelCapture = vi.fn(() => of(cancelledJob));
    const deleteCapture = vi.fn(() => of(undefined));
    const client = runtimeStub({
      createCapture: vi.fn(() => created),
      cancelCapture,
      deleteCapture,
    });
    const store = initializeStore(libraryStub(), client);

    store.retry(summary.documentId);
    store.cancel(summary.documentId);
    created.next(completedJob);
    created.complete();
    TestBed.tick();
    await settleCaptureLifecycle();

    expect(cancelCapture).not.toHaveBeenCalled();
    expect(deleteCapture).toHaveBeenCalledWith('capture-1');
  });

  it('persists optional raw data before deleting a canceled runtime job', () => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update } as DesktopLibrarySummary));
    const getRaw = vi.fn(() => of(raw));
    const getOcr = vi.fn(() => of(ocrProjection('capture-1', 'completed')));
    const deleteCapture = vi.fn(() => of(undefined));
    const store = initializeStore(
      libraryStub({ updateCapture }),
      runtimeStub({
        createCapture: vi.fn(() => of(cancelledJob)),
        getRaw,
        getOcr,
        deleteCapture,
      }),
    );

    store.retry(summary.documentId);
    TestBed.tick();

    expect(getRaw).toHaveBeenCalledWith('capture-1');
    expect(captureUpdates(updateCapture)).toContainEqual(
      expect.objectContaining({
        status: 'canceled',
        captureId: 'capture-1',
        raw,
      }),
    );
    expect(getOcr).not.toHaveBeenCalled();
    expect(deleteCapture).toHaveBeenCalledWith('capture-1');
  });

  it('retains a canceled runtime job when optional raw retrieval fails', () => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update } as DesktopLibrarySummary));
    const deleteCapture = vi.fn(() => of(undefined));
    const store = initializeStore(
      libraryStub({ updateCapture }),
      runtimeStub({
        createCapture: vi.fn(() => of(cancelledJob)),
        getRaw: vi.fn(() => throwError(() => new Error('raw transport failed'))),
        deleteCapture,
      }),
    );

    store.retry(summary.documentId);
    TestBed.tick();

    expect(captureUpdates(updateCapture)).toContainEqual(
      expect.objectContaining({
        status: 'recovery_required',
        captureId: 'capture-1',
        recoveryCode: 'capture_recovery_required',
      }),
    );
    expect(deleteCapture).not.toHaveBeenCalled();
  });

  it('retains the capture ID and skips DELETE when cancellation fails', () => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update } as DesktopLibrarySummary));
    const deleteCapture = vi.fn(() => of(undefined));
    const client = runtimeStub({
      createCapture: vi.fn(() => of(runningJob)),
      cancelCapture: vi.fn(() =>
        throwError(() => new Error('cancel request failed'))),
      deleteCapture,
    });
    const store = initializeStore(libraryStub({ updateCapture }), client);

    store.retry(summary.documentId);
    store.cancel(summary.documentId);
    TestBed.tick();

    expect(captureUpdates(updateCapture)).toContainEqual(
      expect.objectContaining({
        status: 'recovery_required',
        captureId: 'capture-1',
        recoveryCode: 'cancel_failed',
      }),
    );
    expect(deleteCapture).not.toHaveBeenCalled();
  });

  it.each([
    ['raw retrieval', {
      getRaw: vi.fn(() => throwError(() => new Error('raw failed'))),
    }],
    ['result retrieval', {
      getResult: vi.fn(() => throwError(() => new Error('result failed'))),
    }],
  ])('retains the runtime job when %s fails', async (_case, runtimeOverride) => {
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...summary, ...update } as DesktopLibrarySummary));
    const deleteCapture = vi.fn(() => of(undefined));
    const client = runtimeStub({
      createCapture: vi.fn(() => of(completedJob)),
      deleteCapture,
      ...runtimeOverride,
    });
    const store = initializeStore(libraryStub({ updateCapture }), client);

    store.retry(summary.documentId);
    TestBed.tick();
    await settleCaptureLifecycle();

    expect(captureUpdates(updateCapture)).toContainEqual(
      expect.objectContaining({
        status: 'recovery_required',
        captureId: 'capture-1',
        recoveryCode: 'capture_recovery_required',
      }),
    );
    expect(deleteCapture).not.toHaveBeenCalled();
  });

  it('retains the runtime job when the terminal library commit fails', async () => {
    let terminalCommitAttempted = false;
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      if (update['status'] === 'completed' && !update['clearCaptureId']) {
        terminalCommitAttempted = true;
        return throwError(() => new Error('library commit failed'));
      }
      return of({ ...summary, ...update } as DesktopLibrarySummary);
    });
    const deleteCapture = vi.fn(() => of(undefined));
    const client = runtimeStub({
      createCapture: vi.fn(() => of(completedJob)),
      deleteCapture,
    });
    const store = initializeStore(libraryStub({ updateCapture }), client);

    store.retry(summary.documentId);
    TestBed.tick();
    await settleCaptureLifecycle();

    expect(terminalCommitAttempted).toBe(true);
    expect(captureUpdates(updateCapture)).toContainEqual(
      expect.objectContaining({
        status: 'recovery_required',
        captureId: 'capture-1',
      }),
    );
    expect(deleteCapture).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed'] as const)(
    'retains the durable %s capture across terminal and recovery write failures',
    async (terminalStatus) => {
      const captureId = `capture-terminal-recovery-write-failure-${terminalStatus}`;
      const terminal = job({
        captureId,
        status: terminalStatus,
        stage: terminalStatus,
        ...(terminalStatus === 'failed'
          ? { error: { code: 'terminal_error', message: 'terminal evidence' } }
          : {}),
      });
      const durable = { ...summary } as DesktopLibrarySummary;
      const terminalUpdates: Record<string, unknown>[] = [];
      const recoveryUpdates: Record<string, unknown>[] = [];
      const cleanupClearUpdates: Record<string, unknown>[] = [];
      let failTerminalWrite = true;
      let failRecoveryWrite = true;
      const updateCapture = vi.fn((update: Record<string, unknown>) => {
        if (
          (update['status'] === 'completed' || update['status'] === 'failed')
          && 'ocrEvidence' in update
        ) {
          terminalUpdates.push(update);
          if (failTerminalWrite) {
            failTerminalWrite = false;
            return throwError(() => new Error('terminal OCR commit failed'));
          }
        }
        if (update['status'] === 'recovery_required') {
          recoveryUpdates.push(update);
          if (failRecoveryWrite) {
            failRecoveryWrite = false;
            return throwError(() => new Error('recovery write failed'));
          }
        }
        if (
          update['clearCaptureId'] === true
          && update['status'] !== 'processing'
        ) {
          cleanupClearUpdates.push(update);
        }
        Object.assign(durable, applyDurableCaptureUpdate(durable, update));
        return of(durable);
      });
      const getOcr = vi.fn((id: string) => of(ocrProjection(id, terminalStatus)));
      const deleteCapture = vi.fn(() => of(undefined));
      const createCapture = vi.fn(() => of(terminal));
      const getCapture = vi.fn(() => of(terminal));
      const library = libraryStub({
        list: vi.fn(() => of([durable])),
        get: vi.fn(() => of(durable as DesktopLibraryDetail)),
        updateCapture,
      });
      const store = initializeStore(
        library,
        runtimeStub({ createCapture, getCapture, getOcr, deleteCapture }),
      );

      store.retry(summary.documentId);
      TestBed.tick();
      await settleCaptureLifecycle();

      expect(getOcr).toHaveBeenCalledWith(captureId);
      expect(terminalUpdates).toHaveLength(1);
      expect(terminalUpdates[0]).toEqual(expect.objectContaining({
        captureId,
        status: terminalStatus,
        ocrEvidence: expect.objectContaining({
          schemaVersion: 1,
          captureId,
          status: terminalStatus,
          digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      }));
      expect(recoveryUpdates).toHaveLength(1);
      expect(deleteCapture).not.toHaveBeenCalled();
      expect(cleanupClearUpdates).toHaveLength(0);
      expect(durable).toEqual(expect.objectContaining({
        status: 'persisting',
        captureId,
      }));
      expect(store.busyIds().has(summary.documentId)).toBe(false);

      store.retry(summary.documentId);
      TestBed.tick();
      await settleCaptureLifecycle();

      expect(createCapture).toHaveBeenCalledOnce();
      expect(getCapture).toHaveBeenCalledWith(captureId);
    },
  );

  it('retains a recovery link when runtime DELETE fails after a successful commit', async () => {
    const events: string[] = [];
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      events.push(`library:${String(update['status'])}`);
      return of({ ...summary, ...update } as DesktopLibrarySummary);
    });
    const deleteCapture = vi.fn(() => {
      events.push('runtime:delete');
      return throwError(() => new Error('delete failed'));
    });
    const client = runtimeStub({
      createCapture: vi.fn(() => of(completedJob)),
      deleteCapture,
    });
    const store = initializeStore(libraryStub({ updateCapture }), client);

    store.retry(summary.documentId);
    TestBed.tick();
    await settleCaptureLifecycle();

    expect(events.indexOf('library:completed')).toBeLessThan(
      events.indexOf('runtime:delete'),
    );
    expect(captureUpdates(updateCapture)).toContainEqual(
      expect.objectContaining({
        status: 'recovery_required',
        captureId: 'capture-1',
        recoveryCode: 'runtime_cleanup_failed',
      }),
    );
  });

  it.each([
    ['failed', 'failed'],
    ['cancelled', 'canceled'],
  ] as const)(
    'keeps %s terminal evidence separate when runtime cleanup fails',
    async (runtimeStatus, libraryStatus) => {
      const terminal = job({
        captureId: 'capture-terminal-error',
        status: runtimeStatus,
        stage: runtimeStatus,
        error: {
          code: 'terminal_error',
          message: 'terminal evidence',
        },
      });
      const updateCapture = vi.fn((update: Record<string, unknown>) =>
        of({ ...summary, ...update } as DesktopLibrarySummary));
      const deleteCapture = vi.fn(() =>
        throwError(() => new Error('cleanup transport failed')));
      const store = initializeStore(
        libraryStub({ updateCapture }),
        runtimeStub({
          createCapture: vi.fn(() => of(terminal)),
          deleteCapture,
        }),
      );

      store.retry(summary.documentId);
      TestBed.tick();
      await settleCaptureLifecycle();

      expect(captureUpdates(updateCapture)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          status: libraryStatus,
          captureId: 'capture-terminal-error',
          raw,
          errorCode: 'terminal_error',
          errorMessage: 'terminal evidence',
        }),
        expect.objectContaining({
          status: 'recovery_required',
          captureId: 'capture-terminal-error',
          errorCode: 'terminal_error',
          errorMessage: 'terminal evidence',
          recoveryCode: 'runtime_cleanup_failed',
          recoveryMessage: 'cleanup transport failed',
        }),
      ]));
    },
  );

  it.each([
    ['failed', 'failed'],
    ['canceled', 'cancelled'],
  ] as const)(
    'preserves %s terminal evidence when retrying cleanup after restart',
    (status, stage) => {
      const recovery = {
        ...summary,
        status: 'recovery_required',
        stage,
        captureId: 'capture-cleanup-terminal',
        errorCode: 'terminal_error',
        errorMessage: 'terminal evidence',
        recoveryCode: 'runtime_cleanup_failed',
        recoveryMessage: 'cleanup transport failed',
      } satisfies DesktopLibrarySummary;
      const createCapture = vi.fn(() => of(completedJob));
      const getCapture = vi.fn(() => of(completedJob));
      const getRaw = vi.fn(() => of(raw));
      const deleteCapture = vi.fn(() => of(undefined));
      const updateCapture = vi.fn((update: Record<string, unknown>) =>
        of({ ...recovery, ...update } as DesktopLibrarySummary));
      const store = initializeStore(
        libraryStub({
          list: vi.fn(() => of([recovery])),
          get: vi.fn(() => of(recovery as DesktopLibraryDetail)),
          updateCapture,
        }),
        runtimeStub({ createCapture, getCapture, getRaw, deleteCapture }),
      );

      store.retry(recovery.documentId);
      TestBed.tick();

      expect(createCapture).not.toHaveBeenCalled();
      expect(getCapture).not.toHaveBeenCalled();
      expect(getRaw).not.toHaveBeenCalled();
      expect(deleteCapture).toHaveBeenCalledWith('capture-cleanup-terminal');
      expect(captureUpdates(updateCapture)).toContainEqual(
        expect.objectContaining({
          status,
          clearCaptureId: true,
          errorCode: 'terminal_error',
          errorMessage: 'terminal evidence',
        }),
      );
    },
  );

  it('keeps cleanup-only recovery durable when both post-commit library writes fail', async () => {
    const terminal = job({
      captureId: 'capture-double-write',
      status: 'failed',
      stage: 'failed',
      error: {
        code: 'terminal_error',
        message: 'terminal evidence',
      },
    });
    let durable: DesktopLibrarySummary = summary;
    let clearWriteFailed = false;
    let recoveryWriteFailed = false;
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      if (
        update['clearCaptureId'] === true
        && update['status'] === 'failed'
        && !clearWriteFailed
      ) {
        clearWriteFailed = true;
        return throwError(() => new Error('clear link write failed'));
      }
      if (
        update['recoveryCode'] === 'runtime_cleanup_failed'
        && !recoveryWriteFailed
      ) {
        recoveryWriteFailed = true;
        return throwError(() => new Error('recovery metadata write failed'));
      }
      durable = applyDurableCaptureUpdate(durable, update);
      return of(durable);
    });
    const library = libraryStub({
      list: vi.fn(() => of([durable])),
      get: vi.fn(() => of(durable as DesktopLibraryDetail)),
      updateCapture,
    });
    const deleteCapture = vi.fn(() => of(undefined));
    const firstStore = initializeStore(
      library,
      runtimeStub({
        createCapture: vi.fn(() => of(terminal)),
        deleteCapture,
      }),
    );

    firstStore.retry(summary.documentId);
    TestBed.tick();
    await settleCaptureLifecycle();

    expect(clearWriteFailed).toBe(true);
    expect(recoveryWriteFailed).toBe(true);
    expect(durable).toEqual(expect.objectContaining({
      status: 'recovery_required',
      stage: 'failed',
      captureId: 'capture-double-write',
      errorCode: 'terminal_error',
      errorMessage: 'terminal evidence',
      recoveryCode: 'runtime_cleanup_failed',
      recoveryMessage: 'recovery metadata write failed',
    }));

    TestBed.resetTestingModule();
    const createAfterRestart = vi.fn(() => of(completedJob));
    const getAfterRestart = vi.fn(() => of(completedJob));
    const getRawAfterRestart = vi.fn(() => of(raw));
    const restartedStore = initializeStore(
      library,
      runtimeStub({
        createCapture: createAfterRestart,
        getCapture: getAfterRestart,
        getRaw: getRawAfterRestart,
        deleteCapture,
      }),
    );

    restartedStore.retry(summary.documentId);
    TestBed.tick();

    expect(createAfterRestart).not.toHaveBeenCalled();
    expect(getAfterRestart).not.toHaveBeenCalled();
    expect(getRawAfterRestart).not.toHaveBeenCalled();
    expect(deleteCapture).toHaveBeenCalledTimes(2);
    expect(durable).toEqual(expect.objectContaining({
      status: 'failed',
      captureId: undefined,
      errorCode: 'terminal_error',
      errorMessage: 'terminal evidence',
      recoveryCode: undefined,
      recoveryMessage: undefined,
    }));
  });

  it('keeps cleanup-only recovery durable when retry cleanup writes fail twice', () => {
    let durable: DesktopLibrarySummary = {
      ...summary,
      status: 'recovery_required',
      stage: 'cancelled',
      captureId: 'capture-retry-double-write',
      errorCode: 'terminal_cancelled',
      errorMessage: 'canceled terminal evidence',
      recoveryCode: 'runtime_cleanup_failed',
      recoveryMessage: 'initial cleanup failure',
    };
    let clearWriteFailed = false;
    let recoveryWriteFailed = false;
    const updateCapture = vi.fn((update: Record<string, unknown>) => {
      if (update['clearCaptureId'] === true && !clearWriteFailed) {
        clearWriteFailed = true;
        return throwError(() => new Error('retry clear link write failed'));
      }
      if (
        update['recoveryCode'] === 'runtime_cleanup_failed'
        && !recoveryWriteFailed
      ) {
        recoveryWriteFailed = true;
        return throwError(() => new Error('retry recovery metadata write failed'));
      }
      durable = applyDurableCaptureUpdate(durable, update);
      return of(durable);
    });
    const library = libraryStub({
      list: vi.fn(() => of([durable])),
      get: vi.fn(() => of(durable as DesktopLibraryDetail)),
      updateCapture,
    });
    const createCapture = vi.fn(() => of(completedJob));
    const getCapture = vi.fn(() => of(completedJob));
    const getRaw = vi.fn(() => of(raw));
    const deleteCapture = vi.fn(() => of(undefined));
    const store = initializeStore(
      library,
      runtimeStub({ createCapture, getCapture, getRaw, deleteCapture }),
    );

    store.retry(summary.documentId);
    TestBed.tick();

    expect(clearWriteFailed).toBe(true);
    expect(recoveryWriteFailed).toBe(true);
    expect(createCapture).not.toHaveBeenCalled();
    expect(getCapture).not.toHaveBeenCalled();
    expect(getRaw).not.toHaveBeenCalled();
    expect(deleteCapture).toHaveBeenCalledOnce();
    expect(durable).toEqual(expect.objectContaining({
      status: 'recovery_required',
      stage: 'cancelled',
      captureId: 'capture-retry-double-write',
      errorCode: 'terminal_cancelled',
      errorMessage: 'canceled terminal evidence',
      recoveryCode: 'runtime_cleanup_failed',
      recoveryMessage: 'retry recovery metadata write failed',
    }));
  });

  it('recovers persistence with the same runtime ID and never creates a new job', async () => {
    const recovery = {
      ...summary,
      status: 'recovery_required',
      stage: 'completed',
      captureId: 'capture-recovery',
      recoveryCode: 'capture_recovery_required',
    } satisfies DesktopLibrarySummary;
    const createCapture = vi.fn(() => of(completedJob));
    const getCapture = vi.fn(() => of(job({
      ...completedJob,
      captureId: 'capture-recovery',
    })));
    const deleteCapture = vi.fn(() => of(undefined));
    const library = libraryStub({
      list: vi.fn(() => of([recovery])),
      get: vi.fn(() => of(recovery as DesktopLibraryDetail)),
    });
    const client = runtimeStub({ createCapture, getCapture, deleteCapture });
    const store = initializeStore(library, client);

    store.retry(recovery.documentId);
    TestBed.tick();
    await settleCaptureLifecycle();

    expect(createCapture).not.toHaveBeenCalled();
    expect(getCapture).toHaveBeenCalledWith('capture-recovery');
    expect(deleteCapture).toHaveBeenCalledWith('capture-recovery');
  });

  it('retries only DELETE for a cleanup recovery and treats success as clearable', () => {
    const recovery = {
      ...summary,
      status: 'recovery_required',
      stage: 'completed',
      captureId: 'capture-cleanup',
      recoveryCode: 'runtime_cleanup_failed',
    } satisfies DesktopLibrarySummary;
    const updateCapture = vi.fn((update: Record<string, unknown>) =>
      of({ ...recovery, ...update } as DesktopLibrarySummary));
    const createCapture = vi.fn(() => of(completedJob));
    const getCapture = vi.fn(() => of(completedJob));
    const deleteCapture = vi.fn(() => of(undefined));
    const library = libraryStub({
      list: vi.fn(() => of([recovery])),
      get: vi.fn(() => of(recovery as DesktopLibraryDetail)),
      updateCapture,
    });
    const client = runtimeStub({ createCapture, getCapture, deleteCapture });
    const store = initializeStore(library, client);

    store.retry(recovery.documentId);
    TestBed.tick();

    expect(createCapture).not.toHaveBeenCalled();
    expect(getCapture).not.toHaveBeenCalled();
    expect(deleteCapture).toHaveBeenCalledWith('capture-cleanup');
    expect(captureUpdates(updateCapture)).toContainEqual(
      expect.objectContaining({
        status: 'completed',
        clearCaptureId: true,
      }),
    );
  });

  it('deletes only the document UUID selected by the host action', () => {
    const first = {
      ...summary,
      documentId: '1'.repeat(32),
      status: 'completed',
      stage: 'completed',
    } satisfies DesktopLibrarySummary;
    const second = {
      ...summary,
      documentId: '2'.repeat(32),
      fileName: 'second.pdf',
      status: 'completed',
      stage: 'completed',
    } satisfies DesktopLibrarySummary;
    const deleteDocument = vi.fn(() => of(undefined));
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const store = initializeStore(
      libraryStub({
        list: vi.fn(() => of([first, second])),
        delete: deleteDocument,
      }),
      runtimeStub(),
    );

    store.delete(second.documentId);

    expect(deleteDocument).toHaveBeenCalledOnce();
    expect(deleteDocument).toHaveBeenCalledWith(second.documentId);
    expect(deleteDocument).not.toHaveBeenCalledWith(first.documentId);
    confirm.mockRestore();
  });

  it('blocks direct deletion while a native capture is active', () => {
    const pendingCapture = new Subject<CaptureOperation>();
    const deleteDocument = vi.fn(() => of(undefined));
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const library = libraryStub({
      createSource: vi.fn(() => of(summary)),
      delete: deleteDocument,
    });
    const store = initializeStore(
      library,
      runtimeStub({ createCapture: vi.fn(() => pendingCapture) }),
    );

    store.addSourcePaths(['C:\\private\\active.pdf']);
    TestBed.tick();
    store.delete(summary.documentId);

    expect(deleteDocument).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    pendingCapture.complete();
    confirm.mockRestore();
  });

  it('refreshes the selected document after processing and runtime ID updates', () => {
    const pendingCapture = new Subject<CaptureOperation>();
    const list = vi.fn(() => of<readonly DesktopLibrarySummary[]>([summary]));
    const store = initializeStore(
      libraryStub({ list }),
      runtimeStub({ createCapture: vi.fn(() => pendingCapture) }),
    );
    store.select(summary.documentId);
    TestBed.tick();
    const beforeCapture = list.mock.calls.length;

    store.retry(summary.documentId);
    TestBed.tick();

    expect(list.mock.calls.length).toBeGreaterThan(beforeCapture);
    pendingCapture.complete();
  });

  it('blocks direct deletion while a durable runtime capture id is retained', () => {
    const retained = {
      ...summary,
      status: 'recovery_required',
      captureId: 'capture-retained',
    } satisfies DesktopLibrarySummary;
    const deleteDocument = vi.fn(() => of(undefined));
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const store = initializeStore(
      libraryStub({
        list: vi.fn(() => of([retained])),
        delete: deleteDocument,
      }),
      runtimeStub(),
    );

    store.delete(retained.documentId);

    expect(deleteDocument).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});

function initializeStore(
  library: ReturnType<typeof libraryStub>,
  client: ReturnType<typeof runtimeStub>,
): DesktopWorkspaceStore {
  TestBed.configureTestingModule({
    providers: [
      { provide: DesktopLibraryService, useValue: library },
      { provide: DesktopRuntimeClientService, useValue: client },
      DesktopWorkspaceStore,
    ],
  });
  const store = TestBed.inject(DesktopWorkspaceStore);
  store.initialize();
  TestBed.tick();
  return store;
}

function libraryStub(overrides: Record<string, unknown> = {}) {
  return Object.assign({
    list: vi.fn(() => of<readonly DesktopLibrarySummary[]>([])),
    get: vi.fn(() => of<DesktopLibraryDetail>(summary)),
    selectSources: vi.fn(() => of<readonly string[]>([])),
    droppedSources: vi.fn(() => EMPTY),
    createSource: vi.fn(() => of(summary)),
    updateCapture: vi.fn(() => of(summary)),
    export: vi.fn(),
    delete: vi.fn(() => of(undefined)),
  }, overrides);
}

function runtimeStub(overrides: Record<string, unknown> = {}) {
  return Object.assign({
    ready: signal(true),
    started: signal(true),
    error: signal<Error | undefined>(undefined),
    ocrCompute: signal<OcrComputePreflight | null>({
      apiVersion: '2.0',
      schemaVersion: '1',
      service: 'capture-runtime',
      runtimeVersion: '0.4.2',
      contractSetVersion: '2',
      contractSha256: 'a'.repeat(64),
      workerSha256: 'f'.repeat(64),
      mode: 'gpu-dml',
      adapterClass: 'dedicated',
      reasonCode: null,
      userNoticeRequired: false,
      noticeCode: null,
    }),
    pdfPageNumbers: signal<readonly number[] | undefined>(undefined),
    reload: vi.fn(),
    getRequirements: vi.fn(() => of([])),
    getModelOptions: vi.fn(() => of([])),
    startInstallation: vi.fn(),
    getInstallation: vi.fn(),
    startModelInstallation: vi.fn(),
    getModelInstallation: vi.fn(),
    createCapture: vi.fn(() => of(completedJob)),
    getCapture: vi.fn(() => of(completedJob)),
    cancelCapture: vi.fn(() => of(cancelledJob)),
    getRaw: vi.fn(() => of(raw)),
    getResult: vi.fn(() => of(result)),
    getOcr: vi.fn((captureId: string) => of(ocrProjection(
      captureId,
      failedOcrCaptureIds.has(captureId) ? 'failed' : 'completed',
    ))),
    deleteCapture: vi.fn(() => of(undefined)),
  }, overrides);
}

function captureUpdates(
  updateCapture: ReturnType<typeof vi.fn>,
): readonly Record<string, unknown>[] {
  return updateCapture.mock.calls.map(
    ([update]) => update as Record<string, unknown>,
  );
}

function applyDurableCaptureUpdate(
  current: DesktopLibrarySummary,
  update: Record<string, unknown>,
): DesktopLibrarySummary {
  return {
    ...current,
    ...update,
    captureId: update['clearCaptureId'] === true
      ? undefined
      : typeof update['captureId'] === 'string'
        ? update['captureId']
        : current.captureId,
    errorCode: typeof update['errorCode'] === 'string' ? update['errorCode'] : undefined,
    errorMessage: typeof update['errorMessage'] === 'string' ? update['errorMessage'] : undefined,
    recoveryCode: typeof update['recoveryCode'] === 'string' ? update['recoveryCode'] : undefined,
    recoveryMessage: typeof update['recoveryMessage'] === 'string'
      ? update['recoveryMessage']
      : undefined,
  } as DesktopLibrarySummary;
}

function job(input: Record<string, unknown>): CaptureOperation {
  return {
    protocolVersion: '2',
    ingestionId: 'ingestion-1',
    partialRevision: 0,
    lastEventSequence: 0,
    createdAt: '2026-07-20T00:00:00Z',
    source: {
      sha256: 'a'.repeat(64),
      fileName: 'fixture.pdf',
      mediaType: 'application/pdf',
      bytes: 12,
    },
    ...input,
  } as unknown as CaptureOperation;
}

function ocrProjection(
  captureId: string,
  status: 'completed' | 'failed',
): CaptureOcrProjection {
  const provenance = {
    status: 'resolved' as const,
    engine: 'windowsml-ocr' as const,
    model: 'ppocrv6-traditional-multilingual',
    modelDigest: `sha256:${'d'.repeat(64)}`,
    device: 'RTX4060',
    profileId: 'profile-1',
    profileSpecSha256: 'e'.repeat(64),
  };
  const page = status === 'completed'
    ? {
      page: 1,
      status: 'recognized' as const,
      raster: { width: 1200, height: 800, scale: 1, coordinateSystem: 'pixel' as const },
      text: 'OCR text',
      boxes: [{
        polygon: [
          { x: 100, y: 120 },
          { x: 220, y: 120 },
          { x: 220, y: 160 },
          { x: 100, y: 160 },
        ],
        text: 'OCR text',
        confidence: 0.875,
      }],
      confidence: 0.875,
      provenance,
    }
    : {
      page: 1,
      status: 'failed' as const,
      raster: { width: 1200, height: 800, scale: 1, coordinateSystem: 'pixel' as const },
      provenance,
      failure: { code: 'ocr_worker_failed', message: 'worker failed' },
    };
  return {
    apiVersion: '2.0',
    schemaVersion: '3',
    captureId,
    status,
    source: {
      sha256: 'a'.repeat(64),
      fileName: 'fixture.pdf',
      mediaType: 'application/pdf',
      bytes: 12,
    },
    pages: [page],
    pageCount: 1,
    runtimeVersion: '0.4.2',
    contractSha256: 'a'.repeat(64),
    provenance,
    ...(status === 'failed'
      ? { failure: { code: 'ocr_worker_failed', message: 'worker failed' } }
      : {}),
    createdAt: '2026-07-20T00:00:00Z',
  } as CaptureOcrProjection;
}

async function settleCaptureLifecycle(): Promise<void> {
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 25));
  await Promise.resolve();
}
