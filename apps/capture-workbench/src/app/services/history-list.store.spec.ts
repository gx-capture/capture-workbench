import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, Subject } from 'rxjs';
import type { DesktopLibrarySummary } from '../contracts';
import { desktopMessages, setDesktopLocale } from '../i18n/desktop-messages';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopCaptureService } from './desktop-capture.service';
import { DesktopWorkspaceStore } from './desktop-workspace.store';
import { HistoryListStore } from './history-list.store';

describe('HistoryListStore', () => {
  function setup() {
    setDesktopLocale('zh-TW');
    const allDocuments = signal<DesktopLibrarySummary[]>([
      { documentId: 'a', fileName: 'report.pdf', mediaType: 'application/pdf', byteLength: 1, createdAtMs: 1, updatedAtMs: 2, status: 'completed' },
      { documentId: 'b', fileName: 'meeting.mp3', mediaType: 'audio/mpeg', byteLength: 1, createdAtMs: 1, updatedAtMs: 3, status: 'queued' },
    ]);
    const workspace = { allDocuments, refreshDocuments: vi.fn() };
    const library = { delete: vi.fn(() => of(undefined)) };
    const router = { navigate: vi.fn() };
    const busyIds = signal<ReadonlySet<string>>(new Set());
    const activeIds = signal<ReadonlySet<string>>(new Set());
    TestBed.configureTestingModule({ providers: [
      { provide: DesktopWorkspaceStore, useValue: workspace },
      { provide: DesktopLibraryService, useValue: library },
      { provide: DesktopCaptureService, useValue: { busyIds, oneShotOperations: signal(new Map()), recordingOperations: signal(new Map()), hasActiveCapture: (id: string) => activeIds().has(id) } },
      { provide: Router, useValue: router },
    ] });
    return { store: TestBed.inject(HistoryListStore), workspace, library, router, busyIds, activeIds };
  }
  it('retains filters on the root instance and opens with a reload-safe origin', () => {
    const { store, router } = setup();
    store.typeFilter.set('asr');
    expect(store.rows().map((row) => row.documentId)).toEqual(['b']);
    store.statusFilter.set('done');
    expect(store.rows()).toEqual([]);
    store.typeFilter.set('all');
    store.search.set('REPORT');
    expect(store.rows().map((row) => row.documentId)).toEqual(['a']);
    store.open('a');
    expect(router.navigate).toHaveBeenCalledWith(['/history', 'a'], { queryParams: { from: 'history' } });
    expect(TestBed.inject(HistoryListStore).search()).toBe('REPORT');
  });
  it('cancels without deleting and refreshes only after successful deletion', () => {
    const { store, library, workspace } = setup();
    const row = store.rows()[0];
    if (!row) throw new Error('missing row');
    store.askDelete(row);
    store.cancelDelete();
    expect(store.pendingDelete()).toBeNull();
    expect(library.delete).not.toHaveBeenCalled();
    store.askDelete(row);
    store.confirmDelete();
    expect(library.delete).toHaveBeenCalledWith('b');
    expect(workspace.refreshDocuments).toHaveBeenCalledOnce();
    expect(store.pendingDelete()).toBeNull();
  });
  it('localizes failure and guards against double submission and newly busy rows', () => {
    const { store, library, workspace, busyIds } = setup();
    const response = new Subject<undefined>();
    library.delete.mockReturnValue(response);
    const row = store.rows()[0];
    if (!row) throw new Error('missing row');
    store.askDelete(row);
    busyIds.set(new Set(['b']));
    store.confirmDelete();
    expect(library.delete).not.toHaveBeenCalled();
    busyIds.set(new Set());
    store.askDelete(row);
    store.confirmDelete();
    store.confirmDelete();
    expect(library.delete).toHaveBeenCalledOnce();
    response.error(new Error('private host path'));
    expect(store.error()).toBe(desktopMessages().historyDeleteFailed);
    expect(store.deleting()).toBe(false);
    expect(workspace.refreshDocuments).not.toHaveBeenCalled();
  });
  it.each(['removed', 'captureId', 'active capture'] as const)('rechecks a document that is %s while confirmation is open', (change) => {
    const { store, workspace, library, activeIds } = setup();
    const row = store.rows()[0];
    if (!row) throw new Error('missing row');
    store.askDelete(row);
    if (change === 'active capture') {
      activeIds.set(new Set([row.documentId]));
    } else {
      workspace.allDocuments.update((documents) => change === 'removed'
        ? documents.filter((document) => document.documentId !== row.documentId)
        : documents.map((document) => document.documentId === row.documentId ? { ...document, captureId: 'capture' } : document));
    }
    store.confirmDelete();
    expect(library.delete).not.toHaveBeenCalled();
    expect(store.pendingDelete()).toBeNull();
  });
  it('rejects a non-deletable row and clears an earlier error on the next ask or open', () => {
    const { store, busyIds } = setup();
    const row = store.rows()[0];
    if (!row) throw new Error('missing row');
    busyIds.set(new Set([row.documentId]));
    store.error.set('previous failure');
    store.askDelete(row);
    expect(store.pendingDelete()).toBeNull();
    expect(store.error()).toBe('');
    busyIds.set(new Set());
    store.error.set('previous failure');
    store.askDelete(row);
    expect(store.pendingDelete()).toEqual(row);
    expect(store.error()).toBe('');
    store.cancelDelete();
    store.error.set('previous failure');
    store.open(row.documentId);
    expect(store.error()).toBe('');
  });
  it('clears transient state while retaining filters and ignores a late failure after leaving', () => {
    const { store, library } = setup();
    const response = new Subject<undefined>();
    library.delete.mockReturnValue(response);
    const row = store.rows()[0];
    if (!row) throw new Error('missing row');
    store.typeFilter.set('asr'); store.statusFilter.set('waiting'); store.search.set('meeting');
    store.askDelete(row);
    store.confirmDelete();
    store.error.set('old error');
    store.clearTransientState();
    response.error(new Error('late host error'));
    expect(store.pendingDelete()).toBeNull();
    expect(store.error()).toBe('');
    expect(store.typeFilter()).toBe('asr');
    expect(store.statusFilter()).toBe('waiting');
    expect(store.search()).toBe('meeting');
  });
  it('restores focus only when closed, to the surviving row or search after success', () => {
    const { store, library } = setup();
    const row = store.rows()[0];
    if (!row) throw new Error('missing row');
    const container = document.createElement('div');
    container.innerHTML = '<input data-testid="history-search"><div data-testid="history-row" data-document-id="b"><button data-testid="history-row-delete">Delete</button></div>';
    document.body.append(container);
    const search = container.querySelector('input');
    const button = container.querySelector('button');
    try {
      store.askDelete(row);
      search?.focus();
      store.cancelDelete();
      expect(document.activeElement).toBe(search);
      store.onDialogClosed();
      expect(document.activeElement).toBe(button);
      const response = new Subject<undefined>();
      library.delete.mockReturnValueOnce(response);
      store.askDelete(row);
      store.confirmDelete();
      search?.focus();
      response.error(new Error('host error'));
      store.onDialogClosed();
      expect(document.activeElement).toBe(button);
      store.askDelete(row);
      store.confirmDelete();
      store.onDialogClosed();
      expect(document.activeElement).toBe(search);
      store.askDelete(row);
      store.cancelDelete();
      store.clearTransientState();
      container.remove();
      store.onDialogClosed();
      expect(document.activeElement).not.toBe(button);
    } finally {
      container.remove();
    }
  });
});
