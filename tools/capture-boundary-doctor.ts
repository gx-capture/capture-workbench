import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MAX_SAMPLES = 1_000;
const TOKEN_MAX_LENGTH = 4_096;
const IDENTIFIER_MAX_LENGTH = 256;

const OPERATION_ACTIVE = new Set(['queued', 'running', 'cancel_requested']);
const OPERATION_TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const OPERATION_PHASES = new Set([
  'uploading',
  'processing',
  'awaiting_review',
  'transcribing',
  'translating',
  'canceling',
  'committing',
  'canceled',
  'completed',
  'failed',
]);
const CAPTURE_ACTIVE = new Set(['queued', 'running']);
const CAPTURE_TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const CAPTURE_STAGES = new Set([
  'queued',
  'extracting',
  'awaiting_structuring',
  'structuring',
  'completed',
  'failed',
  'cancelled',
]);
const REQUIREMENT_STATUSES = new Set([
  'ready',
  'missing',
  'installable',
  'manual_action_required',
  'unavailable',
]);
const CAPTURE_KINDS = new Set(['pdf', 'image', 'audio']);
const STRUCTURING_MODES = new Set(['runtime', 'host']);
const SAFE_IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/u;
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{1,63}$/u;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u;

type Owner =
  | 'healthy'
  | 'in-progress'
  | 'cert-prep'
  | 'capture-runtime'
  | 'boundary'
  | 'unknown';

type EndReason = 'snapshot' | 'both-terminal' | 'deadline' | 'sample-limit';

export interface BoundaryDoctorCorrelation {
  projectId: string;
  operationId: string;
  captureId: string;
}

export interface BoundaryDoctorOptions {
  certPrepOrigin: string;
  runtimeOrigin: string;
  certPrepToken: string;
  runtimeToken: string;
  correlation?: BoundaryDoctorCorrelation;
  watchSeconds: number;
  intervalMs: number;
  requestTimeoutMs: number;
  outputPath?: string;
}

export interface BoundaryDoctorDependencies {
  fetcher: typeof fetch;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  progress: (message: string) => void;
}

interface EndpointError {
  kind: 'timeout' | 'unreachable' | 'http' | 'invalid-json' | 'invalid-shape';
  status?: number;
}

type Observation<T> =
  | { ok: true; value: T }
  | { ok: false; error: EndpointError };

interface ReadySummary {
  service: string;
  runtimeVersion: string;
  apiVersion: string;
  captureDocumentSchemaVersion: string;
  captureKinds: string[];
  structuringModes: string[];
}

interface RequirementSummary {
  requirementId: string;
  status: string;
}

interface RequirementsSummary {
  items: RequirementSummary[];
}

interface OperationSummary {
  status: string;
  phase: string;
  cancellable: boolean;
  hasError: boolean;
}

interface CaptureSummary {
  status: string;
  stage: string;
  errorCode?: string;
  retryable?: boolean;
}

interface BoundarySample {
  observedAt: string;
  certPrep: {
    ready: Observation<ReadySummary>;
    requirements: Observation<RequirementsSummary>;
    operation?: Observation<OperationSummary>;
  };
  captureRuntime: {
    ready: Observation<ReadySummary>;
    requirements: Observation<RequirementsSummary>;
    capture?: Observation<CaptureSummary>;
  };
}

export interface BoundaryDoctorVerdict {
  owner: Owner;
  code: string;
  detail: string;
}

export interface BoundaryDoctorReport {
  reportVersion: '1';
  mode: 'snapshot' | 'watch';
  generatedAt: string;
  endReason: EndReason;
  endpoints: {
    certPrepOrigin: string;
    captureRuntimeOrigin: string;
  };
  sampleCount: number;
  samples: BoundarySample[];
  verdict: BoundaryDoctorVerdict;
}

export class BoundaryDoctorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoundaryDoctorConfigError';
  }
}

class InvalidShapeError extends Error {}

