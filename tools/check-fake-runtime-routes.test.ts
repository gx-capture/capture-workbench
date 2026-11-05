import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  checkFakeRuntimeRoutes, fakeRoutes, hostRoutes, missingFakeRoutes, normalizeRoute,
} from './check-fake-runtime-routes.ts';

test('normalizes named, positional and colon path parameters and query strings', () => {
  assert.equal(normalizeRoute('put', '/v2/ingestions/{ingestion_id}/chunks/{chunk_index}?x=1'),
    'PUT /v2/ingestions/{}/chunks/{}');
  assert.equal(normalizeRoute('GET', '/v2/captures/:captureId/'), 'GET /v2/captures/{}');
});

test('derives native literal, formatted, helper and SSE requests without test/comment routes', () => {
  const routes = hostRoutes([`
    fn ready() { request_json(state, "GET", "/v2/health/ready", None, None); }
    fn upload() { request_with_headers(config, "PUT", &format!("/v2/ingestions/{id}/chunks/{}", index), None); }
    fn result() { capture_value(state, "GET", &input.id, "/result", None); }
    fn capture_value(state: &State, method: &str, id: &str, suffix: &str) {
      request_json(state, method, &capture_path(id, suffix), None);
    }
    fn capture_path(id: &str, suffix: &str) -> String { format!("/v2/captures/{id}{suffix}") }
    fn events() { request_sse(config, &format!("/v2/captures/{id}/events"), None); }
    fn variable_path() { let path = format!("/v2/ingestions/{id}"); request(config, "DELETE", &path, None, None); }
    // request(state, "POST", "/comment", None);
    #[cfg(test)] mod tests { fn obsolete() { request(state, "POST", "/obsolete", None); } }
  `]);
  assert.deepEqual([...routes].sort(), [
    'DELETE /v2/ingestions/{}',
    'GET /v2/captures/{}/events', 'GET /v2/captures/{}/result',
    'GET /v2/health/ready', 'PUT /v2/ingestions/{}/chunks/{}',
  ]);
});

test('unrecognized native request paths fail closed instead of disappearing from the inventory', () => {
  assert.throws(() => hostRoutes([
    'fn unknown() { request(config, "POST", &build_path(), None, None); }',
  ]), /Cannot derive desktop POST request path/u);
});

const routeTable = `
  fn route(&self, request: Request) -> Response {
    match (request.method.as_str(), request.path.as_str()) {
      ("POST", "/v2/ingestions") => self.open_ingestion(&request),
      _ if request.path.starts_with("/v2/ingestions/") => self.route_ingestion(&request),
      _ if request.path.starts_with("/v2/runtime/installations/") => { self.route_installation(&request) }
    }
  }
  fn route_ingestion(&self, request: Request) {
    match (request.method.as_str(), suffix) {
      ("GET", "") | ("DELETE", "") => response(),
      ("POST", "finalize") => finalize(),
      ("PUT", suffix) if suffix.starts_with("chunks/") => append(),
    }
  }
  fn route_installation(&self, request: Request) {
    if let Some(id) = relative.strip_suffix("/cancel") {
      return if request.method == "POST" { cancel() } else { error() };
    }
    if request.method == "GET" && !relative.contains('/') { return get(); }
  }
`;

test('derives only dispatched fake routes including suffixes, chunks, cancellation and alternatives', () => {
  assert.deepEqual([...fakeRoutes([routeTable])].sort(), [
    'DELETE /v2/ingestions/{}', 'GET /v2/ingestions/{}',
    'GET /v2/runtime/installations/{}', 'POST /v2/ingestions',
    'POST /v2/ingestions/{}/finalize', 'POST /v2/runtime/installations/{}/cancel',
    'PUT /v2/ingestions/{}/chunks/{}',
  ]);
  const removedDispatch = routeTable.replace(
    '_ if request.path.starts_with("/v2/ingestions/") => self.route_ingestion(&request),', '',
  );
  assert.equal(fakeRoutes([removedDispatch]).has('PUT /v2/ingestions/{}/chunks/{}'), false);
});

test('reports the exact missing method and path when creation or upload routes disappear', () => {
  const host = hostRoutes([`
    fn start() { request(config, "POST", "/v2/ingestions", None, None); }
    fn upload() { request(config, "PUT", &format!("/v2/ingestions/{id}/chunks/{chunk}"), None, None); }
  `]);
  const drifted = routeTable.replace('("POST", "/v2/ingestions")', '("GET", "/v2/ingestions")')
    .replace('("PUT", suffix)', '("POST", suffix)');
  assert.deepEqual(missingFakeRoutes(host, fakeRoutes([drifted])), [
    'POST /v2/ingestions', 'PUT /v2/ingestions/{}/chunks/{}',
  ]);
});

test('current deterministic fake serves every native host route', () => {
  const desktop = resolve(import.meta.dirname, '../apps/capture-workbench-desktop');
  assert.ok(checkFakeRuntimeRoutes(desktop) > 0);
});

test('CLI verifies source routes independently of the working directory and staged runtime', () => {
  const result = spawnSync(process.execPath, [
    resolve(import.meta.dirname, 'check-fake-runtime-routes.ts'),
  ], {
    cwd: resolve(import.meta.dirname, '../apps/capture-workbench-desktop/scripts'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Deterministic fake runtime routes verified: \d+ desktop host routes served\./u);
});
