import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

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

export async function runDeterministicSmoke() {
  await assertStagedRuntime('deterministic');
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(join(runtimeData, 'ollama', 'models'), { recursive: true });
  const launched = await launchReadyRuntime();
  const { child, ready, runtimePort, ollamaPort, token, host, origin } = launched;

  try {
    validateReady(ready);
    const policyEvidence = await verifyRequestPolicy({
      runtimePort,
      host,
      origin,
      token,
    });
    const requirementEvidence = await verifyRequirements({
      runtimePort,
      host,
      origin,
      token,
    });
    const captures = [];
    for (const fixture of fixtures) {
      captures.push(
        await verifyRuntimeCapture(
          { runtimePort, host, origin, token },
          fixture,
        ),
      );
    }
    const hostStructuring = await verifyHostStructuring(
      { runtimePort, host, origin, token },
      fixtures[1],
    );

    const report = {
      evidenceKind: 'deterministic-sidecar-smoke',
      releaseGateSatisfied: false,
      canonicalWire: {
        apiVersion: '1.0',
        schemaVersion,
        captureRequest: 'multipart/form-data',
        captureIdField: true,
        rawDiagnosticOnly: true,
      },
      runtimePortIsDynamic: runtimePort > 0,
      ollamaPortIsIndependent: ollamaPort !== runtimePort,
      maxUploadBytes,
      authentication: policyEvidence,
      requirements: requirementEvidence,
      captures,
      hostStructuring,
      disclaimer:
        'Deterministic fixture only; packaged UI automation and real OCR/STT/Ollama clean-install evidence are separate release gates.',
    };
    assertRedactedEvidence(report);
    const reportPath = join(outputDirectory, 'smoke.json');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return { report, reportPath };
  } finally {
    await terminateOwnedTree(child);
  }
}

runDeterministicSmoke()
  .then(({ reportPath }) => {
    process.stdout.write(`Deterministic sidecar smoke report: ${reportPath}\n`);
  })
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
