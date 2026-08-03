import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertNoAmbientModelOverrides,
  assertRealMediaModelEvidence,
  canonicalJson,
  REAL_MODEL_CATALOG_VERSION,
  REAL_MODEL_DEPENDENCY_ORDER_SCOPE,
  REAL_MODEL_RELEASE_VERSION,
  sha256,
} from './real-media-model-smoke.ts';

const digest = 'a'.repeat(64);

function validEvidence() {
  return {
    evidenceKind: 'real-model-enabled-tauri-ui-smoke',
    releaseGateSatisfied: true,
    consumerE2e: false,
    runtimeVersion: REAL_MODEL_RELEASE_VERSION,
    catalogVersion: REAL_MODEL_CATALOG_VERSION,
    sourceLockSha256: digest,
    catalogSha256: digest,
    modelDependencyOrder: ['windowsml-ocr', 'whisper-primary'],
    modelDependencyOrderScope: REAL_MODEL_DEPENDENCY_ORDER_SCOPE,
    media: [
      {
        sourceKind: 'pdf',
        sourceSha256: digest,
        extractionEngine: 'windowsml-ocr',
        model: 'pp-ocrv6-medium-windowsml',
        device: 'windowsml-dml',
        engineDigest: `sha256:${digest}`,
        segmentCount: 1,
        pageLocators: 1,
        durationMs: 100,
      },
      {
        sourceKind: 'image',
        sourceSha256: digest,
        extractionEngine: 'windowsml-ocr',
        model: 'pp-ocrv6-medium-windowsml',
        device: 'windowsml-dml',
        engineDigest: `sha256:${digest}`,
        segmentCount: 1,
        pageLocators: 1,
        durationMs: 100,
      },
      {
        sourceKind: 'audio',
        sourceSha256: digest,
        extractionEngine: 'whisper-primary',
        model: 'lock-selected-whisper',
        device: 'windowsml-dml',
        engineDigest: `sha256:${digest}`,
        segmentCount: 2,
        timeLocators: 2,
        durationMs: 100,
      },
    ],
    rawVisible: true,
    resultVisible: true,
    consentedInstallation: true,
    capturesDeletedAfterVerification: true,
    ownedProcessCleanupVerified: true,
    cdpPortReleased: true,
    candidateMirrorUsed: true,
    candidateMirrorReleased: true,
    isolatedAppDataUsed: true,
  } as const;
}

test('real model evidence is release-gated, provenance-bound, and private', () => {
  assert.doesNotThrow(() => assertRealMediaModelEvidence(validEvidence()));
  const serialized = JSON.stringify(validEvidence());
  assert.doesNotMatch(serialized, /(?:sourceText|expectedText|transcript|token|secret)/iu);
});

test('real model evidence rejects CPU OCR and path leakage', () => {
  const cpuOcr = structuredClone(validEvidence()) as { media: Array<Record<string, unknown>> };
  cpuOcr.media[0].device = 'cpu';
  assert.throws(() => assertRealMediaModelEvidence(cpuOcr));

  const leakedPath = structuredClone(validEvidence()) as { media: Array<Record<string, unknown>> };
  leakedPath.media[2].sourcePath = 'C:\\private\\audio.wav';
  assert.throws(() => assertRealMediaModelEvidence(leakedPath));
});

test('real model evidence names the source-lock model order explicitly', () => {
  const reversed = structuredClone(validEvidence()) as {
    modelDependencyOrder: string[];
  };
  reversed.modelDependencyOrder.reverse();
  assert.throws(() => assertRealMediaModelEvidence(reversed));

  const broadScope = structuredClone(validEvidence()) as {
    modelDependencyOrderScope: string;
  };
  broadScope.modelDependencyOrderScope = 'all-runtime-dependencies';
  assert.throws(() => assertRealMediaModelEvidence(broadScope));
});

test('ambient provider/model overrides are rejected before launching the app', () => {
  assert.doesNotThrow(() => assertNoAmbientModelOverrides({ PATH: 'C:\\Windows\\System32' }));
  assert.throws(
    () => assertNoAmbientModelOverrides({ OLLAMA_MODELS: 'C:\\ambient', PATH: 'C:\\Windows' }),
    /ambient model\/provider overrides/u,
  );
});

test('canonical JSON hashing is deterministic for release contract binding', () => {
  const left = canonicalJson({ z: 1, a: { y: true, x: false } });
  const right = canonicalJson({ a: { x: false, y: true }, z: 1 });
  assert.deepEqual(left, right);
  assert.match(sha256(left), /^[a-f0-9]{64}$/u);
});

test('desktop target runs the UI model smoke after staged runtime and build', async () => {
  const project = JSON.parse(
    await readFile(new URL('../project.json', import.meta.url), 'utf8'),
  ) as {
    readonly targets: {
      readonly ['smoke-real-media-model']: {
        readonly executor: string;
        readonly outputs: readonly string[];
        readonly options: { readonly commands: readonly string[]; readonly parallel: boolean };
      };
    };
  };
  const target = project.targets['smoke-real-media-model'];
  assert.equal(target.executor, 'nx:run-commands');
  assert.deepEqual(target.options.commands, [
    'corepack pnpm nx run capture-workbench-desktop:stage-product-runtime',
    'corepack pnpm nx run capture-workbench-desktop:build-model-smoke',
    'node apps/capture-workbench-desktop/scripts/real-media-model-smoke.ts',
  ]);
  assert.equal(target.options.parallel, false);
  assert.deepEqual(target.outputs, [
    '{workspaceRoot}/tmp/capture-workbench-desktop/real-media-model/real-media-model.json',
  ]);
});

test('desktop model smoke uses generated release catalog and WebView selectors', async () => {
  const source = await readFile(new URL('./real-media-model-smoke.ts', import.meta.url), 'utf8');
  assert.match(source, /['"]dist['"][\s\S]*['"]release['"][\s\S]*capture-engine-catalog\.json/u);
  assert.doesNotMatch(source, /src[\\/]capture_runtime[\\/]assets[\\/]engine-catalog\.json/u);
  for (const selector of [
    'runtime-setup',
    'runtime-requirement',
    'runtime-install',
    'source-import',
    'document-card',
    'document-detail',
    'document-raw',
    'document-result',
    'document-provenance',
    'document-extraction-provenance',
    'document-delete',
  ]) {
    assert.match(source, new RegExp(`(?:getByTestId\\('[^']*${selector}[^']*'\\)|data-testid="${selector}")`, 'u'));
  }
  assert.match(source, /FindWindow\('#32770'/u);
  assert.match(source, /model-private-audio\.mp3/u);
  assert.match(source, /audio\/mpeg/u);
  assert.match(source, /REAL_MODEL_AUDIO_CAPTURE_TIMEOUT_MS/u);
  assert.match(source, /extractionDurationMs/u);
  assert.match(source, /normalizedTranscriptDigest/u);
  assert.ok(
    source.indexOf('UI raw extraction did not become visible')
      < source.indexOf('resultSection.waitFor'),
    'The bounded extraction assertion must observe raw before waiting for the terminal result.',
  );
  assert.doesNotMatch(source, /sha256\(Buffer\.from\(rawText/u);
  assert.doesNotMatch(source, /digestFromProvenance/u);
  assert.match(source, /modelDependencyOrder: \[\.\.\.installationOrder\]/u);
  assert.match(source, /modelDependencyOrderScope: REAL_MODEL_DEPENDENCY_ORDER_SCOPE/u);
  assert.doesNotMatch(source, /pids\.unshift\(/u);
  assert.match(source, /releaseGateSatisfied: true/u);
  assert.match(source, /consumerE2e: false/u);
});
