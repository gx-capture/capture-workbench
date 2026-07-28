import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { App } from './app';
import { DesktopWorkspaceStore } from './services/desktop-workspace.store';

describe('App', () => {
  it('mounts Angular Material controls in the Traditional Chinese desktop workbench', async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideNoopAnimations(),
        {
          provide: DesktopWorkspaceStore,
          useValue: workspaceStub(),
        },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('h1')?.textContent).toContain('文件擷取工作台');
    expect(fixture.nativeElement.querySelector('input[type="file"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.mat-mdc-form-field')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.mat-mdc-button-base')).not.toBeNull();
  });
});

function workspaceStub() {
  return {
    state: signal<'ready'>('ready'),
    message: signal('Capture Runtime 已準備完成，可以開始處理文件。'),
    requirements: signal([]),
    documents: signal([]),
    selectedId: signal<string | null>(null),
    selected: signal(null),
    query: signal(''),
    statusFilter: signal(''),
    installing: signal(false),
    busyIds: signal(new Set<string>()),
    canCapture: signal(true),
    coreMissing: signal([]),
    initialize: vi.fn(),
    installCoreRequirements: vi.fn(),
    addFiles: vi.fn(),
    select: vi.fn(),
    updateQuery: vi.fn(),
    updateStatusFilter: vi.fn(),
    retry: vi.fn(),
    cancel: vi.fn(),
    export: vi.fn(),
    delete: vi.fn(),
    formatBytes: (bytes: number) => `${bytes} B`,
    formatDate: () => '2026年7月28日 上午11:18',
    stageLabel: () => '已完成',
    statusLabel: () => '已完成',
  };
}
