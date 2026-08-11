import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  Observable,
  catchError,
  concatMap,
  defer,
  from,
  map,
  throwError,
  toArray,
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
  validateReady,
  verifyHostStructuring,
  verifyRequirements,
  verifyRequestPolicy,
  verifyRuntimeCapture,
} from './deterministic-http.ts';
import {
  launchReadyRuntime,
  terminateOwnedTree,
} from './deterministic-runtime-launcher.ts';

const workspaceRoot = resolve(appRoot, '..', '..');
const outputDirectory = join(
  workspaceRoot,
  'tmp',
  'capture-workbench-desktop',
  'smoke',
);
const runtimeData = join(outputDirectory, 'runtime-data');
const maxUploadBytes = DETERMINISTIC_MAX_UPLOAD_BYTES;
const schemaVersion = DETERMINISTIC_SCHEMA_VERSION;
const fixtures = DETERMINISTIC_FIXTURES;

export function runDeterministicSmoke(): Observable<{ report: unknown; reportPath: string }> {
  return assertStagedRuntime('deterministic').pipe(
    concatMap(() => defer(() => from(rm(outputDirectory, { recursive: true, force: true })))),
    concatMap(() => defer(() => from(mkdir(join(runtimeData, 'ollama', 'models'), { recursive: true })))),
    concatMap(() => launchReadyRuntime()),
    concatMap(({ child, ready, runtimePort, ollamaPort, token, host, origin }) => {
      const context = { runtimePort, host, origin, token };
      validateReady(ready);
      return verifyRequestPolicy(context).pipe(
        concatMap((policyEvidence) =>
          verifyRequirements(context).pipe(
            concatMap((requirementEvidence) =>
              from(fixtures).pipe(
                concatMap((fixture) => verifyRuntimeCapture(context, fixture)),
                toArray(),
                concatMap((captures) =>
                  verifyHostStructuring(context, fixtures[1]).pipe(
                    map((hostStructuring) => ({
                      policyEvidence,
                      requirementEvidence,
                      captures,
                      hostStructuring,
                    })),
                  ),
                ),
              ),
            ),
          ),
        ),
        map(({ policyEvidence, requirementEvidence, captures, hostStructuring }) => {
          const report = {
      evidenceKind: 'deterministic-sidecar-smoke',
      releaseGateSatisfied: false,
      canonicalWire: {
        apiVersion: '1.0',
        schemaVersion,
        captureRequest: 'v2-ingestions',
        captureIdField: true,
        rawDiagnosticOnly: true,
        events: true,
        eventStream: {
          contentType: 'text/event-stream',
          terminalLast: true,
          cursorReplay: true,
          resyncRequired: true,
        },
      },
      runtimePortIsDynamic: runtimePort > 0,
      ollamaPortIsIndependent: ollamaPort !== runtimePort,
      maxUploadBytes,
            authentication: policyEvidence,
            requirements: requirementEvidence,
            captures,
            hostStructuring,
      disclaimer:
        'Deterministic fixture only; packaged UI automation is diagnostic and does not certify real OCR/STT/Ollama behavior.',
          };
          assertRedactedEvidence(report);
          return { report, reportPath: join(outputDirectory, 'smoke.json'), child };
        }),
        concatMap(({ report, reportPath, child }) =>
          defer(() => from(writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'))).pipe(
            concatMap(() => terminateOwnedTree(child)),
            map(() => ({ report, reportPath })),
          ),
        ),
        catchError((error: unknown) =>
          terminateOwnedTree(child).pipe(
            concatMap(() => throwError(() => error)),
          ),
        ),
      );
    }),
  );
}

runDeterministicSmoke().subscribe({
  next: ({ reportPath }) => {
    process.stdout.write(`Deterministic sidecar smoke report: ${reportPath}\n`);
  },
  error: (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  },
});
