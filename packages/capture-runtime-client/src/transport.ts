import { CaptureTransportError } from './errors.js';
import type { RuntimeInMemoryRoute, CaptureRuntimeClientOptions, RuntimeTransport, RuntimeTransportRequest } from './contracts.js';

export function assertLoopbackBaseUrl(value: string | number): string {
  const candidate = typeof value === 'number' ? `http://127.0.0.1:${value}` : value;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new CaptureTransportError('Capture Runtime URL is invalid.', undefined, 'unsafe_base_url');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
  if (url.protocol !== 'http:' || !loopback || !url.port || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new CaptureTransportError('Capture Runtime URL must be an HTTP loopback origin with an explicit port.', undefined, 'unsafe_base_url');
  }
  return url.origin;
}

export class HttpRuntimeTransport implements RuntimeTransport {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(private readonly options: Pick<CaptureRuntimeClientOptions, 'baseUrl' | 'bearerToken' | 'fetch'>) {
    if (typeof window !== 'undefined' && options.bearerToken !== undefined) {
      throw new CaptureTransportError('Bearer tokens are only valid in a host backend or trusted process.', undefined, 'browser_credential_forbidden');
    }
    this.baseUrl = assertLoopbackBaseUrl(options.baseUrl);
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async request(request: RuntimeTransportRequest): Promise<Response> {
    const token = typeof this.options.bearerToken === 'function'
      ? await this.options.bearerToken()
      : this.options.bearerToken;
    const headers = new Headers({ Accept: 'application/json', ...(request.headers ?? {}) });
    if (token?.trim()) headers.set('Authorization', `Bearer ${token}`);
    try {
      return await this.fetchImplementation(`${this.baseUrl}${request.path}`, {
        method: request.method ?? 'GET',
        headers,
        body: request.body,
        signal: request.signal,
        credentials: 'omit',
        redirect: 'error',
      });
    } catch (error) {
      throw new CaptureTransportError('Capture Runtime transport request failed.', error);
    }
  }
}

export class InMemoryRuntimeTransport implements RuntimeTransport {
  constructor(private readonly routes: readonly RuntimeInMemoryRoute[]) {}

  async request(request: RuntimeTransportRequest): Promise<Response> {
    const route = this.routes.find((candidate) => {
      const methodMatches = !candidate.method || candidate.method === (request.method ?? 'GET');
      const pathMatches = typeof candidate.path === 'string' ? candidate.path === request.path : candidate.path.test(request.path);
      return methodMatches && pathMatches;
    });
    if (!route) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Route not found.' } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    return route.handle(request);
  }
}
