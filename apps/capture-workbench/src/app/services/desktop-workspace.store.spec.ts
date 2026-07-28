import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import type { DesktopLibraryDetail, DesktopLibrarySummary } from '../contracts';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopWorkspaceStore } from './desktop-workspace.store';

const summary: DesktopLibrarySummary = {
  documentId: 'a'.repeat(32), fileName: 'fixture.pdf', mediaType: 'application/pdf',
  byteLength: 12, createdAtMs: 1, updatedAtMs: 1, status: 'queued', stage: 'uploading',
};

describe('DesktopWorkspaceStore', () => {
  it('keeps WindowsML and Ollama installation behind one explicit setup action', async () => {
    const library = { list: vi.fn(async () => []), get: vi.fn(), createSource: vi.fn(), updateCapture: vi.fn() };
    const client = {
      getRequirements: () => of([
        {
          requirementId: 'windowsml-ocr', displayName: 'WindowsML OCR', status: 'installable',
          kind: 'engine', requiredFor: ['capture'], installStrategy: 'automatic', detail: '需要使用者同意後才能安裝。',
        },
        {
          requirementId: 'ollama-runtime', displayName: '隔離 Ollama', status: 'missing',
          kind: 'runtime', requiredFor: ['structuring'], installStrategy: 'winget', detail: '尚未安裝 Ollama 執行環境。',
        },
      ]),
    };
    TestBed.configureTestingModule({ providers: [
      { provide: DesktopLibraryService, useValue: library },
      { provide: DesktopRuntimeClientService, useValue: { getClient: async () => client } },
      DesktopWorkspaceStore,
    ] });
    const store = TestBed.inject(DesktopWorkspaceStore);

    await store.initialize();

    expect(store.state()).toBe('needs-setup');
    expect(store.coreMissing().map((item) => item.requirementId)).toEqual([
      'windowsml-ocr',
      'ollama-runtime',
    ]);
    expect(store.message()).toContain('首次準備');
  });

  it('asks for Whisper only when an audio source is selected', async () => {
    const library = { list: vi.fn(async () => []), get: vi.fn(), createSource: vi.fn(), updateCapture: vi.fn() };
    const client = {
      getRequirements: () => of([{
        requirementId: 'whisper-primary', displayName: 'Whisper', status: 'missing',
        kind: 'model', requiredFor: ['audio'], installStrategy: 'automatic', detail: '音訊功能需要安裝模型。',
      }]),
    };
    TestBed.configureTestingModule({ providers: [
      { provide: DesktopLibraryService, useValue: library },
      { provide: DesktopRuntimeClientService, useValue: { getClient: async () => client } },
      DesktopWorkspaceStore,
    ] });
    const store = TestBed.inject(DesktopWorkspaceStore);

    await store.initialize();
    await store.addFiles([new File(['audio'], 'voice.wav', { type: 'audio/wav' })]);

    expect(store.state()).toBe('needs-setup');
    expect(store.coreMissing().map((item) => item.requirementId)).toEqual(['whisper-primary']);
    expect(store.message()).toContain('Whisper');
  });

  it('persists a completed runtime capture in the desktop library', async () => {
    let current = summary;
    let detail: DesktopLibraryDetail = summary;
    const library = {
      list: vi.fn(async () => [current]),
      get: vi.fn(async () => detail),
      createSource: vi.fn(async () => current),
      updateCapture: vi.fn(async (update: Partial<DesktopLibrarySummary> & { result?: unknown; raw?: unknown }) => {
        current = { ...current, ...update, updatedAtMs: 2 };
        detail = { ...current, raw: update.raw as never, result: update.result as never };
        return current;
      }),
      loadSource: vi.fn(), export: vi.fn(), delete: vi.fn(),
    };
    const client = {
      getReady: () => of({}), getRequirements: () => of([]),
      createCapture: vi.fn(() => of({ captureId: 'capture-1', status: 'completed', stage: 'completed' })),
      getRaw: vi.fn(() => of({ sourceText: 'OCR 原始結果' })),
      getResult: vi.fn(() => of({ targetText: '結構化結果' })),
      deleteCapture: vi.fn(() => of(undefined)),
    };
    TestBed.configureTestingModule({ providers: [
      { provide: DesktopLibraryService, useValue: library },
      { provide: DesktopRuntimeClientService, useValue: { getClient: async () => client } },
      DesktopWorkspaceStore,
    ] });
    const store = TestBed.inject(DesktopWorkspaceStore);

    await store.initialize();
    await store.addFiles([new File(['fixture'], 'fixture.pdf', { type: 'application/pdf' })]);

    expect(store.state()).toBe('ready');
    expect(library.updateCapture).toHaveBeenCalledWith(expect.objectContaining({
      documentId: summary.documentId, status: 'completed', result: expect.anything(),
    }));
    expect(client.deleteCapture).toHaveBeenCalledWith('capture-1');
  });
});
