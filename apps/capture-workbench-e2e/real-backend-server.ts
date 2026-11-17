// Reverse-proxies the Workbench dev server (`capture-workbench:serve`),
// owns a headless `capture-workbench-dev-host` child process for one run, and
// injects a Tauri IPC bridge that forwards host commands over same-origin HTTP.
//
// Use: node apps/capture-workbench-e2e/real-backend-server.ts <port> [upstream]
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  attachWebSocketUpgradeProxy,
  escapeHtml,
  injectIntoHtml,
  parseServerArgs,
  proxyUpstreamRequest,
} from './preview-proxy.ts';

const MAX_HOST_BODY_BYTES = 1024 * 1024;
const DEV_HOST_STARTUP_TIMEOUT_MS = 15_000;
const DEV_HOST_SHUTDOWN_TIMEOUT_MS = 3_000;
const CUSTOM_PREVIEW_HEADER = 'x-capture-preview';

const workspaceRoot = resolve(import.meta.dirname, '..', '..');

function resolvePaths(): {
  readonly devHostExecutable: string;
  readonly stagedExecutable: string;
  readonly stagedManifest: string;
} {
  const desktopRoot = join(workspaceRoot, 'apps', 'capture-workbench-desktop');
  const stagedRoot = join(
    desktopRoot,
    'src-tauri',
    'target',
    'deterministic-qa',
    'staged',
  );
  const stagedExecutable = join(
    stagedRoot,
    'binaries',
    'capture-runtime-x86_64-pc-windows-msvc.exe',
  );
  const stagedManifest = join(
    stagedRoot,
    'resources',
    'capture-runtime-manifest.json',
  );
  const missingStaged = [stagedExecutable, stagedManifest].filter(
    (path) => !existsSync(path),
  );
  if (missingStaged.length > 0) {
    throw new Error(
      `Missing staged deterministic runtime (${missingStaged.join(', ')}). Run: pnpm nx run capture-workbench-desktop:stage-deterministic-runtime`,
    );
  }

  const cargoTargetEnv = process.env['CARGO_TARGET_DIR']?.trim();
  const cargoTargetDir = cargoTargetEnv
    ? isAbsolute(cargoTargetEnv)
      ? cargoTargetEnv
      : resolve(process.cwd(), cargoTargetEnv)
    : join(desktopRoot, 'src-tauri', 'target');
  const devHostBinary =
    process.platform === 'win32'
      ? 'capture-workbench-dev-host.exe'
      : 'capture-workbench-dev-host';
  const devHostExecutable = join(cargoTargetDir, 'debug', devHostBinary);
  if (!existsSync(devHostExecutable)) {
    throw new Error(
      `Missing dev host executable (${devHostExecutable}). Run: pnpm nx run capture-workbench-desktop:build-dev-host`,
    );
  }

  return { devHostExecutable, stagedExecutable, stagedManifest };
}

function redactToken(text: string, token: string): string {
  return text
    .replaceAll(token, '[redacted]')
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]');
}

