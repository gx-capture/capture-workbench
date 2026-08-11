import { TestBed } from '@angular/core/testing';
import {
  CAPTURE_CLIENT,
  type CaptureClient,
  type CaptureEventV2,
  type CaptureStructuringCandidateV1,
} from './contracts';
import {
  HttpCaptureClient,
  provideHttpCaptureClient,
} from './http-capture-client';

describe('HttpCaptureClient', () => {
  it('performs the compatibility handshake and unwraps requirements', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          ready: true,
          service: 'capture-runtime',
          runtimeVersion: '0.3.8',
          apiVersion: '1.0',
          captureDocumentSchemaVersion: '1',
          capabilities: {
            captureKinds: ['pdf'],
            structuringModes: ['runtime'],
            supportsCancellation: true,
            supportsRawDiagnostics: true,
            maxUploadBytes: 1024,
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [] }));
    const client = configureClient(fetchMock);

    let ready: unknown;
    let requirements: unknown;
    let error: unknown;
    client.getReady().subscribe({
      next: (value) => (ready = value),
      error: (value) => (error = value),
      complete: () => client.getRequirements().subscribe({
        next: (value) => (requirements = value),
        error: (value) => (error = value),
      }),
    });
    await vi.waitFor(() => expect(ready).toMatchObject({ captureDocumentSchemaVersion: '1' }));
    expect(error).toBeUndefined();
    expect(requirements).toEqual([]);
  });

  it('lists runtime installations from the canonical collection endpoint', async () => {
    const installation = {
      installationId: 'install-1',
      requirementId: 'ollama-runtime' as const,
      status: 'completed' as const,
      progress: 1,
      createdAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-20T00:00:01Z',
      completedAt: '2026-07-20T00:00:01Z',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ items: [installation] }));
    const client = configureClient(fetchMock);

    let installations: unknown;
    let error: unknown;
    client.listInstallations().subscribe({
      next: (value) => (installations = value),
      error: (value) => (error = value),
    });
    await vi.waitFor(() => expect(installations).toEqual([installation]));
    expect(error).toBeUndefined();
    expect(installations).toEqual([installation]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://127.0.0.1:43119/v1/runtime/installations',
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('rejects a non-loopback destination before resolving the bearer token', async () => {
    const bearerToken = vi.fn(() => 'must-stay-memory-only');
    const fetchMock = vi.fn<typeof fetch>();
    const client = new HttpCaptureClient({
      baseUrl: 'https://capture.example.test:43119',
      bearerToken,
      fetch: fetchMock,
    });

    let error: unknown;
    client.getReady().subscribe({ error: (value) => (error = value) });
    await vi.waitFor(() => expect(error).toEqual(expect.objectContaining({ code: 'unsafe_base_url' })));
    expect(error).toEqual(expect.objectContaining({ code: 'unsafe_base_url' }));
    expect(bearerToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not rewrite or accept a different loopback service identity', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ready: true,
        service: 'untrusted-service',
        runtimeVersion: '0.3.8',
        apiVersion: '1.0',
        captureDocumentSchemaVersion: '1',
        capabilities: {
          captureKinds: ['pdf'],
          structuringModes: ['runtime'],
          supportsCancellation: true,
          supportsRawDiagnostics: true,
          maxUploadBytes: 1024,
        },
      }),
    );
    const client = configureClient(fetchMock);

    let error: unknown;
    client.getReady().subscribe({ error: (value) => (error = value) });
    await vi.waitFor(() => expect(error).toEqual(expect.objectContaining({ code: 'runtime_service_mismatch' })));
    expect(error).toEqual(
      expect.objectContaining({ code: 'runtime_service_mismatch' }),
    );
  });

  it('surfaces the canonical error envelope', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        { error: { code: 'result_unavailable', message: 'No successful result exists.' } },
        409,
      ),
    );
    const client = configureClient(fetchMock);

    let error: unknown;
    client.getStreamingResult('capture-1').subscribe({
      error: (value) => (error = value),
    });
    await vi.waitFor(() => expect(error).toEqual(expect.objectContaining({ status: 409 })));
    expect(error).toEqual(
      expect.objectContaining({
        status: 409,
        code: 'result_unavailable',
        message: 'No successful result exists.',
      }),
    );
  });

  it('redacts credential-shaped error text and details before exposing it', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'runtime_failed',
            message: 'Bearer secret-token',
            details: { authorization: 'Bearer secret-token' },
          },
        },
        500,
      ),
    );
    const client = configureClient(fetchMock);

    let error: unknown;
    client.getReady().subscribe({ error: (value) => (error = value) });
    await vi.waitFor(() => expect(error).toBeDefined());

    expect(error).toEqual(
      expect.objectContaining({
        message: 'Bearer [redacted]',
        details: { authorization: '[redacted]' },
      }),
    );
    expect(JSON.stringify(error)).not.toContain('secret-token');
  });

  it('streams v2 capture events through an authenticated SSE response', async () => {
    const accepted = captureEvent(1, 'accepted');
    const completed = captureEvent(2, 'completed');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(sseResponse([sseFrame(accepted), sseFrame(completed)]));
    const client = configureClient(fetchMock) as HttpCaptureClient;
    const events: CaptureEventV2[] = [];
    let completedStreams = 0;

    client.captureEvents('capture-1').subscribe({
      next: (event) => events.push(event),
      complete: () => (completedStreams += 1),
    });
    await vi.waitFor(() => expect(events).toHaveLength(2));

    expect(completedStreams).toBe(1);
    expect(events.map((event) => event.eventType)).toEqual([
      'accepted',
      'completed',
    ]);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error('Expected capture event request.');
    const [url, request] = call;
    expect(String(url)).toBe(
      'http://127.0.0.1:43119/v2/captures/capture-1/events',
    );
    expect(String(url)).not.toContain('secret-token');
    const headers = request?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer secret-token');
    expect(headers.get('Accept')).toBe('text/event-stream');
  });

  it('resumes v2 event replay with Last-Event-ID', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(sseResponse([sseFrame(captureEvent(4, 'completed'))]));
    const client = configureClient(fetchMock) as HttpCaptureClient;
    const events: CaptureEventV2[] = [];

    client
      .captureEvents('capture-1', { lastEventId: 3 })
      .subscribe({ next: (event) => events.push(event) });
    await vi.waitFor(() => expect(events).toHaveLength(1));

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('Last-Event-ID')).toBe('3');
  });

  it('uploads a file through v2 ingestion before starting the capture operation', async () => {
    const operation = {
      protocolVersion: '2',
      captureId: 'capture-1',
      ingestionId: 'ingestion-1',
      status: 'extracting',
      partialRevision: 0,
      lastEventSequence: 0,
      createdAt: '2026-08-11T00:00:00Z',
      updatedAt: '2026-08-11T00:00:00Z',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ingestionId: 'ingestion-1' }, 201))
      .mockResolvedValueOnce(jsonResponse({ ingestionId: 'ingestion-1' }))
      .mockResolvedValueOnce(jsonResponse({ ingestionId: 'ingestion-1' }))
      .mockResolvedValueOnce(jsonResponse(operation, 202));
    const client = configureClient(fetchMock) as HttpCaptureClient;
    let received: unknown;

    client
      .startStreamingCapture({
        clientRequestId: 'request-1',
        file: new File(['abc'], 'scan.pdf', { type: 'application/pdf' }),
        sourceKind: 'pdf',
        structuringMode: 'runtime',
      })
      .subscribe({ next: (value) => (received = value) });

    await vi.waitFor(() => expect(received).toEqual(operation));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://127.0.0.1:43119/v2/ingestions',
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      '/v2/ingestions/ingestion-1/chunks/0',
    );
    expect((fetchMock.mock.calls[1]?.[1]?.headers as Headers).get('Digest')).toMatch(
      /^sha-256=[0-9a-f]{64}$/,
    );
    expect(String(fetchMock.mock.calls[3]?.[0])).toBe(
      'http://127.0.0.1:43119/v2/captures',
    );
    expect((fetchMock.mock.calls[3]?.[1]?.headers as Headers).get('Authorization')).toBe(
      'Bearer secret-token',
    );
    expect((fetchMock.mock.calls[3]?.[1]?.headers as Headers).get('X-Idempotency-Key')).toBe(
      'request-1',
    );
    expect(String(fetchMock.mock.calls[3]?.[0])).not.toContain('secret-token');
  });

  it('uses v2 operation, partial, result, control, and delete routes', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = configureClient(fetchMock) as HttpCaptureClient;
    const signal = new AbortController().signal;
    const candidate = {
      schemaVersion: '1',
      source: {
        sha256: 'a'.repeat(64),
        fileName: 'scan.pdf',
        mediaType: 'application/pdf',
        bytes: 1,
      },
      rawSegments: [],
      blocks: [],
      sourceText: '',
      targetText: '',
      extractionEngine: {
        engine: 'windowsml',
        model: 'test-ocr',
        digest: `sha256:${'b'.repeat(64)}`,
      },
      structuringEngine: {
        engine: 'ollama',
        model: 'test-structuring',
        digest: `sha256:${'c'.repeat(64)}`,
      },
      warnings: [],
      createdAt: '2026-08-11T00:00:00Z',
      completedAt: '2026-08-11T00:00:01Z',
    } satisfies CaptureStructuringCandidateV1;

    client.getStreamingCapture('capture-1', signal).subscribe();
    client.cancelStreamingCapture('capture-1', signal).subscribe();
    client.getStreamingPartial('capture-1', signal).subscribe();
    client.getStreamingResult('capture-1', signal).subscribe();
    client
      .commitStreamingStructuredResult(
        'capture-1',
        { clientRequestId: 'commit-1', candidate },
        signal,
      )
      .subscribe();
    client
      .reportStreamingStructuringFailure(
        'capture-1',
        { code: 'provider_failed', message: 'Provider failed.' },
        signal,
      )
      .subscribe();
    client.deleteStreamingCapture('capture-1', signal).subscribe();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));
    expect(
      fetchMock.mock.calls.map(([url, request]) => [
        String(url),
        request?.method,
      ]),
    ).toEqual([
      ['http://127.0.0.1:43119/v2/captures/capture-1', 'GET'],
      ['http://127.0.0.1:43119/v2/captures/capture-1/cancel', 'POST'],
      ['http://127.0.0.1:43119/v2/captures/capture-1/partial', 'GET'],
      ['http://127.0.0.1:43119/v2/captures/capture-1/result', 'GET'],
      ['http://127.0.0.1:43119/v2/captures/capture-1/structure/commit', 'POST'],
      ['http://127.0.0.1:43119/v2/captures/capture-1/structure/failure', 'POST'],
      ['http://127.0.0.1:43119/v2/captures/capture-1', 'DELETE'],
    ]);
  });

  it('is cold and aborts each subscription fetch on unsubscribe', async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      const signal = init?.signal;
      if (signal) signals.push(signal);
      return Promise.resolve(
        sseInfiniteResponse([sseFrame(captureEvent(1, 'accepted'))]),
      );
    });
    const client = configureClient(fetchMock) as HttpCaptureClient;
    const first = client.captureEvents('capture-1').subscribe();
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const second = client.captureEvents('capture-1').subscribe();
    await vi.waitFor(() => expect(signals).toHaveLength(2));

    let aborted = false;
    signals[0]?.addEventListener('abort', () => {
      aborted = true;
    });
    first.unsubscribe();
    await vi.waitFor(() => expect(aborted).toBe(true));
    second.unsubscribe();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts the event stream when the caller signal aborts', async () => {
    const caller = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      fetchSignal = init?.signal ?? undefined;
      return Promise.resolve(
        sseInfiniteResponse([sseFrame(captureEvent(1, 'accepted'))]),
      );
    });
    const client = configureClient(fetchMock) as HttpCaptureClient;

    client
      .captureEvents('capture-1', { signal: caller.signal })
      .subscribe();
    await vi.waitFor(() => expect(fetchSignal).toBeDefined());
    let aborted = false;
    fetchSignal?.addEventListener('abort', () => {
      aborted = true;
    });
    caller.abort();
    await vi.waitFor(() => expect(aborted).toBe(true));
  });

  it('rejects a non-loopback destination before resolving the bearer token for event streams', async () => {
    const bearerToken = vi.fn(() => 'must-stay-memory-only');
    const fetchMock = vi.fn<typeof fetch>();
    const client = new HttpCaptureClient({
      baseUrl: 'https://capture.example.test:43119',
      bearerToken,
      fetch: fetchMock,
    });

    let error: unknown;
    client.captureEvents('capture-1').subscribe({
      error: (value) => (error = value),
    });
    await vi.waitFor(() =>
      expect(error).toEqual(expect.objectContaining({ code: 'unsafe_base_url' })),
    );
    expect(bearerToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces canonical event stream errors and redacts credentials', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        { error: { code: 'capture_not_found', message: 'Bearer secret-token' } },
        404,
      ),
    );
    const client = configureClient(fetchMock) as HttpCaptureClient;
    let error: unknown;

    client.captureEvents('missing').subscribe({
      error: (value) => (error = value),
    });
    await vi.waitFor(() => expect(error).toBeDefined());

    expect(error).toEqual(
      expect.objectContaining({
        status: 404,
        code: 'capture_not_found',
        message: 'Bearer [redacted]',
      }),
    );
    expect(JSON.stringify(error)).not.toContain('secret-token');
  });
});

function configureClient(fetchMock: typeof fetch): CaptureClient {
  TestBed.configureTestingModule({
    providers: [
      provideHttpCaptureClient({
        baseUrl: 'http://127.0.0.1:43119/',
        bearerToken: 'secret-token',
        fetch: fetchMock,
      }),
    ],
  });
  return TestBed.inject(CAPTURE_CLIENT);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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
