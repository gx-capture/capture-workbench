import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { BehaviorSubject, of, Subject, throwError } from 'rxjs';
import type { DesktopLibraryDetail, DesktopRuntimeStatus } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopWorkspaceFormattingService } from './desktop-workspace-formatting.service';
import { DesktopWorkspaceStore } from './desktop-workspace.store';
import { DiagnosticsStore } from './diagnostics.store';

describe('DiagnosticsStore', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));
  afterEach(() => {
    vi.useRealTimers();
    setDesktopLocale('zh-TW');
  });

  it('loads no document when the query parameter is absent', () => {
    const { store, library } = setupStore(null);

    expect(store.documentId()).toBeNull();
    expect(store.document()).toBeNull();
    expect(library.get).not.toHaveBeenCalled();
  });

  it('loads the document from the query parameter and exports JSON', async () => {
    vi.useFakeTimers();
    const detailSubject = new Subject<DesktopLibraryDetail>();
    const docId = 'a'.repeat(32);
    const { store, library, formatting } = setupStore(docId, {
      get: vi.fn(() => detailSubject),
      export: vi.fn(() =>
        of({
          fileName: 'doc.json',
          mediaType: 'application/json',
          content: '{"ok":true}',
        }),
      ),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(library.get).toHaveBeenCalledWith(docId, expect.any(AbortSignal));

    detailSubject.next({
      documentId: docId,
      fileName: 'doc.pdf',
      mediaType: 'application/pdf',
      byteLength: 512,
      createdAtMs: 1,
      updatedAtMs: 2,
      status: 'completed',
      raw: {
        schemaVersion: '2',
        diagnosticOnly: true,
        source: {
          sha256: 'b'.repeat(64),
          fileName: 'doc.pdf',
          mediaType: 'application/pdf',
          bytes: 512,
        },
        segments: [],
        sourceText: 'text',
        createdAt: '2026-11-16T00:00:00Z',
      } as unknown as DesktopLibraryDetail['raw'],
    });
    detailSubject.complete();
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();

    expect(store.document()?.fileName).toBe('doc.pdf');

    store.exportJson();
    expect(library.export).toHaveBeenCalledWith(docId, 'json');
    expect(formatting.downloadText).toHaveBeenCalledWith(
      'doc.json',
      '{"ok":true}',
      'application/json',
    );
    expect(store.exporting()).toBe(false);
    expect(store.exportError()).toBeNull();
  });

  it('marks notFound when the document does not exist', async () => {
    vi.useFakeTimers();
    const docId = 'c'.repeat(32);
    const { store } = setupStore(docId, {
      get: vi.fn(() => throwError(() => new Error(`Unknown document: ${docId}`))),
    });

    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();

    expect(store.notFound()).toBe(true);
    expect(store.document()).toBeNull();
    expect(store.documentError()).toBeNull();
  });

  it('reports a localized export failure without exposing the raw host error', async () => {
    vi.useFakeTimers();
    const docId = 'd'.repeat(32);
    const { store, formatting } = setupStore(docId, {
      get: vi.fn(() =>
        of({
          documentId: docId,
          fileName: 'doc.pdf',
          mediaType: 'application/pdf',
          byteLength: 512,
          createdAtMs: 1,
          updatedAtMs: 2,
          status: 'completed',
          raw: { sourceText: 'text', segments: [] } as unknown as DesktopLibraryDetail['raw'],
        }),
      ),
      export: vi.fn(() => throwError(() => new Error('raw C:\\secret\\path error'))),
    });

    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();

    store.exportJson();
    TestBed.tick();

    expect(formatting.downloadText).not.toHaveBeenCalled();
    expect(store.exporting()).toBe(false);
    expect(store.exportError()).toBe('匯出 JSON 失敗，請重試。');
    expect(store.exportError()).not.toContain('secret');
  });
});

function setupStore(
  initialDocumentId: string | null,
  libraryOverrides: Record<string, unknown> = {},
) {
  const queryParamMap$ = new BehaviorSubject(
    convertToParamMap(initialDocumentId ? { document: initialDocumentId } : {}),
  );
  const library = {
    get: vi.fn(),
    export: vi.fn(),
    ...libraryOverrides,
  };
  const formatting = {
    downloadText: vi.fn(),
  };
  const runtime = {
    status: signal<DesktopRuntimeStatus>({ status: 'ready', detail: 'Ready' }),
    ocrCompute: signal(null),
  };
  const workspace = {
    state: signal<'starting' | 'ready' | 'error'>('ready'),
    message: signal(''),
    initialize: vi.fn(),
  };

  TestBed.configureTestingModule({
    providers: [
      { provide: ActivatedRoute, useValue: { queryParamMap: queryParamMap$.asObservable() } },
      { provide: DesktopLibraryService, useValue: library },
      { provide: DesktopWorkspaceFormattingService, useValue: formatting },
      { provide: DesktopRuntimeClientService, useValue: runtime },
      { provide: DesktopWorkspaceStore, useValue: workspace },
      DiagnosticsStore,
    ],
  });

  const store = TestBed.inject(DiagnosticsStore);
  TestBed.tick();
  return { store, library, formatting, workspace, queryParamMap$ };
}
