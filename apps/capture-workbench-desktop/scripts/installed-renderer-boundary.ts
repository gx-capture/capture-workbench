import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chromium, type Browser, type CDPSession, type Page, type Request, type Response } from '@playwright/test';
import { isPackagedWorkbenchUrl } from './packaged-workbench-page.ts';
import {
  assertRawCaptureForFixture,
  assertVisibleOcrPageText,
  expectedVisibleResultForRaw,
  type InstalledCaptureFixtureExpectation,
} from './installed-document-assertions.ts';

interface RendererBoundaryGlobal {
  __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
}

interface BoundaryAudit {
  readonly requests: string[];
  readonly responses: string[];
  readonly pending: Promise<void>[];
  readonly successfulPlugins: string[];
  readonly forbiddenSourceDocuments: Set<string>;
  /**
   * Why the record stopped covering the page, or null while it does. Shared
   * by every copy of the audit, so adoption by a page keeps it.
   */
  readonly coverage: { interrupted: string | null };
  readonly detach: () => void;
}

// Tauri serves IPC to the webview as requests to this host.
const IPC_HOST = 'ipc.localhost';
const UNREADABLE = '<unreadable>';
const audits = new WeakMap<Page, BoundaryAudit>();

/** The Tauri command an IPC request from the page names, or null for any other request. */
export function ipcCommand(url: string): string | null {
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
    coverage: { interrupted: null },
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

/**
 * The IPC requests recorded for the page so far, in the order the page sent
 * them. For a page connected while WebView2 waited for the script debugger,
 * the record starts before the page's first script. Fails unless the record
 * covers the page up to now: a recorder that was closed or lost its
 * debugger, or could not read a response, may have missed a request.
 */
export function recordedIpcRequests(page: Page): { command: string; body: string }[] {
  const audit = audits.get(page);
  assert.ok(audit, 'Renderer boundary audit was not started.');
  assert.equal(audit.coverage.interrupted, null, `The IPC record does not cover the page up to now: ${audit.coverage.interrupted}`);
  assert.ok(!audit.responses.includes(UNREADABLE), 'The IPC record does not cover the page up to now: an IPC response could not be read.');
  return audit.requests.map((serialized) => JSON.parse(serialized) as { command: string; body: string });
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
    audit.coverage.interrupted ??= 'the startup recorder was closed.';
    detachSocket();
    settlePending();
    socket.close();
  };
  const onClose = () => {
    // A premature debugger loss must never produce successful evidence.
    if (!finished) {
      audit.responses.push(UNREADABLE);
      audit.coverage.interrupted ??= 'the startup recorder lost its debugger connection.';
    }
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

/**
 * How long the whole attach and resume may take, from the debugger target
 * list to the resumed page. Its steps with their own bounds take at most
 * about 16 s together; the rest (the debugger session, its resume and detach)
 * had none, so a WebView that stopped answering held the start for ever.
 */
const ATTACH_DEADLINE_MS = 30_000;

/** One deadline over a sequence of steps; the error names the step it stopped at. */
function attachDeadline(deadlineMs: number) {
  let step = 'the start';
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error(`WebView attach did not finish within ${deadlineMs} ms: it stopped at ${step}.`));
    }, deadlineMs);
  });
  // Between steps nothing waits on the expiry; the next step sees it.
  expiry.catch(() => undefined);
  return {
    /** The step's result, unless the deadline passes first; what it yields after that is undone. */
    within<T>(name: string, operation: Promise<T>, undoLate?: (late: T) => unknown): Promise<T> {
      step = name;
      if (undoLate) void operation.then((late) => { if (expired) undoLate(late); }, () => undefined);
      return Promise.race([operation, expiry]);
    },
    clear: () => clearTimeout(timer),
  };
}

