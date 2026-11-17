// Reverse-proxies the Workbench dev server (`capture-workbench:serve`) and
// injects the simulated Tauri desktop bridge (`installFakeDesktop`) into HTML
// responses so developers can calibrate screens and inspect scenarios in any
// browser at http://localhost:4300 without running the Desktop App.
//
// Use: node apps/capture-workbench-e2e/preview-server.ts <port> [upstream]
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import {
  attachWebSocketUpgradeProxy,
  escapeHtml,
  injectIntoHtml,
  parseServerArgs,
  proxyUpstreamRequest,
} from './preview-proxy.ts';
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

const { port, upstreamUrl } = parseServerArgs(
  process.argv,
  'Use: preview-server.ts <port> [upstream]',
);
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

  proxyUpstreamRequest(request, response, upstreamUrl, requestUrl, (html) => {
    const scriptTag = buildInjectedScript(
      scenario,
      speed,
      runtimeVersion,
      pdfFixtureBase64,
      hasScenarioQuery,
      startDelayMs,
    );
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
    return {
      html: injectIntoHtml(html, scriptTag),
      ...(setCookies.length > 0 ? { setCookies } : {}),
    };
  });
});

attachWebSocketUpgradeProxy(server, upstreamUrl);

server.listen(port, '127.0.0.1', () => {
  console.log(`Preview: http://localhost:${port}/__preview (upstream ${upstreamUrl.origin})`);
});