function startDevHost(
  paths: {
    readonly devHostExecutable: string;
    readonly stagedExecutable: string;
    readonly stagedManifest: string;
  },
  appDataDir: string,
  token: string,
  onSpawned: (child: ChildProcess) => void,
): Promise<{ readonly child: ChildProcess; readonly port: number }> {
  return new Promise((resolveReady, rejectReady) => {
    // Not detached: on Windows Node keeps its children in a job that ends
    // them when this process ends, also when it is killed.
    const child = spawn(
      paths.devHostExecutable,
      [
        '--port',
        '0',
        '--app-data',
        appDataDir,
        '--runtime-manifest',
        paths.stagedManifest,
        '--runtime-executable',
        paths.stagedExecutable,
      ],
      {
        cwd: workspaceRoot,
        env: { ...process.env, CAPTURE_DEV_HOST_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    onSpawned(child);

    let settled = false;
    let stdoutBuffer = '';
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;

    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessTree(child);
      rejectReady(error);
    };

    const timer = setTimeout(() => {
      const detail = redactToken(
        Buffer.concat(stderrChunks).toString('utf8').trim(),
        token,
      );
      finishError(
        new Error(
          `Timed out waiting for capture-workbench-dev-host port line.${detail ? ` stderr: ${detail}` : ''}`,
        ),
      );
    }, DEV_HOST_STARTUP_TIMEOUT_MS);
    timer.unref();

    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled || stderrBytes >= 8192) return;
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBuffer += chunk.toString('utf8');
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) {
        if (stdoutBuffer.length > 16 * 1024) {
          finishError(
            new Error('capture-workbench-dev-host stdout line exceeded 16 KiB.'),
          );
        }
        return;
      }
      const firstLine = stdoutBuffer.slice(0, newline).trim();
      let parsed: { readonly port?: unknown };
      try {
        parsed = JSON.parse(firstLine) as { readonly port?: unknown };
      } catch {
        finishError(
          new Error(
            `capture-workbench-dev-host printed invalid port JSON: ${redactToken(firstLine, token)}`,
          ),
        );
        return;
      }
      if (
        typeof parsed.port !== 'number'
        || !Number.isInteger(parsed.port)
        || parsed.port < 1
        || parsed.port > 65535
      ) {
        finishError(
          new Error('capture-workbench-dev-host printed an invalid port.'),
        );
        return;
      }
      settled = true;
      clearTimeout(timer);
      stdoutBuffer = '';
      stderrChunks.length = 0;
      resolveReady({ child, port: parsed.port });
    });

    child.once('error', (error) => {
      finishError(
        new Error(
          `Failed to start capture-workbench-dev-host: ${redactToken(error.message, token)}`,
        ),
      );
    });

    child.once('exit', (code, signal) => {
      if (settled) return;
      const detail = redactToken(
        Buffer.concat(stderrChunks).toString('utf8').trim(),
        token,
      );
      finishError(
        new Error(
          `capture-workbench-dev-host exited before reporting its port (code=${String(code)}, signal=${String(signal)}).${detail ? ` stderr: ${detail}` : ''}`,
        ),
      );
    });
  });
}

function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function killProcessTree(child: ChildProcess): void {
  if (!isChildRunning(child)) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5_000,
    });
  }
  if (isChildRunning(child)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Child already exited.
    }
  }
}

function postDevHostShutdown(port: number, token: string): Promise<void> {
  return new Promise((resolveDone) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: '/__dev/shutdown',
        headers: {
          host: `127.0.0.1:${port}`,
          authorization: `Bearer ${token}`,
          'content-length': '0',
          connection: 'close',
        },
      },
      (res) => {
        res.resume();
        res.once('end', resolveDone);
        res.once('error', resolveDone);
      },
    );
    req.setTimeout(2_000, () => {
      req.destroy();
      resolveDone();
    });
    req.once('error', resolveDone);
    req.end();
  });
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!isChildRunning(child)) return Promise.resolve();
  return new Promise((resolveDone) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolveDone();
    }, timeoutMs);
    timer.unref();
    const onExit = (): void => {
      clearTimeout(timer);
      resolveDone();
    };
    child.once('exit', onExit);
  });
}

