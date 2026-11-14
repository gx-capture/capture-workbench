import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { chromium, type Browser, type Page } from '@playwright/test';
import { beginRendererBoundary, finishRendererBoundary, cancelRendererBoundary, recordRendererBoundary, forbidRecordingSourceBytes, startRendererBoundary, connectRendererBoundary, closeBrowserRendererBoundary } from './installed-renderer-boundary.ts';

test('renderer boundary probes denied commands and audits the picker and the import from the network', async () => {
  const fixture = configure();
  try {
    await beginRendererBoundary(fixture.page);
    assert.deepEqual(fixture.calls.map((item) => item.command), [
      'plugin:event|listen', 'plugin:event|listen', 'plugin:dialog|open',
      'plugin:app|version', 'plugin:window|title',
      'library_import_source', 'library_import_selection',
    ]);
    assert.deepEqual(fixture.calls.slice(0, 2).map((item) => item.args.event), ['tauri://drag-enter', 'tauri://drag-drop']);
    fixture.ipc('library_select_sources', { request: { kind: 'all' } }, { selections: [{ selectionToken: 'a'.repeat(32), fileName: 'chosen.pdf' }], rejected: [] });
    fixture.ipc('library_import_selection', { request: { selectionToken: 'a'.repeat(32) } }, { documentId: 'b'.repeat(32) });
    await finishRendererBoundary(fixture.page, 'C:\\private-fixtures');
    assert.equal(fixture.listeners(), 0);
  } finally { fixture.restore(); }
});

test('the audit does not depend on replacing the page invoke function, which the webview keeps read-only', async () => {
  const fixture = configure();
  try {
    Object.defineProperty(fixture.target.__TAURI_INTERNALS__, 'invoke', { value: fixture.original, writable: false, configurable: false });
    await beginRendererBoundary(fixture.page);
    assert.equal(fixture.target.__TAURI_INTERNALS__.invoke, fixture.original);
    fixture.ipc('library_select_sources', {}, { selections: [], rejected: [] });
    fixture.ipc('library_import_selection', {}, {});
    await finishRendererBoundary(fixture.page, 'C:\\private-fixtures');
  } finally { fixture.restore(); }
});

test('a registered legacy command rejecting a malformed input does not pass', async () => {
  const fixture = configure((command) => command === 'library_import_source' ? Promise.reject('invalid args') : undefined);
  try { await assert.rejects(beginRendererBoundary(fixture.page), /accepted a forbidden IPC/u); }
  finally { fixture.restore(); }
});

test('any accepted forbidden request fails the boundary', async () => {
  const fixture = configure((command) => command === 'plugin:event|listen' ? Promise.resolve(1) : undefined);
  try { await assert.rejects(beginRendererBoundary(fixture.page), /accepted a forbidden IPC/u); }
  finally { fixture.restore(); }
});

test('request and response directory leaks fail without including the directory in the error', async () => {
  for (const direction of ['request', 'response']) {
    const fixture = configure();
    try {
      await beginRendererBoundary(fixture.page);
      fixture.ipc(
        'library_select_sources',
        direction === 'request' ? { leaked: 'c:/private-fixtures/chosen.pdf' } : {},
        direction === 'response' ? { leaked: 'C:\\Private-Fixtures\\chosen.pdf' } : { selections: [], rejected: [] },
      );
      fixture.ipc('library_import_selection', { request: { selectionToken: 'a'.repeat(32) } }, {});
      await assert.rejects(finishRendererBoundary(fixture.page, 'C:\\private-fixtures'), (error: Error) => {
        assert.ok(error.message.includes('exposed the fixture directory'));
        assert.ok(!error.message.includes('Private-Fixtures'));
        return true;
      });
      assert.equal(fixture.listeners(), 0);
    } finally { fixture.restore(); }
  }
});

test('requests to other hosts are not IPC, and an unreadable IPC response fails', async () => {
  const fixture = configure();
  try {
    await beginRendererBoundary(fixture.page);
    fixture.emitRequest('http://tauri.localhost/assets/C:/private-fixtures/app.js', '');
    fixture.ipc('library_select_sources', {}, { selections: [], rejected: [] });
    fixture.ipc('library_import_selection', {}, {});
    await finishRendererBoundary(fixture.page, 'C:\\private-fixtures');

    await beginRendererBoundary(fixture.page);
    fixture.ipc('library_select_sources', {}, { selections: [], rejected: [] });
    fixture.ipc('library_import_selection', {}, new Error('body gone'));
    await assert.rejects(finishRendererBoundary(fixture.page, 'C:\\private-fixtures'), /could not read an IPC response/u);
  } finally { fixture.restore(); }
});

