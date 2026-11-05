import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { catchError, defer, tap, throwError, type Observable } from 'rxjs';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export const installedSmokeDiagnosticRedactionMarker =
  '[redacted unsafe diagnostic]';
export const installedSmokeDiagnosticMessageLimit = 512;
const installedSmokeDiagnosticCountLimit = 32;
const sensitiveDiagnosticFragments = [
  'authorization',
  'bearer',
  'secret',
  'token',
];

function containsSensitiveDiagnosticLabel(value) {
  const compactOriginal = value.toLowerCase().replace(/[^a-z\d]+/gu, '');
  return sensitiveDiagnosticFragments.some((fragment) =>
    compactOriginal.includes(fragment),
  );
}

function containsAbsoluteWindowsPath(value) {
  const substringCandidates = [
    ...value.matchAll(/[A-Za-z]:[\\/]/gu),
    ...value.matchAll(/[\\/]{2}[^\\/\s]+[\\/][^\\/\s]+/gu),
    ...value.matchAll(
      /(?:^|[\s"'`()[\]{}<>,;=:])(?<rooted>[\\/](?![\\/])[^\\/\s]+)/gu,
    ),
  ];
  return substringCandidates.some((match) =>
    win32.isAbsolute(match.groups?.['rooted'] ?? value.slice(match.index)),
  );
}

function redactAbsolutePathFragments(value) {
  return value
    .replace(
      /[A-Za-z]:[\\/][^\s"'`<>|]+/gu,
      installedSmokeDiagnosticRedactionMarker,
    )
    .replace(
      /\\\\[^\\/\s]+[\\/][^\s"'`<>|]+/gu,
      installedSmokeDiagnosticRedactionMarker,
    )
    .replace(
      /(?:^|[\s"'`()[\]{}<>,;=:])[\\/](?![\\/])[^\s"'`<>|]+/gu,
      (match) =>
        match.slice(0, match.length - match.trimStart().length) +
        installedSmokeDiagnosticRedactionMarker,
    );
}

export function sanitizedDiagnosticMessage(error) {
  const raw = errorMessage(error);
  if (containsSensitiveDiagnosticLabel(raw)) {
    return installedSmokeDiagnosticRedactionMarker;
  }
  const normalized = raw.replace(/\b[a-f\d]{32,}\b/giu, installedSmokeDiagnosticRedactionMarker)
    .replace(/\s+/gu, ' ').trim();
  // These contain no user-controlled identifiers or filesystem paths.
  if (/^\/v2\/(?:health\/ready|runtime\/(?:requirements|model-options|(?:model-)?installations(?:\/\{installationId\}(?:\/cancel)?)?)|ingestions(?:\/\{ingestionId\}(?:\/finalize|\/chunks\/\{chunkIndex\})?)?|captures(?:\/\{captureId\}(?:\/(?:raw|result|structure|ocr|partial|events|cancel))?)?)$/u.test(normalized)) return normalized;
  const redacted = containsAbsoluteWindowsPath(normalized)
    ? redactAbsolutePathFragments(normalized)
    : normalized;
  if (redacted.length <= installedSmokeDiagnosticMessageLimit) return redacted;
  return `${redacted.slice(0, installedSmokeDiagnosticMessageLimit - 3)}...`;
}

export function nestedErrorMessages(error) {
  const messages = [];
  const visited = new Set();
  const visit = (candidate) => {
    if (messages.length >= installedSmokeDiagnosticCountLimit) return;
    if (visited.has(candidate)) return;
    if (
      (typeof candidate === 'object' && candidate !== null) ||
      typeof candidate === 'function'
    ) {
      visited.add(candidate);
    }
    messages.push(sanitizedDiagnosticMessage(candidate));
    if (candidate instanceof Error && candidate.cause !== undefined) visit(candidate.cause);
    if (candidate instanceof AggregateError) {
      for (const cause of candidate.errors) visit(cause);
    }
  };
  visit(error);
  return messages;
}

export interface SmokeStepEvent {
  step: string;
  timestamp: string;
  outcome: 'started' | 'passed' | 'failed' | 'skipped';
}

export interface SmokeCardDiagnostic {
  fileName: string;
  status: string | null;
  detailErrors: string[];
}

export function trackSmokeStep<T>(
  timeline: SmokeStepEvent[], step: string, operation: () => Observable<T>,
): Observable<T> {
  return defer(() => {
    timeline.push({ step, timestamp: new Date().toISOString(), outcome: 'started' });
    return defer(operation).pipe(
      tap(() => timeline.push({ step, timestamp: new Date().toISOString(), outcome: 'passed' })),
      catchError((error) => {
        timeline.push({ step, timestamp: new Date().toISOString(), outcome: 'failed' });
        return throwError(() => error);
      }),
    );
  });
}

const installedSteps = ['install', 'launch', 'WebView2 connect', 'page found', 'source picker', 'card visible', 'completion wait'];

export function buildInstalledSmokeFailureReport({
  error, timeline = [] as SmokeStepEvent[], webViewDiagnostics = '',
  cardDiagnostics = [] as SmokeCardDiagnostic[], requestLogLines = [] as string[],
  timestamp = new Date().toISOString(),
  realAppDataGuard = undefined as {
    status: 'not-started' | 'recorded' | 'passed' | 'failed';
    before?: import('./installed-app-data-guard.ts').AppDataSnapshot;
    after?: import('./installed-app-data-guard.ts').AppDataSnapshot;
  } | undefined,
}) {
  const events = [...timeline];
  for (const step of installedSteps) {
    if (!events.some((event) => event.step === step)) {
      events.push({ step, timestamp, outcome: 'skipped' });
    }
  }
  return {
    timestamp: sanitizedDiagnosticMessage(timestamp),
    timeline: events.map((event) => ({
      step: sanitizedDiagnosticMessage(event.step),
      timestamp: sanitizedDiagnosticMessage(event.timestamp),
      outcome: sanitizedDiagnosticMessage(event.outcome),
    })),
    errors: nestedErrorMessages(error),
    ...(realAppDataGuard ? { realAppDataGuard } : {}),
    webViewDiagnostics: sanitizedDiagnosticMessage(webViewDiagnostics),
    cardDiagnostics: cardDiagnostics.map((card) => ({
      fileName: sanitizedDiagnosticMessage(card.fileName),
      status: card.status === null ? null : sanitizedDiagnosticMessage(card.status),
      detailErrors: card.detailErrors.map(sanitizedDiagnosticMessage),
    })),
    requestLogLines: requestLogLines.map(sanitizedRequestLogLine),
  };
}

function sanitizedRequestLogLine(line: string): string {
  // Project only logger fields, then sanitize every string individually. In
  // particular, never persist an unexpected header/body field from a corrupt log.
  try {
    const value = JSON.parse(line);
    return JSON.stringify({
      timestamp: typeof value.timestamp === 'number' ? value.timestamp : sanitizedDiagnosticMessage(value.timestamp),
      method: sanitizedDiagnosticMessage(value.method),
      route: sanitizedDiagnosticMessage(value.route),
      status: typeof value.status === 'number' ? value.status : sanitizedDiagnosticMessage(value.status),
      ...(value.errorCode === undefined ? {} : { errorCode: sanitizedDiagnosticMessage(value.errorCode) }),
    });
  } catch {
    return installedSmokeDiagnosticRedactionMarker;
  }
}

export function readSmokeRequestLog(path: string) {
  return readFile(path, 'utf8').then(
    (contents) => contents.split(/\r?\n/u).filter(Boolean),
    (error) => error?.code === 'ENOENT' ? []
      : [JSON.stringify({ errorCode: sanitizedDiagnosticMessage(error) })],
  );
}

export function writeSmokeFailureReport(
  root: string, report: ReturnType<typeof buildInstalledSmokeFailureReport>,
  prefix = 'installed-smoke-failure', timestamp = new Date(),
) {
  if (!['installed-smoke-failure', 'smoke-failure'].includes(prefix)) {
    throw new Error('Unsupported smoke failure report prefix.');
  }
  const stamp = timestamp.toISOString().replace(/[:.]/gu, '-');
  const destination = join(root, `${prefix}-${stamp}.json`);
  const written = writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const pattern = new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z\\.json$`, 'u');
  return written.then(() => readdir(root, { withFileTypes: true })).then((entries) => {
    const reports = entries.filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => entry.name).sort().reverse();
    return reports.slice(3).reduce(
      (cleanup, name) => cleanup.then(() => unlink(join(root, name))), written,
    ).then(() => destination);
  });
}
