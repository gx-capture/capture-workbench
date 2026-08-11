import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BoundaryDoctorConfigError,
  parseBoundaryDoctorArgs,
  runBoundaryDoctor,
  serializeBoundaryDoctorReport,
  type BoundaryDoctorDependencies,
  type BoundaryDoctorOptions,
} from './capture-boundary-doctor.ts';

const CERT_TOKEN = 'cert-secret-sentinel';
const RUNTIME_TOKEN = 'runtime-secret-sentinel';

const ready = {
  ready: true,
  service: 'capture-runtime',
  runtimeVersion: '0.3.11',
  apiVersion: '1.0',
  captureDocumentSchemaVersion: '1',
  capabilities: {
    captureKinds: ['audio', 'image', 'pdf'],
    structuringModes: ['host', 'runtime'],
  },
};

const requirements = {
  items: [
    {
      requirementId: 'windowsml-ocr',
      status: 'ready',
      detail: 'must not be retained',
    },
    {
      requirementId: 'whisper-primary',
      status: 'ready',
      secretPath: 'C:/private',
    },
  ],
};

function options(overrides: Partial<BoundaryDoctorOptions> = {}) {
  return {
    certPrepOrigin: 'http://127.0.0.1:8765',
    runtimeOrigin: 'http://127.0.0.1:8766',
    certPrepToken: CERT_TOKEN,
    runtimeToken: RUNTIME_TOKEN,
    watchSeconds: 0,
    intervalMs: 250,
    requestTimeoutMs: 1_000,
    ...overrides,
  } satisfies BoundaryDoctorOptions;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type RouteValue = Response | (() => Response);

function makeDependencies(routes: Map<string, RouteValue[]>): {
  dependencies: BoundaryDoctorDependencies;
  requests: Array<{ url: string; authorization: string | null }>;
} {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  let currentTime = 1_000;

  return {
    requests,
    dependencies: {
      fetcher: async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get('authorization'),
        });
        const queue = routes.get(url);
        assert.ok(queue && queue.length > 0, `unexpected request: ${url}`);
        const route = queue.length === 1 ? queue[0] : queue.shift();
        assert.ok(route);
        return typeof route === 'function' ? route() : route.clone();
      },
      now: () => currentTime,
      sleep: async (milliseconds) => {
        currentTime += milliseconds;
      },
      progress: () => undefined,
    },
  };
}

function baseRoutes() {
  return new Map<string, RouteValue[]>([
    ['http://127.0.0.1:8765/capture-runtime/ready', [jsonResponse(ready)]],
    [
      'http://127.0.0.1:8765/capture-runtime/requirements',
      [jsonResponse(requirements)],
    ],
    ['http://127.0.0.1:8766/v1/health/ready', [jsonResponse(ready)]],
    [
      'http://127.0.0.1:8766/v1/runtime/requirements',
      [jsonResponse(requirements)],
    ],
  ]);
}

function assertConfigError(argv: string[], env: NodeJS.ProcessEnv = {}) {
  assert.throws(
    () => parseBoundaryDoctorArgs(argv, env),
    BoundaryDoctorConfigError,
  );
}

test('argument parsing accepts only credential-free numeric loopback origins', () => {
  const parsed = parseBoundaryDoctorArgs(
    [
      '--cert-prep-url',
      'http://127.0.0.1:8765',
      '--runtime-url',
      'http://[::1]:8766',
      '--watch-seconds',
      '1',
      '--interval-ms',
      '250',
    ],
    {
      CAPTURE_BOUNDARY_CERT_PREP_TOKEN: CERT_TOKEN,
      CAPTURE_BOUNDARY_RUNTIME_TOKEN: RUNTIME_TOKEN,
    },
  );

  assert.equal(parsed.certPrepOrigin, 'http://127.0.0.1:8765');
  assert.equal(parsed.runtimeOrigin, 'http://[::1]:8766');
  assert.equal(parsed.watchSeconds, 1);
  assert.equal(parsed.certPrepToken, CERT_TOKEN);

  for (const url of [
    'http://localhost:8765',
    'https://127.0.0.1:8765',
    'http://user:password@127.0.0.1:8765',
    'http://127.0.0.1:8765/path',
    'http://127.0.0.1:8765?query=1',
    'http://127.0.0.1',
  ]) {
    assertConfigError([
      '--cert-prep-url',
      url,
      '--runtime-url',
      'http://127.0.0.1:8766',
    ]);
  }
});

