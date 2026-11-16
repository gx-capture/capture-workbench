import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, Subject } from 'rxjs';
import type { DesktopLibrarySummary } from '../contracts';
import { desktopMessages, setDesktopLocale } from '../i18n/desktop-messages';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopWorkspaceCaptureService } from './desktop-workspace-capture.service';
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
    TestBed.configureTestingModule({ providers: [
      { provide: DesktopWorkspaceStore, useValue: workspace },
      { provide: DesktopLibraryService, useValue: library },
      { provide: DesktopWorkspaceCaptureService, useValue: { busyIds, jobs: signal(new Map()), streamingOperations: signal(new Map()), hasActiveCapture: () => false } },
      { provide: Router, useValue: router },
    ] });
    return { store: TestBed.inject(HistoryListStore), workspace, library, router, busyIds };
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
});
