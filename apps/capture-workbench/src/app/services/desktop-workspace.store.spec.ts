import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
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

describe('DesktopWorkspaceStore', () => {
  it('keeps WindowsML and Ollama installation behind one explicit setup action', () => {
    const library = libraryStub();
    const client = runtimeStub({
      getRequirements: () => of([
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
      ]),
    });
    configureStore(library, client);

    const store = TestBed.inject(DesktopWorkspaceStore);
    store.initialize();
    TestBed.tick();

    expect(store.state()).toBe('needs-setup');
    expect(store.coreMissing().map((item) => item.requirementId)).toEqual([
      'windowsml-ocr',
      'ollama-runtime',
    ]);
  });

  it('asks for Whisper only when an audio source is selected', () => {
    const library = libraryStub();
    const client = runtimeStub({
      getRequirements: () => of([{
        requirementId: 'whisper-primary',
        displayName: 'Whisper',
        status: 'missing',
        kind: 'model',
        requiredFor: ['audio'],
        installStrategy: 'automatic',
      }]),
    });
    configureStore(library, client);

    const store = TestBed.inject(DesktopWorkspaceStore);
    store.initialize();
    TestBed.tick();
    store.addFiles([new File(['audio'], 'voice.wav', { type: 'audio/wav' })]);
    TestBed.tick();

    expect(store.state()).toBe('needs-setup');
    expect(store.coreMissing().map((item) => item.requirementId)).toEqual(['whisper-primary']);
    expect(store.message()).toContain('Whisper');
  });

  it('persists a completed runtime capture in the desktop library', () => {
    let current = summary;
    let detail: DesktopLibraryDetail = summary;
    const library = libraryStub({
      list: () => of([current]),
      get: () => of(detail),
      createSource: () => of(current),
      updateCapture: vi.fn((update: Partial<DesktopLibrarySummary> & { result?: unknown; raw?: unknown }) => {
        current = { ...current, ...update, updatedAtMs: 2 };
        detail = { ...current, raw: update.raw as never, result: update.result as never };
        return of(current);
      }),
    });
    const client = runtimeStub({
      getRequirements: () => of([]),
      createCapture: vi.fn(() => of({ captureId: 'capture-1', status: 'completed', stage: 'completed' })),
      getRaw: vi.fn(() => of({ sourceText: 'OCR text' })),
      getResult: vi.fn(() => of({ targetText: 'translated text' })),
      deleteCapture: vi.fn(() => of(undefined)),
    });
    configureStore(library, client);

    const store = TestBed.inject(DesktopWorkspaceStore);
    store.initialize();
    TestBed.tick();
    store.addFiles([new File(['fixture'], 'fixture.pdf', { type: 'application/pdf' })]);
    TestBed.tick();

    expect(store.state()).toBe('ready');
    expect(library.updateCapture).toHaveBeenCalledWith(expect.objectContaining({
      documentId: summary.documentId,
      status: 'completed',
      result: expect.anything(),
    }));
    expect(client.deleteCapture).toHaveBeenCalledWith('capture-1');
  });
});

function configureStore(library: ReturnType<typeof libraryStub>, client: ReturnType<typeof runtimeStub>): void {
  TestBed.configureTestingModule({
    providers: [
      { provide: DesktopLibraryService, useValue: library },
      { provide: DesktopRuntimeClientService, useValue: client },
      DesktopWorkspaceStore,
    ],
  });
}

function libraryStub(overrides: Partial<Record<keyof typeof libraryMethods, (...args: never[]) => unknown>> = {}) {
  return {
    ...libraryMethods,
    ...overrides,
  };
}

const libraryMethods = {
  list: vi.fn(() => of<readonly DesktopLibrarySummary[]>([])),
  get: vi.fn(() => of<DesktopLibraryDetail>(summary)),
  createSource: vi.fn(() => of(summary)),
  updateCapture: vi.fn(() => of(summary)),
  export: vi.fn(),
  delete: vi.fn(() => of(undefined)),
};

function runtimeStub(overrides: Record<string, unknown>) {
  return {
    ready: signal(true),
    error: signal<Error | undefined>(undefined),
    reload: vi.fn(),
    getRequirements: vi.fn(() => of([])),
    startInstallation: vi.fn(),
    getInstallation: vi.fn(),
    createCapture: vi.fn(),
    getCapture: vi.fn(),
    cancelCapture: vi.fn(),
    getRaw: vi.fn(),
    getResult: vi.fn(),
    deleteCapture: vi.fn(() => of(undefined)),
    ...overrides,
  };
}
