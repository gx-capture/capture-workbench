import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RUNTIME_VERSION } from '@gx-capture/capture-runtime-client';
import type { OcrComputePreflight } from '@gx-capture/capture-workbench-ui';
import type { DesktopSpeechGpuStatus } from '../contracts';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { SpeechGpuSettingsStore } from '../services/speech-gpu-settings.store';
import { ComputePage } from './compute-page';

describe('ComputePage', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));
  afterEach(() => setDesktopLocale('zh-TW'));

  function setup(options: {
    readonly ocrCompute?: OcrComputePreflight | null;
    readonly speechStatus?: DesktopSpeechGpuStatus | null;
    readonly speechGpu?: DesktopSpeechGpuStatus | null;
  } = {}) {
    const compute = {
      ocrCompute: signal<OcrComputePreflight | null>(
        options.ocrCompute === undefined ? gpuPreflight() : options.ocrCompute,
      ),
      speechStatus: signal<DesktopSpeechGpuStatus | null>(
        options.speechStatus === undefined
          ? { cudaAvailable: false, preferGpu: true }
          : options.speechStatus,
      ),
      speechGpu: signal<DesktopSpeechGpuStatus | null>(
        options.speechGpu === undefined ? null : options.speechGpu,
      ),
      savingCompute: signal(false),
      canChangeCompute: signal(true),
      error: signal<string | null>(null),
      setPreferGpu: vi.fn(),
      reload: vi.fn(),
    };

    TestBed.configureTestingModule({
      imports: [ComputePage],
      providers: [{ provide: SpeechGpuSettingsStore, useValue: compute }],
    });

    const fixture = TestBed.createComponent(ComputePage);
    fixture.detectChanges();
    return { fixture, compute, el: fixture.nativeElement as HTMLElement };
  }

  it('renders OCR GPU status and CPU-only speech device when no CUDA driver is present', () => {
    const { el } = setup();

    expect(el.querySelector('h2')?.textContent?.trim()).toBe('運算裝置');
    expect(
      el.querySelector('[data-testid="ocr-compute-status"]')?.textContent?.trim(),
    ).toBe('GPU 加速');
    expect(
      el.querySelector('[data-testid="compute-asr-detected"]')?.textContent?.trim(),
    ).toBe('CPU（未偵測到可用的 CUDA 驅動程式）');
    expect(el.querySelector('[data-testid="compute-prefer-gpu"]')).toBeNull();
  });

  it('binds the speech GPU preference checkbox, saving status, and error', () => {
    const { fixture, compute, el } = setup({
      speechStatus: { cudaAvailable: true, preferGpu: true },
      speechGpu: { cudaAvailable: true, preferGpu: true },
    });

    const checkbox = el.querySelector(
      '[data-testid="compute-prefer-gpu"]',
    ) as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(false);

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    expect(compute.setPreferGpu).toHaveBeenCalledWith(false);

    compute.savingCompute.set(true);
    compute.canChangeCompute.set(false);
    fixture.detectChanges();

    expect(checkbox.disabled).toBe(true);
    expect(
      el.querySelector('[data-testid="compute-saving"]')?.textContent?.trim(),
    ).toBe('正在儲存並重新啟動運算服務…');

    compute.savingCompute.set(false);
    compute.error.set('save failed');
    fixture.detectChanges();

    expect(
      el.querySelector('[data-testid="compute-error"]')?.getAttribute('role'),
    ).toBe('alert');
    expect(
      el.querySelector('[data-testid="compute-error"]')?.textContent?.trim(),
    ).toBe('save failed');
  });

  it('renders English labels when the locale is en', () => {
    setDesktopLocale('en');
    const { el } = setup({
      speechStatus: { cudaAvailable: true, preferGpu: true },
      speechGpu: { cudaAvailable: true, preferGpu: true },
    });

    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Compute');
    expect(
      el.querySelector('[data-testid="ocr-compute-status"]')?.textContent?.trim(),
    ).toBe('GPU acceleration on');
    expect(
      el.querySelector('[data-testid="compute-asr-detected"]')?.textContent?.trim(),
    ).toBe('CUDA GPU detected');
    expect(
      el.querySelector('label[for="compute-prefer-gpu"]')?.textContent?.trim(),
    ).toBe('Use the GPU for speech recognition');
  });
});

function gpuPreflight(): OcrComputePreflight {
  return {
    apiVersion: '2.0',
    schemaVersion: '1',
    service: 'capture-runtime',
    runtimeVersion: RUNTIME_VERSION,
    contractSetVersion: '2',
    contractSha256: 'a'.repeat(64),
    workerSha256: 'f'.repeat(64),
    mode: 'gpu-dml',
    adapterClass: 'dedicated',
    reasonCode: null,
    userNoticeRequired: false,
    noticeCode: null,
  };
}
