import { signal, type WritableSignal } from '@angular/core';
import type {
  CaptureClient,
  CaptureDocumentV1,
  CaptureJobV1,
  RawCaptureV1,
  RuntimeReadyV1,
  CapturePreprocessor,
  CaptureStructuringProvider,
  CaptureWorkbenchConfig,
  CaptureWorkbenchInputSource,
} from '../contracts';
import { of } from 'rxjs';

export const READY: RuntimeReadyV1 = {
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

export function job(
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
    createCapture: vi.fn(() => of(job('completed', 'completed'))),
    getCapture: vi.fn(() => of(job('completed', 'completed'))),
    cancelCapture: vi.fn(() => of(job('cancelled', 'cancelled'))),
    getRaw: vi.fn(() => of(RAW)),
    getResult: vi.fn(() => of(DOCUMENT)),
    commitStructuredResult: vi.fn(() =>
      of(job('completed', 'completed', 'host')),
    ),
    reportStructuringFailure: vi.fn(() => of(job('failed', 'failed', 'host'))),
    deleteCapture: vi.fn(() => of(undefined)),
    ...overrides,
  };
}

export function selectFiles(
  fixture: { readonly nativeElement: HTMLElement },
  files: readonly File[],
): void {
  const input = fixture.nativeElement.querySelector(
    'input[type=file]',
  ) as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change'));
}
