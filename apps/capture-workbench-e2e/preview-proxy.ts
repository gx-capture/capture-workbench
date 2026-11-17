import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect as netConnect } from 'node:net';

export interface ParsedServerArgs {
  readonly port: number;
  readonly upstreamUrl: URL;
}

export interface HtmlTransformResult {
  readonly html: string;
  readonly setCookies?: readonly string[];
}

export function parseServerArgs(argv: readonly string[], usage: string): ParsedServerArgs {
  if (argv.length < 3 || argv.length > 4) {
    throw new Error(usage);
  }
  const port = Number(argv[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(usage);
  }
  const upstreamRaw = argv[3] ?? 'http://localhost:4200';
  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(upstreamRaw);
  } catch {
    throw new Error(`Invalid upstream URL: ${upstreamRaw}`);
  }
  if (upstreamUrl.protocol !== 'http:') {
    throw new Error(`Upstream URL must use http:// (got ${upstreamUrl.protocol}).`);
  }
  return { port, upstreamUrl };
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function injectIntoHtml(html: string, scriptTag: string): string {
  const headMatch = /<head\b[^>]*>/iu.exec(html);
  if (!headMatch) {
    return `${scriptTag}${html}`;
  }
  const insertAt = headMatch.index + headMatch[0].length;
  return `${html.slice(0, insertAt)}${scriptTag}${html.slice(insertAt)}`;
}

function buildUpstreamHeaders(
  incoming: IncomingHttpHeaders,
  upstreamHost: string,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(incoming)) {
    const lower = key.toLowerCase();
    if (lower === 'host' || lower === 'accept-encoding') continue;
    // Injected pages vary by mode/scenario, so upstream must send the full HTML.
    if (lower === 'if-none-match' || lower === 'if-modified-since') continue;
    if (value !== undefined) {
      headers[key] = value;
    }
  }
  headers['host'] = upstreamHost;
  return headers;
}

function buildPassthroughHeaders(incoming: IncomingHttpHeaders): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (key.toLowerCase().startsWith('access-control-allow-')) continue;
    if (value !== undefined) {
      headers[key] = value;
    }
  }
  return headers;
}

export function proxyUpstreamRequest(
  request: IncomingMessage,
  response: ServerResponse,
  upstreamUrl: URL,
  requestUrl: URL,
  transformHtml: (html: string) => HtmlTransformResult,
): void {
  const upstreamPath = `${requestUrl.pathname}${requestUrl.search}`;
  const upstreamReq = httpRequest(
    {
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port ? Number(upstreamUrl.port) : 80,
      method: request.method,
      path: upstreamPath,
      headers: buildUpstreamHeaders(request.headers, upstreamUrl.host),
    },
    (upstreamRes) => {
      const statusCode = upstreamRes.statusCode ?? 502;
      const contentType = String(upstreamRes.headers['content-type'] ?? '').toLowerCase();
      const isHtml200 = statusCode === 200 && contentType.startsWith('text/html');

      if (!isHtml200) {
        response.writeHead(statusCode, buildPassthroughHeaders(upstreamRes.headers));
        upstreamRes.pipe(response);
        return;
      }

      const chunks: Buffer[] = [];
      upstreamRes.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      upstreamRes.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8');
        const transformed = transformHtml(html);

        const outHeaders: OutgoingHttpHeaders = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          const lower = key.toLowerCase();
          if (lower === 'content-security-policy') continue;
          if (lower.startsWith('access-control-allow-')) continue;
          // The body changes with the injected bridge: no validator, no stored
          // copy, and one fixed length instead of the upstream's framing.
          if (
            lower === 'etag'
            || lower === 'last-modified'
            || lower === 'cache-control'
            || lower === 'transfer-encoding'
          ) {
            continue;
          }
          if (value !== undefined) {
            outHeaders[key] = value;
          }
        }
        outHeaders['content-length'] = String(Buffer.byteLength(transformed.html, 'utf8'));
        outHeaders['cache-control'] = 'no-store';

        const setCookies = transformed.setCookies ?? [];
        if (setCookies.length > 0) {
          const existing = outHeaders['set-cookie'];
          const existingList = Array.isArray(existing)
            ? existing
            : existing !== undefined
              ? [String(existing)]
              : [];
          outHeaders['set-cookie'] = [...existingList, ...setCookies];
        }

        response.writeHead(200, outHeaders);
        response.end(transformed.html);
      });
      upstreamRes.on('error', () => {
        if (!response.headersSent) {
          response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        }
        response.end('Upstream response error.\n');
      });
    },
  );

  upstreamReq.on('error', () => {
    if (!response.headersSent) {
      response
        .writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        .end(
          `Upstream dev server (${upstreamUrl.origin}) is unavailable. Start it with: pnpm nx run capture-workbench:serve\n`,
        );
    } else if (!response.destroyed) {
      response.destroy();
    }
  });

  request.pipe(upstreamReq);
}

export function attachWebSocketUpgradeProxy(server: Server, upstreamUrl: URL): void {
  server.on('upgrade', (request, clientSocket, head) => {
    const upstreamPort = upstreamUrl.port ? Number(upstreamUrl.port) : 80;
    const upstreamSocket = netConnect({
      host: upstreamUrl.hostname,
      port: upstreamPort,
    });

    const closeBoth = (): void => {
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    };

    clientSocket.on('error', closeBoth);
    clientSocket.on('close', closeBoth);
    upstreamSocket.on('error', closeBoth);
    upstreamSocket.on('close', closeBoth);

    upstreamSocket.on('connect', () => {
      const lines = [
        `${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${request.httpVersion}`,
      ];
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const name = request.rawHeaders[i];
        const value = request.rawHeaders[i + 1];
        if (name === undefined || value === undefined) continue;
        if (name.toLowerCase() === 'host') {
          lines.push(`${name}: ${upstreamUrl.host}`);
        } else {
          lines.push(`${name}: ${value}`);
        }
      }
      lines.push('', '');
      upstreamSocket.write(lines.join('\r\n'));
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });
  });
}
