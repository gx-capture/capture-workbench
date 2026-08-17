import {
  CAPTURE_API_VERSION,
  CAPTURE_CONTRACT_SET_SHA256,
  CAPTURE_DOCUMENT_SCHEMA_SHA256,
  CAPTURE_DOCUMENT_SCHEMA_VERSION,
  type CaptureRuntimeClientOptions,
  type RuntimeDiscovery,
  type RuntimeReady,
  type RuntimeStreamingCapabilities,
  type RuntimeTransport,
  type RuntimeTransportRequest,
} from '../contracts.js';
import {
  CaptureRuntimeCompatibilityError,
  CaptureRuntimeProtocolError,
} from '../errors.js';
import {
  decodeError,
  sha256,
  type RuntimeResponseModel,
} from './codec-plumbing.js';

type RuntimeJson = <T>(
  request: RuntimeTransportRequest,
  model?: RuntimeResponseModel,
) => Promise<T>;

export interface RuntimeDiscoveryContext {
  readonly options: CaptureRuntimeClientOptions;
  readonly transport: RuntimeTransport;
  readonly json: RuntimeJson;
  readonly getReady: (signal?: AbortSignal) => Promise<RuntimeReady>;
  readonly getStreamingCapabilities: (
    signal?: AbortSignal,
  ) => Promise<RuntimeStreamingCapabilities>;
}

/** Negotiate readiness, contract identity, and the v2 streaming surface. */
export async function negotiateRuntime(
  context: RuntimeDiscoveryContext,
  signal?: AbortSignal,
): Promise<RuntimeDiscovery> {
  const ready = await context.getReady(signal);
  const failures: string[] = [];
  const expectedApi = context.options.expectedApiVersion ?? CAPTURE_API_VERSION;
  const expectedSchema =
    context.options.expectedSchemaVersion ?? CAPTURE_DOCUMENT_SCHEMA_VERSION;
  const expectedHash =
    context.options.expectedSchemaSha256 ?? CAPTURE_DOCUMENT_SCHEMA_SHA256;
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
  const contractIndex = await context.json<ContractIndex>({
    path: '/meta/v2/contracts',
    signal,
  });
  validateContractIndex(contractIndex);
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
  const bundleResponse = await context.transport.request({
    path: href,
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!bundleResponse.ok) throw await decodeError(bundleResponse);
  const bundleBytes = new Uint8Array(await bundleResponse.arrayBuffer());
  const bundleHash = await sha256(bundleBytes);
  const allowedContractHashes = context.options.allowedContractSetSha256 ?? [
    context.options.expectedContractSetSha256 ?? CAPTURE_CONTRACT_SET_SHA256,
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
  const bundleSchemaHash = validateContractBundle(contractBundle);
  // V2 readiness is part of the negotiated client surface. Do not silently
  // continue after a malformed or otherwise incompatible response.
  const streaming = await context.getStreamingCapabilities(signal);
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

function validateContractIndex(index: ContractIndex): void {
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

function validateContractBundle(bundle: ContractBundle): string {
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
    '/v2/captures/{capture_id}/structure/session',
    '/v2/captures/{capture_id}/structure/session/batches/{batch_index}',
  ]) {
    if (!paths.has(path))
      throw new CaptureRuntimeCompatibilityError(
        'Capture Runtime contract bundle does not advertise the required client surface.',
      );
  }
  const requireOperation = (path: string, method?: string) =>
    operations.find(
      (operation) =>
        (operation as { path?: unknown; method?: unknown })?.path === path &&
        (method === undefined ||
          (operation as { method?: unknown })?.method === method),
    ) as
      | {
          body?: { kind?: unknown };
          requiredHeaders?: unknown[];
          idempotency?: { mode?: unknown; header?: unknown };
          mediaType?: unknown;
          streaming?: { kind?: unknown; lastEventIdHeader?: unknown };
        }
      | undefined;
  const upload = requireOperation('/v2/captures');
  const chunk = requireOperation(
    '/v2/ingestions/{ingestion_id}/chunks/{chunk_index}',
  );
  const events = requireOperation('/v2/captures/{capture_id}/events');
  const sessionOpen = requireOperation(
    '/v2/captures/{capture_id}/structure/session',
    'POST',
  );
  const batchGet = requireOperation(
    '/v2/captures/{capture_id}/structure/session/batches/{batch_index}',
    'GET',
  );
  const batchSubmit = requireOperation(
    '/v2/captures/{capture_id}/structure/session/batches/{batch_index}',
    'PUT',
  );
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
  if (
    sessionOpen?.body?.kind !== 'json' ||
    !sessionOpen.requiredHeaders?.includes('X-Idempotency-Key') ||
    sessionOpen.idempotency?.mode !== 'required' ||
    batchGet?.body?.kind !== 'none' ||
    batchSubmit?.body?.kind !== 'json' ||
    !batchSubmit.requiredHeaders?.includes('X-Idempotency-Key') ||
    batchSubmit.idempotency?.mode !== 'required'
  ) {
    throw new CaptureRuntimeCompatibilityError(
      'Capture Runtime pull-session metadata is incompatible.',
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