export async function connectRendererBoundary(
  endpoint: string,
  auditRenderer: boolean,
  onRecorderAttached: (attached: boolean) => void,
  deadlineMs = ATTACH_DEADLINE_MS,
): Promise<Browser> {
  const deadline = attachDeadline(deadlineMs);
  let boundary: Awaited<ReturnType<typeof startRendererBoundary>> | undefined;
  let browser: Browser | undefined;
  let session: CDPSession | undefined;
  try {
    boundary = auditRenderer
      ? await deadline.within('the startup debugger connection', startRendererBoundary(endpoint), (late) => late.close())
      : undefined;
    onRecorderAttached(Boolean(boundary));
    browser = await deadline.within(
      'the Playwright connection',
      chromium.connectOverCDP(endpoint, { timeout: 2_000 }),
      (late) => late.close().catch(() => undefined),
    );
    if (boundary) {
      // The target is paused before its first script, so it may still be at
      // its initial URL and may not be listed yet. The window has one page.
      const pageDeadline = Date.now() + 5_000;
      let pages = browser.contexts().flatMap((context) => context.pages());
      while (pages.length === 0 && Date.now() < pageDeadline) {
        await deadline.within('the application page', new Promise((resolvePromise) => setTimeout(resolvePromise, 50)));
        pages = browser.contexts().flatMap((context) => context.pages());
      }
      const page = pages.find((candidate) => isPackagedWorkbenchUrl(candidate.url()))
        ?? (pages.length === 1 ? pages[0] : undefined);
      assert.ok(page, `Paused WebView did not expose a single application page (${pages.length} pages).`);
      boundary.adopt(page);
      browserRecorders.set(browser, boundary.close);
      browser.once('disconnected', boundary.close);
      session = await deadline.within(
        'the debugger session',
        page.context().newCDPSession(page),
        (late) => late.detach().catch(() => undefined),
      );
      await deadline.within('the debugger resume (Runtime.runIfWaitingForDebugger)', session.send('Runtime.runIfWaitingForDebugger'));
      // Cleared before the wait, so a detach that times out is not sent a second time.
      const detaching = session;
      session = undefined;
      await deadline.within('the debugger session detach', detaching.detach());
    }
    return browser;
  } catch (error) {
    boundary?.close();
    void session?.detach().catch(() => undefined);
    if (browser) {
      // Closing must not hang either: a connection that stopped answering is dropped.
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        browser.close().catch(() => undefined),
        new Promise((resolvePromise) => { closeTimer = setTimeout(resolvePromise, 5_000); }),
      ]);
      clearTimeout(closeTimer);
    }
    throw error;
  } finally {
    deadline.clear();
  }
}

export async function assertInstalledCapture(
  page: Page,
  documentId: string,
  fixture: InstalledCaptureFixtureExpectation,
  visibleResult: unknown,
): Promise<void> {
  const detail = await page.evaluate((id) => {
    return (globalThis as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args: unknown) => Promise<{ raw: unknown }>;
      };
    }).__TAURI_INTERNALS__.invoke('library_get', { request: { documentId: id } });
  }, documentId);
  assertRawCaptureForFixture(detail.raw, fixture);
  const expected = expectedVisibleResultForRaw(detail.raw, fixture);
  if (expected.kind === 'page') {
    assertVisibleOcrPageText(visibleResult, expected.text);
  } else {
    const visibleLines = Array.isArray(visibleResult)
      ? visibleResult.map((line) => String(line ?? '').trim())
      : typeof visibleResult === 'string' && visibleResult.trim().length > 0
        ? visibleResult.trim().split(/\r?\n/u).map((line) => line.trim())
        : [];
    assert.ok(
      visibleLines.length > 0 && visibleLines.every((line) => line.length > 0),
      'Installed result preview was empty.',
    );
    assert.deepEqual(visibleLines, expected.lines);
  }
  if (fixture.bytes) {
    const playbackNote = page.getByTestId('result-playback-unavailable');
    await playbackNote.waitFor({ state: 'visible', timeout: 5_000 });
    assert.ok((await playbackNote.textContent())?.trim());
  }
}
