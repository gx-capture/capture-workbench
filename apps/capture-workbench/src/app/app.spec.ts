import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { App } from './app';
import { DesktopWorkspaceStore } from './services/desktop-workspace.store';

describe('App', () => {
  it('mounts Angular Material controls in the Traditional Chinese desktop workbench', () =>
    TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideNoopAnimations(),
        {
          provide: DesktopWorkspaceStore,
          useValue: workspaceStub(),
        },
      ],
    }).compileComponents().then(() => {
      const fixture = TestBed.createComponent(App);
      fixture.detectChanges();
      return fixture.whenStable().then(() => {
        expect(fixture.nativeElement.querySelector('h1')?.textContent).toContain('文件擷取工作台');
        expect(fixture.nativeElement.textContent).toContain('拖放到視窗');
        expect(fixture.nativeElement.querySelector('.mat-mdc-form-field')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('.mat-mdc-button-base')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('[data-testid="source-import"]')).not.toBeNull();
      });
    }),
  );

  it('exposes the exact extraction provenance digest without source paths or credentials', () =>
    TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideNoopAnimations(),
        {
          provide: DesktopWorkspaceStore,
          useValue: workspaceStub({
            documentId: 'a'.repeat(32),
            fileName: 'fixture.pdf',
            mediaType: 'application/pdf',
            byteLength: 16,
            createdAtMs: 1,
            updatedAtMs: 1,
            status: 'completed',
            stage: 'completed',
            raw: { sourceText: 'OCR text', segments: [] },
            result: {
              targetText: 'translated text',
              extractionEngine: {
                engine: 'windowsml',
                model: 'ocr-v1',
                device: 'windowsml-dml',
                digest: `sha256:${'a'.repeat(64)}`,
              },
              structuringEngine: {
                engine: 'ollama',
                model: 'capture-test',
                digest: `sha256:${'b'.repeat(64)}`,
              },
            },
          }),
        },
      ],
    }).compileComponents().then(() => {
      const fixture = TestBed.createComponent(App);
      fixture.detectChanges();
      return fixture.whenStable().then(() => {
        const provenance = fixture.nativeElement.querySelector(
          '[data-testid="document-extraction-provenance"]',
        ) as HTMLElement | null;
        expect(provenance).not.toBeNull();
        expect(provenance?.dataset).toMatchObject({
          engine: 'windowsml',
          model: 'ocr-v1',
          device: 'windowsml-dml',
          digest: `sha256:${'a'.repeat(64)}`,
        });
        expect(provenance?.textContent).toContain(`sha256:${'a'.repeat(64)}`);
        expect(provenance?.textContent).not.toMatch(
          /Bearer|secret-token|C:\\private/iu,
        );
      });
    }),
  );
});

function workspaceStub(selected: unknown = null) {
  return {
    state: signal<'ready'>('ready'),
    message: signal('Capture Runtime 已準備完成，可以開始處理文件。'),
    requirements: signal([]),
    documents: signal([]),
    selectedId: signal<string | null>(null),
    selected: signal(selected),
    query: signal(''),
    statusFilter: signal(''),
    installing: signal(false),
    busyIds: signal(new Set<string>()),
    canCapture: signal(true),
    coreMissing: signal([]),
    installableCoreRequirements: signal([]),
    initialize: vi.fn(),
    installCoreRequirements: vi.fn(),
    chooseSources: vi.fn(),
    select: vi.fn(),
    updateQuery: vi.fn(),
    updateStatusFilter: vi.fn(),
    retry: vi.fn(),
    cancel: vi.fn(),
    export: vi.fn(),
    delete: vi.fn(),
    formatBytes: (bytes: number) => `${bytes} B`,
    formatDate: () => '2026 年 7 月 28 日 11:18',
    stageLabel: () => '已完成',
    statusLabel: () => '已完成',
  };
}
