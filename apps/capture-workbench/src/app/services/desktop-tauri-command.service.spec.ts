import { vi } from 'vitest';

const tauriMocks = vi.hoisted(() => {
  class TestChannel<T> {
    onmessage: (message: T) => void;

    constructor(onmessage: (message: T) => void) {
      this.onmessage = onmessage;
    }
  }

  return {
    invoke: vi.fn(),
    isTauri: vi.fn(() => true),
    TestChannel,
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  Channel: tauriMocks.TestChannel,
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri,
}));

import { DesktopTauriCommandService } from './desktop-tauri-command.service';

describe('DesktopTauriCommandService', () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    tauriMocks.isTauri.mockReturnValue(true);
  });

  it('cancels an active native stream when its RxJS subscription is torn down', async () => {
    tauriMocks.invoke.mockImplementation((command: string) =>
      command === 'runtime_stream_streaming_events'
        ? new Promise(() => undefined)
        : Promise.resolve(),
    );
    const service = new DesktopTauriCommandService();
    const subscription = service.invokeChannel(
      'runtime_stream_streaming_events',
      { input: { streamRequestId: 'stream-request-1' } },
      undefined,
      {
        command: 'runtime_cancel_streaming_events',
        args: { input: { streamRequestId: 'stream-request-1' } },
      },
    ).subscribe();

    await vi.waitFor(() => expect(tauriMocks.invoke).toHaveBeenCalledWith(
      'runtime_stream_streaming_events',
      expect.objectContaining({
        input: { streamRequestId: 'stream-request-1' },
        channel: expect.anything(),
      }),
    ));
    subscription.unsubscribe();

    await vi.waitFor(() => expect(tauriMocks.invoke).toHaveBeenCalledWith(
      'runtime_cancel_streaming_events',
      { input: { streamRequestId: 'stream-request-1' } },
    ));
  });
});
