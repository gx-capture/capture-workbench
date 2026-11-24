import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideCaptureWorkbenchInputs } from '../contracts';
import type {
  CaptureClient,
  PartialCapture,
  CaptureStructuringProvider,
} from '../contracts';
import { of, throwError } from 'rxjs';
import { CaptureWorkbenchComponent } from './capture-workbench.component';
import {
  CaptureWorkbenchTestInputSource,
  DOCUMENT,
  RAW,
  captureWorkbenchRoot,
  createCaptureWorkbenchTestInputSource,
  fakeClient,
  selectFiles,
  streamingOperation,
} from '../testing/capture-test-support';

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

  it('reports v2 host structuring failure with raw diagnostics and never completes', async () => {
    const client = fakeClient({
      startCapture: vi.fn(() =>
        of(streamingOperation('awaiting_structuring', 0.7)),
      ),
      reportStructuringFailure: vi.fn(() =>
        of({
          ...streamingOperation('failed'),
          error: {
            code: 'host_provider_failed',
            message: 'Bearer [redacted]',
            stage: 'structuring',
          },
        }),
      ),
    });
    const structure = vi.fn<CaptureStructuringProvider['structure']>(() =>
      throwError(() => ({ code: 'NOT VALID!', message: 'Bearer secret-token' })),
    );
    const completed = vi.fn();
    const failed = vi.fn();
    inputSource.client.set(client);
    inputSource.structuringProvider.set({ structure });
    inputSource.config.set({ structuringMode: 'host', showRuntimeSetup: false });
    fixture.componentInstance.completed.subscribe(completed);
    fixture.componentInstance.failed.subscribe(failed);
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'scan.pdf')]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(client.reportStructuringFailure).toHaveBeenCalledWith(
      'capture-1',
      { code: 'host_provider_failed', message: 'Bearer [redacted]' },
      expect.any(AbortSignal),
    );
    expect(structure).toHaveBeenCalledWith(
      expect.objectContaining({
        documentContract: expect.objectContaining({ schemaVersion: '2' }),
      }),
    );
    expect(completed).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: 'scan.pdf',
        raw: expect.objectContaining({
          source: RAW.source,
          segments: RAW.segments,
          sourceText: RAW.sourceText,
          extractionEngine: RAW.extractionEngine,
        }),
      }),
    );
    expect(captureWorkbenchRoot(fixture).textContent).not.toContain(
      'secret-token',
    );
  });

  it('isolates saved v2 raw evidence from component-owned provider mutation', async () => {
    const raw = {
      ...structuredClone(RAW),
      warnings: ['runtime-warning'],
    };
    const client = fakeClient({
      startCapture: vi.fn(() =>
        of(streamingOperation('awaiting_structuring', 0.7)),
      ),
      getPartial: vi.fn<
        NonNullable<CaptureClient['getPartial']>
      >(() =>
        of({
          protocolVersion: '2',
          captureId: 'capture-1',
          source: raw.source,
          revision: 1,
          segments: raw.segments,
          sourceText: raw.sourceText,
          extractionEngine: raw.extractionEngine,
          updatedAt: raw.createdAt,
        } satisfies PartialCapture),
      ),
      getRaw: vi.fn(() => of(raw)),
    });
    const structure = vi.fn<CaptureStructuringProvider['structure']>(
      (request) => {
        expect(request.raw.warnings).toEqual(['runtime-warning']);
        expect(request.raw).not.toBe(raw);
        expect(Object.isFrozen(request.raw)).toBe(true);
        expect(Object.isFrozen(request.raw.source)).toBe(true);
        expect(Object.isFrozen(request.raw.segments)).toBe(true);
        expect(Object.isFrozen(request.raw.segments[0]?.locator)).toBe(true);
        expect(() => {
          (request.raw.source as { fileName: string }).fileName = 'mutated.pdf';
        }).toThrow(TypeError);
        return of({ ...DOCUMENT, warnings: raw.warnings });
      },
    );
    inputSource.client.set(client);
    inputSource.structuringProvider.set({ structure });
    inputSource.config.set({ structuringMode: 'host', showRuntimeSetup: false });
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'scan.pdf')]);
    await fixture.whenStable();

    expect(structure).toHaveBeenCalledOnce();
    expect(client.getRaw).toHaveBeenCalledWith(
      'capture-1',
      expect.any(AbortSignal),
    );
    expect(raw.source.fileName).toBe('scan.pdf');
    expect(fixture.componentInstance.tasks()[0]?.raw).not.toBe(raw);
  });

  it('lets the v2 client own structuring without a browser provider', async () => {
    const client = fakeClient({
      startCapture: vi.fn(() =>
        of(streamingOperation('completed')),
      ),
    });
    const completed = vi.fn();
    inputSource.client.set(client);
    inputSource.config.set({
      structuringMode: 'host',
      hostStructuringOwner: 'client',
      showRuntimeSetup: false,
    });
    fixture.componentInstance.completed.subscribe(completed);
    fixture.detectChanges();

    selectFiles(fixture, [new File(['test'], 'scan.pdf')]);
    await fixture.whenStable();

    expect(client.getPartial).not.toHaveBeenCalled();
    expect(client.commitStructure).not.toHaveBeenCalled();
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
