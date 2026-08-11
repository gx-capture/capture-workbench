import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
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

  it('delivers native SSE channel messages as incremental RxJS events', () => {
    const event = {
      protocolVersion: '2',
      eventId: 'capture-1/2',
      sequence: 2,
      captureId: 'capture-1',
      kind: 'pdf',
      eventType: 'checkpoint',
      stage: 'extracting',
      createdAt: '2026-07-20T00:00:00Z',
    } as const;
    const commands = {
      invoke: vi.fn((command: string) => command === 'desktop_runtime_status'
        ? of({ status: 'ready', detail: 'Runtime ready' })
        : of({ items: [] })),
      invokeChannel: vi.fn(() => of(event)),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: DesktopTauriCommandService, useValue: commands },
        DesktopRuntimeClientService,
      ],
    });

    const service = TestBed.inject(DesktopRuntimeClientService);
    TestBed.tick();
    const received: Array<readonly unknown[]> = [];
    service.getStreamingEvents('capture-1', 1).subscribe((value) => received.push(value));

    expect(received).toEqual([[event]]);
    expect(commands.invokeChannel).toHaveBeenCalledWith(
      'runtime_stream_streaming_events',
      { input: { id: 'capture-1', lastEventId: 1 } },
      undefined,
    );
  });
});
