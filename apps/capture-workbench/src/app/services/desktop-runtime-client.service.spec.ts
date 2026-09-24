import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import {
  CaptureRuntimeProtocolError,
  type CaptureOcrProjection,
} from '@gx-capture/capture-runtime-client';
import type {
  CaptureDocument,
  CaptureOperation,
  RawCapture,
  RuntimeReady,
} from '@gx-capture/capture-workbench-ui';
import {
  DESKTOP_RUNTIME_READY_TIMEOUT_MS,
  DesktopRuntimeClientService,
} from './desktop-runtime-client.service';
import { DesktopTauriCommandService } from './desktop-tauri-command.service';

const readyPayload: RuntimeReady = {
  ready: true,
  service: 'capture-runtime',
  apiVersion: '2.0',
  runtimeVersion: '0.4.2',
  captureDocumentSchemaVersion: '2',
  capabilities: {},
  ocrCompute: {
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
  },
};

const ocrProjection: CaptureOcrProjection = {
  apiVersion: '2.0',
  schemaVersion: '3',
  captureId: 'capture-1',
  status: 'completed',
  source: {
    sha256: 'd'.repeat(64),
    fileName: 'scan.pdf',
    mediaType: 'application/pdf',
    bytes: 1024,
  },
  pages: [{
    page: 1,
    status: 'recognized',
    raster: { width: 120, height: 80, scale: 1, coordinateSystem: 'pixel' },
    text: 'OCR',
    boxes: [{
      polygon: [{ x: 1, y: 1 }, { x: 20, y: 1 }, { x: 20, y: 20 }, { x: 1, y: 20 }],
      text: 'OCR',
      confidence: 0.9,
    }],
    confidence: 0.9,
    provenance: {
      status: 'resolved',
      engine: 'windowsml-ocr',
      model: 'pp-ocrv6-medium-windowsml',
      modelDigest: `sha256:${'b'.repeat(64)}`,
      device: 'windowsml-dml',
      profileId: 'capture-workbench-ocr-pipeline-v1',
      profileSpecSha256: 'c'.repeat(64),
    },
  }],
  pageCount: 1,
  runtimeVersion: '0.4.2',
  contractSha256: 'a'.repeat(64),
  provenance: {
    status: 'resolved',
    engine: 'windowsml-ocr',
    model: 'pp-ocrv6-medium-windowsml',
    modelDigest: `sha256:${'b'.repeat(64)}`,
    device: 'windowsml-dml',
    profileId: 'capture-workbench-ocr-pipeline-v1',
    profileSpecSha256: 'c'.repeat(64),
  },
  createdAt: '2026-08-14T00:00:00Z',
};

