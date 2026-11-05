import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import {
  Observable, catchError, concatMap, defer, dematerialize, endWith, from,
  ignoreElements, map, materialize, take, throwError, throwIfEmpty, toArray,
} from 'rxjs';

import { assertStagedRuntime } from './assert-staged-runtime.ts';
import {
  DETERMINISTIC_FIXTURES,
  DETERMINISTIC_MAX_UPLOAD_BYTES,
  DETERMINISTIC_SCHEMA_VERSION,
} from './constants/deterministic.ts';
import { appRoot } from './stage-runtime.ts';
import { assertRedactedEvidence } from './package-qa.ts';
import {
  validateReady, verifyHostStructuring, verifyRequirements,
  verifyRequestPolicy, verifyRuntimeCapture,
} from './deterministic-http.ts';
import { launchReadyRuntime, terminateOwnedTree } from './deterministic-runtime-launcher.ts';
import {
  buildInstalledSmokeFailureReport, nestedErrorMessages,
  readSmokeRequestLog, writeSmokeFailureReport,
} from './smoke-diagnostics.ts';

const workspaceRoot = resolve(appRoot, '..', '..');
const outputDirectory = join(workspaceRoot, 'tmp', 'capture-workbench-desktop', 'smoke');
const runtimeData = join(outputDirectory, 'runtime-data');
const requestLogPath = join(outputDirectory, 'runtime-requests.jsonl');
const schemaVersion = DETERMINISTIC_SCHEMA_VERSION;
const fixtures = DETERMINISTIC_FIXTURES;

// Stop the owned runtime before emitting either evidence or an operation error.
export function withOwnedRuntime<T>(
  child: ChildProcess, operation: () => Observable<T>, stop = terminateOwnedTree,
): Observable<T> {
  return defer(operation).pipe(
    take(1),
    throwIfEmpty(),
    materialize(),
    take(1),
    concatMap((notification) => defer(() => stop(child)).pipe(
      ignoreElements(),
      endWith(notification),
      catchError((cleanupError) => throwError(() => notification.kind === 'E'
        ? new AggregateError([notification.error, cleanupError], 'Deterministic smoke and runtime cleanup failed.')
        : cleanupError)),
    )),
    dematerialize(),
  );
}

export function runDeterministicSmoke(): Observable<{ report: unknown; reportPath: string }> {
  return defer(() => from(mkdir(outputDirectory, { recursive: true }))).pipe(
    concatMap(() => assertStagedRuntime('deterministic').pipe(
      concatMap(() => defer(() => from(rm(runtimeData, { recursive: true, force: true })))),
      concatMap(() => defer(() => from(rm(requestLogPath, { force: true })))),
      concatMap(() => defer(() => from(rm(join(outputDirectory, 'smoke.json'), { force: true })))),
      concatMap(() => defer(() => from(mkdir(join(runtimeData, 'ollama', 'models'), { recursive: true })))),
      concatMap(() => launchReadyRuntime(requestLogPath)),
      concatMap(({ child, ready, runtimePort, ollamaPort, token, host, origin }) => {
        const context = { runtimePort, host, origin, token };
        return withOwnedRuntime(child, () => {
          validateReady(ready);
          return verifyRequestPolicy(context).pipe(
            concatMap((policyEvidence) => verifyRequirements(context).pipe(
              concatMap((requirementEvidence) => from(fixtures).pipe(
                concatMap((fixture) => verifyRuntimeCapture(context, fixture)),
                toArray(),
                concatMap((captures) => verifyHostStructuring(context, fixtures[1]).pipe(
                  map((hostStructuring) => ({ policyEvidence, requirementEvidence, captures, hostStructuring })),
                )),
              )),
            )),
            concatMap(({ policyEvidence, requirementEvidence, captures, hostStructuring }) => {
              const report = {
                evidenceKind: 'deterministic-sidecar-smoke', releaseGateSatisfied: false,
                canonicalWire: {
                  apiVersion: '2.0', schemaVersion, captureRequest: 'application/json',
                  ingestionUpload: 'application/octet-stream', ingestionFinalization: true,
                  captureIdField: true, resultEnvelope: true, rawDiagnosticOnly: true,
                },
                runtimePortIsDynamic: runtimePort > 0,
                ollamaPortIsIndependent: ollamaPort !== runtimePort,
                maxUploadBytes: DETERMINISTIC_MAX_UPLOAD_BYTES,
                authentication: policyEvidence, requirements: requirementEvidence,
                captures, hostStructuring,
                disclaimer: 'Deterministic fixture only; packaged UI automation is diagnostic and does not certify real OCR/STT/Ollama behavior.',
              };
              assertRedactedEvidence(report);
              const reportPath = join(outputDirectory, 'smoke.json');
              return defer(() => from(writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'))).pipe(
                map(() => ({ report, reportPath })),
              );
            }),
          );
        });
      }),
      catchError((error) => defer(() => from(readSmokeRequestLog(requestLogPath))).pipe(
        concatMap((requestLogLines) => defer(() => from(writeSmokeFailureReport(
          outputDirectory, buildInstalledSmokeFailureReport({ error, requestLogLines }), 'smoke-failure',
        )))),
        catchError((reportError) => throwError(() => new AggregateError(
          [error, reportError], 'Deterministic smoke failed and its failure report could not be written.',
        ))),
        concatMap(() => throwError(() => error)),
      )),
    )),
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runDeterministicSmoke().subscribe({
    next: ({ reportPath }) => process.stdout.write(`Deterministic sidecar smoke report: ${reportPath}\n`),
    error: (error: unknown) => {
      process.stderr.write(`${nestedErrorMessages(error).join('\n')}\n`);
      process.exitCode = 1;
    },
  });
}
