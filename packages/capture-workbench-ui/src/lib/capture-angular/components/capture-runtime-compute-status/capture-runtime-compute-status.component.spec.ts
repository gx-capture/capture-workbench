import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CaptureRuntimeComputeStatusComponent } from './capture-runtime-compute-status.component';

describe('CaptureRuntimeComputeStatusComponent', () => {
  let fixture: ComponentFixture<CaptureRuntimeComputeStatusComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CaptureRuntimeComputeStatusComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(CaptureRuntimeComputeStatusComponent);
  });

  it('shows the explicit CPU fallback notice before OCR', () => {
    fixture.componentRef.setInput('preflight', {
      apiVersion: '2.0',
      schemaVersion: '1',
      service: 'capture-runtime',
      runtimeVersion: '0.4.2',
      contractSetVersion: '2',
      contractSha256: 'a'.repeat(64),
      mode: 'cpu-fallback',
      adapterClass: 'unknown',
      reasonCode: 'no_compatible_gpu',
      userNoticeRequired: true,
      noticeCode: 'ocr_cpu_fallback',
    });
    fixture.detectChanges();

    const notice = fixture.nativeElement.querySelector(
      '[data-testid="ocr-compute-notice"]',
    ) as HTMLElement;
    expect(notice?.textContent).toContain(
      'No usable GPU acceleration is available. CPU OCR may be slower.',
    );
    expect(notice?.getAttribute('data-mode')).toBe('cpu-fallback');
  });

  it('shows concise GPU acceleration status without a CPU fallback notice', () => {
    fixture.componentRef.setInput('preflight', {
      apiVersion: '2.0',
      schemaVersion: '1',
      service: 'capture-runtime',
      runtimeVersion: '0.4.2',
      contractSetVersion: '2',
      contractSha256: 'a'.repeat(64),
      mode: 'gpu-dml',
      adapterClass: 'dedicated',
      reasonCode: null,
      userNoticeRequired: false,
      noticeCode: null,
    });
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('[data-testid="ocr-compute-status"]')
        ?.textContent,
    ).toContain('OCR acceleration enabled (DirectML).');
    expect(
      fixture.nativeElement.querySelector('[data-testid="ocr-compute-notice"]'),
    ).toBeNull();
  });
});
