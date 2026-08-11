import { lastValueFrom, toArray } from 'rxjs';
import type { CaptureEventV2 } from './contracts';
import {
  captureEventStream,
  decodeCaptureEventFrame,
  parseSseText,
} from './sse-capture-event-stream';

const EVENT_URL = 'http://127.0.0.1:43119/v2/captures/capture-1/events';

describe('captureEventStream', () => {
  it('parses SSE frames split across arbitrary chunk boundaries', async () => {
    const frame = sseFrame(captureEvent(1, 'accepted'));
    const split = Math.floor(frame.length / 2);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(sseResponse([frame.slice(0, split), frame.slice(split)]));

    const events = await lastValueFrom(
      captureEventStream(fetchMock, EVENT_URL).pipe(toArray()),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sequence: 1,
      captureId: 'capture-1',
      eventType: 'accepted',
      stage: 'extracting',
    });
  });

  it('passes Authorization and Last-Event-ID headers without leaking tokens into URLs', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(sseResponse([sseFrame(captureEvent(1, 'accepted'))]));

    await lastValueFrom(
      captureEventStream(fetchMock, EVENT_URL, {
        headers: { Authorization: 'Bearer secret-token' },
        lastEventId: 7,
      }).pipe(toArray()),
    );

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error('Expected event stream request.');
    const [url, init] = call;
    expect(String(url)).toBe(EVENT_URL);
    expect(String(url)).not.toContain('secret-token');
    const headers = init?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer secret-token');
    expect(headers.get('Last-Event-ID')).toBe('7');
  });

  it('ignores comments and unknown fields and joins multi-line data', () => {
    const frames = parseSseText(
      [
        ': keep-alive',
        'id: 1',
        'event: accepted',
        'data: {"eventId":"e1","sequence":1,',
        'data: "captureId":"capture-1","eventType":"accepted","stage":"extracting","createdAt":"2026-08-11T00:00:00Z"}',
        'x-unknown: ignored',
        '',
        'id: 2',
        'event: completed',
        'data: {"eventId":"e2","sequence":2,"captureId":"capture-1","eventType":"completed","stage":"completed","createdAt":"2026-08-11T00:00:01Z"}',
      ].join('\n'),
    );

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ id: '1', event: 'accepted' });
    expect(decodeCaptureEventFrame(frames[0])).toMatchObject({ sequence: 1 });
    expect(frames[1]).toMatchObject({ id: '2', event: 'completed' });
  });

  it('normalizes CRLF line endings', () => {
    const frames = parseSseText(
      'id: 1\r\nevent: accepted\r\ndata: {"eventId":"e1","sequence":1,"captureId":"capture-1","eventType":"accepted","stage":"extracting","createdAt":"2026-08-11T00:00:00Z"}\r\n\r\n',
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: '1', event: 'accepted' });
  });

  it('flushes a final frame that has no trailing blank line', () => {
    const frames = parseSseText(
      `id: 2\nevent: completed\ndata: ${JSON.stringify(captureEvent(2, 'completed'))}`,
    );

    expect(frames).toHaveLength(1);
    expect(decodeCaptureEventFrame(frames[0])).toMatchObject({ sequence: 2 });
  });

  it('defaults a missing protocolVersion to v2', () => {
    const event = captureEvent(1, 'accepted') as unknown as Record<
      string,
      unknown
    >;
    delete event['protocolVersion'];
    const frames = parseSseText(`data: ${JSON.stringify(event)}\n\n`);

    expect(decodeCaptureEventFrame(frames[0]).protocolVersion).toBe('2');
  });

  it('rejects malformed SSE event JSON', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(sseResponse(['data: {not-json}\n\n']));

    await expect(
      lastValueFrom(captureEventStream(fetchMock, EVENT_URL)),
    ).rejects.toMatchObject({ code: 'invalid_event_frame' });
  });

  it('rejects capture events missing required fields', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(sseResponse(['data: {"eventId":"e1","sequence":1}\n\n']));

    await expect(
      lastValueFrom(captureEventStream(fetchMock, EVENT_URL)),
    ).rejects.toMatchObject({ code: 'invalid_event_frame' });
  });

  it('rejects unknown event types', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        sseResponse([
          `data: ${JSON.stringify(captureEvent(1, 'exploded' as CaptureEventV2['eventType']))}\n\n`,
        ]),
      );

    await expect(
      lastValueFrom(captureEventStream(fetchMock, EVENT_URL)),
    ).rejects.toMatchObject({ code: 'invalid_event_frame' });
  });

  it('rejects an SSE id that does not match the payload sequence', () => {
    const [frame] = parseSseText(
      `id: 2\nevent: accepted\ndata: ${JSON.stringify(captureEvent(1, 'accepted'))}\n\n`,
    );

    expect(() => decodeCaptureEventFrame(frame)).toThrowError(
      expect.objectContaining({ code: 'invalid_event_frame' }),
    );
  });

  it('rejects an SSE event name that does not match the payload eventType', () => {
    const [frame] = parseSseText(
      `id: 1\nevent: completed\ndata: ${JSON.stringify(captureEvent(1, 'accepted'))}\n\n`,
    );

    expect(() => decodeCaptureEventFrame(frame)).toThrowError(
      expect.objectContaining({ code: 'invalid_event_frame' }),
    );
  });

  it('surfaces the canonical error envelope from a non-ok response', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'capture_not_found', message: 'Streaming capture was not found.' },
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      lastValueFrom(captureEventStream(fetchMock, EVENT_URL)),
    ).rejects.toMatchObject({
      status: 404,
      code: 'capture_not_found',
      message: 'Streaming capture was not found.',
    });
  });

  it('rejects non-event-stream success responses', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      lastValueFrom(captureEventStream(fetchMock, EVENT_URL)),
    ).rejects.toMatchObject({ code: 'invalid_event_stream' });
  });

  it('aborts the fetch when the subscription is unsubscribed', async () => {
    let capturedSignal: AbortSignal | undefined;
    let aborted = false;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      capturedSignal = init?.signal ?? undefined;
      capturedSignal?.addEventListener('abort', () => {
        aborted = true;
      });
      return Promise.resolve(
        sseInfiniteResponse([sseFrame(captureEvent(1, 'accepted'))]),
      );
    });

    const subscription = captureEventStream(fetchMock, EVENT_URL).subscribe();
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    subscription.unsubscribe();
    await vi.waitFor(() => expect(aborted).toBe(true));
  });
});

function captureEvent(
  sequence: number,
  eventType: CaptureEventV2['eventType'],
): CaptureEventV2 {
  return {
    protocolVersion: '2',
    eventId: `event-${sequence}`,
    sequence,
    captureId: 'capture-1',
    kind: 'pdf',
    eventType,
    stage: eventType === 'accepted' ? 'extracting' : eventType,
    progress: eventType === 'accepted' ? 0 : 1,
    createdAt: '2026-08-11T00:00:00Z',
  };
}

function sseFrame(event: CaptureEventV2): string {
  return `id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`;
}

function sseResponse(chunks: readonly string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function sseInfiniteResponse(chunks: readonly string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}
