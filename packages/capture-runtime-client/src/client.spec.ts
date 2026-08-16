import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { CaptureRuntimeClient } from './client';
import {
  CAPTURE_CONTRACT_SET_SHA256,
  CAPTURE_DOCUMENT_SCHEMA_SHA256,
} from './contracts';
import { decodeJson } from './codec';
import {
  CaptureAuthenticationError,
  CaptureRuntimeCompatibilityError,
  CaptureRuntimeError,
  CaptureRuntimeProtocolError,
} from './errors';
import { InMemoryRuntimeTransport, assertLoopbackBaseUrl } from './transport';
import * as publicSdk from './index';

const ready = {
  ready: true,
  service: 'capture-runtime',
  apiVersion: '2.0',
  runtimeVersion: '0.4.0',
  captureDocumentSchemaVersion: '2',
  captureDocumentSchemaSha256: CAPTURE_DOCUMENT_SCHEMA_SHA256,
  capabilities: {
    captureKinds: ['pdf'],
    structuringModes: ['host'],
    supportsCancellation: true,
    supportsRawDiagnostics: true,
    maxUploadBytes: 100,
  },
};

const canonicalBundleBytes = Uint8Array.from(
  readFileSync(
    resolve(
      process.cwd(),
      'packages/capture-runtime/src/capture_runtime/assets/contract-set.json',
    ),
  ),
);
const canonicalContractIndex = {
  catalogVersion: '2',
  runtimeVersion: '0.4.0',
  contractSetVersion: '2',
  surfaces: [{ id: 'v2' }],
  sha256: CAPTURE_CONTRACT_SET_SHA256,
  href: `/meta/v2/contracts/sha256/${CAPTURE_CONTRACT_SET_SHA256}`,
};

function withDiscovery(
  routes: ConstructorParameters<typeof InMemoryRuntimeTransport>[0],
  visited?: string[],
): ConstructorParameters<typeof InMemoryRuntimeTransport>[0] {
  const observe = (path: string) => visited?.push(path);
  return [
    {
      path: '/v2/health/ready',
      handle: () => {
        observe('/v2/health/ready');
        return Response.json(ready);
      },
    },
    {
      path: '/meta/v2/contracts',
      handle: () => {
        observe('/meta/v2/contracts');
        return Response.json(canonicalContractIndex);
      },
    },
    {
      path: canonicalContractIndex.href,
      handle: () => {
        observe(canonicalContractIndex.href);
        return new Response(canonicalBundleBytes, {
          headers: {
            'Content-Type': 'application/json',
            'X-Contract-SHA256': CAPTURE_CONTRACT_SET_SHA256,
            ETag: `"${CAPTURE_CONTRACT_SET_SHA256}"`,
          },
        });
      },
    },
    {
      path: '/v2/streaming/health/ready',
      handle: () => {
        observe('/v2/streaming/health/ready');
        return Response.json({
          protocolVersion: '2',
          maxChunkBytes: 10,
          checkpointIntervalMs: 500,
          heartbeatIntervalMs: 1000,
          stallTimeoutMs: 5000,
        });
      },
    },
    ...routes,
  ];
}

