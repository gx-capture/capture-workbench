import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import type { CaptureDocument, CaptureOperation, RawCapture } from '@gx-capture/capture-workbench-ui';
import {
  DESKTOP_RUNTIME_READY_TIMEOUT_MS,
  DesktopRuntimeClientService,
} from './desktop-runtime-client.service';
import { DesktopTauriCommandService } from './desktop-tauri-command.service';

describe('DesktopRuntimeClientService', () => {
  it('allows a cold packaged sidecar three minutes to become ready', () => {
    expect(DESKTOP_RUNTIME_READY_TIMEOUT_MS).toBe(180_000);
  });

  it('exposes runtime readiness through rxResource and commands through Observables', () => {
    const commands = {
      invoke: vi.fn((command: string) => command === 'desktop_runtime_status'
        ? of({ status: 'ready', detail: 'Runtime ready' })
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
    expect(service.ready()).toBe(true);

    let requirements: readonly unknown[] | undefined;
    service.getRequirements().subscribe((value) => requirements = value);
    expect(requirements).toEqual([]);
    expect(commands.invoke).toHaveBeenCalledWith('runtime_requirements', {}, undefined);
  });

  it('unwraps the v2 terminal result envelope for the one-shot capture path', () => {
    const operation = { captureId: 'capture-1', status: 'completed' } as CaptureOperation;
    const raw = { sourceText: 'OCR text' } as RawCapture;
    const result = { targetText: 'structured text' } as CaptureDocument;
    const commands = {
      invoke: vi.fn((command: string) => command === 'desktop_runtime_status'
        ? of({ status: 'ready', detail: 'Runtime ready' })
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
});
