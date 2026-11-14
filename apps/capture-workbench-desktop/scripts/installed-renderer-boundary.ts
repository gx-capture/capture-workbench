import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chromium, type Browser, type Page, type Request, type Response } from '@playwright/test';
import { isPackagedWorkbenchUrl } from './packaged-workbench-page.ts';
import { assertCaptureDocumentForFixture } from './installed-document-assertions.ts';

interface RendererBoundaryGlobal {
  __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
}

interface BoundaryAudit {
  readonly requests: string[];
  readonly responses: string[];
  readonly pending: Promise<void>[];
  readonly successfulPlugins: string[];
  readonly forbiddenSourceDocuments: Set<string>;
  readonly detach: () => void;
}

// Tauri serves IPC to the webview as requests to this host.
const IPC_HOST = 'ipc.localhost';
const UNREADABLE = '<unreadable>';
const audits = new WeakMap<Page, BoundaryAudit>();

function ipcCommand(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname === IPC_HOST ? decodeURIComponent(parsed.pathname.slice(1)) : null;
  } catch {
    return null;
  }
}

/**
 * Exercise denied IPC while the session recorder remains attached until
 * `finishRendererBoundary`. The page's `invoke` is read-only in
 * the webview, so the record is taken from the network, not by wrapping it.
 */
export async function beginRendererBoundary(page: Page): Promise<void> {
  if (!audits.has(page)) recordRendererBoundary(page);
  const refused = await page.evaluate(async () => {
    const internals = (globalThis as unknown as RendererBoundaryGlobal).__TAURI_INTERNALS__;
    const cases: [string, unknown][] = [
      ...['tauri://drag-enter', 'tauri://drag-drop'].map((event): [string, unknown] => ['plugin:event|listen', { event, target: { kind: 'Any' }, handler: 0 }]),
      ['plugin:dialog|open', { options: { multiple: true } }],
      // Core commands the default permission set would allow; the window is granted none.
      ['plugin:app|version', {}],
      ['plugin:window|title', { label: 'main' }],
      ['library_import_source', { request: {} }],
      ['library_import_selection', { request: { selectionToken: '0'.repeat(32) } }],
    ];
    const result: boolean[] = [];
    for (const [command, args] of cases) {
      try {
        await internals.invoke(command, args);
        result.push(false);
      } catch (error) {
        result.push(command !== 'library_import_source' || String(error).includes('Command library_import_source not found'));
      }
    }
    return result;
  });
  assert.ok(refused.length === 7 && refused.every(Boolean), 'Renderer boundary accepted a forbidden IPC request.');

}

/**
 * Tauri answers a refused or failed command with HTTP 200 too; the outcome is
 * in the `Tauri-Response` header. Without that header a 2xx counts as success.
 */
function ipcSucceeded(response: Response): boolean {
  const outcome = response.headers()['tauri-response'];
  return outcome === undefined ? response.ok() : outcome === 'ok';
}

export function recordRendererBoundary(page: Page): void {
  stopRecording(page);
  const requests: string[] = [];
  const responses: string[] = [];
  const pending: Promise<void>[] = [];
  const successfulPlugins: string[] = [];
  const forbiddenSourceDocuments = new Set<string>();
  const onRequest = (request: Request) => {
    const command = ipcCommand(request.url());
    if (command === null) return;
    requests.push(JSON.stringify({ command, body: request.postData() ?? '' }));
  };
  const onResponse = (response: Response) => {
    const command = ipcCommand(response.url());
    if (command === null) return;
    if (command.startsWith('plugin:') && ipcSucceeded(response)) successfulPlugins.push(command);
    pending.push(response.text().then(
      (text) => { responses.push(text); },
      // A body that cannot be read cannot be shown to be free of paths.
      () => { responses.push(UNREADABLE); },
    ));
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  audits.set(page, {
    requests,
    responses,
    pending,
    successfulPlugins,
    forbiddenSourceDocuments,
    detach: () => {
      page.off('request', onRequest);
      page.off('response', onResponse);
    },
  });
}

export async function finishRendererBoundary(page: Page, fixtureDirectory: string): Promise<string[]> {
  const audit = audits.get(page);
  assert.ok(audit, 'Renderer boundary audit was not started.');
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Renderer IPC audit did not settle.')), 15_000);
  });
  try {
    // The import's response may still be in flight when the card appears.
    let observed = -1;
    while (observed !== audit.pending.length) {
      observed = audit.pending.length;
      await Promise.race([Promise.all(audit.pending), deadline]);
    }
  } finally {
    clearTimeout(timeout);
    stopRecording(page);
  }
  assert.equal(
    audit.successfulPlugins.length,
    0,
    `Renderer successfully invoked a plugin command: ${[...new Set(audit.successfulPlugins)].sort().join(', ')}`,
  );
  assert.ok(!audit.requests.some((serialized) => {
    const request = JSON.parse(serialized);
    if (request.command !== 'library_source_bytes') return false;
    try { return audit.forbiddenSourceDocuments.has(JSON.parse(request.body).request?.documentId); } catch { return true; }
  }), 'Renderer loaded a large recording for playback.');
  assert.ok(!audit.responses.includes(UNREADABLE), 'Renderer boundary could not read an IPC response.');
  const forbidden = fixtureDirectory.toLowerCase().split('\\').join('/');
  const exposed = [...audit.requests, ...audit.responses].some((value) => {
    // Decode the JSON escaping before comparing separators, without persisting payloads.
    const normalized = value.toLowerCase().split('\\\\').join('/').split('\\').join('/');
    return normalized.includes(forbidden);
  });
  assert.ok(!exposed, 'Renderer boundary exposed the fixture directory over IPC.');
  const commands = new Set(audit.requests.map((value) => (JSON.parse(value) as { command: string }).command));
  assert.ok(commands.has('library_select_sources'), 'Renderer boundary did not observe the native picker.');
  assert.ok(commands.has('library_import_selection'), 'Renderer boundary did not observe token import.');
  return [...commands].sort();
}

