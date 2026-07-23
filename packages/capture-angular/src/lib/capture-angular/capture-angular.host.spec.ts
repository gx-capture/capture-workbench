import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideCaptureWorkbenchInputs } from '../contracts';
import type { CaptureStructuringProvider } from '../contracts';
import { of, throwError } from 'rxjs';
import { CaptureWorkbenchComponent } from './capture-angular';
import {
  CaptureWorkbenchTestInputSource,
  DOCUMENT,
  RAW,
  createCaptureWorkbenchTestInputSource,
  fakeClient,
  job,
  selectFiles,
} from './capture-angular-test-support';

describe('CaptureWorkbenchComponent', () => {
  let fixture: ComponentFixture<CaptureWorkbenchComponent>;
  let inputSource: CaptureWorkbenchTestInputSource;

  beforeEach(async () => {
    inputSource = createCaptureWorkbenchTestInputSource();
    await TestBed.configureTestingModule({
      imports: [CaptureWorkbenchComponent],
      providers: [provideCaptureWorkbenchInputs(inputSource)],
    }).compileComponents();
    fixture = TestBed.createComponent(CaptureWorkbenchComponent);
  });

  it('reports host structuring failure with raw diagnostics and never completes', async () => {
    const client = fakeClient({
      createCapture: vi.fn(() =>
        of(job('running', 'awaiting_structuring', 'host')),
      ),
    });
    const structure = vi.fn<CaptureStructuringProvider['structure']>(() =>
      throwError(() => ({
        code: 'NOT VALID!',
        message: 'provider returned invalid JSON',
      })),
    );
    const provider: CaptureStructuringProvider = { structure };
    const completed = vi.fn();
    const failed = vi.fn();
    inputSource.client.set(client);
    inputSource.structuringProvider.set(provider);
    inputSource.config.set({
      structuringMode: 'host',
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.componentInstance.completed.subscribe(completed);
    fixture.componentInstance.failed.subscribe(failed);
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(client.reportStructuringFailure).toHaveBeenCalledWith(
      'capture-1',
      {
        code: 'host_provider_failed',
        message: 'provider returned invalid JSON',
      },
      expect.any(AbortSignal),
    );
    expect(structure).toHaveBeenCalledWith(
      expect.objectContaining({
        documentContract: expect.objectContaining({ schemaVersion: '1' }),
      }),
    );
    const request = structure.mock.calls[0]?.[0];
    expect(Object.isFrozen(request?.documentContract.jsonSchema ?? {})).toBe(
      true,
    );
    expect(completed).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'scan.pdf', raw: RAW }),
    );
    expect(
      fixture.nativeElement.querySelector('.raw-diagnostics').textContent,
    ).toContain('diagnostic only');
  });

  it('isolates saved raw evidence from component-owned provider mutation', async () => {
    const raw = structuredClone(RAW);
    const client = fakeClient({
      createCapture: vi.fn(() =>
        of(job('running', 'awaiting_structuring', 'host')),
      ),
      getRaw: vi.fn(() => of(raw)),
    });
    const structure = vi.fn<CaptureStructuringProvider['structure']>(
      (request) => {
        expect(request.raw).not.toBe(raw);
        expect(Object.isFrozen(request.raw)).toBe(true);
        expect(Object.isFrozen(request.raw.source)).toBe(true);
        expect(Object.isFrozen(request.raw.segments)).toBe(true);
        expect(Object.isFrozen(request.raw.segments[0]?.locator)).toBe(true);

        expect(() => {
          (request.raw.source as { fileName: string }).fileName = 'mutated.pdf';
        }).toThrow(TypeError);
        expect(() => {
          (
            request.raw.segments[0]?.locator as {
              page: number;
            }
          ).page = 99;
        }).toThrow(TypeError);
        return of(DOCUMENT);
      },
    );
    const completed = vi.fn();
    inputSource.client.set(client);
    inputSource.structuringProvider.set({ structure });
    inputSource.config.set({
      structuringMode: 'host',
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.componentInstance.completed.subscribe(completed);
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();

    expect(structure).toHaveBeenCalledOnce();
    expect(raw.source.fileName).toBe('scan.pdf');
    expect(raw.segments[0]?.locator).toEqual({ kind: 'page', page: 1 });
    expect(fixture.componentInstance.tasks()[0]?.raw).toBe(raw);
    expect(completed).toHaveBeenCalledOnce();
  });

  it('lets a trusted host client own structuring without a browser provider', async () => {
    const client = fakeClient({
      createCapture: vi.fn(() =>
        of(job('running', 'awaiting_structuring', 'host')),
      ),
      getCapture: vi.fn(() => of(job('completed', 'completed', 'host'))),
    });
    const completed = vi.fn();
    inputSource.client.set(client);
    inputSource.config.set({
      structuringMode: 'host',
      hostStructuringOwner: 'client',
      showRuntimeSetup: false,
      pollIntervalMs: 0,
    });
    fixture.componentInstance.completed.subscribe(completed);
    fixture.detectChanges();

    selectFiles(fixture, [
      new File(['test'], 'scan.pdf', { type: 'application/pdf' }),
    ]);
    await fixture.whenStable();

    expect(client.getRaw).not.toHaveBeenCalled();
    expect(client.commitStructuredResult).not.toHaveBeenCalled();
    expect(client.reportStructuringFailure).not.toHaveBeenCalled();
    expect(client.getResult).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(completed).toHaveBeenCalledWith({
      taskId: expect.any(String),
      document: DOCUMENT,
    });
  });
});