describe('CaptureRuntimeClient', () => {
  it('binds the public allowlist and package metadata to the runtime contract asset', () => {
    const assetRoot = resolve(
      process.cwd(),
      'packages/capture-runtime/src/capture_runtime/assets',
    );
    const bundle = readFileSync(resolve(assetRoot, 'contract-set.json'));
    const digest = readFileSync(
      resolve(assetRoot, 'contract-set.sha256'),
      'utf8',
    ).trim();
    const packageManifest = JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'packages/capture-runtime-client/package.json'),
        'utf8',
      ),
    ) as { contractSetSha256?: string };
    expect(createHash('sha256').update(bundle).digest('hex')).toBe(digest);
    expect(CAPTURE_CONTRACT_SET_SHA256).toBe(digest);
    expect(packageManifest.contractSetSha256).toBe(digest);
  });
  it('publishes only v2 client paths and hides generated codec exports', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, 'client.ts'),
      'utf8',
    );
    const retiredSurface = `/v${1}/`;
    expect(source).not.toContain(retiredSurface);
    expect(source).not.toMatch(/Capture(?:Job|Failure)V[12]/u);
    expect(Object.keys(publicSdk)).not.toContain('decodeJson');
  });

  it('discovers and negotiates versions plus schema hash', async () => {
    const operation = (
      path: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      path,
      method: path.includes('/v2/') ? 'GET' : 'GET',
      surface: 'v2',
      body: { kind: 'none' },
      requiredHeaders: [],
      idempotency: { mode: 'none', header: null },
      responseStatusCodes: [200],
      ...overrides,
    });
    const bundle = {
      contractSetVersion: '2',
      schemaDialect: 'https://json-schema.org/draft/2020-12/schema',
      surfaces: [{ id: 'v2' }],
      schemas: [
        {
          name: 'CaptureDocument',
          schemaSha256: CAPTURE_DOCUMENT_SCHEMA_SHA256,
        },
      ],
      operations: [
        operation('/v2/health/ready'),
        operation('/v2/captures', {
          method: 'POST',
          body: { kind: 'json' },
          requiredHeaders: ['X-Idempotency-Key'],
          idempotency: { mode: 'required', header: 'X-Idempotency-Key' },
        }),
        operation('/v2/streaming/health/ready'),
        operation('/v2/runtime/requirements'),
        operation('/v2/runtime/installations', {
          method: 'POST',
          requiredHeaders: ['X-Idempotency-Key'],
          idempotency: { mode: 'required', header: 'X-Idempotency-Key' },
        }),
        operation('/v2/runtime/model-options'),
        operation('/v2/runtime/model-installations', {
          method: 'POST',
          requiredHeaders: ['X-Idempotency-Key'],
          idempotency: { mode: 'required', header: 'X-Idempotency-Key' },
        }),
        operation('/v2/ingestions/{ingestion_id}/chunks/{chunk_index}', {
          method: 'PUT',
          body: { kind: 'binary' },
          requiredHeaders: ['Content-Range', 'Digest', 'X-Idempotency-Key'],
          idempotency: { mode: 'required', header: 'X-Idempotency-Key' },
        }),
        operation('/v2/captures/{capture_id}/events', {
          mediaType: 'text/event-stream',
          optionalHeaders: ['Last-Event-ID'],
          streaming: { kind: 'sse', lastEventIdHeader: 'Last-Event-ID' },
        }),
        operation('/v2/captures/{capture_id}/raw'),
        operation('/v2/captures/{capture_id}/result'),
        operation('/v2/captures/{capture_id}/structure/session', {
          method: 'POST',
          body: { kind: 'json' },
          requiredHeaders: ['X-Idempotency-Key'],
          idempotency: { mode: 'required', header: 'X-Idempotency-Key' },
        }),
        operation('/v2/captures/{capture_id}/structure/session/batches/{batch_index}', {
          method: 'GET',
        }),
        operation('/v2/captures/{capture_id}/structure/session/batches/{batch_index}', {
          method: 'PUT',
          body: { kind: 'json' },
          requiredHeaders: ['X-Idempotency-Key'],
          idempotency: { mode: 'required', header: 'X-Idempotency-Key' },
        }),
      ],
      problems: [],
      invariants: [],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));
    const digestBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const digest = Array.from(new Uint8Array(digestBuffer), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const index = {
      catalogVersion: '2',
      runtimeVersion: '0.4.0',
      contractSetVersion: '2',
      surfaces: [{ id: 'v2' }],
      sha256: digest,
      href: `/meta/v2/contracts/sha256/${digest}`,
    };
    const transport = new InMemoryRuntimeTransport([
      { path: '/v2/health/ready', handle: () => Response.json(ready) },
      {
        path: '/v2/streaming/health/ready',
        handle: () =>
          Response.json({
            protocolVersion: '2',
            maxChunkBytes: 10,
            checkpointIntervalMs: 500,
            heartbeatIntervalMs: 1000,
            stallTimeoutMs: 5000,
          }),
      },
      { path: '/meta/v2/contracts', handle: () => Response.json(index) },
      {
        path: index.href,
        handle: () =>
          new Response(bytes, {
            headers: {
              'Content-Type': 'application/json',
              'X-Contract-SHA256': digest,
              ETag: `"${digest}"`,
            },
          }),
      },
    ]);
    const discovery = await new CaptureRuntimeClient({
      baseUrl: 43123,
      transport,
      expectedContractSetSha256: digest,
    }).discover();
    expect(discovery.schemaSha256).toBe(CAPTURE_DOCUMENT_SCHEMA_SHA256);
  });

  it('fails closed on an incompatible schema hash', async () => {
    const transport = new InMemoryRuntimeTransport([
      {
        path: '/v2/health/ready',
        handle: () =>
          Response.json({ ...ready, captureDocumentSchemaSha256: 'wrong' }),
      },
    ]);
    await expect(
      new CaptureRuntimeClient({
        baseUrl: 43123,
        transport,
        expectedContractSetSha256: '0'.repeat(64),
      }).discover(),
    ).rejects.toBeInstanceOf(CaptureRuntimeCompatibilityError);
  });

  it('negotiates the contract before direct operations and caches the result', async () => {
    const visited: string[] = [];
    const transport = new InMemoryRuntimeTransport(
      withDiscovery(
        [
          {
            path: '/v2/runtime/requirements',
            handle: () => {
              visited.push('/v2/runtime/requirements');
              return Response.json({ items: [] });
            },
          },
        ],
        visited,
      ),
    );
    const client = new CaptureRuntimeClient({ baseUrl: 43123, transport });

    await client.getRequirements();
    await client.getRequirements();

    expect(visited).toEqual([
      '/v2/health/ready',
      '/meta/v2/contracts',
      canonicalContractIndex.href,
      '/v2/streaming/health/ready',
      '/v2/runtime/requirements',
      '/v2/runtime/requirements',
    ]);
  });

  it('redacts credentials from common errors', () => {
    const error = new CaptureRuntimeError(
      401,
      'unauthorized',
      'Bearer very-secret-token',
    );
    expect(error.message).not.toContain('very-secret-token');
    expect(assertLoopbackBaseUrl(43123)).toBe('http://127.0.0.1:43123');
    expect(() => assertLoopbackBaseUrl('http://localhost:43123')).toThrow();
  });

  it('maps remote diagnostics and malformed responses to stable errors', async () => {
    const remote = new Response(
      JSON.stringify({
        error: {
          code: 'new_problem',
          message: 'conflict',
          details: {
            category: 'conflict',
            retryable: true,
            issues: [{ message: 'duplicate' }],
            requestId: 'body-id',
          },
        },
      }),
      {
        status: 409,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-ID': 'header-id',
        },
      },
    );
    await expect(decodeJson(remote)).rejects.toMatchObject({
      code: 'new_problem',
      category: 'conflict',
      retryable: true,
      requestId: 'header-id',
    });
    await expect(
      decodeJson(
        new Response(
          JSON.stringify({
            error: { code: 'unauthorized', message: 'Bearer secret' },
          }),
          { status: 401 },
        ),
      ),
    ).rejects.toBeInstanceOf(CaptureAuthenticationError);
    await expect(
      decodeJson(new Response('not-json', { status: 200 })),
    ).rejects.toBeInstanceOf(CaptureRuntimeProtocolError);
  });

  it('resumes SSE events and sends idempotency keys', async () => {
    let received: RequestInit | undefined;
    const transport = new InMemoryRuntimeTransport(
      withDiscovery([
        {
          path: '/v2/captures/cap/events',
          handle: (request) => {
            received = request as RequestInit;
            const event = {
              captureId: 'cap',
              sequence: 2,
              eventType: 'completed',
            };
            return new Response(`id: 2\ndata: ${JSON.stringify(event)}\n\n`, {
              headers: { 'Content-Type': 'text/event-stream' },
            });
          },
        },
        {
          method: 'POST',
          path: '/v2/runtime/installations',
          handle: (request) => {
            received = request as RequestInit;
            return Response.json({
              installationId: 'i1',
              requirementId: 'r1',
              status: 'queued',
              progress: 0,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            });
          },
        },
        {
          path: '/v2/runtime/model-installations/model-1',
          handle: () =>
            Response.json({
              installationId: 'model-1',
              optionId: 'option-1',
              status: 'running',
              progress: 0.5,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            }),
        },
        {
          method: 'POST',
          path: '/v2/runtime/model-installations/model-1/cancel',
          handle: () =>
            Response.json({
              installationId: 'model-1',
              optionId: 'option-1',
              status: 'cancelled',
              progress: 0.5,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            }),
        },
      ]),
    );
    const client = new CaptureRuntimeClient({ baseUrl: 43123, transport });
    const events = [];
    for await (const event of client.captureEvents('cap', { lastEventId: 1 }))
      events.push(event);
    expect(events).toHaveLength(1);
    await client.startInstallation('r1', 'idempotency-1');
    expect(received).toBeDefined();
    expect((await client.getModelInstallation('model-1')).status).toBe(
      'running',
    );
    expect((await client.getModelInstallationStatus('model-1')).status).toBe(
      'running',
    );
    expect((await client.cancelModelInstallation('model-1')).status).toBe(
      'cancelled',
    );
  });

  it('rejects a tampered contract bundle before parsing operations', async () => {
    const bytes = new TextEncoder().encode('{"tampered":true}');
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    const index = {
      catalogVersion: '2',
      runtimeVersion: '0.4.0',
      contractSetVersion: '2',
      surfaces: [{ id: 'v2' }],
      sha256: digest,
      href: `/meta/v2/contracts/sha256/${digest}`,
    };
    const transport = new InMemoryRuntimeTransport([
      { path: '/v2/health/ready', handle: () => Response.json(ready) },
      { path: '/meta/v2/contracts', handle: () => Response.json(index) },
      {
        path: index.href,
        handle: () =>
          new Response(bytes, { headers: { 'X-Contract-SHA256': digest } }),
      },
    ]);
    await expect(
      new CaptureRuntimeClient({
        baseUrl: 43123,
        transport,
        expectedContractSetSha256: digest,
      }).discover(),
    ).rejects.toBeInstanceOf(CaptureRuntimeProtocolError);
  });

  it('rejects a content-addressed contract href whose terminal digest differs', async () => {
    const digest = 'a'.repeat(64);
    const index = {
      catalogVersion: '2',
      runtimeVersion: '0.4.0',
      contractSetVersion: '2',
      surfaces: [{ id: 'v2' }],
      sha256: digest,
      href: `/meta/v2/contracts/sha256/${'b'.repeat(64)}`,
    };
    const transport = new InMemoryRuntimeTransport([
      { path: '/v2/health/ready', handle: () => Response.json(ready) },
      { path: '/meta/v2/contracts', handle: () => Response.json(index) },
    ]);
    await expect(
      new CaptureRuntimeClient({
        baseUrl: 43123,
        transport,
        expectedContractSetSha256: digest,
      }).discover(),
    ).rejects.toMatchObject({ code: 'incompatible_runtime' });
  });

  it('rejects malformed generated model payloads instead of casting unknown fields', async () => {
    await expect(
      decodeJson(
        new Response(
          JSON.stringify({
            installationId: 'i1',
            optionId: 'o1',
            status: 'queued',
            progress: 0,
            unexpected: true,
          }),
        ),
        undefined,
        'RuntimeModelInstallation',
      ),
    ).rejects.toBeInstanceOf(CaptureRuntimeProtocolError);
  });

  it('retries idempotent requests while refusing non-idempotent retries', async () => {
    let readyAttempts = 0;
    const readyTransport = new InMemoryRuntimeTransport([
      {
        path: '/v2/health/ready',
        handle: () => {
          readyAttempts += 1;
          return readyAttempts === 1
            ? new Response(
                JSON.stringify({ error: { code: 'busy', message: 'retry' } }),
                { status: 503 },
              )
            : Response.json(ready);
        },
      },
    ]);
    expect(
      (
        await new CaptureRuntimeClient({
          baseUrl: 43123,
          transport: readyTransport,
          maxRetries: 1,
        }).getReady()
      ).ready,
    ).toBe(true);
    expect(readyAttempts).toBe(2);

    let cancelAttempts = 0;
    const cancelTransport = new InMemoryRuntimeTransport(
      withDiscovery([
        {
          method: 'POST',
          path: '/v2/captures/cap/cancel',
          handle: () => {
            cancelAttempts += 1;
            return new Response(
              JSON.stringify({ error: { code: 'busy', message: 'retry' } }),
              { status: 503 },
            );
          },
        },
      ]),
    );
    await expect(
      new CaptureRuntimeClient({
        baseUrl: 43123,
        transport: cancelTransport,
        maxRetries: 2,
      }).cancelCapture('cap'),
    ).rejects.toBeInstanceOf(CaptureRuntimeError);
    expect(cancelAttempts).toBe(1);

    let keyedAttempts = 0;
    const keyedTransport = new InMemoryRuntimeTransport(
      withDiscovery([
        {
          method: 'POST',
          path: '/v2/runtime/installations',
          handle: () => {
            keyedAttempts += 1;
            return keyedAttempts === 1
              ? new Response(
                  JSON.stringify({ error: { code: 'busy', message: 'retry' } }),
                  { status: 503 },
                )
              : Response.json({
                  installationId: 'i1',
                  requirementId: 'r1',
                  status: 'queued',
                  progress: 0,
                  createdAt: '2026-01-01T00:00:00Z',
                  updatedAt: '2026-01-01T00:00:00Z',
                });
          },
        },
      ]),
    );
    await new CaptureRuntimeClient({
      baseUrl: 43123,
      transport: keyedTransport,
      maxRetries: 1,
    }).startInstallation('r1', 'request-1');
    expect(keyedAttempts).toBe(2);
  });

  it('reconnects SSE streams with the latest Last-Event-ID cursor', async () => {
    let calls = 0;
    const received: string[] = [];
    const transport = new InMemoryRuntimeTransport(
      withDiscovery([
        {
          path: '/v2/captures/cap/events',
          handle: (request) => {
            calls += 1;
            received.push(
              new Headers(request.headers).get('Last-Event-ID') ?? '',
            );
            const event =
              calls === 1
                ? { captureId: 'cap', sequence: 1, eventType: 'checkpoint' }
                : { captureId: 'cap', sequence: 2, eventType: 'completed' };
            return new Response(
              `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`,
              { headers: { 'Content-Type': 'text/event-stream' } },
            );
          },
        },
      ]),
    );
    const events = [];
    for await (const event of new CaptureRuntimeClient({
      baseUrl: 43123,
      transport,
    }).captureEvents('cap'))
      events.push(event);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(received).toEqual(['', '1']);
  });

  it('opens, pulls, and submits strict pull-session batches with matching idempotency', async () => {
    const session = {
      protocolVersion: '2',
      sessionId: 'session-1',
      captureId: 'cap',
      rawSourceSha256: 'a'.repeat(64),
      contractSetSha256: CAPTURE_CONTRACT_SET_SHA256,
      providerCapability: {
        provider: { engine: 'ollama', model: 'model-1', digest: `sha256:${'b'.repeat(64)}` },
        capability: 'capture-structuring',
        schemaDialect: 'https://json-schema.org/draft/2020-12/schema',
      },
      schemaDialect: 'https://json-schema.org/draft/2020-12/schema',
      batchCount: 1,
      nextBatchIndex: 0,
      sessionDigest: 'c'.repeat(64),
      status: 'open',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      completedAt: null,
    };
    const batch = {
      protocolVersion: '2',
      sessionId: 'session-1',
      captureId: 'cap',
      batchIndex: 0,
      batchCount: 1,
      sourceSegmentIds: ['segment-1'],
      providerPrompt: { rawSegments: [] },
      providerSchema: { type: 'object' },
      numCtx: 2048,
      numPredict: 256,
      batchDigest: 'd'.repeat(64),
      status: 'ready',
    };
    let openHeaders: Headers | undefined;
    let submitHeaders: Headers | undefined;
    const transport = new InMemoryRuntimeTransport(
      withDiscovery([
        {
          method: 'POST',
          path: '/v2/captures/cap/structure/session',
          handle: (request) => {
            openHeaders = new Headers(request.headers);
            return new Response(JSON.stringify(session), {
              status: 201,
              headers: { 'Content-Type': 'application/json' },
            });
          },
        },
        {
          method: 'GET',
          path: '/v2/captures/cap/structure/session',
          handle: () => Response.json(session),
        },
        {
          method: 'GET',
          path: '/v2/captures/cap/structure/session/batches/0',
          handle: () => Response.json(batch),
        },
        {
          method: 'PUT',
          path: '/v2/captures/cap/structure/session/batches/0',
          handle: (request) => {
            submitHeaders = new Headers(request.headers);
            return Response.json({ ...session, nextBatchIndex: 1, status: 'completed' });
          },
        },
      ]),
    );
    const client = new CaptureRuntimeClient({ baseUrl: 43123, transport });
    const request = {
      protocolVersion: '2' as const,
      captureId: 'cap',
      providerCapability: session.providerCapability,
      schemaDialect: session.schemaDialect,
      clientRequestId: 'session-key',
    };
    await client.openStructuringSession('cap', request);
    expect((await client.openStructuringSession('cap', request)).sessionId).toBe('session-1');
    expect(openHeaders?.get('X-Idempotency-Key')).toBe('session-key');
    expect((await client.getStructuringSession('cap')).sessionId).toBe('session-1');
    expect((await client.pullStructuringBatch('cap', 0)).batchDigest).toBe(batch.batchDigest);
    await client.submitStructuringBatch(
      'cap',
      0,
      { batchDigest: batch.batchDigest, blocks: [{ sourceSegmentId: 'segment-1', type: 'paragraph', targetText: 'translated' }] },
      'batch-key',
    );
    await client.submitStructuringBatch(
      'cap',
      0,
      { batchDigest: batch.batchDigest, blocks: [{ sourceSegmentId: 'segment-1', type: 'paragraph', targetText: 'translated' }] },
      'batch-key',
    );
    expect(submitHeaders?.get('X-Idempotency-Key')).toBe('batch-key');
    expect(() => client.openStructuringSession('other', request)).toThrow(
      CaptureRuntimeProtocolError,
    );
  });

  it('rejects extra semantic batch fields before transport and maps keyed conflicts', async () => {
    const transport = new InMemoryRuntimeTransport(
      withDiscovery([
        {
          method: 'PUT',
          path: '/v2/captures/cap/structure/session/batches/0',
          handle: () =>
            new Response(
              JSON.stringify({
                error: { code: 'idempotency_conflict', message: 'same key, different body' },
              }),
              { status: 409, headers: { 'Content-Type': 'application/json' } },
            ),
        },
      ]),
    );
    const client = new CaptureRuntimeClient({ baseUrl: 43123, transport });
    await expect(
      Promise.resolve().then(() =>
        client.submitStructuringBatch(
          'cap',
          0,
          {
            batchDigest: 'e'.repeat(64),
            blocks: [
              {
                sourceSegmentId: 'segment-1',
                type: 'paragraph',
                targetText: 'ok',
                sourceText: 'must-not-cross-the-wire',
              },
            ],
          } as never,
          'batch-key',
        ),
      ),
    ).rejects.toBeInstanceOf(CaptureRuntimeProtocolError);
    await expect(
      client.submitStructuringBatch(
        'cap',
        0,
        { batchDigest: 'e'.repeat(64), blocks: [{ sourceSegmentId: 'segment-1', type: 'paragraph' }] },
        'batch-key',
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict', category: 'remote' });
  });

  it('rejects extra pull-session response fields before exposing decoded data', async () => {
    const transport = new InMemoryRuntimeTransport(
      withDiscovery([
        {
          method: 'GET',
          path: '/v2/captures/cap/structure/session/batches/0',
          handle: () =>
            Response.json({
              protocolVersion: '2',
              sessionId: 'session-1',
              captureId: 'cap',
              batchIndex: 0,
              batchCount: 1,
              sourceSegmentIds: ['segment-1'],
              providerPrompt: {},
              providerSchema: {},
              numCtx: 1,
              numPredict: 1,
              batchDigest: 'e'.repeat(64),
              status: 'ready',
              unexpected: true,
            }),
        },
      ]),
    );
    const client = new CaptureRuntimeClient({ baseUrl: 43123, transport });
    await expect(client.getStructuringBatch('cap', 0)).rejects.toBeInstanceOf(
      CaptureRuntimeProtocolError,
    );
  });
});
