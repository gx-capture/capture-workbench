import { signal, type WritableSignal } from '@angular/core';
import type {
  CaptureClient,
  CaptureDocumentV1,
  CaptureEventV2,
  CaptureOperationV2,
  CaptureStreamingResult,
  PartialCaptureV2,
  RawCaptureV1,
  RuntimeReadyV1,
  CapturePreprocessor,
  CaptureStructuringProvider,
  CaptureWorkbenchConfig,
  CaptureWorkbenchInputSource,
} from '../../../contracts';
import { of } from 'rxjs';

export const READY: RuntimeReadyV1 = {
  ready: true,
  service: 'capture-runtime',
  runtimeVersion: '0.3.8',
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

export const RAW: RawCaptureV1 = {
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

export const DOCUMENT: CaptureDocumentV1 = {
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

export function streamingOperation(
  status: CaptureOperationV2['status'],
  progress = status === 'completed' ? 1 : 0.7,
): CaptureOperationV2 {
  return {
    protocolVersion: '2',
    captureId: 'capture-1',
    ingestionId: 'ingestion-1',
    kind: 'audio',
    status,
    progress,
    partialRevision: 1,
    lastEventSequence: status === 'completed' ? 3 : 1,
    source: RAW.source,
    createdAt: RAW.createdAt,
    updatedAt: RAW.createdAt,
    ...(status === 'completed' ? { completedAt: '2026-07-20T00:00:01Z' } : {}),
  };
}

export function streamingEvent(
  eventType: CaptureEventV2['eventType'],
  stage: string,
): CaptureEventV2 {
  return {
    protocolVersion: '2',
    eventId: `event-${eventType}`,
    sequence: eventType === 'completed' ? 3 : 2,
    captureId: 'capture-1',
    eventType,
    stage,
    createdAt: RAW.createdAt,
  };
}

export const PARTIAL: PartialCaptureV2 = {
  protocolVersion: '2',
  captureId: 'capture-1',
  source: RAW.source,
  revision: 1,
  coveredUntilMs: 0,
  segments: RAW.segments,
  sourceText: RAW.sourceText,
  extractionEngine: RAW.extractionEngine,
  updatedAt: RAW.createdAt,
};

export function streamingResult(
  operation = streamingOperation('completed'),
): CaptureStreamingResult {
  return { operation, raw: RAW, result: DOCUMENT };
}

export interface CaptureWorkbenchTestInputSource
  extends CaptureWorkbenchInputSource {
  readonly config: WritableSignal<CaptureWorkbenchConfig>;
  readonly client: WritableSignal<CaptureClient | null>;
  readonly structuringProvider: WritableSignal<CaptureStructuringProvider | null>;
  readonly preprocessor: WritableSignal<CapturePreprocessor | null>;
}

export function createCaptureWorkbenchTestInputSource(): CaptureWorkbenchTestInputSource {
  return {
    config: signal<CaptureWorkbenchConfig>({}),
    client: signal<CaptureClient | null>(null),
    structuringProvider: signal<CaptureStructuringProvider | null>(null),
    preprocessor: signal<CapturePreprocessor | null>(null),
  };
}

export function fakeClient(
  overrides: Partial<CaptureClient> = {},
): CaptureClient {
  return {
    getReady: vi.fn(() => of(READY)),
    getRequirements: vi.fn(() => of([])),
    startInstallation: vi.fn(),
    listInstallations: vi.fn(() => of([])),
    getInstallation: vi.fn(),
    cancelInstallation: vi.fn(),
    captureEvents: vi.fn(() => of(streamingEvent('completed', 'completed'))),
    startStreamingCapture: vi.fn(() => of(streamingOperation('completed'))),
    getStreamingCapture: vi.fn(() => of(streamingOperation('completed'))),
    cancelStreamingCapture: vi.fn(() => of(streamingOperation('cancelled'))),
    getStreamingPartial: vi.fn(() => of(PARTIAL)),
    getStreamingResult: vi.fn(() => of(streamingResult())),
    commitStreamingStructuredResult: vi.fn(() =>
      of(streamingOperation('completed')),
    ),
    reportStreamingStructuringFailure: vi.fn(() =>
      of({
        ...streamingOperation('failed'),
        error: {
          code: 'host_provider_failed',
          message: 'Host structuring failed.',
          stage: 'structuring',
        },
      }),
    ),
    deleteStreamingCapture: vi.fn(() => of(undefined)),
    ...overrides,
  };
}

export function selectFiles(
  fixture: { readonly nativeElement: HTMLElement },
  files: readonly File[],
): void {
  const input = captureWorkbenchRoot(fixture).querySelector(
    'input[type=file]',
  ) as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change'));
}

export function captureWorkbenchRoot(fixture: {
  readonly nativeElement: HTMLElement;
}): ShadowRoot {
  const root = fixture.nativeElement.shadowRoot;
  if (!root) throw new Error('Expected Capture Workbench Shadow DOM.');
  return root;
}
