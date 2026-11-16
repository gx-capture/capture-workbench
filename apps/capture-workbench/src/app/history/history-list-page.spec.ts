import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { HistoryListStore } from '../services/history-list.store';
import type { HistoryRow } from '../services/history-list';
import { HistoryListPage } from './history-list-page';

describe('HistoryListPage', () => {
  function setup() {
    setDesktopLocale('zh-TW');
    const pendingDelete = signal<HistoryRow | null>(null);
    const store = {
      typeFilter: signal('all'), statusFilter: signal('all'), search: signal(''),
      rows: signal<(HistoryRow & { updatedAt: string })[]>([]), hasDocuments: signal(false),
      pendingDelete, dialogState: computed(() => pendingDelete() ? 'open' : 'closed'),
      error: signal(''), deleting: signal(false), open: vi.fn(), askDelete: vi.fn(),
      onDialogState: vi.fn(), confirmDelete: vi.fn(), cancelDelete: vi.fn(),
    };
    TestBed.configureTestingModule({ imports: [HistoryListPage], providers: [
      provideRouter([]), { provide: HistoryListStore, useValue: store },
    ] });
    const fixture = TestBed.createComponent(HistoryListPage);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    return { fixture, element, store };
  }
  it('distinguishes an empty library from no matches', () => {
    const { fixture, element, store } = setup();
    expect(element.querySelector('[data-testid="history-empty"] a[href="/ocr"]')).not.toBeNull();
    expect(element.querySelector('[data-testid="history-empty"] a[href="/asr"]')).not.toBeNull();
    store.hasDocuments.set(true);
    fixture.detectChanges();
    expect(element.textContent).toContain('沒有符合篩選條件的紀錄');
    expect(element.querySelector('[data-testid="history-empty"] a')).toBeNull();
  });
  it('binds filters and row actions with named links and headers', () => {
    const { fixture, element, store } = setup();
    const row = { documentId: 'a', fileName: 'fixture.pdf', kind: 'ocr', userStatus: 'done', statusText: '完成', extent: '3', updatedAtMs: 1, updatedAt: 'Jan 1', canDelete: true } as const;
    store.rows.set([row]);
    fixture.detectChanges();
    const type = element.querySelector<HTMLSelectElement>('[data-testid="history-type-filter"]');
    const status = element.querySelector<HTMLSelectElement>('[data-testid="history-status-filter"]');
    const search = element.querySelector<HTMLInputElement>('[data-testid="history-search"]');
    if (!type || !status || !search) throw new Error('missing filters');
    type.value = 'ocr'; type.dispatchEvent(new Event('change'));
    status.value = 'done'; status.dispatchEvent(new Event('change'));
    search.value = 'fixture'; search.dispatchEvent(new Event('input'));
    expect(store.typeFilter()).toBe('ocr');
    expect(store.statusFilter()).toBe('done');
    expect(store.search()).toBe('fixture');
    expect(element.querySelectorAll('th[scope="col"]')).toHaveLength(6);
    expect(element.querySelector('td a')?.getAttribute('href')).toBe('/history/a?from=history');
    element.querySelector<HTMLButtonElement>('[data-testid="history-row-view"]')?.click();
    element.querySelector<HTMLButtonElement>('[data-testid="history-row-delete"]')?.click();
    expect(store.open).toHaveBeenCalledWith('a');
    expect(store.askDelete).toHaveBeenCalledWith(row);
  });
});
