import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type {
  StructuringModelInstallation,
  StructuringModelOption,
} from '@gx-capture/capture-workbench-ui';
import { desktopMessages, setDesktopLocale } from '../i18n/desktop-messages';
import type {
  DiagnosticsDocumentView,
  DiagnosticsRuntimeView,
} from '../services/diagnostics';
import { DiagnosticsStore } from '../services/diagnostics.store';
import { RecognitionFeaturesStore } from '../services/recognition-features.store';
import { DiagnosticsPage } from './diagnostics-page';

describe('DiagnosticsPage', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));
  afterEach(() => setDesktopLocale('zh-TW'));

  function setup(options: {
    readonly runtimeView?: DiagnosticsRuntimeView;
    readonly documentId?: string | null;
    readonly document?: DiagnosticsDocumentView | null;
    readonly notFound?: boolean;
  } = {}) {
    const store = {
      runtimeView: signal<DiagnosticsRuntimeView>(
        options.runtimeView ?? {
          state: 'ready',
          statusLabel: '已就緒',
          errorMessage: null,
          runtimeVersion: '0.0.0-test',
          apiVersion: '2.0',
          contractSetVersion: '2',
          contractSetSha256: 'a'.repeat(64),
        },
      ),
      documentId: signal<string | null>(options.documentId ?? null),
      documentLoading: signal(false),
      notFound: signal(options.notFound ?? false),
      documentError: signal<string | null>(null),
      document: signal<DiagnosticsDocumentView | null>(options.document ?? null),
      exporting: signal(false),
      exportError: signal<string | null>(null),
      copyStatus: signal<string | null>(null),
      reconnect: vi.fn(),
      exportJson: vi.fn(),
      copyDigest: vi.fn(),
    };

    const features = {
      modelOptions: signal<readonly StructuringModelOption[]>([
        {
          optionId: 'qwen-test',
          displayName: 'Qwen Test',
          modelReference: 'qwen:test',
          expectedDigest: null,
          downloadBytes: null,
          profileId: 'p1',
          profileSpecSha256: 'b'.repeat(64),
          status: 'active',
        },
      ]),
      selectedModelOptionId: signal<string | null>('qwen-test'),
      activeModelOption: signal<StructuringModelOption | null>({
        optionId: 'qwen-test',
        displayName: 'Qwen Test',
        modelReference: 'qwen:test',
        expectedDigest: null,
        downloadBytes: null,
        profileId: 'p1',
        profileSpecSha256: 'b'.repeat(64),
        status: 'active',
      }),
      activeModelInstallation: signal<StructuringModelInstallation | null>(null),
      modelProgressUnavailable: signal(false),
      modelInstallationPercent: signal(0),
      modelInstallationPhase: signal(''),
      installing: signal(false),
      selectModelOption: vi.fn(),
      installSelectedModel: vi.fn(),
    };

    TestBed.configureTestingModule({
      imports: [DiagnosticsPage],
      providers: [
        provideRouter([]),
        { provide: RecognitionFeaturesStore, useValue: features },
      ],
    });
    TestBed.overrideComponent(DiagnosticsPage, {
      set: {
        providers: [{ provide: DiagnosticsStore, useValue: store }],
      },
    });

    const fixture = TestBed.createComponent(DiagnosticsPage);
    fixture.detectChanges();
    return { fixture, store, features, el: fixture.nativeElement as HTMLElement };
  }

  it('renders runtime and model sections without a document section when no document param is present', () => {
    const { store, el } = setup();

    expect(el.querySelector('h2')?.textContent?.trim()).toBe('診斷');
    expect(el.querySelector('[data-testid="diagnostics-runtime-status"]')?.textContent?.trim()).toBe('已就緒');
    expect(el.querySelector('[data-testid="diagnostics-runtime-version"]')?.textContent?.trim()).toBe('0.0.0-test');
    expect(el.querySelector('[data-testid="diagnostics-api-version"]')?.textContent?.trim()).toBe('2.0');
    expect(el.querySelector('[data-testid="diagnostics-contract-set-version"]')?.textContent?.trim()).toBe('2');
    expect(el.querySelector('[data-testid="diagnostics-contract-digest"]')?.textContent?.trim()).toBe('a'.repeat(64));
    expect(el.querySelectorAll('[data-testid="diagnostics-model-option"]')).toHaveLength(1);
    expect(el.querySelector('[data-testid="diagnostics-document"]')).toBeNull();

    (el.querySelector('[data-testid="diagnostics-copy-contract-digest"]') as HTMLButtonElement).click();
    expect(store.copyDigest).toHaveBeenCalledWith('a'.repeat(64));
  });

  it('keeps the model progress with a hint while status requests fail and the runtime stays ready', () => {
    const { fixture, features, el } = setup();
    features.activeModelInstallation.set({
      installationId: 'model-inst-1',
      optionId: 'qwen-test',
      status: 'running',
      progress: 0.3,
      createdAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-20T00:00:00Z',
    });
    features.modelProgressUnavailable.set(true);
    fixture.detectChanges();

    expect(el.querySelector('[data-testid="diagnostics-runtime-error"]')).toBeNull();
    const progress = el.querySelector('[data-testid="diagnostics-model-progress"]') as HTMLElement;
    expect(progress.getAttribute('data-status')).toBe('running');
    expect(progress.querySelector('[data-testid="diagnostics-model-progress-retrying"]')?.textContent).toContain(
      desktopMessages().installProgressRetrying,
    );

    features.modelProgressUnavailable.set(false);
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="diagnostics-model-progress-retrying"]')).toBeNull();
  });

  it('shows error message and reconnect action when runtime is in error state', () => {
    const { store, el } = setup({
      runtimeView: {
        state: 'error',
        statusLabel: '發生錯誤',
        errorMessage: 'Connection lost',
        runtimeVersion: null,
        apiVersion: null,
        contractSetVersion: null,
        contractSetSha256: null,
      },
    });

    expect(el.querySelector('[data-testid="diagnostics-runtime-error"]')?.textContent?.trim()).toBe('Connection lost');
    (el.querySelector('[data-testid="diagnostics-reconnect"]') as HTMLButtonElement).click();
    expect(store.reconnect).toHaveBeenCalledTimes(1);
  });

  it('renders document provenance, evidence summary, and triggers JSON export', () => {
    const docId = 'c'.repeat(32);
    const { store, el } = setup({
      documentId: docId,
      document: {
        documentId: docId,
        fileName: 'contract.pdf',
        extraction: {
          engine: 'text-recognition',
          model: 'ocr-v1',
          device: 'dml',
          deviceName: null,
          digest: `sha256:${'d'.repeat(64)}`,
        },
        structuring: {
          engine: 'ollama',
          model: 'qwen-test',
          device: 'cuda',
          deviceName: 'GPU example',
          digest: `sha256:${'e'.repeat(64)}`,
        },
        evidence: {
          status: 'completed',
          pageCount: 2,
          digest: 'f'.repeat(64),
        },
        canExportJson: true,
      },
    });

    const docSection = el.querySelector('[data-testid="diagnostics-document"]');
    expect(docSection?.getAttribute('data-document-id')).toBe(docId);
    expect(el.querySelector('[data-testid="diagnostics-document-filename"]')?.textContent?.trim()).toBe('contract.pdf');

    const ext = el.querySelector('[data-testid="diagnostics-extraction-provenance"]');
    expect(ext?.getAttribute('data-engine')).toBe('text-recognition');
    expect(ext?.getAttribute('data-model')).toBe('ocr-v1');
    expect(ext?.getAttribute('data-device')).toBe('dml');
    expect(ext?.getAttribute('data-digest')).toBe(`sha256:${'d'.repeat(64)}`);

    const str = el.querySelector('[data-testid="diagnostics-structuring-provenance"]');
    expect(str?.getAttribute('data-engine')).toBe('ollama');
    expect(str?.getAttribute('data-model')).toBe('qwen-test');
    expect(str?.getAttribute('data-device')).toBe('cuda');
    expect(str?.textContent).toContain('GPU example');
    expect(str?.getAttribute('data-digest')).toBe(`sha256:${'e'.repeat(64)}`);

    expect(el.querySelector('[data-testid="diagnostics-evidence-pages"]')?.textContent?.trim()).toBe('2');
    expect(el.querySelector('[data-testid="diagnostics-back-to-result"]')?.getAttribute('href')).toBe(`/history/${docId}/details`);

    (el.querySelector('[data-testid="diagnostics-export-json"]') as HTMLButtonElement).click();
    expect(store.exportJson).toHaveBeenCalledTimes(1);
  });
});
