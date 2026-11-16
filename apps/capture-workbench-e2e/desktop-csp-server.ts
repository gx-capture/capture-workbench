// Serves the production build of the Workbench the way the packaged desktop
// app does: every response carries the `csp` of the desktop's
// `tauri.conf.json`, and a path that is not a file answers with `index.html`
// (the packaged app does the same for a route such as `/settings/engines`).
// The browser e2e runs a second project against this server, so a change that
// only breaks under the desktop CSP fails here and not first in the installed
// app. Started by `playwright.config.ts`.
//
// Use: node apps/capture-workbench-e2e/desktop-csp-server.ts <port>
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const workspaceRoot = resolve(import.meta.dirname, '..', '..');
const buildRoot = join(workspaceRoot, 'dist', 'apps', 'capture-workbench', 'browser');
const tauriConfigPath = join(
  workspaceRoot,
  'apps',
  'capture-workbench-desktop',
  'src-tauri',
  'tauri.conf.json',
);
const mediaTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function desktopCsp(): string {
  const config = JSON.parse(readFileSync(tauriConfigPath, 'utf8')) as {
    readonly app?: { readonly security?: { readonly csp?: unknown } };
  };
  const csp = config.app?.security?.csp;
  if (typeof csp !== 'string' || csp.length === 0) {
    throw new Error('The desktop tauri.conf.json has no string app.security.csp.');
  }
  return csp;
}

function fileFor(requestPath: string): string | undefined {
  const candidate = resolve(join(buildRoot, requestPath));
  if (candidate !== buildRoot && !candidate.startsWith(buildRoot + sep)) return undefined;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  // A missing asset stays missing; only a route falls back to the shell.
  return extname(requestPath) === '' ? join(buildRoot, 'index.html') : undefined;
}

const port = Number(process.argv[2]);
if (process.argv.length !== 3 || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Use: desktop-csp-server.ts <port>');
}
if (!existsSync(join(buildRoot, 'index.html'))) {
  throw new Error(
    'No production build of capture-workbench was found; run capture-workbench:build first.',
  );
}
const csp = desktopCsp();

createServer((request, response) => {
  const requestPath = decodeURIComponent(
    new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
  );
  const file = fileFor(requestPath);
  if (file === undefined) {
    response.writeHead(404, { 'content-security-policy': csp }).end();
    return;
  }
  response
    .writeHead(200, {
      'content-type': mediaTypes[extname(file)] ?? 'application/octet-stream',
      'content-security-policy': csp,
    })
    .end(readFileSync(file));
}).listen(port, '127.0.0.1');