test('argument parsing fails closed for incomplete correlation, unsafe tokens, and excessive sampling', () => {
  assertConfigError(
    [
      '--cert-prep-url',
      'http://127.0.0.1:8765',
      '--runtime-url',
      'http://127.0.0.1:8766',
      '--project-id',
      'project-1',
    ],
    {
      CAPTURE_BOUNDARY_CERT_PREP_TOKEN: CERT_TOKEN,
      CAPTURE_BOUNDARY_RUNTIME_TOKEN: RUNTIME_TOKEN,
    },
  );
  assertConfigError(
    [
      '--cert-prep-url',
      'http://127.0.0.1:8765',
      '--runtime-url',
      'http://127.0.0.1:8766',
    ],
    {
      CAPTURE_BOUNDARY_CERT_PREP_TOKEN: 'unsafe\ntoken',
      CAPTURE_BOUNDARY_RUNTIME_TOKEN: RUNTIME_TOKEN,
    },
  );
  assertConfigError(
    [
      '--cert-prep-url',
      'http://127.0.0.1:8765',
      '--runtime-url',
      'http://127.0.0.1:8766',
      '--watch-seconds',
      '3600',
      '--interval-ms',
      '250',
    ],
    {
      CAPTURE_BOUNDARY_CERT_PREP_TOKEN: CERT_TOKEN,
      CAPTURE_BOUNDARY_RUNTIME_TOKEN: RUNTIME_TOKEN,
    },
  );
});

test('healthy snapshot compares both boundaries and never serializes bearer tokens or raw details', async () => {
  const routes = baseRoutes();
  const { dependencies, requests } = makeDependencies(routes);
  const report = await runBoundaryDoctor(options(), dependencies);
  const serialized = serializeBoundaryDoctorReport(report);

  assert.equal(report.verdict.owner, 'healthy');
  assert.equal(report.verdict.code, 'boundary_healthy');
  assert.equal(report.sampleCount, 1);
  assert.ok(
    requests.some(
      ({ url, authorization }) =>
        url.includes(':8765/') && authorization === `Bearer ${CERT_TOKEN}`,
    ),
  );
  assert.ok(
    requests.some(
      ({ url, authorization }) =>
        url.includes(':8766/') && authorization === `Bearer ${RUNTIME_TOKEN}`,
    ),
  );
  assert.doesNotMatch(serialized, /secret-sentinel|must not be retained|C:\/private/u);
});

test('direct runtime health plus unavailable proxy assigns ownership to Cert Prep', async () => {
  const routes = baseRoutes();
  routes.set('http://127.0.0.1:8765/capture-runtime/ready', [
    new Response(null, { status: 503 }),
  ]);
  const report = await runBoundaryDoctor(
    options(),
    makeDependencies(routes).dependencies,
  );

  assert.equal(report.verdict.owner, 'cert-prep');
  assert.equal(report.verdict.code, 'proxy_unavailable');
});

test('readable capability mismatch assigns ownership to the integration boundary', async () => {
  const routes = baseRoutes();
  routes.set('http://127.0.0.1:8765/capture-runtime/ready', [
    jsonResponse({
      ...ready,
      capabilities: {
        captureKinds: ['pdf'],
        structuringModes: ['host', 'runtime'],
      },
    }),
  ]);
  const report = await runBoundaryDoctor(
    options(),
    makeDependencies(routes).dependencies,
  );

  assert.equal(report.verdict.owner, 'boundary');
  assert.equal(report.verdict.code, 'snapshot_mismatch');
});

test('runtime failure still active in Cert Prep is a host reconciliation fault', async () => {
  const routes = correlatedRoutes(
    { status: 'running', phase: 'processing', cancellable: true },
    {
      status: 'failed',
      error: {
        code: 'ocr_failed',
        message: 'private source path must not leak',
        stage: 'ocr',
        retryable: false,
      },
    },
  );
  const report = await runBoundaryDoctor(
    correlatedOptions(),
    makeDependencies(routes).dependencies,
  );

  assert.equal(report.verdict.owner, 'cert-prep');
  assert.equal(report.verdict.code, 'runtime_terminal_operation_active');
  assert.doesNotMatch(serializeBoundaryDoctorReport(report), /private source path/u);
});

test('matching propagated runtime failure assigns the underlying failure to Capture Runtime', async () => {
  const routes = correlatedRoutes(
    { status: 'failed', phase: 'failed', cancellable: false, error: {} },
    {
      status: 'failed',
      error: { code: 'ocr_failed', stage: 'ocr', retryable: false },
    },
  );
  const report = await runBoundaryDoctor(
    correlatedOptions(),
    makeDependencies(routes).dependencies,
  );

  assert.equal(report.verdict.owner, 'capture-runtime');
  assert.equal(report.verdict.code, 'runtime_job_failed');
});

test('matching completion is healthy and a terminal host with active runtime needs host cleanup', async () => {
  const completedReport = await runBoundaryDoctor(
    correlatedOptions(),
    makeDependencies(
      correlatedRoutes(
        { status: 'succeeded', phase: 'completed', cancellable: false },
        { status: 'completed' },
      ),
    ).dependencies,
  );
  assert.equal(completedReport.verdict.owner, 'healthy');
  assert.equal(completedReport.verdict.code, 'terminal_success_consistent');

  const cleanupReport = await runBoundaryDoctor(
    correlatedOptions(),
    makeDependencies(
      correlatedRoutes(
        { status: 'failed', phase: 'failed', cancellable: false },
        { status: 'extracting' },
      ),
    ).dependencies,
  );
  assert.equal(cleanupReport.verdict.owner, 'cert-prep');
  assert.equal(cleanupReport.verdict.code, 'operation_terminal_runtime_active');
});