describe('DesktopRuntimeClientService', () => {
  it('allows a cold packaged sidecar three minutes to become ready', () => {
    expect(DESKTOP_RUNTIME_READY_TIMEOUT_MS).toBe(180_000);
  });

  it('exposes runtime readiness through rxResource and commands through Observables', () => {
    const commands = {
      invoke: vi.fn((command: string) => command === 'desktop_runtime_status'
        ? of({ status: 'ready', detail: 'Runtime ready' })
        : command === 'runtime_ready'
          ? of(readyPayload)
        : of({ items: [] })),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: DesktopTauriCommandService, useValue: commands },
        DesktopRuntimeClientService,
      ],
    });

    const service = TestBed.inject(DesktopRuntimeClientService);
    TestBed.tick();

    expect(service.readiness.status()).toBe('resolved');
    expect(service.started()).toBe(true);
    expect(service.ready()).toBe(true);
    expect(service.ocrCompute()?.mode).toBe('gpu-dml');
    expect(service.pdfPageNumbers()).toBeUndefined();
    expect(commands.invoke).toHaveBeenCalledWith('runtime_ready', {}, expect.any(AbortSignal));

    let requirements: readonly unknown[] | undefined;
    service.getRequirements().subscribe((value) => requirements = value);
    expect(requirements).toEqual([]);
    expect(commands.invoke).toHaveBeenCalledWith('runtime_requirements', {}, undefined);
  });

  it('accepts only an ordered PDF page scope advertised by the native acceptance seam', () => {
    const commands = {
      invoke: vi.fn((command: string) => command === 'desktop_runtime_status'
        ? of({ status: 'ready', detail: 'Runtime ready', pdfPageNumbers: [1] })
        : command === 'runtime_ready'
          ? of(readyPayload)
        : of({ items: [] })),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: DesktopTauriCommandService, useValue: commands },
        DesktopRuntimeClientService,
      ],
    });

    const service = TestBed.inject(DesktopRuntimeClientService);
    TestBed.tick();

    expect(service.pdfPageNumbers()).toEqual([1]);
  });

  it('fails malformed native PDF page scope data safe to the all-page default', () => {
    const commands = {
      invoke: vi.fn((command: string) => command === 'desktop_runtime_status'
        ? of({ status: 'ready', detail: 'Runtime ready', pdfPageNumbers: [2] })
        : command === 'runtime_ready'
          ? of(readyPayload)
        : of({ items: [] })),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: DesktopTauriCommandService, useValue: commands },
        DesktopRuntimeClientService,
      ],
    });

    const service = TestBed.inject(DesktopRuntimeClientService);
    TestBed.tick();

    expect(service.pdfPageNumbers()).toBeUndefined();
  });

  it('unwraps the v2 terminal result envelope for the one-shot capture path', () => {
    const operation = { captureId: 'capture-1', status: 'completed' } as CaptureOperation;
    const raw = { sourceText: 'OCR text' } as RawCapture;
    const result = { targetText: 'structured text' } as CaptureDocument;
    const commands = {
      invoke: vi.fn((command: string) => command === 'desktop_runtime_status'
        ? of({ status: 'ready', detail: 'Runtime ready' })
        : command === 'runtime_ready'
          ? of(readyPayload)
        : of({ operation, raw, result })),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: DesktopTauriCommandService, useValue: commands },
        DesktopRuntimeClientService,
      ],
    });

    const service = TestBed.inject(DesktopRuntimeClientService);
    let received: CaptureDocument | undefined;
    service.getResult('capture-1').subscribe((value) => received = value);

    expect(received).toBe(result);
    expect(received).not.toHaveProperty('operation');
    expect(received).not.toHaveProperty('raw');
  });

  it('gets the OCR projection through the fixed native command', () => {
    const commands = {
      invoke: vi.fn((command: string) => command === 'desktop_runtime_status'
        ? of({ status: 'ready', detail: 'Runtime ready' })
        : command === 'runtime_ready'
          ? of(readyPayload)
          : command === 'runtime_get_ocr'
            ? of(ocrProjection)
            : of({ items: [] })),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: DesktopTauriCommandService, useValue: commands },
        DesktopRuntimeClientService,
      ],
    });

    const service = TestBed.inject(DesktopRuntimeClientService);
    let received: CaptureOcrProjection | undefined;
    service.getOcr('capture-1').subscribe((value) => received = value);

    expect(received).toBe(ocrProjection);
    expect(commands.invoke).toHaveBeenCalledWith(
      'runtime_get_ocr',
      { input: { id: 'capture-1' } },
      undefined,
    );
  });

  it('fails closed when the native OCR command returns a malformed projection', () => {
    const commands = {
      invoke: vi.fn((command: string) => command === 'runtime_get_ocr'
        ? of({ captureId: 'capture-1', status: 'completed' })
        : of({ status: 'ready', detail: 'Runtime ready' })),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: DesktopTauriCommandService, useValue: commands },
        DesktopRuntimeClientService,
      ],
    });

    const service = TestBed.inject(DesktopRuntimeClientService);
    let error: unknown;
    service.getOcr('capture-1').subscribe({ error: (value) => error = value });

    expect(error).toBeInstanceOf(CaptureRuntimeProtocolError);
  });

  it('forwards an explicit PDF page scope through the Tauri capture seam', () => {
    const commands = {
      invoke: vi.fn((command: string) => command === 'desktop_runtime_status'
        ? of({ status: 'ready', detail: 'Runtime ready' })
        : command === 'runtime_ready'
          ? of(readyPayload)
          : of({ captureId: 'capture-1', status: 'running' })),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: DesktopTauriCommandService, useValue: commands },
        DesktopRuntimeClientService,
      ],
    });

    const service = TestBed.inject(DesktopRuntimeClientService);
    service.createCapture('a'.repeat(32), 'request-1', [1]).subscribe();

    expect(commands.invoke).toHaveBeenCalledWith(
      'runtime_create_capture',
      {
        input: {
          documentId: 'a'.repeat(32),
          clientRequestId: 'request-1',
          pdfPageNumbers: [1],
        },
      },
      undefined,
    );
  });

  it('keeps setup available when the OCR worker has not been installed yet', () => {
    const commands = {
      invoke: vi.fn((command: string) => command === 'desktop_runtime_status'
        ? of({ status: 'ready', detail: 'Runtime ready' })
        : command === 'runtime_ready'
          ? of({ ...readyPayload, ocrCompute: null })
          : of({ items: [] })),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: DesktopTauriCommandService, useValue: commands },
        DesktopRuntimeClientService,
      ],
    });

    const service = TestBed.inject(DesktopRuntimeClientService);
    TestBed.tick();

    expect(service.readiness.status()).toBe('resolved');
    expect(service.started()).toBe(true);
    expect(service.ready()).toBe(false);
    expect(service.ocrCompute()).toBeNull();
    expect(service.error()).toBeUndefined();
  });

  it('keeps the OCR compute accessor safe when readiness is errored', () => {
    const commands = {
      invoke: vi.fn((command: string) => command === 'desktop_runtime_status'
        ? throwError(() => new Error('Capture Workbench 僅能在 Windows 桌面 App 中使用。'))
        : of({ items: [] })),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: DesktopTauriCommandService, useValue: commands },
        DesktopRuntimeClientService,
      ],
    });

    const service = TestBed.inject(DesktopRuntimeClientService);
    TestBed.tick();

    expect(service.readiness.status()).toBe('error');
    expect(service.error()?.message).toBe('Capture Workbench 僅能在 Windows 桌面 App 中使用。');
    expect(() => service.ocrCompute()).not.toThrow();
    expect(service.ocrCompute()).toBeNull();
  });
});
