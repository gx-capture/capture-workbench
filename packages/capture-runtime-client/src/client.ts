import {
  CAPTURE_API_VERSION,
  CAPTURE_DOCUMENT_SCHEMA_SHA256,
  CAPTURE_DOCUMENT_SCHEMA_VERSION,
  CAPTURE_CONTRACT_SET_SHA256,
  type CaptureDocument,
  type CaptureEvent,
  type CaptureOperation,
  type CaptureStreamingResult,
  type Ingestion,
  type PartialCapture,
  type RawCapture,
  type RuntimeDiscovery,
  type RuntimeInstallation,
  type RuntimeModelInstallation,
  type RuntimeModelOptions,
  type RuntimeReady,
  type RuntimeRequirement,
  type RuntimeRequirements,
  type RuntimeStreamingCapabilities,
  type RuntimeTransport,
  type RuntimeTransportRequest,
  type CaptureUpload,
} from './contracts.js';
import {
  CaptureRuntimeCompatibilityError,
  CaptureRuntimeError,
  CaptureRuntimeProtocolError,
  CaptureTransportError,
} from './errors.js';
import {
  decodeJson,
  decodeSse,
  parseJsonFrame,
  type RuntimeResponseModel,
} from './codec.js';
import { HttpRuntimeTransport } from './transport.js';
import type { CaptureRuntimeClientOptions } from './contracts.js';

const CHUNK_BYTES = 1024 * 1024;

export class CaptureRuntimeClient {
  readonly transport: RuntimeTransport;
  private readonly options: CaptureRuntimeClientOptions;
  private discovery?: Promise<RuntimeDiscovery>;

  constructor(options: CaptureRuntimeClientOptions | RuntimeTransport) {
    this.options = isTransport(options)
      ? { baseUrl: 'http://127.0.0.1:1' }
      : options;
    if (
      (this.options.maxRetries ?? 2) < 0 ||
      !Number.isInteger(this.options.maxRetries ?? 2)
    ) {
      throw new CaptureTransportError(
        'maxRetries must be a non-negative integer.',
      );
    }
    if (
      (this.options.retryBackoffMs ?? 0) < 0 ||
      !Number.isFinite(this.options.retryBackoffMs ?? 0)
    ) {
      throw new CaptureTransportError('retryBackoffMs must be non-negative.');
    }
    if (
      !isTransport(options) &&
      typeof window !== 'undefined' &&
      !options.transport
    ) {
      throw new CaptureTransportError(
        'Browser clients must use a host-provided transport; sidecar URLs and Bearer tokens are process-only.',
        undefined,
        'browser_transport_required',
      );
    }
    this.transport = isTransport(options)
      ? options
      : (options.transport ?? new HttpRuntimeTransport(options));
  }

  discover(signal?: AbortSignal): Promise<RuntimeDiscovery> {
    if (!this.discovery) {
      const negotiation = this.negotiate(signal).catch((error: unknown) => {
        if (this.discovery === negotiation) this.discovery = undefined;
        throw error;
      });
      this.discovery = negotiation;
    }
    return this.discovery;
  }

