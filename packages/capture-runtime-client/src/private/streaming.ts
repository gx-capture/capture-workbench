import type {
  CaptureEvent,
  CaptureOperation,
  CaptureUpload,
  Ingestion,
  RuntimeStreamingCapabilities,
  RuntimeTransportRequest,
} from '../contracts.js';
import {
  CaptureRuntimeError,
  CaptureRuntimeProtocolError,
  CaptureTransportError,
} from '../errors.js';
import {
  bodyBytes,
  decodeSse,
  parseJsonFrame,
  sha256,
  type RuntimeResponseModel,
} from './codec-plumbing.js';

const CHUNK_BYTES = 1024 * 1024;

type RuntimeJson = <T>(
  request: RuntimeTransportRequest,
  model?: RuntimeResponseModel,
) => Promise<T>;

interface StreamingRequestContext {
  readonly json: RuntimeJson;
  readonly getStreamingCapabilities: (
    signal?: AbortSignal,
  ) => Promise<RuntimeStreamingCapabilities>;
  readonly request: (request: RuntimeTransportRequest) => Promise<Response>;
}

/** Upload, finalize, and start one v2 streaming capture through the JSON facade. */
export async function startStreamingCapture(
  context: Pick<StreamingRequestContext, 'json' | 'getStreamingCapabilities'>,
  upload: CaptureUpload,
): Promise<CaptureOperation> {
  const bytes = await bodyBytes(upload.body);
  const digest = await sha256(bytes);
  const capabilities = await context.getStreamingCapabilities(upload.signal);
  const maxChunk = Math.max(
    1,
    Math.min(CHUNK_BYTES, capabilities.maxChunkBytes),
  );
  const open = await context.json<Ingestion>(
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
      ingestion = await context.json(
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
    ingestion = await context.json(
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
    return context.json(
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
    await context
      .json({
        path: `/v2/ingestions/${encodeURIComponent(ingestion.ingestionId)}`,
        method: 'DELETE',
      })
      .catch(() => undefined);
    throw error;
  }
}

/** Stream ordered SSE events and resume with the latest accepted sequence. */
export async function* captureEvents(
  context: Pick<StreamingRequestContext, 'request'>,
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
    const response = await context.request({
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