test('an audit without a picker and an import fails, and cancellation always stops recording', async () => {
  const fixture = configure();
  try {
    await beginRendererBoundary(fixture.page);
    await assert.rejects(finishRendererBoundary(fixture.page, 'C:\\private-fixtures'), /did not observe the native picker/u);
    assert.equal(fixture.listeners(), 0);
    await beginRendererBoundary(fixture.page);
    fixture.ipc('library_select_sources', {}, { selections: [], rejected: [] });
    await assert.rejects(finishRendererBoundary(fixture.page, 'C:\\private-fixtures'), /did not observe token import/u);
    await beginRendererBoundary(fixture.page);
    await cancelRendererBoundary(fixture.page);
    assert.equal(fixture.listeners(), 0);
    await assert.rejects(finishRendererBoundary(fixture.page, 'C:\\private-fixtures'), /audit was not started/u);
  } finally { fixture.restore(); }
});

function configure(override?: (command: string) => Promise<unknown> | undefined) {
  const target = globalThis as unknown as {
    __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
  };
  const previous = Object.getOwnPropertyDescriptor(target, '__TAURI_INTERNALS__');
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const original = async (command: string, args: unknown = {}) => {
    calls.push({ command, args: args as Record<string, unknown> });
    const overridden = override?.(command);
    if (overridden) return overridden;
    if (command === 'library_import_source') throw 'Command library_import_source not found';
    if (command.startsWith('plugin:')) throw 'not allowed';
    if (command === 'library_import_selection' && (args as { request?: { selectionToken?: string } }).request?.selectionToken === '0'.repeat(32)) throw 'Selected source is no longer available. Choose it again.';
    return { selections: [], rejected: [] };
  };
  Object.defineProperty(target, '__TAURI_INTERNALS__', { value: { invoke: original }, writable: true, configurable: true });
  const events = new EventEmitter();
  const page = {
    evaluate: async (operation: () => unknown) => operation(),
    on: (name: string, listener: (value: unknown) => void) => { events.on(name, listener); },
    off: (name: string, listener: (value: unknown) => void) => { events.off(name, listener); },
  } as unknown as Page;
  const emitRequest = (url: string, body: string) => {
    events.emit('request', { url: () => url, postData: () => body });
  };
  return { page, target, calls, original, emitRequest,
    // One IPC exchange as the webview's network shows it.
    ipc: (command: string, args: unknown, response: unknown) => {
      const url = `http://ipc.localhost/${encodeURIComponent(command)}`;
      emitRequest(url, JSON.stringify(args));
      events.emit('response', {
        url: () => url,
        // Tauri answers every IPC request with HTTP 200; the header carries the outcome.
        ok: () => true,
        headers: () => ({ 'tauri-response': command.startsWith('plugin:') && response !== 'success' ? 'error' : 'ok' }),
        text: () => response instanceof Error ? Promise.reject(response) : Promise.resolve(JSON.stringify(response)),
      });
    },
    listeners: () => events.listenerCount('request') + events.listenerCount('response'),
    restore: () => {
      if (previous) Object.defineProperty(target, '__TAURI_INTERNALS__', previous);
      else delete (target as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    },
  };
}


test('session recording includes startup and probe command names, sorted without arguments', async () => {
  const fixture = configure((command) => {
    fixture.ipc(command, fixture.calls.at(-1)?.args, { error: 'refused' });
    return undefined;
  });
  try {
    recordRendererBoundary(fixture.page);
    fixture.ipc('startup_command', { token: 'private' }, {});
    await beginRendererBoundary(fixture.page);
    fixture.ipc('plugin:event|listen', { secret: 'private' }, { error: 'refused' });
    fixture.ipc('library_select_sources', {}, {});
    fixture.ipc('library_import_selection', {}, {});
    fixture.ipc('startup_command', {}, {});
    assert.deepEqual(await finishRendererBoundary(fixture.page, 'C:\\private-fixtures'),
      ['library_import_selection', 'library_import_source', 'library_select_sources', 'plugin:app|version', 'plugin:dialog|open', 'plugin:event|listen', 'plugin:window|title', 'startup_command']);
  } finally { fixture.restore(); }
});

test('successful plugin command and any source-byte request for the large document fail', async () => {
  for (const plugin of [true, false]) {
    const fixture = configure();
    try {
      await beginRendererBoundary(fixture.page);
      fixture.ipc('library_select_sources', {}, {});
      fixture.ipc('library_import_selection', {}, {});
      if (plugin) fixture.ipc('plugin:window|show', { secret: 'private' }, 'success');
      else {
        fixture.ipc('library_source_bytes', { request: { documentId: 'large' } }, {});
        forbidRecordingSourceBytes(fixture.page, 'large');
      }
      await assert.rejects(finishRendererBoundary(fixture.page, 'C:\\private-fixtures'),
        plugin ? /successfully invoked a plugin/u : /loaded a large recording/u);
    } finally { fixture.restore(); }
  }
});


test('startup CDP recording precedes debugger resume and survives adoption by Playwright', async () => {
  const originalFetch = globalThis.fetch;
  const originalSocket = globalThis.WebSocket;
  const holder: { socket?: FakeSocket } = {};
  class FakeSocket extends EventTarget {
    enabled = false;
    closed = false;
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
    send(serialized: string) {
      const request = JSON.parse(serialized);
      if (request.method === 'Network.enable') this.enabled = true;
      queueMicrotask(() => this.message({ id: request.id, result: request.method === 'Network.getResponseBody' ? { body: '{}' } : {} }));
    }
    exchange(command: string, status = 200, method = 'POST') {
      assert.equal(this.enabled, true);
      const requestId = `${command}-${Math.random()}`;
      this.message({ method: 'Network.requestWillBeSent', params: { requestId, request: { method, url: `http://ipc.localhost/${encodeURIComponent(command)}`, postData: '{"secret":"transient"}' } } });
      this.message({ method: 'Network.responseReceived', params: { requestId, response: { status } } });
      this.message({ method: 'Network.loadingFinished', params: { requestId } });
    }
    close() { this.closed = true; }
  }
  globalThis.fetch = (async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1/fake' }] })) as typeof fetch;
  globalThis.WebSocket = class extends FakeSocket {
    constructor() { super(); Object.assign(holder, { socket: this }); }
  } as unknown as typeof WebSocket;
  const fixture = configure();
  try {
    const boundary = await startRendererBoundary('http://127.0.0.1:1234');
    const socket = holder.socket;
    assert.ok(socket);
    socket.exchange('startup_command');
    socket.exchange('plugin:event|listen', 200, 'OPTIONS');
    socket.exchange('plugin:event|listen', 400);
    boundary.adopt(fixture.page);
    socket.exchange('library_select_sources');
    socket.exchange('library_import_selection');
    assert.deepEqual(await finishRendererBoundary(fixture.page, 'C:\\private-fixtures'),
      ['library_import_selection', 'library_select_sources', 'plugin:event|listen', 'startup_command']);
    assert.equal(socket.closed, true);
  } finally {
    fixture.restore();
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalSocket;
  }
});

for (const failure of ['page', 'session', 'resume', 'none']) {
  test(`connection owns recorder cleanup when adoption reaches ${failure}`, async () => {
    const originalFetch = globalThis.fetch;
    const originalSocket = globalThis.WebSocket;
    const originalConnect = chromium.connectOverCDP;
    let socketCloses = 0;
    let browserCloses = 0;
    class Socket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }
      send(serialized: string) {
        const { id } = JSON.parse(serialized);
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ id, result: {} }),
        })));
      }
      close() {
        socketCloses++;
        this.dispatchEvent(new Event('close'));
      }
    }
    const page = {
      url: () => 'about:blank',
      context: () => ({
        newCDPSession: async () => {
          if (failure === 'session') throw new Error('session failure');
          return {
            send: async () => {
              if (failure === 'resume') throw new Error('resume failure');
            },
            detach: async () => undefined,
          };
        },
      }),
    } as unknown as Page;
    const browser = {
      contexts: () => [{ pages: () => failure === 'page' ? [page, page] : [page] }],
      once: () => undefined,
      close: async () => { browserCloses++; },
    } as unknown as Browser;
    globalThis.fetch = (async () => ({
      json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1/fake' }],
    })) as unknown as typeof fetch;
    globalThis.WebSocket = Socket as unknown as typeof WebSocket;
    chromium.connectOverCDP = (async () => browser) as typeof chromium.connectOverCDP;
    try {
      if (failure === 'none') {
        assert.equal(await connectRendererBoundary('http://127.0.0.1:1234', true, () => undefined), browser);
        assert.equal(socketCloses, 0);
        closeBrowserRendererBoundary(browser);
        closeBrowserRendererBoundary(browser);
        await cancelRendererBoundary(page);
        assert.equal(browserCloses, 0);
      } else {
        await assert.rejects(connectRendererBoundary('http://127.0.0.1:1234', true, () => undefined));
        assert.equal(browserCloses, 1);
        closeBrowserRendererBoundary(browser);
      }
      assert.equal(socketCloses, 1);
    } finally {
      chromium.connectOverCDP = originalConnect;
      globalThis.fetch = originalFetch;
      globalThis.WebSocket = originalSocket;
    }
  });
}