  private async negotiate(signal?: AbortSignal): Promise<RuntimeDiscovery> {
    const ready = await this.getReady(signal);
    const failures: string[] = [];
    const expectedApi = this.options.expectedApiVersion ?? CAPTURE_API_VERSION;
    const expectedSchema =
      this.options.expectedSchemaVersion ?? CAPTURE_DOCUMENT_SCHEMA_VERSION;
    const expectedHash =
      this.options.expectedSchemaSha256 ?? CAPTURE_DOCUMENT_SCHEMA_SHA256;
    if (ready.service !== 'capture-runtime')
      failures.push(`service ${ready.service} is not Capture Runtime`);
    if (!ready.ready) failures.push('runtime is not ready');
    if (ready.apiVersion !== expectedApi)
      failures.push(`API version ${ready.apiVersion} is unsupported`);
    if (ready.captureDocumentSchemaVersion !== expectedSchema)
      failures.push(
        `document schema version ${ready.captureDocumentSchemaVersion} is unsupported`,
      );
    const remoteHash = ready.captureDocumentSchemaSha256 ?? ready.schemaSha256;
    if (remoteHash && remoteHash !== expectedHash)
      failures.push('document schema hash is incompatible');
    const structuringModes = ready.capabilities['structuringModes'];
    if (
      !Array.isArray(structuringModes) ||
      (!structuringModes.includes('host') &&
        !structuringModes.includes('runtime'))
    )
      failures.push('runtime exposes no structuring mode');
    if (failures.length)
      throw new CaptureRuntimeCompatibilityError(failures.join('; '));
    const contractIndex = await this.json<ContractIndex>({
      path: '/meta/v2/contracts',
      signal,
    });
    this.validateContractIndex(contractIndex);
    const href = contractIndex['href'];
    if (
      typeof href !== 'string' ||
      !href.startsWith('/meta/v2/contracts/sha256/')
    ) {
      throw new CaptureRuntimeProtocolError(
        'Capture Runtime contract index href is invalid.',
      );
    }
    const hrefDigest = href.slice('/meta/v2/contracts/sha256/'.length);
    if (
      !/^[0-9a-f]{64}$/u.test(hrefDigest) ||
      hrefDigest !== contractIndex['sha256']
    ) {
      throw new CaptureRuntimeCompatibilityError(
        'Capture Runtime contract index href digest does not match its advertised bundle hash.',
      );
    }
    const bundleResponse = await this.transport.request({
      path: href,
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!bundleResponse.ok)
      throw await (await import('./codec.js')).decodeError(bundleResponse);
    const bundleBytes = new Uint8Array(await bundleResponse.arrayBuffer());
    const bundleHash = await sha256(bundleBytes);
    const allowedContractHashes = this.options.allowedContractSetSha256 ?? [
      this.options.expectedContractSetSha256 ?? CAPTURE_CONTRACT_SET_SHA256,
    ];
    if (!allowedContractHashes.includes(bundleHash)) {
      throw new CaptureRuntimeCompatibilityError(
        'Capture Runtime contract bundle identity is not allowlisted.',
      );
    }
    const etag = bundleResponse.headers.get('etag');
    if (
      bundleHash !== contractIndex['sha256'] ||
      (bundleResponse.headers.get('X-Contract-SHA256') ?? bundleHash) !==
        bundleHash ||
      (etag !== null && etag !== bundleHash && etag !== `"${bundleHash}"`)
    ) {
      throw new CaptureRuntimeCompatibilityError(
        'Capture Runtime contract bundle hash is incompatible.',
      );
    }
    let contractBundle: ContractBundle;
    try {
      contractBundle = JSON.parse(
        new TextDecoder().decode(bundleBytes),
      ) as ContractBundle;
    } catch (error) {
      throw new CaptureRuntimeProtocolError(
        'Capture Runtime contract bundle is not valid JSON.',
        error,
      );
    }
    const bundleSchemaHash = this.validateContractBundle(contractBundle);
    // V2 readiness is part of the negotiated client surface.  Do not silently
    // continue after a malformed, unauthorized, or otherwise incompatible
    // response: callers must not start capture against an unknown protocol.
    const streaming = await this.getStreamingCapabilities(signal);
    if (
      ready.captureDocumentSchemaSha256 &&
      ready.captureDocumentSchemaSha256 !== bundleSchemaHash
    ) {
      throw new CaptureRuntimeCompatibilityError(
        'Capture Runtime readiness schema hash differs from the discovered contract bundle.',
      );
    }
    return {
      ready,
      streaming,
      schemaSha256: bundleSchemaHash,
      contractIndex,
      contractBundle,
    };
  }

  getReady(signal?: AbortSignal): Promise<RuntimeReady> {
    return this.json<RuntimeReady>(
      { path: '/v2/health/ready', signal },
      'RuntimeReady',
    );
  }

  getStreamingCapabilities(
    signal?: AbortSignal,
  ): Promise<RuntimeStreamingCapabilities> {
    return this.json(
      { path: '/v2/streaming/health/ready', signal },
      'RuntimeStreamingCapabilities',
    );
  }

  async getRequirements(
    signal?: AbortSignal,
  ): Promise<readonly RuntimeRequirement[]> {
    const response = await this.json<RuntimeRequirements>(
      { path: '/v2/runtime/requirements', signal },
      'RuntimeRequirements',
    );
    return response.items;
  }

  startInstallation(
    requirementId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<RuntimeInstallation> {
    return this.json(
      {
        path: '/v2/runtime/installations',
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ requirementId, consent: true }),
      },
      'RuntimeInstallation',
    );
  }