function removeAppDataDir(appDataDir: string): void {
  try {
    rmSync(appDataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  } catch {
    // Best-effort cleanup on exit.
  }
}

/**
 * Installs the browser-side Tauri IPC bridge for real-backend mode.
 *
 * This function MUST remain completely self-contained: it is serialised with
 * `Function.prototype.toString()` and evaluated inside the browser page.
 */
function installRealBackendBridge(): void {
  interface RealBackendGlobal {
    isTauri: boolean;
    __TAURI_INTERNALS__: {
      invoke: (command: string, args?: unknown) => Promise<unknown>;
      metadata: {
        currentWindow: { label: string };
        currentWebview: { label: string };
      };
      transformCallback: (callback?: (eventData: unknown) => void) => number;
      unregisterCallback: (id: number) => void;
      convertFileSrc: (filePath: string, protocol?: string) => string;
    };
  }
  const target = globalThis as unknown as RealBackendGlobal;
  let nextCallbackId = 1;
  const callbacks = new Map<number, (eventData: unknown) => void>();

  target.isTauri = true;
  target.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main' },
    },
    transformCallback: (callback?: (eventData: unknown) => void): number => {
      const id = nextCallbackId++;
      if (typeof callback === 'function') {
        callbacks.set(id, callback);
      }
      return id;
    },
    unregisterCallback: (id: number): void => {
      callbacks.delete(id);
    },
    convertFileSrc: (filePath: string, protocol = 'asset'): string =>
      `${protocol}://localhost/${encodeURIComponent(filePath)}`,
    invoke: (command: string, rawArgs?: unknown): Promise<unknown> => {
      const body = JSON.stringify(rawArgs === undefined ? {} : rawArgs);
      return fetch(`/__host/invoke/${encodeURIComponent(command)}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-capture-preview': '1',
        },
        body,
      }).then((response) => {
        const contentType = (
          response.headers.get('content-type') ?? ''
        ).toLowerCase();
        if (response.ok) {
          if (contentType.startsWith('application/octet-stream')) {
            return response.arrayBuffer();
          }
          return response
            .text()
            .then((text) => (text.length > 0 ? JSON.parse(text) : null));
        }
        if (response.status === 404) {
          return Promise.reject(
            `Command ${command} is not served by the dev host.`,
          );
        }
        return response.text().then((text) => {
          let message =
            text || `Host command ${command} failed with HTTP ${response.status}.`;
          if (contentType.includes('application/json') && text.length > 0) {
            try {
              const parsed = JSON.parse(text) as { readonly error?: unknown };
              if (typeof parsed.error === 'string' && parsed.error.length > 0) {
                message = parsed.error;
              }
            } catch {
              // Keep raw error text when JSON parsing fails.
            }
          }
          return Promise.reject(message);
        });
      });
    },
  };
}

function buildBridgeScriptTag(): string {
  const fnSource = installRealBackendBridge.toString();
  if (/<\/script|<!--/iu.test(fnSource)) {
    throw new Error(
      'installRealBackendBridge source must not contain </script or <!--.',
    );
  }
  return `<script>(${fnSource})();</script>`;
}

function renderRealBackendStatusHtml(devHostPort: number): string {
  return `<!doctype html>
<html lang="zh-Hant-TW">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Capture Workbench 真實後端預覽</title>
    <style>
      body {
        font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
        max-width: 640px;
        margin: 48px auto;
        padding: 0 20px;
        line-height: 1.6;
        color: #18181b;
        background: #fafafa;
      }
      .card {
        background: #ffffff;
        border: 1px solid #e4e4e7;
        border-radius: 10px;
        padding: 20px 22px;
      }
      code {
        font-size: 0.9rem;
        color: #18181b;
        background: #f4f4f5;
        padding: 2px 6px;
        border-radius: 4px;
      }
      a {
        display: inline-block;
        margin-top: 12px;
        color: #09090b;
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Capture Workbench 真實後端模式</h1>
      <p>目前預覽伺服器已連線至本機 Dev Host（連接埠 <code>${escapeHtml(String(devHostPort))}</code>），情境 Cookie 已忽略。</p>
      <a href="/">前往 Capture Workbench</a>
    </div>
  </body>
</html>
`;
}

function headerValues(rawHeaders: readonly string[], name: string): string[] {
  const target = name.toLowerCase();
  const values: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const headerName = rawHeaders[i];
    const headerValue = rawHeaders[i + 1];
    if (headerName !== undefined && headerValue !== undefined) {
      if (headerName.toLowerCase() === target) {
        values.push(headerValue);
      }
    }
  }
  return values;
}

function sendPlainRejection(
  response: ServerResponse,
  status: 400 | 403,
  body: 'Bad Request\n' | 'Forbidden\n',
): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body, 'utf8')),
  });
  response.end(body);
}

function resolveDevHostTarget(
  request: IncomingMessage,
  requestUrl: URL,
  launcherPort: number,
): { readonly ok: true; readonly path: string; readonly declaredLength?: number }
  | { readonly ok: false; readonly status: 400 | 403 } {
  const allowedHosts = new Set([
    `127.0.0.1:${launcherPort}`,
    `localhost:${launcherPort}`,
  ]);
  const allowedOrigins = new Set([
    `http://127.0.0.1:${launcherPort}`,
    `http://localhost:${launcherPort}`,
  ]);

  const hosts = headerValues(request.rawHeaders, 'host');
  if (hosts.length !== 1 || !allowedHosts.has(hosts[0].toLowerCase())) {
    return { ok: false, status: 403 };
  }

  const origins = headerValues(request.rawHeaders, 'origin');
  if (
    origins.length > 1
    || (origins.length === 1 && !allowedOrigins.has(origins[0].toLowerCase()))
  ) {
    return { ok: false, status: 403 };
  }

  const secFetchSites = headerValues(request.rawHeaders, 'sec-fetch-site');
  if (
    secFetchSites.length > 1
    || (secFetchSites.length === 1
      && secFetchSites[0].toLowerCase() !== 'same-origin'
      && secFetchSites[0].toLowerCase() !== 'none')
  ) {
    return { ok: false, status: 403 };
  }

  if (request.method !== 'POST') {
    return { ok: false, status: 403 };
  }

  const previewHeaders = headerValues(request.rawHeaders, CUSTOM_PREVIEW_HEADER);
  if (previewHeaders.length !== 1 || previewHeaders[0] !== '1') {
    return { ok: false, status: 403 };
  }

  const rawUrl = request.url ?? '';
  if (requestUrl.search !== '' || rawUrl.includes('..') || rawUrl.includes('//')) {
    return { ok: false, status: 403 };
  }

  let targetPath: string;
  if (requestUrl.pathname === '/__host/selection') {
    targetPath = '/__dev/selection';
  } else if (requestUrl.pathname.startsWith('/__host/invoke/')) {
    const command = requestUrl.pathname.slice('/__host/invoke/'.length);
    if (!/^[a-z0-9_]+$/u.test(command)) {
      return { ok: false, status: 403 };
    }
    targetPath = `/invoke/${command}`;
  } else {
    return { ok: false, status: 403 };
  }

  const contentTypes = headerValues(request.rawHeaders, 'content-type');
  if (contentTypes.length !== 1) {
    return { ok: false, status: 400 };
  }
  const mediaType = contentTypes[0].split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return { ok: false, status: 400 };
  }

  const contentLengths = headerValues(request.rawHeaders, 'content-length');
  if (contentLengths.length > 1) {
    return { ok: false, status: 400 };
  }
  let declaredLength: number | undefined;
  if (contentLengths.length === 1) {
    if (!/^\d+$/u.test(contentLengths[0])) {
      return { ok: false, status: 400 };
    }
    declaredLength = Number(contentLengths[0]);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_HOST_BODY_BYTES) {
      return { ok: false, status: 400 };
    }
  }

  return { ok: true, path: targetPath, declaredLength };
}