const defaultDependencies: BoundaryDoctorDependencies = {
  fetcher: fetch,
  now: Date.now,
  sleep: (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
  progress: (message) => process.stderr.write(`${message}\n`),
};

export function parseBoundaryDoctorArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
): BoundaryDoctorOptions {
  const values = parseFlags(argv);
  const certPrepOrigin = requiredOrigin(values, '--cert-prep-url');
  const runtimeOrigin = requiredOrigin(values, '--runtime-url');
  const certPrepToken = requiredToken(
    env.CAPTURE_BOUNDARY_CERT_PREP_TOKEN,
    'CAPTURE_BOUNDARY_CERT_PREP_TOKEN',
  );
  const runtimeToken = requiredToken(
    env.CAPTURE_BOUNDARY_RUNTIME_TOKEN,
    'CAPTURE_BOUNDARY_RUNTIME_TOKEN',
  );
  const watchSeconds = integerFlag(values, '--watch-seconds', 0, 0, 3_600);
  const intervalMs = integerFlag(values, '--interval-ms', 250, 250, 10_000);
  const requestTimeoutMs = integerFlag(
    values,
    '--request-timeout-ms',
    5_000,
    250,
    30_000,
  );

  const projectId = values.get('--project-id');
  const operationId = values.get('--operation-id');
  const captureId = values.get('--capture-id');
  const suppliedCorrelationValues = [projectId, operationId, captureId].filter(
    (value) => value !== undefined,
  ).length;
  if (suppliedCorrelationValues !== 0 && suppliedCorrelationValues !== 3) {
    throw new BoundaryDoctorConfigError(
      'project, operation, and capture identifiers must be supplied together',
    );
  }

  const correlation =
    suppliedCorrelationValues === 3
      ? {
          projectId: safeIdentifier(projectId),
          operationId: safeIdentifier(operationId),
          captureId: safeIdentifier(captureId),
        }
      : undefined;
  const sampleBudget = Math.ceil((watchSeconds * 1_000) / intervalMs) + 1;
  if (sampleBudget > MAX_SAMPLES) {
    throw new BoundaryDoctorConfigError(
      `watch configuration exceeds the ${MAX_SAMPLES} sample limit`,
    );
  }

  const outputPath = values.get('--output');
  if (outputPath !== undefined && !isSafeNonEmptyText(outputPath, 32_768)) {
    throw new BoundaryDoctorConfigError('output path is invalid');
  }

  return {
    certPrepOrigin,
    runtimeOrigin,
    certPrepToken,
    runtimeToken,
    ...(correlation === undefined ? {} : { correlation }),
    watchSeconds,
    intervalMs,
    requestTimeoutMs,
    ...(outputPath === undefined ? {} : { outputPath }),
  };
}

function parseFlags(argv: string[]): Map<string, string> {
  const supported = new Set([
    '--cert-prep-url',
    '--runtime-url',
    '--project-id',
    '--operation-id',
    '--capture-id',
    '--watch-seconds',
    '--interval-ms',
    '--request-timeout-ms',
    '--output',
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !supported.has(flag)) {
      throw new BoundaryDoctorConfigError('an unsupported argument was supplied');
    }
    if (values.has(flag)) {
      throw new BoundaryDoctorConfigError('an argument was supplied more than once');
    }
    if (value === undefined || value.startsWith('--')) {
      throw new BoundaryDoctorConfigError('an argument value is missing');
    }
    values.set(flag, value);
  }
  return values;
}

function requiredOrigin(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined) {
    throw new BoundaryDoctorConfigError('both service URLs are required');
  }
  return validateLoopbackOrigin(value);
}

export function validateLoopbackOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BoundaryDoctorConfigError('service URL is invalid');
  }
  if (
    url.protocol !== 'http:' ||
    url.username !== '' ||
    url.password !== '' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.port === '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new BoundaryDoctorConfigError(
      'service URL must be a credential-free numeric loopback HTTP origin with an explicit port',
    );
  }
  return url.origin;
}

