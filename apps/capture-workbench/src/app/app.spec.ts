import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import type {
  RuntimeModelInstallationV1,
  RuntimeModelOptionV1,
} from '@gx-capture/capture-workbench-ui';
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
        expect(fixture.nativeElement.textContent).toContain('PDF、圖片與音訊皆可匯入');
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

  it('shows visible model download progress and phase while the selected model installs', async () => {
    const store = workspaceStub(null, {
      installationId: 'model-installation',
      optionId: 'qwen3.5-0.8b-v1',
      status: 'running',
      progress: 0.42,
      createdAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-20T00:00:00Z',
    });
    store.state.set('needs-setup');
    store.modelSelectionRequired.set(true);
    store.modelInstallationPhase.set('下載與驗證模型');
    store.modelInstallationPercent.set(42);
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideNoopAnimations(),
        {
          provide: DesktopWorkspaceStore,
          useValue: store,
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="model-install-progress"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('progress')?.getAttribute('value')).toBe('42');
    expect(fixture.nativeElement.textContent).toContain('下載與驗證模型');
  });

  it('starts the exact model selected through the setup UI', async () => {
    const store = workspaceStub();
    store.state.set('needs-setup');
    store.modelSelectionRequired.set(true);
    store.modelOptions.set([{
      optionId: 'qwen3.5-0.8b-v1',
      displayName: 'Qwen 3.5 0.8B',
      modelReference: 'qwen3.5:0.8b',
      expectedDigest: null,
      expectedBytes: null,
      profileId: 'capture-workbench-qwen3.5-0.8b-structure-v1',
      profileSpecSha256: 'a'.repeat(64),
      status: 'not-installed',
    }]);
    store.selectModelOption.mockImplementation((optionId: string) => {
      store.selectedModelOptionId.set(optionId);
    });
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideNoopAnimations(),
        {
          provide: DesktopWorkspaceStore,
          useValue: store,
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    const option = fixture.nativeElement.querySelector(
      '[data-testid="model-option"][value="qwen3.5-0.8b-v1"]',
    ) as HTMLInputElement | null;
    expect(option).not.toBeNull();
    option?.click();
    fixture.detectChanges();

    const install = fixture.nativeElement.querySelector(
      '[data-testid="model-install"]',
    ) as HTMLButtonElement;
    expect(option?.checked).toBe(true);
    expect(install.disabled).toBe(false);
    install.click();
    expect(store.selectModelOption).toHaveBeenCalledWith('qwen3.5-0.8b-v1');
    expect(store.installSelectedModel).toHaveBeenCalledOnce();
  });
});

function workspaceStub(selected: unknown = null, modelInstallation: RuntimeModelInstallationV1 | null = null) {
  return {
    state: signal<'ready' | 'needs-setup'>('ready'),
    message: signal('Capture Runtime 已準備完成，可以開始處理文件。'),
    requirements: signal([]),
    documents: signal([]),
    selectedId: signal<string | null>(null),
    selected: signal(selected),
    query: signal(''),
    statusFilter: signal(''),
    installing: signal(false),
    activeModelInstallation: signal<RuntimeModelInstallationV1 | null>(modelInstallation),
    modelInstallationPhase: signal(''),
    modelInstallationPercent: signal(0),
    activeModelOption: signal(null),
    modelSelectionRequired: signal(false),
    modelOptions: signal<readonly RuntimeModelOptionV1[]>([]),
    selectedModelOptionId: signal<string | null>(null),
    busyIds: signal(new Set<string>()),
    canCapture: signal(true),
    coreMissing: signal([]),
    installableCoreRequirements: signal([]),
    initialize: vi.fn(),
    installCoreRequirements: vi.fn(),
    selectModelOption: vi.fn(),
    installSelectedModel: vi.fn(),
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
