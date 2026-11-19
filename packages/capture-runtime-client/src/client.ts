import {
  type CaptureDocument,
  type CaptureEvent,
  type CaptureOperation,
  type CaptureOcrProjection,
  type CaptureRequirementId,
  type CaptureResult,
  type PartialCapture,
  type RawCapture,
  type RuntimeDiscovery,
  type RuntimeInstallation,
  type StructuringModelInstallation,
  type StructuringModelOptions,
  type RuntimeReady,
  type RuntimeRequirement,
  type RuntimeRequirements,
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
  startCapture as startCaptureRequest,
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

  /** Negotiate the runtime contract once; concurrent callers share the result and a failure is retried on the next call. */
  discover(signal?: AbortSignal): Promise<RuntimeDiscovery> {
    if (!this.discovery) {
      const negotiation = negotiateRuntime(
        {
          options: this.options,
          transport: this.transport,
          json: this.json.bind(this),
          getReady: this.getReady.bind(this),
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

  /**
   * Read `/v2/health/ready`: runtime version, API version, contract identity,
   * and the capabilities (capture kinds, structuring modes, upload limits).
   */
  getReady(signal?: AbortSignal): Promise<RuntimeReady> {
    return this.json<RuntimeReady>(
      { path: '/v2/health/ready', signal },
      'RuntimeReady',
    );
  }

  /** List the runtime requirements (OCR, Whisper, Ollama) and their install status. */
  async getRequirements(
    signal?: AbortSignal,
  ): Promise<readonly RuntimeRequirement[]> {
    const response = await this.json<RuntimeRequirements>(
      { path: '/v2/runtime/requirements', signal },
      'RuntimeRequirements',
    );
    return response.items;
  }

  /** Start installing a requirement with user consent; the idempotency key makes retries safe. */
  startInstallation(
    requirementId: CaptureRequirementId,
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

  /** List requirement installations known to the runtime, including active ones. */
  listInstallations(
    signal?: AbortSignal,
  ): Promise<readonly RuntimeInstallation[]> {
    return this.json<{ items: readonly RuntimeInstallation[] }>(
      { path: '/v2/runtime/installations', signal },
      'RuntimeInstallations',
    ).then((value) => value.items);
  }

  /** Read one requirement installation's status and progress. */
  getInstallation(
    id: string,
    signal?: AbortSignal,
  ): Promise<RuntimeInstallation> {
    return this.json(
      { path: `/v2/runtime/installations/${encodeURIComponent(id)}`, signal },
      'RuntimeInstallation',
    );
  }

  /** Cancel a queued or running requirement installation. */
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

  /**
   * Remove an installed engine to free disk space and return the requirement,
   * now not installed. Uninstalling one that is not installed returns it as is.
   */
  uninstallRequirement(
    requirementId: CaptureRequirementId,
    signal?: AbortSignal,
  ): Promise<RuntimeRequirement> {
    return this.json(
      {
        path: `/v2/runtime/requirements/${encodeURIComponent(requirementId)}/installation`,
        method: 'DELETE',
        signal,
      },
      'RuntimeRequirement',
    );
  }

  /** List the structuring model options the runtime allows. */
  getModelOptions(signal?: AbortSignal): Promise<StructuringModelOptions> {
    return this.json(
      { path: '/v2/runtime/structuring-model-options', signal },
      'StructuringModelOptions',
    );
  }

  /** Start installing the selected structuring model. */
  startModelInstallation(
    optionId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<StructuringModelInstallation> {
    return this.json(
      {
        path: '/v2/runtime/structuring-model-installations',
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ optionId, consent: true }),
      },
      'StructuringModelInstallation',
    );
  }

  /** Read one structuring model installation's status. */
  getModelInstallation(
    id: string,
    signal?: AbortSignal,
  ): Promise<StructuringModelInstallation> {
    return this.json(
      {
        path: `/v2/runtime/structuring-model-installations/${encodeURIComponent(id)}`,
        signal,
      },
      'StructuringModelInstallation',
    );
  }

  /** Cancel a structuring model installation. */
  cancelModelInstallation(
    id: string,
    signal?: AbortSignal,
  ): Promise<StructuringModelInstallation> {
    return this.json(
      {
        path: `/v2/runtime/structuring-model-installations/${encodeURIComponent(id)}/cancel`,
        method: 'POST',
        signal,
      },
      'StructuringModelInstallation',
    );
  }

  /** Upload a file through a chunked ingestion and start its capture. */
  startCapture(upload: CaptureUpload): Promise<CaptureOperation> {
    return startCaptureRequest(
      { json: this.json.bind(this), discover: this.discover.bind(this) },
      upload,
    );
  }

  /** Read a capture operation's current state. */
  getCapture(id: string, signal?: AbortSignal): Promise<CaptureOperation> {
    return this.json(
      { path: `/v2/captures/${encodeURIComponent(id)}`, signal },
      'CaptureOperation',
    );
  }

  /** Read the partial result a capture has produced so far. */
  getPartial(id: string, signal?: AbortSignal): Promise<PartialCapture> {
    return this.json(
      { path: `/v2/captures/${encodeURIComponent(id)}/partial`, signal },
      'PartialCapture',
    );
  }

  /** Read the raw extraction of a capture. */
  getRaw(id: string, signal?: AbortSignal): Promise<RawCapture> {
    return this.json(
      { path: `/v2/captures/${encodeURIComponent(id)}/raw`, signal },
      'RawCapture',
    );
  }

  /** Read the page-addressable OCR projection of a capture. */
  getOcr(id: string, signal?: AbortSignal): Promise<CaptureOcrProjection> {
    return this.json(
      { path: `/v2/captures/${encodeURIComponent(id)}/ocr`, signal },
      'CaptureOcrProjection',
    );
  }

  /** Read the terminal capture state, raw extraction, and structured document. */
  getResult(id: string, signal?: AbortSignal): Promise<CaptureResult> {
    return this.json(
      { path: `/v2/captures/${encodeURIComponent(id)}/result`, signal },
      'CaptureResult',
    );
  }

  /** Request cancellation of a capture operation. */
  cancelCapture(id: string, signal?: AbortSignal): Promise<CaptureOperation> {
    return this.json(
      {
        path: `/v2/captures/${encodeURIComponent(id)}/cancel`,
        method: 'POST',
        signal,
      },
      'CaptureOperation',
    );
  }

  /** Commit the final structured document for a capture. */
  commitStructure(
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

  /** Report that host-side structuring failed for a capture. */
  reportStructuringFailure(
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

  /** Delete a capture and its stored artifacts from the runtime. */
  deleteCapture(id: string, signal?: AbortSignal): Promise<void> {
    return this.json<void>({
      path: `/v2/captures/${encodeURIComponent(id)}`,
      method: 'DELETE',
      signal,
    });
  }

  /**
   * Delete an ingestion and its uploaded bytes. The runtime rejects it with
   * `ingestion_delete_rejected` while a capture of it is still running.
   */
  deleteIngestion(id: string, signal?: AbortSignal): Promise<void> {
    return this.json<void>({
      path: `/v2/ingestions/${encodeURIComponent(id)}`,
      method: 'DELETE',
      signal,
    });
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

  /** Read the structuring session of a capture. */
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

  /** Read one batch of a structuring session. */
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

  /** Submit the host's result for one structuring batch. */
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

  /** Yield capture events from the SSE stream until a terminal event, resuming after the last seen event. */
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