function requiredToken(value: string | undefined, name: string): string {
  if (!isSafeNonEmptyText(value, TOKEN_MAX_LENGTH)) {
    throw new BoundaryDoctorConfigError(`${name} is missing or invalid`);
  }
  return value;
}

function integerFlag(
  values: Map<string, string>,
  flag: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = values.get(flag);
  if (raw === undefined) return fallback;
  if (!/^\d+$/u.test(raw)) {
    throw new BoundaryDoctorConfigError('a numeric argument is invalid');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new BoundaryDoctorConfigError('a numeric argument is outside its range');
  }
  return value;
}

function safeIdentifier(value: string | undefined): string {
  if (!isSafeNonEmptyText(value, IDENTIFIER_MAX_LENGTH)) {
    throw new BoundaryDoctorConfigError('a correlation identifier is invalid');
  }
  return value;
}

function isSafeNonEmptyText(
  value: string | undefined,
  maximumLength: number,
): value is string {
  return (
    value !== undefined &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !containsControlCharacter(value)
  );
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

export async function runBoundaryDoctor(
  options: BoundaryDoctorOptions,
  dependencies: BoundaryDoctorDependencies = defaultDependencies,
): Promise<BoundaryDoctorReport> {
  const samples: BoundarySample[] = [];
  const deadline = dependencies.now() + options.watchSeconds * 1_000;
  let endReason: EndReason = options.watchSeconds === 0 ? 'snapshot' : 'deadline';

  while (samples.length < MAX_SAMPLES) {
    const sample = await collectBoundarySample(options, dependencies);
    samples.push(sample);
    dependencies.progress(sampleProgress(samples.length, sample));

    if (options.watchSeconds === 0) break;
    if (bothCorrelatedJobsTerminal(sample)) {
      endReason = 'both-terminal';
      break;
    }
    const remainingMs = deadline - dependencies.now();
    if (remainingMs <= 0) break;
    await dependencies.sleep(Math.min(options.intervalMs, remainingMs));
  }
  if (samples.length === MAX_SAMPLES && dependencies.now() < deadline) {
    endReason = 'sample-limit';
  }

  const finalSample = samples.at(-1);
  if (!finalSample) throw new Error('sample collection failed');
  const report: BoundaryDoctorReport = {
    reportVersion: '1',
    mode: options.watchSeconds === 0 ? 'snapshot' : 'watch',
    generatedAt: new Date(dependencies.now()).toISOString(),
    endReason,
    endpoints: {
      certPrepOrigin: options.certPrepOrigin,
      captureRuntimeOrigin: options.runtimeOrigin,
    },
    sampleCount: samples.length,
    samples,
    verdict: classifyBoundarySample(finalSample),
  };

  if (options.outputPath !== undefined) {
    await writeFile(options.outputPath, serializeBoundaryDoctorReport(report), 'utf8');
  }
  return report;
}

export async function collectBoundarySample(
  options: BoundaryDoctorOptions,
  dependencies: BoundaryDoctorDependencies = defaultDependencies,
): Promise<BoundarySample> {
  const certPrep = options.certPrepOrigin;
  const runtime = options.runtimeOrigin;
  const operationUrl = options.correlation
    ? `${certPrep}/projects/${encodeURIComponent(options.correlation.projectId)}/document-operations/${encodeURIComponent(options.correlation.operationId)}`
    : undefined;
  const captureUrl = options.correlation
    ? `${runtime}/v2/captures/${encodeURIComponent(options.correlation.captureId)}`
    : undefined;

  const [
    certReady,
    certRequirements,
    runtimeReady,
    runtimeRequirements,
    operation,
    capture,
  ] = await Promise.all([
      requestJson(
        `${certPrep}/capture-runtime/ready`,
        options.certPrepToken,
        parseReady,
        options.requestTimeoutMs,
        dependencies,
      ),
      requestJson(
        `${certPrep}/capture-runtime/requirements`,
        options.certPrepToken,
        parseRequirements,
        options.requestTimeoutMs,
        dependencies,
      ),
      requestJson(
        `${runtime}/v1/health/ready`,
        options.runtimeToken,
        parseReady,
        options.requestTimeoutMs,
        dependencies,
      ),
      requestJson(
        `${runtime}/v1/runtime/requirements`,
        options.runtimeToken,
        parseRequirements,
        options.requestTimeoutMs,
        dependencies,
      ),
      operationUrl === undefined
        ? Promise.resolve(undefined)
        : requestJson(
            operationUrl,
            options.certPrepToken,
            parseOperation,
            options.requestTimeoutMs,
            dependencies,
          ),
      captureUrl === undefined
        ? Promise.resolve(undefined)
        : requestJson(
            captureUrl,
            options.runtimeToken,
            parseCapture,
            options.requestTimeoutMs,
            dependencies,
          ),
    ]);

  return {
    observedAt: new Date(dependencies.now()).toISOString(),
    certPrep: {
      ready: certReady,
      requirements: certRequirements,
      ...(operation === undefined ? {} : { operation }),
    },
    captureRuntime: {
      ready: runtimeReady,
      requirements: runtimeRequirements,
      ...(capture === undefined ? {} : { capture }),
    },
  };
}

async function requestJson<T>(
  url: string,
  token: string,
  parse: (value: unknown) => T,
  timeoutMs: number,
  dependencies: BoundaryDoctorDependencies,
): Promise<Observation<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await dependencies.fetcher(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        connection: 'close',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: { kind: 'http', status: response.status } };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: { kind: 'invalid-json' } };
    }
    try {
      return { ok: true, value: parse(body) };
    } catch (error) {
      if (error instanceof InvalidShapeError) {
        return { ok: false, error: { kind: 'invalid-shape' } };
      }
      throw error;
    }
  } catch {
    return {
      ok: false,
      error: { kind: controller.signal.aborted ? 'timeout' : 'unreachable' },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseReady(value: unknown): ReadySummary {
  const root = record(value);
  const capabilities = record(root.capabilities);
  if (root.ready !== true) throw new InvalidShapeError();
  const service = textField(root, 'service');
  const runtimeVersion = textField(root, 'runtimeVersion');
  const apiVersion = textField(root, 'apiVersion');
  const captureDocumentSchemaVersion = textField(
    root,
    'captureDocumentSchemaVersion',
  );
  const captureKinds = uniqueAllowedArray(
    capabilities,
    'captureKinds',
    CAPTURE_KINDS,
  );
  const structuringModes = uniqueAllowedArray(
    capabilities,
    'structuringModes',
    STRUCTURING_MODES,
  );
  if (
    service !== 'capture-runtime' ||
    !SAFE_VERSION.test(runtimeVersion) ||
    !SAFE_VERSION.test(apiVersion) ||
    !SAFE_VERSION.test(captureDocumentSchemaVersion)
  ) {
    throw new InvalidShapeError();
  }
  return {
    service,
    runtimeVersion,
    apiVersion,
    captureDocumentSchemaVersion,
    captureKinds,
    structuringModes,
  };
}

function parseRequirements(value: unknown): RequirementsSummary {
  const items = record(value).items;
  if (!Array.isArray(items)) throw new InvalidShapeError();
  const summaries = items.map((item) => {
    const requirement = record(item);
    const requirementId = textField(requirement, 'requirementId');
    const status = textField(requirement, 'status');
    if (
      !SAFE_IDENTIFIER.test(requirementId) ||
      !REQUIREMENT_STATUSES.has(status)
    ) {
      throw new InvalidShapeError();
    }
    return {
      requirementId,
      status,
    };
  });
  const identifiers = summaries.map(({ requirementId }) => requirementId);
  if (new Set(identifiers).size !== identifiers.length) {
    throw new InvalidShapeError();
  }
  return {
    items: summaries.sort((left, right) =>
      left.requirementId.localeCompare(right.requirementId),
    ),
  };
}

function parseOperation(value: unknown): OperationSummary {
  const operation = record(value);
  const status = textField(operation, 'status');
  if (!OPERATION_ACTIVE.has(status) && !OPERATION_TERMINAL.has(status)) {
    throw new InvalidShapeError();
  }
  if (typeof operation.cancellable !== 'boolean') throw new InvalidShapeError();
  const phase = textField(operation, 'phase');
  if (!OPERATION_PHASES.has(phase)) throw new InvalidShapeError();
  return {
    status,
    phase,
    cancellable: operation.cancellable,
    hasError: operation.error !== null && operation.error !== undefined,
  };
}

function parseCapture(value: unknown): CaptureSummary {
  const capture = record(value);
  const status = textField(capture, 'status');
  if (!CAPTURE_ACTIVE.has(status) && !CAPTURE_TERMINAL.has(status)) {
    throw new InvalidShapeError();
  }
  const stage = textField(capture, 'stage');
  if (!CAPTURE_STAGES.has(stage)) throw new InvalidShapeError();
  const error = capture.error === null || capture.error === undefined
    ? undefined
    : record(capture.error);
  const errorCode = optionalTextField(error, 'code');
  if (errorCode !== undefined && !SAFE_ERROR_CODE.test(errorCode)) {
    throw new InvalidShapeError();
  }
  const retryable = error?.retryable;
  if (retryable !== undefined && typeof retryable !== 'boolean') {
    throw new InvalidShapeError();
  }
  return {
    status,
    stage,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(retryable === undefined ? {} : { retryable }),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidShapeError();
  }
  return value as Record<string, unknown>;
}

function textField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !isSafeNonEmptyText(field, 256)) {
    throw new InvalidShapeError();
  }
  return field;
}

