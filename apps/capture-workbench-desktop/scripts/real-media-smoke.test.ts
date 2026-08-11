import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertRealMediaEvidence,
  assertRealMediaRequirementsAvailable,
  dependencyOrder,
  expectedProvenanceFromSourceLock,
  observeKnownRuntimeProcesses,
  observeOwnedRuntimeTree,
  parseOwnedRuntimeEvidence,
  runtimeEnvironment,
} from './real-media-smoke.ts';

const unavailableCatalog = {
  catalogVersion: '2',
  runtimeVersion: '0.3.8',
  requirements: dependencyOrder.map((requirementId) => ({
    requirementId,
    artifacts: [],
    modelFiles: null,
    unavailableReason: `${requirementId} is not published`,
  })),
};

function modelEnabledCatalog(runtimeVersion = '0.3.11') {
  return {
    catalogVersion: '2',
    runtimeVersion,
    requirements: dependencyOrder.map((requirementId) => ({
      requirementId,
      artifacts: [{ fileName: `${requirementId}.zip` }],
      modelFiles: { entryPoint: 'model' },
      unavailableReason: null,
    })),
  };
}

test('real-media preflight names every unavailable requirement', () => {
  assert.throws(
    () =>
      assertRealMediaRequirementsAvailable(
        {
          approval: {
            approvedAt: null,
            approvedBy: null,
            blockers: ['approval remains blocked'],
            status: 'blocked',
          },
          requirements: [],
        },
        unavailableCatalog,
      ),
    (error: unknown) => {
      assert.match(
        error instanceof Error ? error.message : String(error),
        /before release-artifact build or app startup/u,
      );
      assert.match(
        error instanceof Error ? error.message : String(error),
        /unavailable requirements: windowsml-ocr \([\s\S]*whisper-primary/u,
      );
      assert.match(
        error instanceof Error ? error.message : String(error),
        /embedded engine catalog marks it unavailable/u,
      );
      return true;
    },
  );
});

test('approved model-enabled lock preserves the generated-catalog path', () => {
  assert.doesNotThrow(() =>
    assertRealMediaRequirementsAvailable(
      {
        approval: { blockers: [], status: 'approved' },
        releaseVersion: '0.3.11',
        requirements: dependencyOrder.map((requirementId) => ({
          requirementId,
        })),
      },
      modelEnabledCatalog(),
    ),
  );
});

test('model-enabled preflight rejects immutable v0.3.8', () => {
  assert.throws(
    () =>
      assertRealMediaRequirementsAvailable(
        {
          approval: { blockers: [], status: 'approved' },
          releaseVersion: '0.3.8',
          requirements: dependencyOrder.map((requirementId) => ({
            requirementId,
          })),
        },
        modelEnabledCatalog('0.3.8'),
      ),
    /unused successor version.*v0\.3\.8 is immutable core-only/u,
  );
});

test('real-media runtime environment removes ambient provider and model overrides', () => {
  const environment = runtimeEnvironment(
    'C:\\owned-app-data',
    43123,
    't'.repeat(64),
    {
      ocrModel: 'pp-ocrv6-medium-windowsml',
      whisperModel: 'small',
      whisperDevice: 'cpu',
      whisperPreferGpu: true,
    },
    {
      PATH: 'C:\\Windows\\System32',
      CAPTURE_EXTRACTION_PROVIDER: 'fake',
      CAPTURE_WINDOWSML_MODEL_DIR: 'C:\\ambient-ocr',
      CAPTURE_WHISPER_MODELS_DIR: 'C:\\ambient-whisper',
      CAPTURE_REAL_MEDIA_PDF: 'C:\\secret-fixture.pdf',
      OLLAMA_MODELS: 'C:\\ambient-ollama',
    },
  );

  assert.equal(environment.PATH, 'C:\\Windows\\System32');
  assert.equal(environment.CAPTURE_EXTRACTION_PROVIDER, 'runtime');
  assert.equal(environment.CAPTURE_WINDOWSML_MODEL_DIR, undefined);
  assert.equal(environment.CAPTURE_WHISPER_MODELS_DIR, undefined);
  assert.equal(environment.CAPTURE_REAL_MEDIA_PDF, undefined);
  assert.equal(environment.OLLAMA_MODELS, undefined);
  assert.equal(environment.CAPTURE_WHISPER_PREFER_GPU, 'true');
});

test('source-lock Whisper role is the production worker model provenance', () => {
  const expected = expectedProvenanceFromSourceLock({
    fixtures: [
      {
        kind: 'ocr',
        expectedEngine: 'windowsml-ocr',
        expectedModel: 'pp-ocrv6-medium-windowsml',
        expectedDevice: 'windowsml-dml',
      },
      {
        kind: 'whisper',
        expectedEngine: 'whisper-primary',
        expectedModel: 'fallback',
        expectedDevice: 'cpu',
        preferGpu: true,
      },
    ],
  });

  assert.equal(expected.whisperModel, 'fallback');
  assert.equal(expected.whisperDevice, 'cpu');
  assert.equal(expected.whisperPreferGpu, true);
});

test('owned runtime evidence keeps descendant and listener identities bounded', () => {
  assert.deepEqual(
    parseOwnedRuntimeEvidence({
      pids: [10, 11],
      listeners: [{ pid: 11, port: 43123 }],
    }),
    {
      pids: [10, 11],
      listeners: [{ pid: 11, port: 43123 }],
    },
  );
  assert.throws(
    () => parseOwnedRuntimeEvidence({ pids: [10], listeners: [{ pid: 11 }] }),
    /listener port was invalid/u,
  );
});

test(
  'Windows owned runtime observer captures and rechecks the exact process identity',
  { skip: process.platform !== 'win32' },
  () => {
    const tree = observeOwnedRuntimeTree(process.pid);
    assert.ok(tree.pids.includes(process.pid));
    const known = observeKnownRuntimeProcesses([process.pid]);
    assert.deepEqual(known.pids, [process.pid]);
  },
);

test('real-media diagnostic cannot claim release or consumer E2E acceptance', () => {
  assert.doesNotThrow(() =>
    assertRealMediaEvidence({
      evidenceKind: 'real-core-first-media-diagnostic',
      releaseGateSatisfied: false,
      consumerE2e: false,
      dependencyOrder,
      pdf: {
        extractionEngine: 'windowsml-ocr',
        model: 'pp-ocrv6-medium-windowsml',
        device: 'windowsml-dml',
        segmentCount: 1,
        pageLocators: 1,
      },
      image: {
        extractionEngine: 'windowsml-ocr',
        model: 'pp-ocrv6-medium-windowsml',
        device: 'windowsml-dml',
        segmentCount: 1,
        pageLocators: 1,
      },
      audio: {
        extractionEngine: 'whisper-primary',
        model: 'small',
        device: 'cpu',
        segmentCount: 1,
        timeLocators: 1,
      },
      hostStructuring: true,
      capturesDeletedAfterVerification: true,
      ownedProcessCleanupVerified: true,
    }),
  );
});

test('real-media target preflights before product runtime staging', async () => {
  const project = JSON.parse(
    await readFile(new URL('../project.json', import.meta.url), 'utf8'),
  ) as {
    readonly targets: {
      readonly ['smoke-real-media']: {
        readonly dependsOn?: unknown;
        readonly executor?: unknown;
        readonly options: {
          readonly commands: readonly string[];
          readonly parallel: boolean;
        };
      };
    };
  };
  const target = project.targets['smoke-real-media'];
  assert.equal(target.dependsOn, undefined);
  assert.equal(target.executor, 'nx:run-commands');
  assert.deepEqual(target.options.commands, [
    'node apps/capture-workbench-desktop/scripts/real-media-smoke.ts --preflight',
    'corepack pnpm nx run capture-workbench-desktop:stage-product-runtime',
    'node apps/capture-workbench-desktop/scripts/real-media-smoke.ts',
  ]);
  assert.equal(target.options.parallel, false);
});
