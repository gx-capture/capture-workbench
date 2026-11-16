import { createHash, randomUUID } from 'node:crypto';

const defaultIngestionChunkBytes = 1024 * 1024;
const terminalCaptureStatuses = new Set(['completed', 'failed', 'cancelled']);

interface CaptureFailure {
  readonly code?: string;
  readonly message?: string;
  readonly stage?: string | null;
}

export interface CaptureOperation {
  readonly captureId: string;
  readonly status: string;
  readonly error?: CaptureFailure | null;
}

interface IngestionResponse {
  readonly ingestionId: string;
  readonly status: string;
}

type V2RequestFn = <T>(path: string, init?: RequestInit) => Promise<T>;

export function validateWorkerMirrorUrl(
  rawUrl: string | undefined,
  envVarName = 'CAPTURE_REAL_SMOKE_WORKER_MIRROR_URL',
): string | undefined {
  if (rawUrl === undefined) return undefined;
  const trimmed = rawUrl.trim();
  if (trimmed === '') return undefined;
  const prefix = 'http://127.0.0.1:';
  if (!trimmed.startsWith(prefix)) {
    throw new Error(`${envVarName} must use http://127.0.0.1:<port>.`);
  }
  const portText = trimmed.slice(prefix.length);
  if (!/^\d+$/u.test(portText)) {
    throw new Error(
      `${envVarName} must specify a numeric port without path, query, or credentials.`,
    );
  }
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${envVarName} port must be between 1 and 65535.`);
  }
  return `${prefix}${port}`;
}

export function isTerminalCaptureStatus(status: string): boolean {
  return terminalCaptureStatuses.has(status);
}

export function buildOpenIngestionRequest(input: {
  readonly clientRequestId: string;
  readonly kind?: 'pdf' | 'image' | 'audio';
  readonly fileName: string;
  readonly mediaType?: string;
  readonly totalBytes: number;
  readonly sourceSha256: string;
}): {
  readonly protocolVersion: '2';
  readonly kind: 'pdf' | 'image' | 'audio';
  readonly mode: 'file';
  readonly clientRequestId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly totalBytes: number;
  readonly sourceSha256: string;
} {
  return {
    protocolVersion: '2',
    kind: input.kind ?? 'pdf',
    mode: 'file',
    clientRequestId: input.clientRequestId,
    fileName: input.fileName,
    mediaType: input.mediaType ?? 'application/pdf',
    totalBytes: input.totalBytes,
    sourceSha256: input.sourceSha256,
  };
}

export function buildFinalizeIngestionRequest(input: {
  readonly totalBytes: number;
  readonly sha256: string;
}): {
  readonly protocolVersion: '2';
  readonly totalBytes: number;
  readonly sha256: string;
} {
  return {
    protocolVersion: '2',
    totalBytes: input.totalBytes,
    sha256: input.sha256,
  };
}

export function buildStartCaptureRequest(input: {
  readonly clientRequestId: string;
  readonly ingestionId: string;
  readonly structuringMode?: 'runtime' | 'host';
  readonly targetLanguage?: string;
}): {
  readonly protocolVersion: '2';
  readonly clientRequestId: string;
  readonly ingestionId: string;
  readonly structuringMode: 'runtime' | 'host';
  readonly targetLanguage: string;
  readonly startPolicy: 'eager';
} {
  return {
    protocolVersion: '2',
    clientRequestId: input.clientRequestId,
    ingestionId: input.ingestionId,
    structuringMode: input.structuringMode ?? 'runtime',
    targetLanguage: input.targetLanguage ?? 'zh-TW',
    startPolicy: 'eager',
  };
}

async function uploadIngestionChunks(input: {
  readonly request: V2RequestFn;
  readonly ingestionId: string;
  readonly sourceBytes: Uint8Array;
  readonly chunkBytes?: number;
}): Promise<void> {
  const chunkBytes = input.chunkBytes ?? defaultIngestionChunkBytes;
  for (
    let index = 0, offset = 0;
    offset < input.sourceBytes.length;
    index += 1, offset += chunkBytes
  ) {
    const chunk = input.sourceBytes.subarray(
      offset,
      Math.min(input.sourceBytes.length, offset + chunkBytes),
    );
    await input.request<void>(
      `/v2/ingestions/${input.ingestionId}/chunks/${index}`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          'content-range': `bytes ${offset}-${offset + chunk.length - 1}/${input.sourceBytes.length}`,
          digest: `sha-256=${createHash('sha256').update(chunk).digest('hex')}`,
          'x-idempotency-key': randomUUID(),
        },
        body: new Uint8Array(chunk),
      },
    );
  }
}

export async function startV2Capture(input: {
  readonly request: V2RequestFn;
  readonly fileName: string;
  readonly kind?: 'pdf' | 'image' | 'audio';
  readonly mediaType?: string;
  readonly sourceBytes: Uint8Array;
  readonly sourceSha256?: string;
  readonly structuringMode?: 'runtime' | 'host';
  readonly targetLanguage?: string;
  readonly chunkBytes?: number;
}): Promise<CaptureOperation> {
  const sourceSha256 =
    input.sourceSha256 ??
    createHash('sha256').update(input.sourceBytes).digest('hex');
  const ingestionKey = randomUUID();
  const ingestion = await input.request<IngestionResponse>('/v2/ingestions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-idempotency-key': ingestionKey,
    },
    body: JSON.stringify(
      buildOpenIngestionRequest({
        clientRequestId: ingestionKey,
        kind: input.kind,
        fileName: input.fileName,
        mediaType: input.mediaType,
        totalBytes: input.sourceBytes.length,
        sourceSha256,
      }),
    ),
  });

  await uploadIngestionChunks({
    request: input.request,
    ingestionId: ingestion.ingestionId,
    sourceBytes: input.sourceBytes,
    chunkBytes: input.chunkBytes,
  });

  await input.request<IngestionResponse>(
    `/v2/ingestions/${ingestion.ingestionId}/finalize`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        buildFinalizeIngestionRequest({
          totalBytes: input.sourceBytes.length,
          sha256: sourceSha256,
        }),
      ),
    },
  );

  const captureKey = randomUUID();
  return input.request<CaptureOperation>('/v2/captures', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-idempotency-key': captureKey,
    },
    body: JSON.stringify(
      buildStartCaptureRequest({
        clientRequestId: captureKey,
        ingestionId: ingestion.ingestionId,
        structuringMode: input.structuringMode,
        targetLanguage: input.targetLanguage,
      }),
    ),
  });
}