function optionalTextField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (value === undefined || value[key] === null || value[key] === undefined) {
    return undefined;
  }
  return textField(value, key);
}

function textArray(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  if (!Array.isArray(field) || field.length > 64) throw new InvalidShapeError();
  return field.map((item) => {
    if (!isSafeNonEmptyText(typeof item === 'string' ? item : undefined, 128)) {
      throw new InvalidShapeError();
    }
    return item;
  });
}

function uniqueAllowedArray(
  value: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
): string[] {
  const items = textArray(value, key);
  if (
    new Set(items).size !== items.length ||
    items.some((item) => !allowed.has(item))
  ) {
    throw new InvalidShapeError();
  }
  return items.sort();
}

export function classifyBoundarySample(
  sample: BoundarySample,
): BoundaryDoctorVerdict {
  const allObservations: Array<Observation<unknown>> = [
    sample.certPrep.ready,
    sample.certPrep.requirements,
    sample.captureRuntime.ready,
    sample.captureRuntime.requirements,
  ];
  if (sample.certPrep.operation !== undefined) {
    allObservations.push(sample.certPrep.operation);
  }
  if (sample.captureRuntime.capture !== undefined) {
    allObservations.push(sample.captureRuntime.capture);
  }
  if (allObservations.some(isAuthenticationFailure)) {
    return verdict(
      'unknown',
      'authentication_failed',
      'At least one endpoint rejected its bearer credential.',
    );
  }

  const certBaseHealthy =
    sample.certPrep.ready.ok && sample.certPrep.requirements.ok;
  const runtimeBaseHealthy =
    sample.captureRuntime.ready.ok && sample.captureRuntime.requirements.ok;
  if (!certBaseHealthy && !runtimeBaseHealthy) {
    return verdict(
      'capture-runtime',
      'runtime_unavailable',
      'The direct runtime and the Cert Prep runtime proxy are both unavailable.',
    );
  }
  if (!certBaseHealthy && runtimeBaseHealthy) {
    return verdict(
      'cert-prep',
      'proxy_unavailable',
      'Capture Runtime is directly readable but its Cert Prep proxy is unavailable.',
    );
  }
  if (certBaseHealthy && !runtimeBaseHealthy) {
    return verdict(
      'boundary',
      'direct_runtime_unavailable',
      'Cert Prep reports runtime state but the configured direct runtime endpoint is unavailable.',
    );
  }

  if (
    sample.certPrep.ready.ok &&
    sample.captureRuntime.ready.ok &&
    sample.certPrep.requirements.ok &&
    sample.captureRuntime.requirements.ok &&
    (!equivalent(sample.certPrep.ready.value, sample.captureRuntime.ready.value) ||
      !equivalent(
        sample.certPrep.requirements.value,
        sample.captureRuntime.requirements.value,
      ))
  ) {
    return verdict(
      'boundary',
      'snapshot_mismatch',
      'The proxy and direct runtime expose different identity, capability, or requirement snapshots.',
    );
  }

  const operation = sample.certPrep.operation;
  const capture = sample.captureRuntime.capture;
  if (operation === undefined && capture === undefined) {
    return verdict(
      'healthy',
      'boundary_healthy',
      'The Cert Prep proxy and direct Capture Runtime snapshots match.',
    );
  }
  if (operation === undefined || capture === undefined) {
    return verdict(
      'unknown',
      'incomplete_correlation',
      'The correlated job observations are incomplete.',
    );
  }
  if (!operation.ok && capture.ok) {
    return verdict(
      isNotFound(operation) ? 'unknown' : 'cert-prep',
      isNotFound(operation) ? 'operation_not_found' : 'operation_unavailable',
      isNotFound(operation)
        ? 'The requested Cert Prep operation was not found.'
        : 'The runtime capture is readable but the Cert Prep operation is unavailable.',
    );
  }
  if (operation.ok && !capture.ok) {
    if (isNotFound(capture) && operation.value.status === 'succeeded') {
      return verdict(
        'healthy',
        'runtime_job_ephemeral_after_success',
        'Cert Prep completed successfully and the ephemeral runtime job is no longer retained.',
      );
    }
    return verdict(
      'unknown',
      isNotFound(capture)
        ? 'capture_not_found_while_operation_present'
        : 'capture_unavailable',
      isNotFound(capture)
        ? 'The requested runtime capture was not found while the Cert Prep operation remains observable.'
        : 'The Cert Prep operation is readable but the runtime capture is unavailable.',
    );
  }
  if (!operation.ok || !capture.ok) {
    return verdict(
      'unknown',
      'correlation_unavailable',
      'Neither correlated job endpoint produced a readable snapshot.',
    );
  }

  const operationStatus = operation.value.status;
  const captureStatus = capture.value.status;
  const operationIsActive = OPERATION_ACTIVE.has(operationStatus);
  const operationIsTerminal = OPERATION_TERMINAL.has(operationStatus);
  const captureIsActive = CAPTURE_ACTIVE.has(captureStatus);
  const captureIsTerminal = CAPTURE_TERMINAL.has(captureStatus);

  if (captureIsTerminal && operationIsActive) {
    return verdict(
      'cert-prep',
      'runtime_terminal_operation_active',
      'Capture Runtime is terminal while Cert Prep still reports active work.',
    );
  }
  if (operationIsTerminal && captureIsActive) {
    return verdict(
      'cert-prep',
      'operation_terminal_runtime_active',
      'Cert Prep is terminal while Capture Runtime still reports active work.',
    );
  }
  if (operationIsActive && captureIsActive) {
    return verdict(
      'in-progress',
      'correlated_work_in_progress',
      'Both layers report active correlated work.',
    );
  }
  if (operationStatus === 'succeeded' && captureStatus === 'completed') {
    return verdict(
      'healthy',
      'terminal_success_consistent',
      'Both layers report successful completion.',
    );
  }
  if (operationStatus === 'canceled' && captureStatus === 'cancelled') {
    return verdict(
      'healthy',
      'cancellation_consistent',
      'Both layers report cancellation.',
    );
  }
  if (operationStatus === 'failed' && captureStatus === 'failed') {
    return verdict(
      'capture-runtime',
      'runtime_job_failed',
      'Cert Prep propagated the Capture Runtime job failure.',
    );
  }
  return verdict(
    'cert-prep',
    'terminal_state_mismatch',
    'The terminal Cert Prep and Capture Runtime states are inconsistent.',
  );
}