test('accepts every v2 capture active status without legacy stage metadata', async () => {
  for (const status of [
    'created',
    'waiting_input',
    'extracting',
    'awaiting_structuring',
    'structuring',
  ]) {
    const report = await runBoundaryDoctor(
      correlatedOptions(),
      makeDependencies(
        correlatedRoutes(
          { status: 'running', phase: 'processing', cancellable: true },
          { status },
        ),
      ).dependencies,
    );

    assert.equal(report.verdict.code, 'correlated_work_in_progress');
  }
});

test('watch mode judges only the final sample and stops when both jobs become terminal', async () => {
  const routes = correlatedRoutes(
    [
      { status: 'running', phase: 'processing', cancellable: true },
      { status: 'succeeded', phase: 'completed', cancellable: false },
    ],
    [
      { status: 'extracting' },
      { status: 'completed' },
    ],
  );
  duplicateBaseRoutes(routes, 2);
  const report = await runBoundaryDoctor(
    correlatedOptions({ watchSeconds: 5, intervalMs: 250 }),
    makeDependencies(routes).dependencies,
  );

  assert.equal(report.sampleCount, 2);
  assert.equal(report.endReason, 'both-terminal');
  assert.equal(report.verdict.owner, 'healthy');
  assert.equal(report.verdict.code, 'terminal_success_consistent');
});

test('authentication failures remain sanitized and use unknown ownership', async () => {
  const routes = baseRoutes();
  routes.set('http://127.0.0.1:8765/capture-runtime/ready', [
    new Response('token rejected: cert-secret-sentinel', { status: 401 }),
  ]);
  const report = await runBoundaryDoctor(
    options(),
    makeDependencies(routes).dependencies,
  );
  const serialized = serializeBoundaryDoctorReport(report);

  assert.equal(report.verdict.owner, 'unknown');
  assert.equal(report.verdict.code, 'authentication_failed');
  assert.doesNotMatch(serialized, /secret-sentinel|token rejected/u);
});

test('request timeouts become sanitized endpoint faults without blocking the other boundary', async () => {
  const routes = baseRoutes();
  const { dependencies } = makeDependencies(routes);
  const routedFetcher = dependencies.fetcher;
  dependencies.fetcher = (input, init) => {
    if (String(input) !== 'http://127.0.0.1:8765/capture-runtime/ready') {
      return routedFetcher(input, init);
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('secret timeout detail', 'AbortError')),
        { once: true },
      );
    });
  };
  const report = await runBoundaryDoctor(
    options({ requestTimeoutMs: 5 }),
    dependencies,
  );
  const serialized = serializeBoundaryDoctorReport(report);

  assert.equal(report.verdict.owner, 'cert-prep');
  assert.equal(report.verdict.code, 'proxy_unavailable');
  assert.match(serialized, /"kind": "timeout"/u);
  assert.doesNotMatch(serialized, /secret timeout detail/u);
});

test('an explicitly requested report is written without creating parent directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capture-boundary-doctor-'));
  const outputPath = join(directory, 'report.json');
  try {
    const report = await runBoundaryDoctor(
      options({ outputPath }),
      makeDependencies(baseRoutes()).dependencies,
    );
    assert.deepEqual(
      JSON.parse(await readFile(outputPath, 'utf8')),
      JSON.parse(serializeBoundaryDoctorReport(report)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function correlatedOptions(overrides: Partial<BoundaryDoctorOptions> = {}) {
  return options({
    correlation: {
      projectId: 'project-1',
      operationId: 'operation-1',
      captureId: 'capture-1',
    },
    ...overrides,
  });
}

function correlatedRoutes(
  operation:
    | Record<string, unknown>
    | Array<Record<string, unknown>>,
  capture:
    | Record<string, unknown>
    | Array<Record<string, unknown>>,
) {
  const routes = baseRoutes();
  const operations = Array.isArray(operation) ? operation : [operation];
  const captures = Array.isArray(capture) ? capture : [capture];
  routes.set(
    'http://127.0.0.1:8765/projects/project-1/document-operations/operation-1',
    operations.map((value) => jsonResponse(value)),
  );
  routes.set(
    'http://127.0.0.1:8766/v2/captures/capture-1',
    captures.map((value) => jsonResponse(value)),
  );
  return routes;
}

function duplicateBaseRoutes(routes: Map<string, RouteValue[]>, count: number) {
  for (const url of [
    'http://127.0.0.1:8765/capture-runtime/ready',
    'http://127.0.0.1:8765/capture-runtime/requirements',
    'http://127.0.0.1:8766/v1/health/ready',
    'http://127.0.0.1:8766/v1/runtime/requirements',
  ]) {
    const current = routes.get(url);
    assert.ok(current?.[0]);
    routes.set(
      url,
      Array.from({ length: count }, () => current[0]),
    );
  }
}
