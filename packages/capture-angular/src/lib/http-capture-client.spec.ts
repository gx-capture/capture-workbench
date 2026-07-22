import { TestBed } from '@angular/core/testing';
import { CAPTURE_CLIENT, type CaptureClient } from './contracts';
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
          runtimeVersion: '0.1.0',
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

    await expect(client.getReady()).resolves.toMatchObject({
      captureDocumentSchemaVersion: '1',
    });
    await expect(client.getRequirements()).resolves.toEqual([]);
  });

  it('keeps the token in the authorization header and sends capture idempotency', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        captureId: 'capture-1',
        status: 'queued',
        stage: 'queued',
        structuringMode: 'host',
        progress: 0,
        createdAt: '2026-07-20T00:00:00Z',
        updatedAt: '2026-07-20T00:00:00Z',
      }),
    );
    const client = configureClient(fetchMock);

    await client.createCapture({
      clientRequestId: '6b19b58e-0a7e-4ff7-9d07-19a727070609',
      file: new File(['voice'], 'voice.wav', { type: 'audio/wav' }),
      sourceKind: 'audio',
      structuringMode: 'host',
      targetLanguage: 'zh-TW',
    });

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error('Expected capture request.');
    const [url, request] = call;
    expect(String(url)).toBe('http://127.0.0.1:43119/v1/captures');
    expect(String(url)).not.toContain('secret-token');
    const headers = request?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer secret-token');
    expect(headers.get('X-Idempotency-Key')).toBe('6b19b58e-0a7e-4ff7-9d07-19a727070609');
    const form = request?.body as FormData;
    expect(form.get('structuringMode')).toBe('host');
    expect(form.get('sourceKind')).toBe('audio');
    expect(form.get('targetLanguage')).toBe('zh-TW');
  });

  it('rejects a non-loopback destination before resolving the bearer token', async () => {
    const bearerToken = vi.fn(() => 'must-stay-memory-only');
    const fetchMock = vi.fn<typeof fetch>();
    const client = new HttpCaptureClient({
      baseUrl: 'https://capture.example.test:43119',
      bearerToken,
      fetch: fetchMock,
    });

    await expect(client.getReady()).rejects.toEqual(
      expect.objectContaining({ code: 'unsafe_base_url' }),
    );
    expect(bearerToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not rewrite or accept a different loopback service identity', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ready: true,
        service: 'untrusted-service',
        runtimeVersion: '0.1.0',
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

    await expect(client.getReady()).rejects.toEqual(
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

    await expect(client.getResult('capture-1')).rejects.toEqual(
      expect.objectContaining({
        status: 409,
        code: 'result_unavailable',
        message: 'No successful result exists.',
      }),
    );
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