function stopRecording(page: Page): void {
  audits.get(page)?.detach();
  audits.delete(page);
}

/** Stop recording on a picker/card failure too. */
export async function cancelRendererBoundary(page: Page): Promise<void> {
  stopRecording(page);
}

/** Keep identifiers transient; evidence contains command names only. */
export function forbidRecordingSourceBytes(page: Page, documentId: string): void {
  const audit = audits.get(page);
  assert.ok(audit, 'Renderer boundary audit was not started.');
  audit.forbiddenSourceDocuments.add(documentId);
}


/** Attach while WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER holds the first navigation.
 * Keep this CDP session for the entire exercise; Playwright may resume the target
 * while connecting, so attaching Page listeners after connect would lose startup.
 */
export async function startRendererBoundary(endpoint: string) {
  const targets = await (await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(2_000) })).json() as { type: string; webSocketDebuggerUrl?: string }[];
  const target = targets.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl);
  assert.ok(target?.webSocketDebuggerUrl, 'WebView startup debugger target is unavailable.');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      socket.close();
      reject(new Error('WebView startup debugger connection failed.'));
    };
    const timeout = setTimeout(() => {
      cleanup();
      socket.close();
      reject(new Error('WebView startup debugger connection timed out.'));
    }, 2_000);
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
  });
  let nextId = 0;
  const replies = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const events = new EventEmitter();
  // Adapter for the same request/response audit used by the behavior tests.
  const source = events as unknown as Page;
  recordRendererBoundary(source);
  const audit = audits.get(source);
  assert.ok(audit, 'Startup renderer audit was not created.');
  const requests = new Map<string, { url: string; status?: number; complete: () => void }>();
  function send(method: string, params = {}): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => {
        replies.delete(id);
        reject(new Error('WebView debugger command timed out.'));
      }, 5_000);
      replies.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  const onMessage = (event: MessageEvent) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const reply = replies.get(message.id);
      replies.delete(message.id);
      if (message.error) reply?.reject(new Error('WebView startup debugger command failed.'));
      else reply?.resolve(message.result ?? {});
      return;
    }
    const params = message.params;
    if (message.method === 'Network.requestWillBeSent' && params.request.method !== 'OPTIONS' && ipcCommand(params.request.url) !== null) {
      let complete: () => void = () => undefined;
      audit.pending.push(new Promise<void>((resolve) => { complete = resolve; }));
      requests.set(params.requestId, { url: params.request.url, complete });
      events.emit('request', { url: () => params.request.url, postData: () => params.request.postData ?? '' });
    }
    const request = requests.get(params?.requestId);
    if (!request) return;
    if (message.method === 'Network.responseReceived') {
      request.status = params.response.status;
      // Start waiting now, so finish cannot miss a response whose body is still loading.
      let resolveBody: (value: string) => void = () => undefined;
      let rejectBody: (error: Error) => void = () => undefined;
      const body = new Promise<string>((resolve, reject) => {
        resolveBody = resolve;
        rejectBody = reject;
      });
      const headers = Object.fromEntries(
        Object.entries((params.response.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value]),
      );
      events.emit('response', { url: () => request.url, ok: () => request.status >= 200 && request.status < 300, headers: () => headers, text: () => body });
      bodies.set(params.requestId, { resolve: resolveBody, reject: rejectBody });
    } else if (message.method === 'Network.loadingFinished') {
      const body = bodies.get(params.requestId);
      if (body) void send('Network.getResponseBody', { requestId: params.requestId }).then(
        (result) => body.resolve(result.base64Encoded ? Buffer.from(String(result.body), 'base64').toString('utf8') : String(result.body)),
        () => body.reject(new Error('IPC response unavailable.')),
      );
      request.complete();
      bodies.delete(params.requestId);
      requests.delete(params.requestId);
    } else if (message.method === 'Network.loadingFailed') {
      bodies.get(params.requestId)?.reject(new Error('IPC response unavailable.'));
      request.complete();
      bodies.delete(params.requestId);
      requests.delete(params.requestId);
    }
  };
  socket.addEventListener('message', onMessage);
  const bodies = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>();
  const detach = audit.detach;
  let finished = false;
  const settlePending = () => {
    for (const reply of replies.values()) reply.reject(new Error('WebView debugger closed.'));
    replies.clear();
    for (const body of bodies.values()) body.reject(new Error('IPC response unavailable.'));
    bodies.clear();
    for (const request of requests.values()) request.complete();
    requests.clear();
  };
  const detachSocket = () => {
    socket.removeEventListener('message', onMessage);
    socket.removeEventListener('close', onClose);
    detach();
  };
  const close = () => {
    if (finished) return;
    finished = true;
    detachSocket();
    settlePending();
    socket.close();
  };
  const onClose = () => {
    // A premature debugger loss must never produce successful evidence.
    if (!finished) audit.responses.push(UNREADABLE);
    finished = true;
    detachSocket();
    settlePending();
  };
  socket.addEventListener('close', onClose, { once: true });
  try {
    await send('Network.enable');
    // Playwright attaches only after the independent recorder is listening.
    return {
      adopt(page: Page) {
        audits.delete(source);
        audits.set(page, { ...audit, detach: close });
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

const browserRecorders = new WeakMap<Browser, () => void>();

export function closeBrowserRendererBoundary(browser: Browser | undefined): void {
  if (!browser) return;
  browserRecorders.get(browser)?.();
  browserRecorders.delete(browser);
}

export async function connectRendererBoundary(
  endpoint: string,
  auditRenderer: boolean,
  onRecorderAttached: (attached: boolean) => void,
): Promise<Browser> {
  const boundary = auditRenderer ? await startRendererBoundary(endpoint) : undefined;
  onRecorderAttached(Boolean(boundary));
  let browser: Browser | undefined;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 2_000 });
    if (boundary) {
      // The target is paused before its first script, so it may still be at
      // its initial URL and may not be listed yet. The window has one page.
      const pageDeadline = Date.now() + 5_000;
      let pages = browser.contexts().flatMap((context) => context.pages());
      while (pages.length === 0 && Date.now() < pageDeadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        pages = browser.contexts().flatMap((context) => context.pages());
      }
      const page = pages.find((candidate) => isPackagedWorkbenchUrl(candidate.url()))
        ?? (pages.length === 1 ? pages[0] : undefined);
      assert.ok(page, `Paused WebView did not expose a single application page (${pages.length} pages).`);
      boundary.adopt(page);
      browserRecorders.set(browser, boundary.close);
      browser.once('disconnected', boundary.close);
      const session = await page.context().newCDPSession(page);
      await session.send('Runtime.runIfWaitingForDebugger');
      await session.detach();
    }
    return browser;
  } catch (error) {
    boundary?.close();
    await browser?.close().catch(() => undefined);
    throw error;
  }
}

export async function assertInstalledCapture(page: Page, documentId: string, fixture, text: unknown): Promise<void> {
  const detail = await page.evaluate((id) => {
    return (globalThis as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<{ result: unknown }> } }).__TAURI_INTERNALS__.invoke('library_get', { request: { documentId: id } });
  }, documentId);
  assertCaptureDocumentForFixture(detail.result, fixture);
  assert.equal(String(text ?? '').trim(), String((detail.result as { targetText: string }).targetText).trim());
  if (fixture.bytes) {
    await page.getByTestId('large-recording-playback-note').waitFor({ state: 'visible', timeout: 5_000 });
    assert.ok((await page.getByTestId('large-recording-playback-note').textContent())?.trim());
  }
  assert.ok(String(text ?? '').trim(), 'Installed result preview was empty.');
}
