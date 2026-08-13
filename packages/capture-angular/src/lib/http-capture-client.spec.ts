import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import {
  CAPTURE_CLIENT,
  type CaptureClient,
  type CaptureEventV2,
  type CaptureStructuringCandidateV1,
} from './contracts';
import {
  decodeCaptureOperationResponse,
  decodeCaptureStreamingResult,
  decodePartialCaptureResponse,
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
      kind: 'pdf',
      status: 'extracting',
      partialRevision: 0,
      lastEventSequence: 0,
      source: {
        sha256: 'a'.repeat(64),
        fileName: 'scan.pdf',
        mediaType: 'application/pdf',
        bytes: 3,
      },
      createdAt: '2026-08-11T00:00:00Z',
      updatedAt: '2026-08-11T00:00:00Z',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ingestionResponse('ingestion-1', 201))
      .mockResolvedValueOnce(jsonResponse({ ingestionId: 'ingestion-1' }))
      .mockResolvedValueOnce(ingestionResponse('ingestion-1'))
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

  it('rejects a malformed ingestion identity before constructing a chunk URL', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ingestionId: '../escape' }, 201))
      .mockResolvedValueOnce(jsonResponse({ ingestionId: '../escape' }, 201));
    const client = configureClient(fetchMock) as HttpCaptureClient;

    await expect(firstValueFrom(client.startStreamingCapture({
      clientRequestId: 'request-malformed-ingestion',
      file: new File(['abc'], 'scan.pdf', { type: 'application/pdf' }),
      sourceKind: 'pdf',
      structuringMode: 'runtime',
    }))).rejects.toMatchObject({ code: 'invalid_response' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://127.0.0.1:43119/v2/ingestions',
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      '/v2/ingestions/by-client-request/request-malformed-ingestion',
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/chunks/'))).toBe(false);
  });

  it('rejects an initial open-ingestion response with mismatched kind before upload', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({
      protocolVersion: '2',
      ingestionId: 'ingestion-1',
      status: 'open',
      kind: 'image',
      fileName: 'scan.pdf',
      mediaType: 'application/pdf',
      totalBytes: 3,
    }, 201));
    const client = configureClient(fetchMock) as HttpCaptureClient;

    await expect(firstValueFrom(client.startStreamingCapture({
      clientRequestId: 'request-initial-kind-mismatch',
      file: new File(['abc'], 'scan.pdf', { type: 'application/pdf' }),
      sourceKind: 'pdf',
      structuringMode: 'runtime',
    }))).rejects.toMatchObject({ code: 'invalid_response' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      '/v2/ingestions/by-client-request/request-initial-kind-mismatch',
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/chunks/'))).toBe(false);
  });

  it('rejects an initial open-ingestion response whose status is not open', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({
      protocolVersion: '2',
      ingestionId: 'ingestion-1',
      status: 'ready',
      kind: 'pdf',
      fileName: 'scan.pdf',
      mediaType: 'application/pdf',
      totalBytes: 3,
    }, 201));
    const client = configureClient(fetchMock) as HttpCaptureClient;

    await expect(firstValueFrom(client.startStreamingCapture({
      clientRequestId: 'request-initial-status-mismatch',
      file: new File(['abc'], 'scan.pdf', { type: 'application/pdf' }),
      sourceKind: 'pdf',
      structuringMode: 'runtime',
    }))).rejects.toMatchObject({ code: 'invalid_response' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      '/v2/ingestions/by-client-request/request-initial-status-mismatch',
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/chunks/'))).toBe(false);
  });

  it('rejects a finalize response whose ingestion identity does not match the upload', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(ingestionResponse('ingestion-1', 201))
      .mockResolvedValueOnce(jsonResponse({ ingestionId: 'ingestion-1' }))
      .mockResolvedValueOnce(ingestionResponse('ingestion-2'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = configureClient(fetchMock) as HttpCaptureClient;

    await expect(firstValueFrom(client.startStreamingCapture({
      clientRequestId: 'request-mismatched-finalize',
      file: new File(['abc'], 'scan.pdf', { type: 'application/pdf' }),
      sourceKind: 'pdf',
      structuringMode: 'runtime',
    }))).rejects.toMatchObject({ code: 'invalid_response' });

    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/v2/ingestions/ingestion-1') && init?.method === 'DELETE',
    )).toBe(true);
  });

  it('rejects a capture response whose identity does not match the requested URL', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      protocolVersion: '2',
      captureId: 'capture-2',
      ingestionId: 'ingestion-1',
      kind: 'pdf',
      status: 'extracting',
      partialRevision: 0,
      lastEventSequence: 0,
      createdAt: '2026-08-11T00:00:00Z',
      updatedAt: '2026-08-11T00:00:00Z',
    }));
    const client = configureClient(fetchMock) as HttpCaptureClient;

    await expect(firstValueFrom(client.getStreamingCapture('capture-1'))).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://127.0.0.1:43119/v2/captures/capture-1',
    );
  });

  it('recovers a committed capture after the create response is lost without deleting its ingestion', async () => {
    const operation = {
      protocolVersion: '2',
      captureId: 'capture-recovered',
      ingestionId: 'ingestion-1',
      kind: 'pdf',
      status: 'extracting',
      partialRevision: 0,
      lastEventSequence: 0,
      source: {
        sha256: 'a'.repeat(64),
        fileName: 'scan.pdf',
        mediaType: 'application/pdf',
        bytes: 3,
      },
      createdAt: '2026-08-11T00:00:00Z',
      updatedAt: '2026-08-11T00:00:00Z',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ingestionResponse('ingestion-1', 201))
      .mockResolvedValueOnce(jsonResponse({ ingestionId: 'ingestion-1' }))
      .mockResolvedValueOnce(ingestionResponse('ingestion-1'))
      .mockRejectedValueOnce(new TypeError('connection closed after commit'))
      .mockResolvedValueOnce(jsonResponse(operation, 200));
    const client = configureClient(fetchMock) as HttpCaptureClient;
    let received: unknown;
    let error: unknown;

    client
      .startStreamingCapture({
        clientRequestId: 'consumer.request.v1',
        file: new File(['abc'], 'scan.pdf', { type: 'application/pdf' }),
        sourceKind: 'pdf',
        structuringMode: 'runtime',
      })
      .subscribe({ next: (value) => (received = value), error: (value) => (error = value) });

    await vi.waitFor(() => expect(received).toEqual(operation));
    expect(error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(String(fetchMock.mock.calls[4]?.[0])).toContain(
      '/v2/captures/by-client-request/consumer.request.v1',
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/v2/ingestions/ingestion-1'))).toBe(
      true,
    );
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/v2/ingestions/ingestion-1') && init?.method === 'DELETE',
    )).toBe(false);
  });

  it('keeps the ingestion when uncertain create lookup is unavailable', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ingestionResponse('ingestion-1', 201))
      .mockResolvedValueOnce(jsonResponse({ ingestionId: 'ingestion-1' }))
      .mockResolvedValueOnce(ingestionResponse('ingestion-1'))
      .mockRejectedValueOnce(new TypeError('connection closed after commit'))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const client = configureClient(fetchMock) as HttpCaptureClient;
    let error: unknown;

    client
      .startStreamingCapture({
        clientRequestId: 'request-unknown-response',
        file: new File(['abc'], 'scan.pdf', { type: 'application/pdf' }),
        sourceKind: 'pdf',
        structuringMode: 'runtime',
      })
      .subscribe({ error: (value) => (error = value) });

    await vi.waitFor(() => expect(error).toBeInstanceOf(TypeError));
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/v2/ingestions/ingestion-1') && init?.method === 'DELETE',
    )).toBe(false);
  });

  it('propagates the caller abort signal to the uncertain capture-create recovery lookup', async () => {
    const operation = {
      protocolVersion: '2',
      captureId: 'capture-recovered',
      ingestionId: 'ingestion-1',
      kind: 'pdf',
      status: 'extracting',
      partialRevision: 0,
      lastEventSequence: 0,
      source: {
        sha256: 'a'.repeat(64),
        fileName: 'scan.pdf',
        mediaType: 'application/pdf',
        bytes: 3,
      },
      createdAt: '2026-08-11T00:00:00Z',
      updatedAt: '2026-08-11T00:00:00Z',
    };
    const controller = new AbortController();
    let resolveLookup!: (value: Response) => void;
    const lookup = new Promise<Response>((resolve) => {
      resolveLookup = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = String(input);
      if (url.endsWith('/v2/ingestions')) {
        return Promise.resolve(ingestionResponse('ingestion-1', 201));
      }
      if (url.includes('/v2/ingestions/ingestion-1/chunks/')) {
        return Promise.resolve(jsonResponse({ ingestionId: 'ingestion-1' }));
      }
      if (url.endsWith('/v2/ingestions/ingestion-1/finalize')) {
        return Promise.resolve(ingestionResponse('ingestion-1'));
      }
      if (url.endsWith('/v2/captures')) {
        return Promise.reject(new TypeError('connection closed after commit'));
      }
      if (url.includes('/v2/captures/by-client-request/')) {
        return lookup;
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    const client = configureClient(fetchMock) as HttpCaptureClient;
    let received: unknown;

    client
      .startStreamingCapture({
        clientRequestId: 'request-signal-create',
        file: new File(['abc'], 'scan.pdf', { type: 'application/pdf' }),
        sourceKind: 'pdf',
        structuringMode: 'runtime',
        signal: controller.signal,
      })
      .subscribe({ next: (value) => (received = value) });

    await vi.waitFor(() => expect(fetchMock.mock.calls).toHaveLength(5));
    controller.abort();
    await vi.waitFor(() =>
      expect((fetchMock.mock.calls[4]?.[1]?.signal as AbortSignal).aborted).toBe(true),
    );
    resolveLookup(jsonResponse(operation, 200));
    await vi.waitFor(() => expect(received).toEqual(operation));
  });

  it('propagates the caller abort signal to the lost-open ingestion recovery lookup', async () => {
    const operation = {
      protocolVersion: '2',
      captureId: 'capture-recovered',
      ingestionId: 'ingestion-1',
      kind: 'pdf',
      status: 'extracting',
      partialRevision: 0,
      lastEventSequence: 0,
      source: {
        sha256: 'a'.repeat(64),
        fileName: 'scan.pdf',
        mediaType: 'application/pdf',
        bytes: 3,
      },
      createdAt: '2026-08-11T00:00:00Z',
      updatedAt: '2026-08-11T00:00:00Z',
    };
    const controller = new AbortController();
    let resolveLookup!: (value: Response) => void;
    const lookup = new Promise<Response>((resolve) => {
      resolveLookup = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = String(input);
      if (url.endsWith('/v2/ingestions')) {
        return Promise.reject(new TypeError('connection closed after open'));
      }
      if (url.includes('/v2/ingestions/by-client-request/')) {
        return lookup;
      }
      if (url.includes('/v2/ingestions/ingestion-1/chunks/')) {
        return Promise.resolve(jsonResponse({ ingestionId: 'ingestion-1' }));
      }
      if (url.endsWith('/v2/ingestions/ingestion-1/finalize')) {
        return Promise.resolve(ingestionResponse('ingestion-1'));
      }
      if (url.endsWith('/v2/captures')) {
        return Promise.resolve(jsonResponse(operation, 202));
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    const recoveredIngestion = ingestionResponse('ingestion-1', {
        kind: 'pdf',
        fileName: 'scan.pdf',
        mediaType: 'application/pdf',
        totalBytes: 3,
      });
    const client = configureClient(fetchMock) as HttpCaptureClient;
    let received: unknown;
    let error: unknown;

    client
      .startStreamingCapture({
        clientRequestId: 'request-signal-open',
        file: new File(['abc'], 'scan.pdf', { type: 'application/pdf' }),
        sourceKind: 'pdf',
        structuringMode: 'runtime',
        signal: controller.signal,
      })
      .subscribe({ next: (value) => (received = value), error: (value) => (error = value) });

    await vi.waitFor(() => expect(fetchMock.mock.calls).toHaveLength(2));
    controller.abort();
    await vi.waitFor(() =>
      expect((fetchMock.mock.calls[1]?.[1]?.signal as AbortSignal).aborted).toBe(true),
    );
    resolveLookup(recoveredIngestion);
    await vi.waitFor(() => expect(error).toBeDefined());
    expect(received).toBeUndefined();
  });

  it('preserves AbortError when the lost-open ingestion recovery lookup aborts', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      if (url.endsWith('/v2/ingestions')) {
        return Promise.reject(new TypeError('connection closed after open'));
      }
      if (url.includes('/v2/ingestions/by-client-request/')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          }, { once: true });
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    const client = configureClient(fetchMock) as HttpCaptureClient;
    let error: unknown;

    client
      .startStreamingCapture({
        clientRequestId: 'request-lookup-abort',
        file: new File(['abc'], 'scan.pdf', { type: 'application/pdf' }),
        sourceKind: 'pdf',
        structuringMode: 'runtime',
        signal: controller.signal,
      })
      .subscribe({ error: (value) => (error = value) });

    await vi.waitFor(() => expect(fetchMock.mock.calls).toHaveLength(2));
    controller.abort();
    await vi.waitFor(() => expect(error).toMatchObject({ name: 'AbortError' }));
  });

  it('fails closed and never deletes when recovered ingestion is not open', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('connection closed after open'))
      .mockResolvedValueOnce(jsonResponse({
        protocolVersion: '2',
        ingestionId: 'ingestion-1',
        status: 'ready',
        kind: 'pdf',
        fileName: 'scan.pdf',
        mediaType: 'application/pdf',
        totalBytes: 3,
      }));
    const client = configureClient(fetchMock) as HttpCaptureClient;
    let error: unknown;

    client
      .startStreamingCapture({
        clientRequestId: 'request-non-open-recovery',
        file: new File(['abc'], 'scan.pdf', { type: 'application/pdf' }),
        sourceKind: 'pdf',
        structuringMode: 'runtime',
      })
      .subscribe({ error: (value) => (error = value) });

    await vi.waitFor(() => expect(error).toBeInstanceOf(TypeError));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).includes('/chunks/') && init?.method === 'PUT',
    )).toBe(false);
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/v2/ingestions/ingestion-1') && init?.method === 'DELETE',
    )).toBe(false);
  });

  it('does not delete the ingestion when cancelled before the capture id arrives', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      if (url.endsWith('/v2/ingestions')) {
        return Promise.resolve(ingestionResponse('ingestion-1', 201));
      }
      if (url.includes('/v2/ingestions/ingestion-1/chunks/')) {
        return Promise.resolve(jsonResponse({ ingestionId: 'ingestion-1' }));
      }
      if (url.endsWith('/v2/ingestions/ingestion-1/finalize')) {
        return Promise.resolve(ingestionResponse('ingestion-1'));
      }
      if (url.endsWith('/v2/captures')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          }, { once: true });
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    const client = configureClient(fetchMock) as HttpCaptureClient;
    let error: unknown;

    client
      .startStreamingCapture({
        clientRequestId: 'request-cancel-before-id',
        file: new File(['abc'], 'scan.pdf', { type: 'application/pdf' }),
        sourceKind: 'pdf',
        structuringMode: 'runtime',
        signal: controller.signal,
      })
      .subscribe({ error: (value) => (error = value) });

    await vi.waitFor(() => expect(fetchMock.mock.calls).toHaveLength(4));
    controller.abort();
    await vi.waitFor(() => expect(error).toMatchObject({ name: 'AbortError' }));
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/v2/ingestions/ingestion-1') && init?.method === 'DELETE',
    )).toBe(false);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      clientRequestId: 'request-cancel-before-id',
    });
  });

  it('recovers a committed ingestion after the open response is lost by client request lookup', async () => {
    const operation = {
      protocolVersion: '2',
      captureId: 'capture-recovered',
      ingestionId: 'ingestion-1',
      kind: 'pdf',
      status: 'extracting',
      partialRevision: 0,
      lastEventSequence: 0,
      source: {
        sha256: 'a'.repeat(64),
        fileName: 'scan.pdf',
        mediaType: 'application/pdf',
        bytes: 3,
      },
      createdAt: '2026-08-11T00:00:00Z',
      updatedAt: '2026-08-11T00:00:00Z',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('connection closed after open'))
      .mockResolvedValueOnce(ingestionResponse('ingestion-1', {
        kind: 'pdf',
        fileName: 'scan.pdf',
        mediaType: 'application/pdf',
        totalBytes: 3,
      }))
      .mockResolvedValueOnce(jsonResponse({ ingestionId: 'ingestion-1' }))
      .mockResolvedValueOnce(ingestionResponse('ingestion-1'))
      .mockResolvedValueOnce(jsonResponse(operation, 202));
    const client = configureClient(fetchMock) as HttpCaptureClient;
    let received: unknown;
    let error: unknown;

    client
      .startStreamingCapture({
        clientRequestId: 'request-lost-open',
        file: new File(['abc'], 'scan.pdf', { type: 'application/pdf' }),
        sourceKind: 'pdf',
        structuringMode: 'runtime',
      })
      .subscribe({ next: (value) => (received = value), error: (value) => (error = value) });

    await vi.waitFor(() => expect(received).toEqual(operation));
    expect(error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      '/v2/ingestions/by-client-request/request-lost-open',
    );
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/v2/ingestions/ingestion-1') && init?.method === 'DELETE',
    )).toBe(false);
  });

  it('fails closed when recovered ingestion metadata does not match the open request', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('connection closed after open'))
      .mockResolvedValueOnce(ingestionResponse('ingestion-1', {
        kind: 'image',
        fileName: 'scan.pdf',
        mediaType: 'application/pdf',
        totalBytes: 3,
      }));
    const client = configureClient(fetchMock) as HttpCaptureClient;
    let error: unknown;

    client
      .startStreamingCapture({
        clientRequestId: 'request-mismatched-recovery',
        file: new File(['abc'], 'scan.pdf', { type: 'application/pdf' }),
        sourceKind: 'pdf',
        structuringMode: 'runtime',
      })
      .subscribe({ error: (value) => (error = value) });

    await vi.waitFor(() => expect(error).toBeInstanceOf(TypeError));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).includes('/chunks/') && init?.method === 'PUT',
    )).toBe(false);
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/v2/ingestions/ingestion-1') && init?.method === 'DELETE',
    )).toBe(false);
  });

  it('keeps the open response recoverable when its ingestion lookup is unavailable', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('connection closed after open'))
      .mockResolvedValueOnce(jsonResponse(
        { error: { code: 'runtime_unavailable', message: 'Runtime unavailable.' } },
        503,
      ));
    const client = configureClient(fetchMock) as HttpCaptureClient;
    let error: unknown;

    client
      .startStreamingCapture({
        clientRequestId: 'request-unknown-open',
        file: new File(['abc'], 'scan.pdf', { type: 'application/pdf' }),
        sourceKind: 'pdf',
        structuringMode: 'runtime',
      })
      .subscribe({ error: (value) => (error = value) });

    await vi.waitFor(() => expect(error).toBeInstanceOf(TypeError));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/v2/ingestions/ingestion-1') && init?.method === 'DELETE',
    )).toBe(false);
  });

  it('rethrows the original open failure when lookup confirms the ingestion was never created', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('connection closed after open'))
      .mockResolvedValueOnce(jsonResponse(
        { error: { code: 'ingestion_not_found', message: 'Ingestion was not found.' } },
        404,
      ));
    const client = configureClient(fetchMock) as HttpCaptureClient;
    let error: unknown;

    client
      .startStreamingCapture({
        clientRequestId: 'request-absent-open',
        file: new File(['abc'], 'scan.pdf', { type: 'application/pdf' }),
        sourceKind: 'pdf',
        structuringMode: 'runtime',
      })
      .subscribe({ error: (value) => (error = value) });

    await vi.waitFor(() => expect(error).toBeInstanceOf(TypeError));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/v2/ingestions/ingestion-1') && init?.method === 'DELETE',
    )).toBe(false);
  });

  it('keeps a 128-character client request id within the ingestion request bound', async () => {
    const operation = {
      protocolVersion: '2',
      captureId: 'capture-128',
      ingestionId: 'ingestion-128',
      kind: 'pdf',
      status: 'extracting',
      partialRevision: 0,
      lastEventSequence: 0,
      source: {
        sha256: 'a'.repeat(64),
        fileName: 'scan.pdf',
        mediaType: 'application/pdf',
        bytes: 3,
      },
      createdAt: '2026-08-11T00:00:00Z',
      updatedAt: '2026-08-11T00:00:00Z',
    };
    const clientRequestId = 'r'.repeat(128);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ingestionResponse('ingestion-128', 201))
      .mockResolvedValueOnce(jsonResponse({ ingestionId: 'ingestion-128' }))
      .mockResolvedValueOnce(ingestionResponse('ingestion-128'))
      .mockResolvedValueOnce(jsonResponse(operation, 202));
    const client = configureClient(fetchMock) as HttpCaptureClient;

    await expect(firstValueFrom(client.startStreamingCapture({
      clientRequestId,
      file: new File(['abc'], 'scan.pdf', { type: 'application/pdf' }),
      sourceKind: 'pdf',
      structuringMode: 'runtime',
    }))).resolves.toEqual(operation);

    const openBody = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(JSON.parse(openBody)).toMatchObject({ clientRequestId });
    expect(openBody).not.toContain('-ingestion');
    expect(String(fetchMock.mock.calls[3]?.[0])).toBe(
      'http://127.0.0.1:43119/v2/captures',
    );
    expect((fetchMock.mock.calls[3]?.[1]?.headers as Headers).get('X-Idempotency-Key')).toBe(
      clientRequestId,
    );
  });

  it('uses v2 operation, partial, result, control, and delete routes', async () => {
    const operation = {
      protocolVersion: '2',
      captureId: 'capture-1',
      ingestionId: 'ingestion-1',
      kind: 'pdf',
      status: 'extracting',
      partialRevision: 0,
      lastEventSequence: 0,
      createdAt: '2026-08-11T00:00:00Z',
      updatedAt: '2026-08-11T00:00:00Z',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(operation))
      .mockResolvedValueOnce(jsonResponse(operation))
      .mockResolvedValueOnce(jsonResponse(validPartial()))
      .mockResolvedValueOnce(jsonResponse({
        operation,
        raw: validRaw(),
        result: validDocument(),
      }))
      .mockResolvedValueOnce(jsonResponse(operation))
      .mockResolvedValueOnce(jsonResponse(operation))
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

  it('uses the supplied failure request id as the idempotency key without sending it in the body', async () => {
    const operation = {
      protocolVersion: '2',
      captureId: 'capture-1',
      ingestionId: 'ingestion-1',
      kind: 'pdf',
      status: 'failed',
      partialRevision: 1,
      lastEventSequence: 3,
      createdAt: '2026-08-11T00:00:00Z',
      updatedAt: '2026-08-11T00:00:01Z',
      completedAt: '2026-08-11T00:00:01Z',
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(operation, 200));
    const client = configureClient(fetchMock) as HttpCaptureClient;

    await firstValueFrom(client.reportStreamingStructuringFailure(
      'capture-1',
      {
        clientRequestId: 'failure-request-1',
        code: 'host_provider_failed',
        message: 'Host structuring failed.',
      },
    ));

    const request = fetchMock.mock.calls[0]?.[1];
    expect((request?.headers as Headers).get('X-Idempotency-Key')).toBe(
      'failure-request-1',
    );
    expect(JSON.parse(String(request?.body))).toEqual({
      code: 'host_provider_failed',
      message: 'Host structuring failed.',
    });
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

  it('validates the full v2 operation contract before accepting an operation', () => {
    const valid = fullOperation();
    expect(decodeCaptureOperationResponse(valid, 'capture-1')).toEqual(valid);

    const mutations: ReadonlyArray<(value: Record<string, unknown>) => void> = [
      (value) => delete value['kind'],
      (value) => { value['status'] = 'uploading'; },
      (value) => { value['partialRevision'] = -1; },
      (value) => { value['lastEventSequence'] = -1; },
      (value) => { value['progress'] = 1.5; },
      (value) => { value['createdAt'] = 'not-a-timestamp'; },
      (value) => { value['updatedAt'] = 'not-a-timestamp'; },
    ];
    for (const mutate of mutations) {
      const malformed = fullOperation();
      mutate(malformed);
      expect(() => decodeCaptureOperationResponse(malformed, 'capture-1')).toThrowError(
        expect.objectContaining({ code: 'invalid_response' }),
      );
    }
  });

  it('requires completedAt exactly for terminal operation statuses', () => {
    const terminalWithoutTimestamp = fullOperation();
    terminalWithoutTimestamp['status'] = 'completed';
    expect(() =>
      decodeCaptureOperationResponse(terminalWithoutTimestamp, 'capture-1'),
    ).toThrowError(expect.objectContaining({ code: 'invalid_response' }));

    const activeWithTimestamp = fullOperation();
    activeWithTimestamp['completedAt'] = '2026-08-11T00:00:01Z';
    expect(() =>
      decodeCaptureOperationResponse(activeWithTimestamp, 'capture-1'),
    ).toThrowError(expect.objectContaining({ code: 'invalid_response' }));
  });

  it('rejects malformed operation source metadata', () => {
    const malformed = fullOperation();
    malformed['source'] = {
      sha256: 'not-a-digest',
      fileName: '',
      mediaType: '',
      bytes: 0,
    };
    expect(() => decodeCaptureOperationResponse(malformed, 'capture-1')).toThrowError(
      expect.objectContaining({ code: 'invalid_response' }),
    );
  });

  it('rejects a capture-start response whose source metadata does not match the request', async () => {
    const operation = fullOperation();
    (operation['source'] as Record<string, unknown>)['bytes'] = 4;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ingestionResponse('ingestion-1', 201))
      .mockResolvedValueOnce(jsonResponse({ ingestionId: 'ingestion-1' }))
      .mockResolvedValueOnce(ingestionResponse('ingestion-1'))
      .mockResolvedValueOnce(jsonResponse(operation, 202));
    const client = configureClient(fetchMock) as HttpCaptureClient;

    await expect(firstValueFrom(client.startStreamingCapture({
      clientRequestId: 'request-source-mismatch',
      file: new File(['abc'], 'scan.pdf', { type: 'application/pdf' }),
      sourceKind: 'pdf',
      structuringMode: 'runtime',
    }))).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects a capture-start response that omits source metadata', async () => {
    const operation = fullOperation();
    delete operation['source'];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ingestionResponse('ingestion-1', 201))
      .mockResolvedValueOnce(jsonResponse({ ingestionId: 'ingestion-1' }))
      .mockResolvedValueOnce(ingestionResponse('ingestion-1'))
      .mockResolvedValueOnce(jsonResponse(operation, 202));
    const client = configureClient(fetchMock) as HttpCaptureClient;

    await expect(firstValueFrom(client.startStreamingCapture({
      clientRequestId: 'request-source-missing',
      file: new File(['abc'], 'scan.pdf', { type: 'application/pdf' }),
      sourceKind: 'pdf',
      structuringMode: 'runtime',
    }))).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('validates the full bounded partial payload before accepting it', () => {
    const valid = {
      protocolVersion: '2',
      captureId: 'capture-1',
      source: validSource(),
      revision: 1,
      coveredUntilMs: 100,
      segments: [validSegment(0)],
      sourceText: 'text-0',
      extractionEngine: validEngine(),
      updatedAt: '2026-08-11T00:00:01Z',
    };
    expect(decodePartialCaptureResponse(valid, 'capture-1')).toEqual(valid);

    const malformed = [
      { ...valid, revision: -1 },
      { ...valid, coveredUntilMs: -1 },
      { ...valid, segments: Array.from({ length: 10_001 }, () => validSegment(0)) },
      { ...valid, sourceText: 'x'.repeat(8_000_001) },
      { ...valid, updatedAt: 'not-a-timestamp' },
    ];
    for (const candidate of malformed) {
      expect(() => decodePartialCaptureResponse(candidate, 'capture-1')).toThrowError(
        expect.objectContaining({ code: 'invalid_response' }),
      );
    }
  });

  it('validates the full bounded raw/result payload before accepting terminal data', () => {
    const operation = fullOperation();
    const valid = { operation, raw: validRaw(), result: validDocument() };
    expect(decodeCaptureStreamingResult(valid, 'capture-1')).toEqual(valid);

    const invalidRaw = [
      { ...valid, raw: { ...valid.raw, segments: [] } },
      { ...valid, raw: { ...valid.raw, sourceText: 'different' } },
      {
        ...valid,
        raw: {
          ...valid.raw,
          segments: Array.from({ length: 10_001 }, () => validSegment(0)),
        },
      },
    ];
    for (const candidate of invalidRaw) {
      expect(() => decodeCaptureStreamingResult(candidate, 'capture-1')).toThrowError(
        expect.objectContaining({ code: 'invalid_response' }),
      );
    }

    const block = (valid.result as Record<string, unknown>)['blocks'] as Record<string, unknown>[];
    const invalidResult = [
      { ...valid, result: { ...valid.result, blocks: [] } },
      { ...valid, result: { ...valid.result, blocks: [{ ...block[0], order: 1 }] } },
      { ...valid, result: { ...valid.result, completedAt: '2026-08-10T00:00:00Z' } },
      {
        ...valid,
        result: { ...valid.result, source: { ...validSource(), bytes: 99 } },
      },
    ];
    for (const candidate of invalidResult) {
      expect(() => decodeCaptureStreamingResult(candidate, 'capture-1')).toThrowError(
        expect.objectContaining({ code: 'invalid_response' }),
      );
    }
  });

  it('fails closed on a malformed partial recovery payload from the client', async () => {
    const malformedPartial = {
      protocolVersion: '2',
      captureId: 'capture-1',
      source: validSource(),
      revision: -1,
      coveredUntilMs: 0,
      updatedAt: '2026-08-11T00:00:00Z',
    };
    const partialFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(malformedPartial));
    const partialClient = configureClient(partialFetch) as HttpCaptureClient;
    await expect(
      firstValueFrom(partialClient.getStreamingPartial('capture-1')),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('fails closed on a malformed terminal result payload from the client', async () => {
    const malformedResult = {
      operation: fullOperation(),
      raw: validRaw(),
      result: { ...validDocument(), blocks: [] },
    };
    const resultFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(malformedResult));
    const resultClient = configureClient(resultFetch) as HttpCaptureClient;
    await expect(
      firstValueFrom(resultClient.getStreamingResult('capture-1')),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

function fullOperation(): Record<string, unknown> {
  return {
    protocolVersion: '2',
    captureId: 'capture-1',
    ingestionId: 'ingestion-1',
    kind: 'pdf',
    status: 'extracting',
    progress: 0.5,
    partialRevision: 0,
    lastEventSequence: 0,
    source: {
      sha256: 'a'.repeat(64),
      fileName: 'scan.pdf',
      mediaType: 'application/pdf',
      bytes: 3,
    },
    createdAt: '2026-08-11T00:00:00Z',
    updatedAt: '2026-08-11T00:00:00Z',
  };
}

function validSource(): Record<string, unknown> {
  return {
    sha256: 'a'.repeat(64),
    fileName: 'scan.pdf',
    mediaType: 'application/pdf',
    bytes: 3,
  };
}

function validEngine(): Record<string, unknown> {
  return {
    engine: 'windowsml',
    model: 'test-ocr',
    digest: `sha256:${'b'.repeat(64)}`,
    device: 'cpu',
  };
}

function validSegment(order: number, segmentId = `segment-${order}`): Record<string, unknown> {
  return {
    segmentId,
    order,
    locator: { kind: 'time', startMs: 0, endMs: 1 },
    text: `text-${order}`,
  };
}

function validRaw(source = validSource()): Record<string, unknown> {
  const segments = [validSegment(0)];
  return {
    schemaVersion: '1',
    diagnosticOnly: true,
    source,
    segments,
    sourceText: 'text-0',
    extractionEngine: validEngine(),
    warnings: [],
    createdAt: '2026-08-11T00:00:00Z',
  };
}

function validDocument(source = validSource()): Record<string, unknown> {
  const rawSegments = [validSegment(0)];
  return {
    schemaVersion: '1',
    source,
    rawSegments,
    blocks: [
      {
        blockId: 'block-0',
        order: 0,
        type: 'transcript',
        sourceSegmentId: 'segment-0',
        locator: rawSegments[0]?.['locator'],
        sourceText: 'text-0',
        targetText: 'text-0',
      },
    ],
    sourceText: 'text-0',
    targetText: 'text-0',
    extractionEngine: validEngine(),
    structuringEngine: validEngine(),
    warnings: [],
    createdAt: '2026-08-11T00:00:00Z',
    completedAt: '2026-08-11T00:00:01Z',
  };
}

function validPartial(): Record<string, unknown> {
  return {
    protocolVersion: '2',
    captureId: 'capture-1',
    source: validSource(),
    revision: 1,
    coveredUntilMs: 100,
    segments: [validSegment(0)],
    sourceText: 'text-0',
    extractionEngine: validEngine(),
    updatedAt: '2026-08-11T00:00:01Z',
  };
}

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

function ingestionResponse(
  ingestionId: string,
  metadata: {
    readonly kind: string;
    readonly fileName: string;
    readonly mediaType: string;
    readonly totalBytes: number;
  } | number = 200,
  status = 200,
): Response {
  if (typeof metadata === 'number') {
    return jsonResponse({
      protocolVersion: '2',
      ingestionId,
      status: 'open',
      kind: 'pdf',
      fileName: 'scan.pdf',
      mediaType: 'application/pdf',
      totalBytes: 3,
      receivedBytes: 0,
      contiguousBytes: 0,
      nextChunkIndex: 0,
      nextOffset: 0,
      expiresAt: '2026-08-12T00:00:00Z',
    }, metadata);
  }
  return jsonResponse({
    protocolVersion: '2',
    ingestionId,
    status: 'open',
    ...metadata,
    receivedBytes: 0,
    contiguousBytes: 0,
    nextChunkIndex: 0,
    nextOffset: 0,
    expiresAt: '2026-08-12T00:00:00Z',
  }, status);
}

function captureEvent(
  sequence: number,
  eventType: CaptureEventV2['eventType'],
): CaptureEventV2 {
  return {
    protocolVersion: '2',
    eventId: `capture-1/${sequence}`,
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
