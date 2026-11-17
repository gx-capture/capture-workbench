// Reverse-proxies the Workbench dev server (`capture-workbench:serve`) and
// injects the simulated Tauri desktop bridge (`installFakeDesktop`) into HTML
// responses so developers can calibrate screens and inspect scenarios in any
// browser at http://localhost:4300 without running the Desktop App.
//
// Use: node apps/capture-workbench-e2e/preview-server.ts <port> [upstream]
import { readFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from 'node:http';
import { connect as netConnect } from 'node:net';
import { join, resolve } from 'node:path';
import { installFakeDesktop } from './src/fake-desktop.ts';
import {
  DEFAULT_PREVIEW_SCENARIO,
  PREVIEW_SCENARIOS,
  previewScenarioConfig,
} from './src/preview-scenarios.ts';

const SCENARIO_COOKIE = 'capture-preview-scenario';
const SPEED_COOKIE = 'capture-preview-speed';
const START_DELAY_COOKIE = 'capture-preview-start-delay';

const workspaceRoot = resolve(import.meta.dirname, '..', '..');
const versionJsonPath = join(workspaceRoot, 'release', 'version.json');
const pdfFixturePath = join(
  workspaceRoot,
  'apps',
  'capture-workbench-e2e',
  'src',
  'fixtures',
  'two-pages.pdf',
);

function readRuntimeVersion(): string {
  const parsed = JSON.parse(readFileSync(versionJsonPath, 'utf8')) as {
    readonly releaseVersion?: unknown;
  };
  if (typeof parsed.releaseVersion !== 'string' || parsed.releaseVersion.length === 0) {
    throw new Error('release/version.json has no string releaseVersion.');
  }
  return parsed.releaseVersion;
}

function parseArgs(): { readonly port: number; readonly upstreamUrl: URL } {
  if (process.argv.length < 3 || process.argv.length > 4) {
    throw new Error('Use: preview-server.ts <port> [upstream]');
  }
  const port = Number(process.argv[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Use: preview-server.ts <port> [upstream]');
  }
  const upstreamRaw = process.argv[3] ?? 'http://localhost:4200';
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

function parseCookies(cookieHeader: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const eqIndex = part.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    try {
      cookies.set(key, decodeURIComponent(value));
    } catch {
      cookies.set(key, value);
    }
  }
  return cookies;
}

function parseValidSpeed(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > 1000) return undefined;
  return parsed;
}

function parseValidStartDelay(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 30_000) return undefined;
  return parsed;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPreviewIndexHtml(): string {
  const items = Object.entries(PREVIEW_SCENARIOS)
    .map(
      ([name, scenario]) => `
        <li class="card">
          <div class="card-head">
            <a class="scenario-link" href="/?scenario=${encodeURIComponent(name)}">${escapeHtml(scenario.label)}</a>
            <code>${escapeHtml(name)}</code>
          </div>
          <p>${escapeHtml(scenario.description)}</p>
        </li>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="zh-Hant-TW">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Capture Workbench 本機預覽情境</title>
    <style>
      body {
        font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
        max-width: 720px;
        margin: 48px auto;
        padding: 0 20px;
        line-height: 1.6;
        color: #18181b;
        background: #fafafa;
      }
      h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
      .notice {
        padding: 12px 16px;
        border-radius: 8px;
        background: #f4f4f5;
        border: 1px solid #e4e4e7;
        font-size: 0.925rem;
        margin-bottom: 1.5rem;
      }
      ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
      .card {
        background: #ffffff;
        border: 1px solid #e4e4e7;
        border-radius: 10px;
        padding: 16px 18px;
      }
      .card-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
      }
      .scenario-link {
        font-size: 1.05rem;
        font-weight: 600;
        color: #09090b;
        text-decoration: none;
      }
      .scenario-link:hover { text-decoration: underline; }
      code {
        font-size: 0.85rem;
        color: #52525b;
        background: #f4f4f5;
        padding: 2px 6px;
        border-radius: 4px;
      }
      p { margin: 6px 0 0; color: #3f3f46; font-size: 0.925rem; }
    </style>
  </head>
  <body>
    <h1>Capture Workbench 本機預覽</h1>
    <p class="notice">此預覽使用模擬的桌面後端，不會啟動真實引擎，也不會存取或上傳任何本機檔案。</p>
    <p class="notice">查詢參數：<code>?speed=4</code> 可調整模擬安裝階段倍速（0.1–1000）；<code>?startDelay=1500</code> 可覆寫開始安裝的回應延遲毫秒數（0–30000，預設 500）。</p>
    <ul>
      ${items}
    </ul>
  </body>
</html>
`;
}

function buildInjectedScript(
  scenarioName: string,
  speed: number,
  runtimeVersion: string,
  pdfFixtureBase64: string,
  freshStart: boolean,
  startDelayMs?: number,
): string {
  const fnSource = installFakeDesktop.toString();
  if (/<\/script|<!--/iu.test(fnSource)) {
    throw new Error('installFakeDesktop source must not contain </script or <!--.');
  }
  const config = previewScenarioConfig(
    scenarioName,
    speed,
    runtimeVersion,
    pdfFixtureBase64,
    startDelayMs,
  );
  const configJson = JSON.stringify(config).replace(/</g, '\\u003c');
  // Choosing a scenario by its link is a fresh machine: what the application
  // and the simulated library remembered in this origin's storage goes. A
  // reload without the query keeps it, like the application restarted.
  const reset = freshStart
    ? 'try{localStorage.clear();sessionStorage.clear();}catch{}'
    : '';
  return `<script>${reset}(${fnSource})(${configJson});</script>`;
}

function injectIntoHtml(html: string, scriptTag: string): string {
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
    // The injected document depends on the scenario, so the upstream must
    // answer with the full page, never with "not modified".
    if (lower === 'if-none-match' || lower === 'if-modified-since') continue;
    if (value !== undefined) {
      headers[key] = value;
    }
  }
  headers['host'] = upstreamHost;
  return headers;
}

const { port, upstreamUrl } = parseArgs();
const runtimeVersion = readRuntimeVersion();
const pdfFixtureBase64 = readFileSync(pdfFixturePath).toString('base64');
const previewIndexHtml = renderPreviewIndexHtml();

const server = createServer((request, response) => {
  request.on('error', () => {
    if (!response.destroyed) response.destroy();
  });
  response.on('error', () => {
    if (!request.destroyed) request.destroy();
  });

  const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);

  if (
    requestUrl.pathname === '/__preview'
    && (request.method === 'GET' || request.method === 'HEAD')
  ) {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(Buffer.byteLength(previewIndexHtml, 'utf8')),
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    response.end(previewIndexHtml);
    return;
  }

  const cookies = parseCookies(request.headers['cookie']);
  const hasScenarioQuery = requestUrl.searchParams.has('scenario');
  const hasSpeedQuery = requestUrl.searchParams.has('speed');
  const hasStartDelayQuery = requestUrl.searchParams.has('startDelay');

  let scenario = DEFAULT_PREVIEW_SCENARIO;
  if (hasScenarioQuery) {
    const requested = requestUrl.searchParams.get('scenario') ?? '';
    if (!Object.prototype.hasOwnProperty.call(PREVIEW_SCENARIOS, requested)) {
      const validNames = Object.keys(PREVIEW_SCENARIOS).join(', ');
      response
        .writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        .end(`Unknown preview scenario "${requested}". Valid scenarios: ${validNames}\n`);
      return;
    }
    scenario = requested;
  } else {
    const cookieScenario = cookies.get(SCENARIO_COOKIE);
    if (
      cookieScenario
      && Object.prototype.hasOwnProperty.call(PREVIEW_SCENARIOS, cookieScenario)
    ) {
      scenario = cookieScenario;
    }
  }

  let speed = 1;
  if (hasSpeedQuery) {
    const parsed = parseValidSpeed(requestUrl.searchParams.get('speed') ?? '');
    if (parsed === undefined) {
      response
        .writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        .end('Invalid speed parameter: expected a finite number between 0.1 and 1000.\n');
      return;
    }
    speed = parsed;
  } else {
    const cookieSpeed = parseValidSpeed(cookies.get(SPEED_COOKIE));
    if (cookieSpeed !== undefined) {
      speed = cookieSpeed;
    }
  }

  let startDelayMs: number | undefined;
  if (hasStartDelayQuery) {
    const parsed = parseValidStartDelay(requestUrl.searchParams.get('startDelay') ?? '');
    if (parsed === undefined) {
      response
        .writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        .end('Invalid startDelay parameter: expected a finite number between 0 and 30000.\n');
      return;
    }
    startDelayMs = parsed;
  } else {
    const cookieStartDelay = parseValidStartDelay(cookies.get(START_DELAY_COOKIE));
    if (cookieStartDelay !== undefined) {
      startDelayMs = cookieStartDelay;
    }
  }

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
        response.writeHead(statusCode, upstreamRes.headers);
        upstreamRes.pipe(response);
        return;
      }

      const chunks: Buffer[] = [];
      upstreamRes.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      upstreamRes.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8');
        const scriptTag = buildInjectedScript(
          scenario,
          speed,
          runtimeVersion,
          pdfFixtureBase64,
          hasScenarioQuery,
          startDelayMs,
        );
        const modifiedHtml = injectIntoHtml(html, scriptTag);

        const outHeaders: OutgoingHttpHeaders = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          const lower = key.toLowerCase();
          if (lower === 'content-security-policy') continue;
          // The body changes with the scenario: no validator, no stored copy,
          // and one fixed length instead of the upstream's framing.
          if (
            lower === 'etag'
            || lower === 'last-modified'
            || lower === 'cache-control'
            || lower === 'transfer-encoding'
          ) continue;
          if (value !== undefined) {
            outHeaders[key] = value;
          }
        }
        outHeaders['content-length'] = String(Buffer.byteLength(modifiedHtml, 'utf8'));
        outHeaders['cache-control'] = 'no-store';

        const setCookies: string[] = [];
        if (hasScenarioQuery) {
          setCookies.push(
            `${SCENARIO_COOKIE}=${encodeURIComponent(scenario)}; Path=/; SameSite=Lax`,
          );
        }
        if (hasSpeedQuery) {
          setCookies.push(`${SPEED_COOKIE}=${String(speed)}; Path=/; SameSite=Lax`);
        }
        if (hasStartDelayQuery && startDelayMs !== undefined) {
          setCookies.push(`${START_DELAY_COOKIE}=${String(startDelayMs)}; Path=/; SameSite=Lax`);
        }
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
        response.end(modifiedHtml);
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
});

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

server.listen(port, '127.0.0.1', () => {
  console.log(`Preview: http://localhost:${port}/__preview (upstream ${upstreamUrl.origin})`);
});