function verdict(
  owner: Owner,
  code: string,
  detail: string,
): BoundaryDoctorVerdict {
  return { owner, code, detail };
}

function equivalent(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isAuthenticationFailure(observation: Observation<unknown>): boolean {
  return (
    !observation.ok &&
    observation.error.kind === 'http' &&
    (observation.error.status === 401 || observation.error.status === 403)
  );
}

function isNotFound(observation: Observation<unknown>): boolean {
  return (
    !observation.ok &&
    observation.error.kind === 'http' &&
    observation.error.status === 404
  );
}

function bothCorrelatedJobsTerminal(sample: BoundarySample): boolean {
  const operation = sample.certPrep.operation;
  const capture = sample.captureRuntime.capture;
  return Boolean(
    operation?.ok &&
      capture?.ok &&
      OPERATION_TERMINAL.has(operation.value.status) &&
      CAPTURE_TERMINAL.has(capture.value.status),
  );
}

function sampleProgress(index: number, sample: BoundarySample): string {
  const certPrepState =
    sample.certPrep.ready.ok && sample.certPrep.requirements.ok ? 'ok' : 'fault';
  const runtimeState =
    sample.captureRuntime.ready.ok && sample.captureRuntime.requirements.ok
      ? 'ok'
      : 'fault';
  return `[capture-boundary-doctor] sample=${index} cert-prep=${certPrepState} capture-runtime=${runtimeState}`;
}

export function serializeBoundaryDoctorReport(
  report: BoundaryDoctorReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export async function runBoundaryDoctorCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  dependencies: BoundaryDoctorDependencies = defaultDependencies,
): Promise<number> {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(usage());
    return 0;
  }
  try {
    const options = parseBoundaryDoctorArgs(argv, env);
    const report = await runBoundaryDoctor(options, dependencies);
    process.stdout.write(serializeBoundaryDoctorReport(report));
    return ['healthy', 'in-progress'].includes(report.verdict.owner) ? 0 : 2;
  } catch (error) {
    if (error instanceof BoundaryDoctorConfigError) {
      process.stderr.write(`configuration_error: ${error.message}\n`);
    } else {
      process.stderr.write('boundary_doctor_error: diagnostic collection failed\n');
    }
    return 1;
  }
}

function usage(): string {
  return [
    'Capture boundary doctor (read-only, attach-only)',
    '',
    'Usage:',
    '  pnpm nx run capture-tools:boundary-doctor -- --cert-prep-url http://127.0.0.1:8765 --runtime-url http://127.0.0.1:8766 [options]',
    '  pnpm nx run capture-tools:boundary-doctor --args="--help"',
    '',
    'Secrets (environment only):',
    '  CAPTURE_BOUNDARY_CERT_PREP_TOKEN',
    '  CAPTURE_BOUNDARY_RUNTIME_TOKEN',
    '',
    'Correlation options (all or none):',
    '  --project-id VALUE --operation-id VALUE --capture-id VALUE',
    '',
    'Polling options:',
    '  --watch-seconds 0..3600 --interval-ms 250..10000 --request-timeout-ms 250..30000',
    '  --output PATH',
    '',
  ].join('\n');
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  process.exitCode = await runBoundaryDoctorCli(process.argv.slice(2), process.env);
}
