import {
  type CaptureDocument,
  type CaptureEvent,
  type CaptureOperation,
  type CaptureStreamingResult,
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
  type OpenStructuringSession,
  type StructuringBatch,
  type StructuringSession,
  type SubmitStructuringBatch,
} from './contracts.js';
import {
  CaptureRuntimeProtocolError,
  CaptureTransportError,
} from './errors.js';
import { HttpRuntimeTransport } from './transport.js';
import type { CaptureRuntimeClientOptions } from './contracts.js';
import {
  assertStructuringBatchSubmission,
  decodeRuntimeJson,
  type RuntimeResponseModel,
} from './private/codec-plumbing.js';
import { negotiateRuntime } from './private/discovery.js';
import {
  captureEvents as streamCaptureEvents,
  startStreamingCapture as startStreamingCaptureRequest,
} from './private/streaming.js';
import { requestWithRetry } from './private/transport-retry.js';

/**
 * Public framework-neutral facade for authenticated Capture Runtime v2 calls.
 *
 * Discovery, retry, streaming, and codec details remain private so consumers
 * depend on the stable client API rather than transport implementation seams.
 */
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
      const negotiation = negotiateRuntime(
        {
          options: this.options,
          transport: this.transport,
          json: this.json.bind(this),
          getReady: this.getReady.bind(this),
          getStreamingCapabilities: this.getStreamingCapabilities.bind(this),
        },
        signal,
      ).catch((error: unknown) => {
        if (this.discovery === negotiation) this.discovery = undefined;
        throw error;
      });
      this.discovery = negotiation;
    }
    return this.discovery;
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

  /** Open an authenticated pull-based structuring session for one capture. */
  openStructuringSession(
    captureId: string,
    request: OpenStructuringSession,
    idempotencyKey = request.clientRequestId,
    signal?: AbortSignal,
  ): Promise<StructuringSession> {
    if (request.captureId !== captureId) {
      throw new CaptureRuntimeProtocolError(
        'Structuring session captureId must match the route capture.',
      );
    }
    if (!idempotencyKey || idempotencyKey !== request.clientRequestId) {
      throw new CaptureRuntimeProtocolError(
        'X-Idempotency-Key must match structuring session clientRequestId.',
      );
    }
    return this.json(
      {
        path: `/v2/captures/${encodeURIComponent(captureId)}/structure/session`,
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(request),
      },
      'StructuringSession',
    );
  }

  getStructuringSession(
    captureId: string,
    signal?: AbortSignal,
  ): Promise<StructuringSession> {
    return this.json(
      {
        path: `/v2/captures/${encodeURIComponent(captureId)}/structure/session`,
        signal,
      },
      'StructuringSession',
    );
  }

  getStructuringBatch(
    captureId: string,
    batchIndex: number,
    signal?: AbortSignal,
  ): Promise<StructuringBatch> {
    if (!Number.isInteger(batchIndex) || batchIndex < 0) {
      throw new CaptureRuntimeProtocolError(
        'Structuring batch index must be a non-negative integer.',
      );
    }
    return this.json(
      {
        path: `/v2/captures/${encodeURIComponent(captureId)}/structure/session/batches/${batchIndex}`,
        signal,
      },
      'StructuringBatch',
    );
  }

  /** Alias that makes the pull nature explicit for host coordinators. */
  pullStructuringBatch(
    captureId: string,
    batchIndex: number,
    signal?: AbortSignal,
  ): Promise<StructuringBatch> {
    return this.getStructuringBatch(captureId, batchIndex, signal);
  }

  submitStructuringBatch(
    captureId: string,
    batchIndex: number,
    submission: SubmitStructuringBatch,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<StructuringSession> {
    if (!Number.isInteger(batchIndex) || batchIndex < 0) {
      throw new CaptureRuntimeProtocolError(
        'Structuring batch index must be a non-negative integer.',
      );
    }
    assertStructuringBatchSubmission(submission);
    if (!idempotencyKey) {
      throw new CaptureRuntimeProtocolError(
        'Structuring batch submissions require X-Idempotency-Key.',
      );
    }
    const body = { ...submission, protocolVersion: '2' as const };
    return this.json(
      {
        path: `/v2/captures/${encodeURIComponent(captureId)}/structure/session/batches/${batchIndex}`,
        method: 'PUT',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      },
      'StructuringSession',
    );
  }

  async startStreamingCapture(
    upload: CaptureUpload,
  ): Promise<CaptureOperation> {
    return startStreamingCaptureRequest(
      {
        json: this.json.bind(this),
        getStreamingCapabilities: this.getStreamingCapabilities.bind(this),
      },
      upload,
    );
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
    yield* streamCaptureEvents(
      { request: this.request.bind(this) },
      id,
      options,
    );
  }

  private async json<T>(
    request: RuntimeTransportRequest,
    model?: RuntimeResponseModel,
  ): Promise<T> {
    return decodeRuntimeJson<T>(
      await this.request(request),
      this.transport,
      model,
    );
  }

  private async request(request: RuntimeTransportRequest): Promise<Response> {
    return requestWithRetry(
      {
        transport: this.transport,
        options: this.options,
        discover: this.discover.bind(this),
      },
      request,
    );
  }
}

function isTransport(
  value: CaptureRuntimeClientOptions | RuntimeTransport,
): value is RuntimeTransport {
  return typeof (value as RuntimeTransport).request === 'function';
}