function handleHostProxy(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  launcherPort: number,
  devHostPort: number,
  token: string,
): void {
  const checked = resolveDevHostTarget(request, requestUrl, launcherPort);
  if (!checked.ok) {
    sendPlainRejection(
      response,
      checked.status,
      checked.status === 403 ? 'Forbidden\n' : 'Bad Request\n',
    );
    return;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let settled = false;

  request.once('error', () => {
    settled = true;
  });

  request.on('data', (chunk: Buffer) => {
    if (settled) return;
    totalBytes += chunk.length;
    if (totalBytes > MAX_HOST_BODY_BYTES) {
      settled = true;
      sendPlainRejection(response, 400, 'Bad Request\n');
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });

  request.on('end', () => {
    if (settled) return;
    settled = true;
    const body = Buffer.concat(chunks);
    if (
      checked.declaredLength !== undefined
      && body.length !== checked.declaredLength
    ) {
      sendPlainRejection(response, 400, 'Bad Request\n');
      return;
    }

    const upstreamReq = httpRequest(
      {
        hostname: '127.0.0.1',
        port: devHostPort,
        method: 'POST',
        path: checked.path,
        headers: {
          host: `127.0.0.1:${devHostPort}`,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': String(body.length),
          connection: 'close',
        },
      },
      (devRes) => {
        const outHeaders: OutgoingHttpHeaders = {};
        const contentType = devRes.headers['content-type'];
        if (typeof contentType === 'string') {
          outHeaders['content-type'] = contentType;
        }
        const contentLength = devRes.headers['content-length'];
        if (typeof contentLength === 'string') {
          outHeaders['content-length'] = contentLength;
        }
        response.writeHead(devRes.statusCode ?? 502, outHeaders);
        devRes.pipe(response);
      },
    );

    upstreamReq.on('error', () => {
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Dev host request failed.\n');
      } else if (!response.destroyed) {
        response.destroy();
      }
    });

    upstreamReq.end(body);
  });
}

async function main(): Promise<void> {
  const { port, upstreamUrl } = parseServerArgs(
    process.argv,
    'Use: real-backend-server.ts <port> [upstream]',
  );
  const paths = resolvePaths();
  const appDataDir = mkdtempSync(join(tmpdir(), 'capture-dev-host-'));
  const token = randomBytes(32).toString('hex');
  const bridgeScriptTag = buildBridgeScriptTag();

  let devHostChild: ChildProcess | undefined;
  let devHostPort = 0;
  let shutdownPromise: Promise<void> | undefined;

  const cleanupSync = (): void => {
    if (devHostChild) {
      killProcessTree(devHostChild);
    }
    removeAppDataDir(appDataDir);
  };

  process.once('exit', cleanupSync);

  // The dev host takes several seconds to report its port. A signal in that
  // time stops it too: the child is known from the moment it is spawned.
  const startupSignals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const;
  const stopDuringStartup = (): void => {
    cleanupSync();
    process.exit(1);
  };
  for (const signal of startupSignals) {
    process.on(signal, stopDuringStartup);
  }

  try {
    const started = await startDevHost(paths, appDataDir, token, (child) => {
      devHostChild = child;
    });
    devHostChild = started.child;
    devHostPort = started.port;
  } catch (error) {
    cleanupSync();
    throw error;
  } finally {
    for (const signal of startupSignals) {
      process.off(signal, stopDuringStartup);
    }
  }

  const statusHtml = renderRealBackendStatusHtml(devHostPort);

  const server = createServer((request, response) => {
    request.on('error', () => {
      if (!response.destroyed) response.destroy();
    });
    response.on('error', () => {
      if (!request.destroyed) request.destroy();
    });

    const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);

    if (
      requestUrl.pathname === '/__host'
      || requestUrl.pathname.startsWith('/__host/')
    ) {
      handleHostProxy(request, response, requestUrl, port, devHostPort, token);
      return;
    }

    if (
      requestUrl.pathname === '/__preview'
      && (request.method === 'GET' || request.method === 'HEAD')
    ) {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(Buffer.byteLength(statusHtml, 'utf8')),
        'cache-control': 'no-store',
      });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      response.end(statusHtml);
      return;
    }

    proxyUpstreamRequest(request, response, upstreamUrl, requestUrl, (html) => ({
      html: injectIntoHtml(html, bridgeScriptTag),
    }));
  });

  attachWebSocketUpgradeProxy(server, upstreamUrl);

  const shutdown = (exitCode?: number): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        if (server.listening) {
          await new Promise<void>((resolveClosed) => {
            server.close(() => resolveClosed());
            server.closeAllConnections();
          });
        }
        if (devHostChild && isChildRunning(devHostChild)) {
          await postDevHostShutdown(devHostPort, token);
          await waitForChildExit(devHostChild, DEV_HOST_SHUTDOWN_TIMEOUT_MS);
          if (isChildRunning(devHostChild)) {
            killProcessTree(devHostChild);
            await waitForChildExit(devHostChild, 2_000);
          }
        }
        removeAppDataDir(appDataDir);
        if (exitCode !== undefined) {
          process.exit(exitCode);
        }
      })();
    }
    return shutdownPromise;
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.on(signal, () => {
      void shutdown(0);
    });
  }

  server.once('close', () => {
    void shutdown();
  });

  devHostChild.once('exit', () => {
    if (!shutdownPromise) {
      void shutdown(1);
    }
  });

  process.once('uncaughtException', () => {
    void shutdown(1);
  });

  process.once('unhandledRejection', () => {
    void shutdown(1);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(
      `Real-backend preview: http://127.0.0.1:${port}/__preview (upstream ${upstreamUrl.origin}, dev-host 127.0.0.1:${devHostPort})`,
    );
  });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
