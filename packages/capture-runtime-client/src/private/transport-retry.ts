import type {
  CaptureRuntimeClientOptions,
  RuntimeDiscovery,
  RuntimeTransport,
  RuntimeTransportRequest,
} from '../contracts.js';
import { CaptureTransportError } from '../errors.js';

export interface RuntimeRequestContext {
  readonly transport: RuntimeTransport;
  readonly options: Pick<
    CaptureRuntimeClientOptions,
    'maxRetries' | 'retryBackoffMs'
  >;
  readonly discover: (signal?: AbortSignal) => Promise<RuntimeDiscovery>;
}

/** Send a request with the client's discovery gate and idempotent retry policy. */
export async function requestWithRetry(
  context: RuntimeRequestContext,
  request: RuntimeTransportRequest,
): Promise<Response> {
  if (requiresDiscovery(request.path)) await context.discover(request.signal);
  const method = request.method ?? 'GET';
  const headers = new Headers(request.headers ?? {});
  const keyed =
    headers.has('X-Idempotency-Key') && !!headers.get('X-Idempotency-Key');
  const retryableRequest = method === 'GET' || method === 'DELETE' || keyed;
  const retries = retryableRequest ? (context.options.maxRetries ?? 2) : 0;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await context.transport.request(request);
      if (
        [408, 425, 429, 500, 502, 503, 504].includes(response.status) &&
        attempt < retries
      ) {
        const retryAfter = Number(response.headers.get('Retry-After'));
        if (response.body) await response.body.cancel().catch(() => undefined);
        await sleep(
          Number.isFinite(retryAfter) && retryAfter >= 0
            ? retryAfter * 1000
            : (context.options.retryBackoffMs ?? 0) * 2 ** attempt,
        );
        continue;
      }
      return response;
    } catch (error) {
      if (attempt >= retries) throw error;
      await sleep((context.options.retryBackoffMs ?? 0) * 2 ** attempt);
    }
  }
  throw new CaptureTransportError('Capture Runtime retry loop exhausted.');
}

function requiresDiscovery(path: string): boolean {
  return (
    path.startsWith('/v2/') &&
    path !== '/v2/health/ready' &&
    path !== '/v2/streaming/health/ready'
  );
}

async function sleep(milliseconds: number): Promise<void> {
  if (milliseconds > 0)
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