  listInstallations(
    signal?: AbortSignal,
  ): Promise<readonly RuntimeInstallation[]> {
    return this.json<{ items: readonly RuntimeInstallation[] }>(
      { path: '/v2/runtime/installations', signal },
      'RuntimeInstallations',
    ).then((value) => value.items);
  }

  getInstallation(
    id: string,
    signal?: AbortSignal,
  ): Promise<RuntimeInstallation> {
    return this.json(
      { path: `/v2/runtime/installations/${encodeURIComponent(id)}`, signal },
      'RuntimeInstallation',
    );
  }

  cancelInstallation(
    id: string,
    signal?: AbortSignal,
  ): Promise<RuntimeInstallation> {
    return this.json(
      {
        path: `/v2/runtime/installations/${encodeURIComponent(id)}/cancel`,
        method: 'POST',
        signal,
      },
      'RuntimeInstallation',
    );
  }

  getModelOptions(signal?: AbortSignal): Promise<RuntimeModelOptions> {
    return this.json(
      { path: '/v2/runtime/model-options', signal },
      'RuntimeModelOptions',
    );
  }

  startModelInstallation(
    optionId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<RuntimeModelInstallation> {
    return this.json(
      {
        path: '/v2/runtime/model-installations',
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ optionId, consent: true }),
      },
      'RuntimeModelInstallation',
    );
  }

  getModelInstallation(
    id: string,
    signal?: AbortSignal,
  ): Promise<RuntimeModelInstallation> {
    return this.json(
      {
        path: `/v2/runtime/model-installations/${encodeURIComponent(id)}`,
        signal,
      },
      'RuntimeModelInstallation',
    );
  }

  /** Alias retained for callers that use the status-oriented operation name. */
  getModelInstallationStatus(
    id: string,
    signal?: AbortSignal,
  ): Promise<RuntimeModelInstallation> {
    return this.getModelInstallation(id, signal);
  }

  cancelModelInstallation(
    id: string,
    signal?: AbortSignal,
  ): Promise<RuntimeModelInstallation> {
    return this.json(
      {
        path: `/v2/runtime/model-installations/${encodeURIComponent(id)}/cancel`,
        method: 'POST',
        signal,
      },
      'RuntimeModelInstallation',
    );
  }

  createCapture(upload: CaptureUpload): Promise<CaptureOperation> {
    return this.startStreamingCapture(upload);
  }

  getCapture(id: string, signal?: AbortSignal): Promise<CaptureOperation> {
    return this.getStreamingCapture(id, signal);
  }

  cancelCapture(id: string, signal?: AbortSignal): Promise<CaptureOperation> {
    return this.cancelStreamingCapture(id, signal);
  }

  getRaw(id: string, signal?: AbortSignal): Promise<RawCapture> {
    return this.json(
      { path: `/v2/captures/${encodeURIComponent(id)}/raw`, signal },
      'RawCapture',
    );
  }

  getResult(id: string, signal?: AbortSignal): Promise<CaptureStreamingResult> {
    return this.getStreamingResult(id, signal);
  }

  commitStructure(
    id: string,
    candidate: CaptureDocument,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<CaptureOperation> {
    return this.commitStreamingStructuredResult(
      id,
      candidate,
      idempotencyKey,
      signal,
    );
  }

  reportStructuringFailure(
    id: string,
    code: string,
    message: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<CaptureOperation> {
    return this.reportStreamingStructuringFailure(
      id,
      code,
      message,
      idempotencyKey,
      signal,
    );
  }

  async startStreamingCapture(
    upload: CaptureUpload,
  ): Promise<CaptureOperation> {
    const bytes = await bodyBytes(upload.body);
    const digest = await sha256(bytes);
    const capabilities = await this.getStreamingCapabilities(upload.signal);
    const maxChunk = Math.max(
      1,
      Math.min(CHUNK_BYTES, capabilities.maxChunkBytes),
    );
    const open = await this.json<Ingestion>(
      {
        path: '/v2/ingestions',
        method: 'POST',
        signal: upload.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': `${upload.clientRequestId}-ingestion`,
        },
        body: JSON.stringify({
          protocolVersion: '2',
          kind: upload.sourceKind,
          mode: 'file',
          clientRequestId: `${upload.clientRequestId}-ingestion`,
          fileName: upload.fileName,
          mediaType: upload.mediaType ?? 'application/octet-stream',
          totalBytes: bytes.byteLength,
          sourceSha256: digest,
        }),
      },
      'Ingestion',
    );
    let ingestion = open;
    try {
      for (
        let offset = ingestion.nextOffset;
        offset < bytes.byteLength;
        offset += maxChunk
      ) {
        const chunk = bytes.slice(
          offset,
          Math.min(offset + maxChunk, bytes.byteLength),
        );
        ingestion = await this.json(
          {
            path: `/v2/ingestions/${encodeURIComponent(ingestion.ingestionId)}/chunks/${ingestion.nextChunkIndex}`,
            method: 'PUT',
            signal: upload.signal,
            headers: {
              'Content-Range': `bytes ${offset}-${offset + chunk.byteLength - 1}/${bytes.byteLength}`,
              Digest: `sha-256=${await sha256(chunk)}`,
              'X-Idempotency-Key': `${ingestion.ingestionId}-${ingestion.nextChunkIndex}`,
            },
            body: chunk,
          },
          'Ingestion',
        );
      }
      ingestion = await this.json(
        {
          path: `/v2/ingestions/${encodeURIComponent(ingestion.ingestionId)}/finalize`,
          method: 'POST',
          signal: upload.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            protocolVersion: '2',
            totalBytes: bytes.byteLength,
            sha256: digest,
          }),
        },
        'Ingestion',
      );
      return this.json(
        {
          path: '/v2/captures',
          method: 'POST',
          signal: upload.signal,
          headers: {
            'Content-Type': 'application/json',
            'X-Idempotency-Key': upload.clientRequestId,
          },
          body: JSON.stringify({
            protocolVersion: '2',
            clientRequestId: upload.clientRequestId,
            ingestionId: ingestion.ingestionId,
            structuringMode: upload.structuringMode ?? 'runtime',
            targetLanguage: upload.targetLanguage ?? null,
            startPolicy: 'eager',
          }),
        },
        'CaptureOperation',
      );
    } catch (error) {
      await this.json({
        path: `/v2/ingestions/${encodeURIComponent(ingestion.ingestionId)}`,
        method: 'DELETE',
      }).catch(() => undefined);
      throw error;
    }
  }

  getStreamingCapture(
    id: string,
    signal?: AbortSignal,
  ): Promise<CaptureOperation> {
    return this.json(
      { path: `/v2/captures/${encodeURIComponent(id)}`, signal },
      'CaptureOperation',
    );
  }
  getStreamingPartial(
    id: string,
    signal?: AbortSignal,
  ): Promise<PartialCapture> {
    return this.json(
      { path: `/v2/captures/${encodeURIComponent(id)}/partial`, signal },
      'PartialCapture',
    );
  }
  getStreamingResult(
    id: string,
    signal?: AbortSignal,
  ): Promise<CaptureStreamingResult> {
    return this.json(
      { path: `/v2/captures/${encodeURIComponent(id)}/result`, signal },
      'StreamingResult',
    );
  }
  cancelStreamingCapture(
    id: string,
    signal?: AbortSignal,
  ): Promise<CaptureOperation> {
    return this.json(
      {
        path: `/v2/captures/${encodeURIComponent(id)}/cancel`,
        method: 'POST',
        signal,
      },
      'CaptureOperation',
    );
  }
  commitStreamingStructuredResult(
    id: string,
    candidate: CaptureDocument,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<CaptureOperation> {
    return this.json(
      {
        path: `/v2/captures/${encodeURIComponent(id)}/structure/commit`,
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(candidate),
      },
      'CaptureOperation',
    );
  }
  reportStreamingStructuringFailure(
    id: string,
    code: string,
    message: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<CaptureOperation> {
    return this.json(
      {
        path: `/v2/captures/${encodeURIComponent(id)}/structure/failure`,
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ protocolVersion: '2', code, message }),
      },
      'CaptureOperation',
    );
  }
  deleteCapture(id: string, signal?: AbortSignal): Promise<void> {
    return this.json<void>({
      path: `/v2/captures/${encodeURIComponent(id)}`,
      method: 'DELETE',
      signal,
    });
  }

  async *captureEvents(
    id: string,
    options: {
      readonly lastEventId?: string | number;
      readonly signal?: AbortSignal;
      readonly maxReconnects?: number;
    } = {},
  ): AsyncGenerator<CaptureEvent> {
    const maxReconnects = options.maxReconnects ?? 2;
    if (maxReconnects < 0 || !Number.isInteger(maxReconnects))
      throw new CaptureRuntimeProtocolError(
        'maxReconnects must be a non-negative integer.',
      );
    let previous =
      options.lastEventId === undefined ? -1 : Number(options.lastEventId);
    let reconnects = 0;
    while (true) {
      const response = await this.request({
        path: `/v2/captures/${encodeURIComponent(id)}/events`,
        signal: options.signal,
        headers: {
          Accept: 'text/event-stream',
          ...(previous < 0 ? {} : { 'Last-Event-ID': String(previous) }),
        },
      });
      try {
        for await (const frame of decodeSse(response)) {
          const event = parseJsonFrame<CaptureEvent>(frame);
          if (event.captureId !== id || event.sequence <= previous)
            throw new CaptureRuntimeProtocolError(
              'Capture Runtime returned an invalid event identity or sequence.',
            );
          previous = event.sequence;
          yield event;
          if (['completed', 'failed', 'cancelled'].includes(event.eventType))
            return;
        }
      } catch (error) {
        const retryable =
          error instanceof CaptureTransportError ||
          (error instanceof CaptureRuntimeError && error.retryable);
        if (!retryable || reconnects >= maxReconnects) throw error;
        reconnects += 1;
        continue;
      }
      if (reconnects >= maxReconnects) return;
      reconnects += 1;
    }
  }

  private async json<T>(
    request: RuntimeTransportRequest,
    model?: RuntimeResponseModel,
  ): Promise<T> {
    return decodeJson<T>(await this.request(request), this.transport, model);
  }

  private async request(request: RuntimeTransportRequest): Promise<Response> {
    if (requiresDiscovery(request.path)) await this.discover(request.signal);
    const method = request.method ?? 'GET';
    const headers = new Headers(request.headers ?? {});
    const keyed =
      headers.has('X-Idempotency-Key') && !!headers.get('X-Idempotency-Key');
    const retryableRequest = method === 'GET' || method === 'DELETE' || keyed;
    const retries = retryableRequest ? (this.options.maxRetries ?? 2) : 0;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await this.transport.request(request);
        if (
          [408, 425, 429, 500, 502, 503, 504].includes(response.status) &&
          attempt < retries
        ) {
          const retryAfter = Number(response.headers.get('Retry-After'));
          if (response.body)
            await response.body.cancel().catch(() => undefined);
          await sleep(
            Number.isFinite(retryAfter) && retryAfter >= 0
              ? retryAfter * 1000
              : (this.options.retryBackoffMs ?? 0) * 2 ** attempt,
          );
          continue;
        }
        return response;
      } catch (error) {
        if (attempt >= retries) throw error;
        await sleep((this.options.retryBackoffMs ?? 0) * 2 ** attempt);
      }
    }
    throw new CaptureTransportError('Capture Runtime retry loop exhausted.');
  }

  private validateContractIndex(index: ContractIndex): void {
    const required = [
      'catalogVersion',
      'runtimeVersion',
      'contractSetVersion',
      'surfaces',
      'sha256',
      'href',
    ];
    if (required.some((field) => !(field in index)))
      throw new CaptureRuntimeProtocolError(
        'Capture Runtime contract index is missing required fields.',
      );
    if (
      index['catalogVersion'] !== '2' ||
      index['contractSetVersion'] !== '2' ||
      typeof index['runtimeVersion'] !== 'string'
    )
      throw new CaptureRuntimeCompatibilityError(
        'Capture Runtime contract catalog version is incompatible.',
      );
    const surfaces = index['surfaces'];
    if (
      !Array.isArray(surfaces) ||
      new Set(surfaces.map((surface) => (surface as { id?: unknown })?.id))
        .size !== 1 ||
      !surfaces.some((surface) => (surface as { id?: unknown })?.id === 'v2')
    )
      throw new CaptureRuntimeCompatibilityError(
        'Capture Runtime contract catalog does not expose the v2 surface.',
      );
    if (
      typeof index['sha256'] !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(index['sha256'])
    )
      throw new CaptureRuntimeProtocolError(
        'Capture Runtime contract index hash is invalid.',
      );
  }

  private validateContractBundle(bundle: ContractBundle): string {
    const requiredArrays = [
      'surfaces',
      'schemas',
      'operations',
      'problems',
      'invariants',
    ] as const;
    if (
      bundle['contractSetVersion'] !== '2' ||
      bundle['schemaDialect'] !==
        'https://json-schema.org/draft/2020-12/schema' ||
      requiredArrays.some((field) => !Array.isArray(bundle[field]))
    ) {
      throw new CaptureRuntimeProtocolError(
        'Capture Runtime contract bundle is invalid.',
      );
    }
    const surfaces = bundle['surfaces'];
    const surfaceIds = new Set(
      surfaces.map((surface) => (surface as { id?: unknown })?.id),
    );
    if (surfaceIds.size !== 1 || !surfaceIds.has('v2')) {
      throw new CaptureRuntimeCompatibilityError(
        'Capture Runtime contract bundle does not expose the v2 surface.',
      );
    }
    const operations = bundle['operations'];
    if (
      operations.some((operation) => {
        if (!operation || typeof operation !== 'object') return true;
        const value = operation as {
          path?: unknown;
          method?: unknown;
          surface?: unknown;
          body?: unknown;
          requiredHeaders?: unknown;
          idempotency?: unknown;
          responseStatusCodes?: unknown;
        };
        return (
          typeof value.path !== 'string' ||
          typeof value.method !== 'string' ||
          typeof value.surface !== 'string' ||
          !value.body ||
          typeof value.body !== 'object' ||
          !Array.isArray(value.requiredHeaders) ||
          !value.idempotency ||
          typeof value.idempotency !== 'object' ||
          !Array.isArray(value.responseStatusCodes)
        );
      })
    ) {
      throw new CaptureRuntimeProtocolError(
        'Capture Runtime contract operation metadata is invalid.',
      );
    }
    const paths = new Set(
      operations.map((operation) => (operation as { path?: unknown })?.path),
    );
    for (const path of [
      '/v2/health/ready',
      '/v2/streaming/health/ready',
      '/v2/runtime/requirements',
      '/v2/runtime/installations',
      '/v2/captures',
      '/v2/captures/{capture_id}/events',
      '/v2/captures/{capture_id}/raw',
      '/v2/captures/{capture_id}/result',
    ]) {
      if (!paths.has(path))
        throw new CaptureRuntimeCompatibilityError(
          'Capture Runtime contract bundle does not advertise the required client surface.',
        );
    }
    const requireOperation = (path: string) =>
      operations.find(
        (operation) => (operation as { path?: unknown })?.path === path,
      ) as
        | {
            body?: { kind?: unknown };
            requiredHeaders?: unknown[];
            mediaType?: unknown;
            streaming?: { kind?: unknown; lastEventIdHeader?: unknown };
          }
        | undefined;
    const upload = requireOperation('/v2/captures');
    const chunk = requireOperation(
      '/v2/ingestions/{ingestion_id}/chunks/{chunk_index}',
    );
    const events = requireOperation('/v2/captures/{capture_id}/events');
    if (
      !['json', 'none'].includes(String(upload?.body?.kind)) ||
      !upload?.requiredHeaders?.includes('X-Idempotency-Key')
    ) {
      throw new CaptureRuntimeCompatibilityError(
        'Capture Runtime v2 capture metadata is incompatible.',
      );
    }
    if (
      chunk?.body?.kind !== 'binary' ||
      !['Content-Range', 'Digest', 'X-Idempotency-Key'].every((header) =>
        chunk.requiredHeaders?.includes(header),
      )
    ) {
      throw new CaptureRuntimeCompatibilityError(
        'Capture Runtime v2 chunk metadata is incompatible.',
      );
    }
    if (
      events?.mediaType !== 'text/event-stream' ||
      events.streaming?.kind !== 'sse' ||
      events.streaming.lastEventIdHeader !== 'Last-Event-ID'
    ) {
      throw new CaptureRuntimeCompatibilityError(
        'Capture Runtime SSE metadata is incompatible.',
      );
    }
    const documentSchema = bundle['schemas'].find(
      (schema) => (schema as { name?: unknown })?.name === 'CaptureDocument',
    ) as { schemaSha256?: unknown } | undefined;
    if (
      typeof documentSchema?.schemaSha256 !== 'string' ||
      documentSchema.schemaSha256 !== CAPTURE_DOCUMENT_SCHEMA_SHA256
    )
      throw new CaptureRuntimeCompatibilityError(
        'Capture Runtime document schema hash is incompatible.',
      );
    return documentSchema.schemaSha256;
  }
}

function requiresDiscovery(path: string): boolean {
  return (
    path.startsWith('/v2/') &&
    path !== '/v2/health/ready' &&
    path !== '/v2/streaming/health/ready'
  );
}

type ContractIndex = {
  readonly catalogVersion?: unknown;
  readonly runtimeVersion?: unknown;
  readonly contractSetVersion?: unknown;
  readonly surfaces?: unknown;
  readonly sha256?: unknown;
  readonly href?: unknown;
};

type ContractBundle = {
  readonly contractSetVersion?: unknown;
  readonly schemaDialect?: unknown;
  readonly surfaces: readonly unknown[];
  readonly schemas: readonly unknown[];
  readonly operations: readonly unknown[];
  readonly problems: readonly unknown[];
  readonly invariants: readonly unknown[];
  readonly [key: string]: unknown;
};

function isTransport(
  value: CaptureRuntimeClientOptions | RuntimeTransport,
): value is RuntimeTransport {
  return typeof (value as RuntimeTransport).request === 'function';
}
async function sleep(milliseconds: number): Promise<void> {
  if (milliseconds > 0)
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function bodyBytes(
  body: BodyInit | Uint8Array | ArrayBuffer,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', owned);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
