// eslint-disable-next-line @nx/enforce-module-boundaries -- shared test temp-root guard.
import '../../../tools/test-temp-root.ts';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertAudioDeviceMatchesSourceLock,
  assertCaptureRecord,
  audioCheckpointSatisfied,
  assertCudaPathRetainedForAppLaunch,
  assertNoAmbientModelOverrides,
  assertNvidiaDriverForCudaSpeechContent,
  assertRealMediaModelEvidence,
  buildModelSmokeLaunchEnvironment,
  canonicalJson,
  collectSafeBackendCaptureState,
  collectSafeBackendState,
  cpuSpeechModelFiles,
  deleteLibraryDocument,
  desktopRuntimeReady,
  generatedCatalogCandidates,
  installConsentedRequirementsThroughTauri,
  installModelThroughTauri,
  mediaTypeFor,
  nativeDialogUiAutomationDefinitions,
  nativeDialogUiAutomationScript,
  REAL_MODEL_CATALOG_VERSION,
  REAL_MODEL_DEPENDENCY_ORDER_SCOPE,
  REAL_MODEL_AUDIO_CAPTURE_TIMEOUT_MS,
  PROGRESSIVE_AUDIO_CHECKPOINT_MS,
  REAL_MODEL_RELEASE_VERSION,
  REAL_MODEL_SOURCE_IMPORT_MODE,
  modelSmokeInjectedDocumentId,
  modelSmokeFixtureEnvironment,
  normalizedNativeClickPoint,
  normalizedOcrTextDigest,
  normalizedTranscriptDigest,
  runtimeModelOptionActive,
  runtimeRequirementsReady,
  safeBackendStateSnapshot,
  safeInputName,
  safeSmokeFailureMessage,
  safeTerminalDocumentFailure,
  safeTerminalInstallationFailure,
  safeTerminalModelInstallationFailure,
  safeUiAutomationDiagnostics,
  sha256,
  shouldUseBackendReuseReadiness,
  type TauriInvoke,
  validateSourceLockAndCatalog,
  waitForCaptureAccepted,
  whisperCpuFallbackAllowedForSourceLock,
  windowsPowerShellExecutable,
} from './real-media-model-smoke.ts';
import {
  expectedStructuringEngine,
  expectedStructuringModel,
} from './real-ollama-smoke.ts';
import {
  assertProgressiveAudioOracleEvidence,
  assertProgressiveAudioSampleMatchesOracle,
  assertProgressiveAudioSampleEvidence,
  deriveProgressiveAudioOracleEvidence,
  deriveProgressiveAudioSampleEvidence,
  PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS,
} from './progressive-audio-evidence.ts';

const digest = 'a'.repeat(64);

test('audio smoke keeps its independent ten-minute upper-bound watchdog', () => {
  assert.equal(REAL_MODEL_AUDIO_CAPTURE_TIMEOUT_MS, 10 * 60_000);
});

test('audio checkpoint uses final text for short samples and the five-minute gate for long samples', () => {
  assert.equal(audioCheckpointSatisfied(120, 120_000, 1, 'sample'), true);
  assert.equal(audioCheckpointSatisfied(120, 0, 1, 'sample'), false);
  assert.equal(audioCheckpointSatisfied(undefined, PROGRESSIVE_AUDIO_CHECKPOINT_MS - 1, 1, 'sample'), false);
  assert.equal(audioCheckpointSatisfied(undefined, PROGRESSIVE_AUDIO_CHECKPOINT_MS, 1, 'sample'), true);
});

test('audio v2 smoke keeps bounded runtime failure codes visible', () => {
  assert.equal(
    safeTerminalDocumentFailure(
      'failed',
      'failed',
      'progressive_stall',
      'Progressive audio extraction stopped producing observable progress.',
      'audio',
    ),
    'Desktop capture terminated. status=failed; stage=failed; errorCode=progressive_stall; mediaKind=audio.',
  );
});

test('Tauri audio smoke rejects CPU fallback when source lock requires CUDA', () => {
  assert.doesNotThrow(() => assertAudioDeviceMatchesSourceLock('cuda', 'cuda'));
  assert.throws(() => assertAudioDeviceMatchesSourceLock('cpu', 'cuda'));
  assert.equal(whisperCpuFallbackAllowedForSourceLock('cuda'), false);
  assert.equal(whisperCpuFallbackAllowedForSourceLock('cpu'), true);
});

test('audio-only smoke still declares every owned fixture required by the Tauri registry', () => {
  assert.deepEqual(
    modelSmokeFixtureEnvironment({ pdf: 'owned-pdf', image: 'owned-image', audio: 'owned-audio' }),
    {
      CAPTURE_SMOKE_FIXTURE_PDF: 'owned-pdf',
      CAPTURE_SMOKE_FIXTURE_IMAGE: 'owned-image',
      CAPTURE_SMOKE_FIXTURE_AUDIO: 'owned-audio',
    },
  );
});

test('reused audio-only production smoke uses backend readiness instead of setup UI', () => {
  assert.equal(shouldUseBackendReuseReadiness(true, true), true);
  assert.equal(shouldUseBackendReuseReadiness(true, false), false);
  assert.equal(shouldUseBackendReuseReadiness(false, true), false);
});

test('backend reuse readiness waits for the Tauri sidecar before querying requirements', () => {
  assert.equal(desktopRuntimeReady({ status: 'ready' }), true);
  assert.equal(desktopRuntimeReady({ status: 'starting' }), false);
  assert.equal(desktopRuntimeReady({ status: 'failed' }), false);
  assert.equal(desktopRuntimeReady(null), false);
});

function validEvidence() {
  return {
    evidenceKind: 'real-model-enabled-tauri-host-smoke',
    sourceImportMode: REAL_MODEL_SOURCE_IMPORT_MODE,
    nativePickerExercised: false,
    releaseGateSatisfied: false,
    localProductionPreflight: true,
    consumerE2e: false,
    runtimeVersion: REAL_MODEL_RELEASE_VERSION,
    catalogVersion: REAL_MODEL_CATALOG_VERSION,
    sourceLockSha256: digest,
    catalogSha256: digest,
    selectedModelOptionId: 'qwen3.5-0.8b-v1',
    modelDependencyOrder: ['windowsml-ocr', 'speech-recognition'],
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
        ocrEvidencePersisted: true,
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
        ocrEvidencePersisted: true,
        durationMs: 100,
      },
      {
        sourceKind: 'audio',
        sourceSha256: digest,
        extractionEngine: 'speech-recognition',
        model: 'lock-selected-whisper',
        device: 'windowsml-dml',
        engineDigest: `sha256:${digest}`,
        structuringEngine: expectedStructuringEngine,
        structuringModel: expectedStructuringModel,
        structuringDigest: `sha256:${digest}`,
        structuredBlockCount: 2,
        segmentCount: 2,
        timeLocators: 2,
        durationMs: 100,
      },
    ],
    rawPersisted: true,
    recordingResultPersisted: true,
    consentedInstallation: true,
    capturesDeletedAfterVerification: true,
    ownedProcessCleanupVerified: true,
    cdpPortReleased: true,
    candidateMirrorUsed: true,
    candidateMirrorReleased: true,
    isolatedAppDataUsed: true,
  };
}

test('real model evidence is release-gated, provenance-bound, and private', () => {
  assert.doesNotThrow(() => assertRealMediaModelEvidence(validEvidence()));
  const serialized = JSON.stringify(validEvidence());
  assert.doesNotMatch(serialized, /(?:sourceText|expectedText|transcript|token|secret)/iu);
});

test('real model evidence enforces document OCR checkpoint fields and recording structuring fields', () => {
  const cpuOcr = structuredClone(validEvidence()) as { media: Array<Record<string, unknown>> };
  cpuOcr.media[0].device = 'cpu';
  assert.throws(() => assertRealMediaModelEvidence(cpuOcr));

  for (const [field, value] of [
    ['structuringEngine', expectedStructuringEngine],
    ['structuringModel', expectedStructuringModel],
    ['structuringDigest', `sha256:${digest}`],
    ['structuredBlockCount', 1],
  ] as const) {
    const docWithStructuring = structuredClone(validEvidence()) as { media: Array<Record<string, unknown>> };
    docWithStructuring.media[0][field] = value;
    assert.throws(() => assertRealMediaModelEvidence(docWithStructuring), new RegExp(field, 'u'));

    const imageWithStructuring = structuredClone(validEvidence()) as { media: Array<Record<string, unknown>> };
    imageWithStructuring.media[1][field] = value;
    assert.throws(() => assertRealMediaModelEvidence(imageWithStructuring), new RegExp(field, 'u'));
  }

  for (const docIndex of [0, 1] as const) {
    const missingOcrEvidence = structuredClone(validEvidence()) as { media: Array<Record<string, unknown>> };
    delete missingOcrEvidence.media[docIndex].ocrEvidencePersisted;
    assert.throws(() => assertRealMediaModelEvidence(missingOcrEvidence));

    const falseOcrEvidence = structuredClone(validEvidence()) as { media: Array<Record<string, unknown>> };
    falseOcrEvidence.media[docIndex].ocrEvidencePersisted = false;
    assert.throws(() => assertRealMediaModelEvidence(falseOcrEvidence));
  }

  for (const field of [
    'structuringEngine',
    'structuringModel',
    'structuringDigest',
    'structuredBlockCount',
  ] as const) {
    const missingRecordingField = structuredClone(validEvidence()) as { media: Array<Record<string, unknown>> };
    delete missingRecordingField.media[2][field];
    assert.throws(() => assertRealMediaModelEvidence(missingRecordingField));
  }

  const zeroBlocks = structuredClone(validEvidence()) as { media: Array<Record<string, unknown>> };
  zeroBlocks.media[2].structuredBlockCount = 0;
  assert.throws(() => assertRealMediaModelEvidence(zeroBlocks));

  const wrongStructuringModel = structuredClone(validEvidence()) as { media: Array<Record<string, unknown>> };
  wrongStructuringModel.media[2].structuringModel = 'other-model';
  assert.throws(() => assertRealMediaModelEvidence(wrongStructuringModel));

  const legacyReportFlag = structuredClone(validEvidence()) as Record<string, unknown>;
  legacyReportFlag.resultPersisted = true;
  assert.throws(() => assertRealMediaModelEvidence(legacyReportFlag));

  const missingRecordingFlag = structuredClone(validEvidence()) as Record<string, unknown>;
  delete missingRecordingFlag.recordingResultPersisted;
  assert.throws(() => assertRealMediaModelEvidence(missingRecordingFlag));

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
  for (const name of ['CAPTURE_SPEECH_RECOGNITION_VARIANT', 'CAPTURE_SPEECH_RECOGNITION_MODEL']) {
    assert.throws(
      () => assertNoAmbientModelOverrides({ [name]: 'cpu', PATH: 'C:\\Windows' }),
      /ambient model\/provider overrides/u,
      name,
    );
  }
});

test('the model smoke needs the NVIDIA driver file that makes the runtime pick cuda', () => {
  const asked: string[] = [];
  const present = (path: string) => {
    asked.push(path);
    return true;
  };
  assert.doesNotThrow(() => assertNvidiaDriverForCudaSpeechContent('C:\\Windows', present));
  assert.deepEqual(asked, [join('C:\\Windows', 'System32', 'nvcuda.dll')]);
  for (const systemRoot of ['C:\\Windows', undefined, '  ']) {
    assert.throws(
      () => assertNvidiaDriverForCudaSpeechContent(systemRoot, () => false),
      /needs the NVIDIA driver/u,
    );
  }
});

test('CUDA toolkit locator is retained without weakening provider override isolation', () => {
  assert.doesNotThrow(() =>
    assertCudaPathRetainedForAppLaunch(
      { Cuda_Path: 'fake-cuda-toolkit-root' },
      { CUDA_PATH: 'fake-cuda-toolkit-root' },
    ),
  );
  assert.throws(
    () =>
      assertCudaPathRetainedForAppLaunch(
        { CUDA_PATH: 'fake-cuda-toolkit-root' },
        {},
      ),
    /did not retain CUDA_PATH for app launch/u,
  );
  assert.doesNotThrow(() =>
    assertCudaPathRetainedForAppLaunch({ PATH: 'safe-path' }, { PATH: 'safe-path' }),
  );
});

test('canonical JSON hashing is deterministic for release contract binding', () => {
  const left = canonicalJson({ z: 1, a: { y: true, x: false } });
  const right = canonicalJson({ a: { x: false, y: true }, z: 1 });
  assert.deepEqual(left, right);
  assert.match(sha256(left), /^[a-f0-9]{64}$/u);
});

test('progressive audio sample evidence is digest-only and bound to the five-minute gate', () => {
  const evidence = deriveProgressiveAudioSampleEvidence({
    sourceSha256: digest,
    sourceBytes: 2_000_000,
    coveredUntilMs: PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS,
    partialRevision: 2,
    segments: [
      { order: 0, startMs: 0, endMs: 1_000, text: '  sample  one ' },
      { order: 1, startMs: 1_000, endMs: 2_000, text: 'sample\n two' },
    ],
    extraction: {
      engine: 'speech-recognition',
      model: 'tea-asr-1.1',
      device: 'cuda',
      digest: `sha256:${digest}`,
    },
  });
  assertProgressiveAudioSampleEvidence(evidence);
  assert.equal(evidence.sampleIntervalMs, 5 * 60_000);
  assert.equal(evidence.firstCheckpoint.segmentCount, 2);
  assert.match(evidence.expectedOutput.normalizedSha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(evidence), /sample\s+one|sample\s+two/u);
  assert.doesNotMatch(JSON.stringify(evidence), /(?:sourceText|transcript|token|secret)/iu);
});

test('progressive audio sample evidence rejects incomplete or unsafe samples', () => {
  assert.throws(() => deriveProgressiveAudioSampleEvidence({
    sourceSha256: digest,
    sourceBytes: 2_000_000,
    coveredUntilMs: PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS - 1,
    partialRevision: 1,
    segments: [{ order: 0, startMs: 0, endMs: 1_000, text: 'sample' }],
    extraction: {
      engine: 'speech-recognition',
      model: 'tea-asr-1.1',
      device: 'cuda',
      digest: `sha256:${digest}`,
    },
  }));
  const safe = deriveProgressiveAudioSampleEvidence({
    sourceSha256: digest,
    sourceBytes: 2_000_000,
    coveredUntilMs: PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS,
    partialRevision: 1,
    segments: [{ order: 0, startMs: 0, endMs: 1_000, text: 'C:\\private\\audio' }],
    extraction: {
      engine: 'speech-recognition',
      model: 'tea-asr-1.1',
      device: 'cuda',
      digest: `sha256:${digest}`,
    },
  });
  assertProgressiveAudioSampleEvidence(safe);
  assert.doesNotMatch(JSON.stringify(safe), /C:\\\\private\\\\audio/u);
});

test('progressive audio oracle compares an independent worker result without persisting text', () => {
  const oracle = deriveProgressiveAudioOracleEvidence({
    sourceSha256: digest,
    sourceBytes: 2_000_000,
    coveredUntilMs: PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS,
    partialRevision: 3,
    segments: [
      { order: 0, startMs: 0, endMs: 1_000, text: 'oracle one' },
      { order: 1, startMs: 1_000, endMs: 2_000, text: 'oracle two' },
    ],
    extraction: {
      engine: 'speech-recognition',
      model: 'tea-asr-1.1',
      device: 'cuda',
      digest: `sha256:${digest}`,
    },
  });
  assertProgressiveAudioOracleEvidence(oracle);
  assertProgressiveAudioSampleMatchesOracle(oracle, {
    sourceSha256: digest,
    sourceBytes: 2_000_000,
    coveredUntilMs: PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS,
    partialRevision: 4,
    segments: [
      { order: 0, startMs: 0, endMs: 1_000, text: 'oracle one' },
      { order: 1, startMs: 1_000, endMs: 2_000, text: 'oracle two' },
    ],
    extraction: oracle.extraction,
  });
  assert.equal(oracle.oracle, 'non-tauri-production-worker');
  assert.doesNotMatch(JSON.stringify(oracle), /oracle one|oracle two|transcript/u);
  assert.throws(() => assertProgressiveAudioSampleMatchesOracle(oracle, {
    sourceSha256: digest,
    sourceBytes: 2_000_000,
    coveredUntilMs: PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS,
    partialRevision: 4,
    segments: [{ order: 0, startMs: 0, endMs: 1_000, text: 'different' }],
    extraction: oracle.extraction,
  }));
});

test('model smoke fixture injection returns only a bounded document ID', () => {
  const documentId = 'a'.repeat(32);
  assert.equal(modelSmokeInjectedDocumentId({
    documentId,
    fileName: 'prepared.pdf',
    sourcePath: 'C:\\private\\fixture.pdf',
  }), documentId);
  assert.throws(
    () => modelSmokeInjectedDocumentId({ documentId: 'C:\\private\\fixture.pdf' }),
    (error: unknown) => error instanceof Error
      && !error.message.includes('private')
      && !error.message.includes('fixture.pdf'),
  );
});

test('model smoke waits for backend capture acceptance via library_list', async () => {
  const documentId = 'a'.repeat(32);
  const captureId = '11111111-1111-1111-1111-111111111111';
  let polls = 0;
  const invoke: TauriInvoke = async (command) => {
    assert.equal(command, 'library_list');
    polls += 1;
    if (polls === 1) {
      return [{ documentId, status: 'queued' }];
    }
    return [{ documentId, status: 'processing', captureId }];
  };
  const acceptedCaptureId = await waitForCaptureAccepted(documentId, invoke, 2_000);
  assert.equal(acceptedCaptureId, captureId);
  assert.equal(polls, 2);

  await assert.rejects(
    waitForCaptureAccepted('b'.repeat(32), async () => [{ documentId: 'b'.repeat(32), status: 'queued' }], 300),
    /capture start was not accepted/u,
  );
});

test('private OCR oracle hashes normalized source text without exposing its contents', () => {
  const first = normalizedOcrTextDigest('  private  PDF\noutput  ');
  const second = normalizedOcrTextDigest('private PDF output');
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.throws(() => normalizedOcrTextDigest('  '), /source text was empty/u);
});

test('runtime readiness requires backend-reported ready states', () => {
  assert.equal(
    runtimeRequirementsReady({
      items: [
        { requirementId: 'windowsml-ocr', status: 'ready' },
        { requirementId: 'ollama-runtime', status: 'ready' },
      ],
    }, ['windowsml-ocr', 'ollama-runtime']),
    true,
  );
  assert.equal(
    runtimeRequirementsReady({
      items: [{ requirementId: 'windowsml-ocr', status: 'installable' }],
    }, ['windowsml-ocr']),
    false,
  );
  assert.equal(runtimeRequirementsReady({ items: [] }, ['windowsml-ocr']), false);
  assert.equal(runtimeRequirementsReady({}, ['windowsml-ocr']), false);
});

test('model readiness requires the exact backend option to be active', () => {
  assert.equal(runtimeModelOptionActive({
    items: [
      { optionId: 'qwen3.5-0.8b-v1', status: 'active' },
      { optionId: 'qwen3.5-4b-v1', status: 'not-installed' },
    ],
  }, 'qwen3.5-0.8b-v1'), true);
  assert.equal(runtimeModelOptionActive({
    items: [{ optionId: 'qwen3.5-0.8b-v1', status: 'not-installed' }],
  }, 'qwen3.5-0.8b-v1'), false);
  assert.equal(runtimeModelOptionActive({}, 'qwen3.5-0.8b-v1'), false);
});

test('terminal model installation failure is bounded and content-free', () => {
  const failure = safeTerminalModelInstallationFailure(
    'failed',
    'installation_failed',
    0.1,
  );
  assert.equal(
    failure,
    'Desktop model installation terminated. status=failed; errorCode=installation_failed; progressBand=early.',
  );
  const message = safeSmokeFailureMessage(new Error(failure ?? ''), 0, {});
  assert.match(message, /failure=terminal-model-installation/u);
  assert.doesNotMatch(message, /PRIVATE|C:\\/u);
  assert.equal(safeTerminalModelInstallationFailure('running', null, 0.1), undefined);
  assert.match(
    safeSmokeFailureMessage(new Error('Desktop model installation did not start.'), 0, {}),
    /failure=model-installation-start/u,
  );
});

test('native dialog helper resolves PowerShell without relying on PATH', () => {
  assert.equal(
    windowsPowerShellExecutable('C:\\Windows'),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
});

test('native click maps emulated CSS viewport coordinates to the real client rectangle', () => {
  assert.deepEqual(
    normalizedNativeClickPoint(
      { x: 360, y: 290, width: 48, height: 46 },
      { width: 1440, height: 900 },
    ),
    { xRatio: 0.26666666666666666, yRatio: 0.3477777777777778 },
  );
  assert.throws(
    () => normalizedNativeClickPoint(
      { x: 1_400, y: 0, width: 100, height: 20 },
      { width: 1_440, height: 900 },
    ),
    /invalid viewport coordinates/u,
  );
});

test('native dialog diagnostics reject values and private paths', () => {
  const safe = 'TOP|pid=42|relation=target|aid=FileNameControlHost|type=ControlType.ComboBox|class=ComboBox|patterns=Value';
  assert.equal(safeUiAutomationDiagnostics(`${safe}\n`), safe);
  assert.equal(
    safeUiAutomationDiagnostics('UIA|stage=timeout|value=C:\\private\\fixture.pdf'),
    'none',
  );
  assert.equal(safeUiAutomationDiagnostics('PowerShell error containing private data'), 'none');
});

test('smoke failure output excludes OCR, audio, and document-name content', async () => {
  const privateOcr = 'PRIVATE_CERT_OCR_SENTINEL';
  const privateAudio = 'PRIVATE_AUDIO_TRANSCRIPT_SENTINEL';
  const privateDocumentName = 'private-certificate-name.pdf';
  const message = safeSmokeFailureMessage(
    new Error(`${privateOcr} ${privateAudio}`),
    2,
    {
      runtimeStatus: 'ready',
      requirements: [
        { requirementId: 'windowsml-ocr', status: 'ready', detail: privateOcr },
        { requirementId: 'private-requirement', status: 'ready' },
      ],
      modelOptions: [
        { optionId: 'qwen3.5-0.8b-v1', status: 'active' },
      ],
      modelInstallation: {
        optionId: 'qwen3.5-0.8b-v1',
        status: 'running',
        progress: 0.5,
        error: { code: 'none', message: privateAudio },
      },
      rawText: privateOcr,
      transcript: privateAudio,
      documentNames: [privateDocumentName],
    },
    '{"status":"failed","stage":"failed","progressBand":"unknown","errorCode":"capture_failed"}',
  );
  assert.doesNotMatch(message, new RegExp(`${privateOcr}|${privateAudio}|${privateDocumentName}|private-requirement`, 'u'));
  assert.match(message, /failure=unexpected/u);
  assert.match(message, /windowsml-ocr/u);
  assert.match(message, /qwen3\.5-0\.8b-v1/u);
  assert.match(message, /Backend state: /u);
  assert.match(message, /Backend capture state: \{"status":"failed","stage":"failed","progressBand":"unknown","errorCode":"capture_failed"\}/u);

  const collectedState = await collectSafeBackendState(async (command) => {
    if (command === 'desktop_runtime_status') return { status: 'ready', detail: privateOcr };
    if (command === 'runtime_requirements') return { items: [{ requirementId: 'windowsml-ocr', status: 'ready' }] };
    if (command === 'runtime_model_options') return { items: [{ optionId: 'qwen3.5-0.8b-v1', status: 'active' }] };
    if (command === 'runtime_get_model_installation') {
      return { optionId: 'qwen3.5-0.8b-v1', status: 'failed', progress: 0.2, error: { code: 'install_failed', message: privateAudio } };
    }
    return undefined;
  }, 'model-install-1');
  const snapshot = safeBackendStateSnapshot(collectedState);
  assert.doesNotMatch(snapshot, new RegExp(`${privateOcr}|${privateAudio}`, 'u'));
  assert.match(snapshot, /"install_failed"/u);

  const captureState = await collectSafeBackendCaptureState(async (command) => {
    if (command === 'library_list') {
      return [{ documentId: 'c'.repeat(32), status: 'failed', stage: 'structuring', errorCode: 'structuring_failed', errorMessage: privateOcr }];
    }
    return undefined;
  }, 'c'.repeat(32));
  assert.equal(
    captureState,
    '{"status":"failed","stage":"structuring","progressBand":"unknown","errorCode":"structuring_failed"}',
  );
});

test('terminal document failure is immediate, allowlisted, and content-free', () => {
  const terminalFailure = safeTerminalDocumentFailure(
    'failed',
    'failed',
    'structuring_invalid_output',
  );
  assert.equal(
    terminalFailure,
    'Desktop capture terminated. status=failed; stage=failed; errorCode=structuring_invalid_output.',
  );
  const thrownMessage = safeSmokeFailureMessage(new Error(terminalFailure), 0, {});
  assert.match(thrownMessage, /failure=terminal-document/u);
  assert.match(
    thrownMessage,
    /terminal=Desktop capture terminated\. status=failed; stage=failed; errorCode=structuring_invalid_output\./u,
  );
  assert.equal(safeTerminalDocumentFailure('processing', 'structuring', null), undefined);
  assert.equal(
    safeTerminalDocumentFailure(
      'failed',
      'failed',
      'extraction_failed',
      'Source extraction worker failed at ocr-probe-assets-missing-5.',
    ),
    'Desktop capture terminated. status=failed; stage=failed; errorCode=extraction_failed; workerStage=ocr-probe-assets-missing-5.',
  );
  assert.equal(
    safeTerminalDocumentFailure(
      'failed',
      'failed',
      'extraction_failed',
      'Source extraction worker failed at stages speech-model-load-cuda-failed-runtimeerror>speech-gpu-fallback>speech-model-load-cpu-failed-runtimeerror.',
      'audio',
    ),
    'Desktop capture terminated. status=failed; stage=failed; errorCode=extraction_failed; mediaKind=audio; workerStage=speech-model-load-cuda-failed-runtimeerror>speech-gpu-fallback>speech-model-load-cpu-failed-runtimeerror.',
  );
  assert.equal(
    safeTerminalDocumentFailure(
      'failed',
      'failed',
      'extraction_failed',
      'Source extraction worker failed at stages worker-entry-start>python-import-capture-runtime-start>python-import-capture-runtime-failed.',
    ),
    'Desktop capture terminated. status=failed; stage=failed; errorCode=extraction_failed; workerStage=worker-entry-start>python-import-capture-runtime-start>python-import-capture-runtime-failed.',
  );
  assert.equal(
    safeTerminalDocumentFailure(
      'failed',
      'failed',
      'extraction_failed',
      'Source extraction failed validation.',
    ),
    'Desktop capture terminated. status=failed; stage=failed; errorCode=extraction_failed; failureReason=validation-failed.',
  );
  assert.equal(
    safeTerminalDocumentFailure(
      'failed',
      'failed',
      'extraction_failed',
      'Source extraction failed at the runtime boundary.',
      'image',
    ),
    'Desktop capture terminated. status=failed; stage=failed; errorCode=extraction_failed; mediaKind=image; failureReason=runtime-boundary.',
  );
  const privateValue = 'PRIVATE_OCR_OR_PATH_SENTINEL';
  const redacted = safeTerminalDocumentFailure('failed', privateValue, privateValue);
  assert.equal(
    redacted,
    'Desktop capture terminated. status=failed; stage=unknown; errorCode=unknown.',
  );
  assert.doesNotMatch(redacted ?? '', new RegExp(privateValue, 'u'));
});

test('terminal installation failure is bounded and content-free', () => {
  const failure = safeTerminalInstallationFailure(
    'speech-recognition',
    'failed',
    'probing',
    'worker_failed',
    0.92,
    'worker failed at stage worker-process-response-error-bootloader',
  );
  assert.equal(
    failure,
    'Desktop runtime installation terminated. requirement=speech-recognition; status=failed; stage=probing; errorCode=worker_failed; progressBand=late; workerStage=worker-process-response-error-bootloader; failureReason=runtime-install-unexpected.',
  );
  const message = safeSmokeFailureMessage(new Error(failure), 0, {});
  assert.match(message, /failure=terminal-installation/u);
  assert.doesNotMatch(message, /PRIVATE|C:\\|worker failed/u);
  assert.equal(
    safeTerminalInstallationFailure('windowsml-ocr', 'failed', 'probing', 'worker_failed', 0.9),
    'Desktop runtime installation terminated. requirement=windowsml-ocr; status=failed; stage=probing; errorCode=worker_failed; progressBand=late; failureReason=runtime-install-unexpected.',
  );
  assert.equal(safeTerminalInstallationFailure('private-requirement', 'failed', 'probing', 'x', 0.9), undefined);
  assert.equal(
    safeTerminalInstallationFailure(
      'speech-recognition',
      'failed',
      null,
      'installation_failed',
      0.7,
      'direct model download exhausted bounded retries',
    ),
    'Desktop runtime installation terminated. requirement=speech-recognition; status=failed; stage=unknown; errorCode=installation_failed; progressBand=download; failureReason=direct-model-retries-exhausted.',
  );
});

test('native dialog UIA script parses in Windows PowerShell', { skip: process.platform !== 'win32' }, () => {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const parser = `
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseInput(
  [Console]::In.ReadToEnd(),
  [ref]$tokens,
  [ref]$errors
)
if ($errors.Count -ne 0) {
  $errors | ForEach-Object {
    Write-Output ([string]$_.Extent.StartLineNumber + ':' + $_.Extent.Text)
  }
  exit 1
}
`;
  const result = spawnSync(
    windowsPowerShellExecutable(systemRoot),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', parser],
    {
      encoding: 'utf8',
      input: nativeDialogUiAutomationScript(),
      env: {
        SystemRoot: systemRoot,
        Path: process.env.Path || process.env.PATH || '',
      },
      windowsHide: true,
    },
  );
  assert.equal(
    result.status,
    0,
    `The generated UIA helper must be valid Windows PowerShell syntax. ${result.stdout}${result.stderr}`,
  );
});

function runPickerStubCase(body: string): { keys: string[]; clicks: number; result: boolean; diagnostics: string[] } {
  const script = nativeDialogUiAutomationDefinitions() + `
$script:keys = New-Object 'System.Collections.Generic.List[string]'
$script:clicks = 0
$script:foregroundCalls = 0
function Invoke-RawKeySend([string]$value) { $script:keys.Add($value) }
function Invoke-RawClick([int]$x, [int]$y) { $script:clicks++; return $true }
function Get-NativeRoot([IntPtr]$handle) { return $handle }
function Get-ForegroundRoot { return [IntPtr]42 }
function Invoke-PickerActivation([IntPtr]$handle) { return $false }
function Test-TargetEnabled { return $false }
function Start-Sleep { param($Milliseconds) }
$dialog = [pscustomobject]@{ Current = [pscustomobject]@{ NativeWindowHandle = 42 } }
$env:CAPTURE_SMOKE_DIALOG_FILE = 'C:\\fixture.txt'
$diagnostics = @(& {
${body}
} 6>&1 | ForEach-Object {
  if ($_ -is [bool]) { $script:result = $_ } else { [string]$_ }
})
@{ keys = @($script:keys.ToArray()); clicks = $script:clicks; result = $script:result; diagnostics = $diagnostics } | ConvertTo-Json -Compress
`;
  const result = spawnSync(windowsPowerShellExecutable(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', '& ([scriptblock]::Create([Console]::In.ReadToEnd()))'],
    { input: script, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, String(result.error || result.stderr));
  assert.equal(result.stderr, '', result.stderr);
  return JSON.parse(result.stdout.trim());
}

const powershellSkip = process.platform !== 'win32' ? 'Requires Windows PowerShell' : false;
const refusedDiagnostic = 'UIA|stage=input-guard|code=foreground-not-owned';

test('brokered fallback refuses input when activation fails', { skip: powershellSkip }, () => {
  const result = runPickerStubCase(`
function Get-ForegroundRoot { return [IntPtr]99 }
Invoke-BrokeredPickerKeyboardFallback $dialog`);
  assert.equal(result.result, false);
  assert.deepEqual(result.keys, []);
  assert.deepEqual(result.diagnostics, [refusedDiagnostic]);
});

test('brokered fallback sends the fixture when the picker owns the foreground', { skip: powershellSkip }, () => {
  const result = runPickerStubCase('Invoke-BrokeredPickerKeyboardFallback $dialog');
  assert.equal(result.result, true);
  assert.ok(result.keys.length > 0);
  assert.ok(result.keys.includes('C:\\fixture.txt'));
});

test('brokered fallback stops immediately when foreground ownership is lost', { skip: powershellSkip }, () => {
  const result = runPickerStubCase(`
function Get-ForegroundRoot {
  $script:foregroundCalls++
  if ($script:foregroundCalls -eq 1) { return [IntPtr]42 }
  return [IntPtr]99
}
Invoke-BrokeredPickerKeyboardFallback $dialog`);
  assert.equal(result.result, false);
  assert.deepEqual(result.keys, ['%n']);
  assert.deepEqual(result.diagnostics, [refusedDiagnostic]);
});

test('brokered fallback refuses a dialog without a native handle', { skip: powershellSkip }, () => {
  const result = runPickerStubCase(`
$dialog.Current.NativeWindowHandle = 0
Invoke-BrokeredPickerKeyboardFallback $dialog`);
  assert.equal(result.result, false);
  assert.deepEqual(result.keys, []);
  assert.deepEqual(result.diagnostics, [refusedDiagnostic]);
});

test('guarded click refuses another foreground window', { skip: powershellSkip }, () => {
  const result = runPickerStubCase(`
function Get-ForegroundRoot { return [IntPtr]99 }
Invoke-GuardedClick $dialog 10 20`);
  assert.equal(result.result, false);
  assert.equal(result.clicks, 0);
  assert.deepEqual(result.diagnostics, [refusedDiagnostic]);
});

test('classic dialog selects a fixture without keyboard input', {
  skip: process.platform !== 'win32' || process.env.CAPTURE_SMOKE_REAL_DIALOG_TEST !== '1'
    ? 'Opens a window; requires Windows and CAPTURE_SMOKE_REAL_DIALOG_TEST=1' : false,
  timeout: 45_000,
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'capture-picker-uia-'));
  const fixture = join(temporary, 'picker-probe.txt');
  const readySignal = join(temporary, 'open-dialog.signal');
  await writeFile(fixture, 'picker probe\n', 'utf8');
  const hostScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Tauri Window'
$form.Add_Shown({
  [Console]::WriteLine('HWND=' + $form.Handle.ToInt64())
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 25
  $timer.Add_Tick({
    if (-not (Test-Path -LiteralPath $env:CAPTURE_SMOKE_DIALOG_SIGNAL)) { return }
    $timer.Stop()
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    try {
      if ($dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::WriteLine($dialog.FileName)
      }
    } finally { $dialog.Dispose(); $form.Close() }
  }.GetNewClosure())
  $timer.Start()
}.GetNewClosure())
[System.Windows.Forms.Application]::Run($form)
$form.Dispose()
`;
  const host = spawn(windowsPowerShellExecutable(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', hostScript], {
      env: { ...process.env, CAPTURE_SMOKE_DIALOG_SIGNAL: readySignal },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
  let hostOutput = '';
  host.stdout.on('data', (chunk: Buffer) => { hostOutput += chunk.toString(); });
  const hostExit = new Promise<number | null>((resolvePromise, reject) => {
    host.once('error', reject);
    host.once('close', resolvePromise);
  });
  try {
    assert.ok(host.pid);
    // The host starts hidden (windowsHide), so it has no main window handle to
    // look up; it reports its form's handle instead.
    const hostHandleDeadline = Date.now() + 15_000;
    let hostHandle: string | undefined;
    while (hostHandle === undefined && Date.now() < hostHandleDeadline) {
      hostHandle = /^HWND=(\d+)\r?$/mu.exec(hostOutput)?.[1];
      if (hostHandle === undefined) await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.ok(hostHandle, 'The dialog host did not report its window handle.');
    const definitions = nativeDialogUiAutomationDefinitions();
    // A WinForms host has a generated class name; production Tauri uses its fixed class.
    const script = definitions + `
function Get-TargetMainWindowHandles { return @([long]${hostHandle}) }
$script:keyCount = 0
function Invoke-RawKeySend([string]$value) { $script:keyCount++; throw 'Unexpected keyboard input' }
try { & {
` + nativeDialogUiAutomationScript().slice(definitions.length) + `
} } finally { [Console]::WriteLine('KEYCOUNT=' + $script:keyCount) }
`;
    const automation = spawn(windowsPowerShellExecutable(),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', '& ([scriptblock]::Create([Console]::In.ReadToEnd()))'], {
        env: { ...process.env, CAPTURE_SMOKE_APP_PID: String(host.pid), CAPTURE_SMOKE_DIALOG_FILE: fixture },
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
    let output = '';
    const automationExit = new Promise<number | null>((resolvePromise, reject) => {
      automation.once('error', reject);
      automation.once('close', resolvePromise);
    });
    let signaled = false;
    automation.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (!signaled && output.includes('UIA|stage=ready|code=listening')) {
        signaled = true;
        void writeFile(readySignal, 'ready\n', 'utf8');
      }
    });
    const watchdog = setTimeout(() => { automation.kill(); host.kill(); }, 35_000);
    try {
      automation.stdin.end(script);
      assert.equal(await automationExit, 0, output);
      assert.match(output, /KEYCOUNT=0/u);
      assert.equal(await hostExit, 0);
      assert.equal(hostOutput.trim().split(/\r?\n/u).at(-1), fixture);
    } finally { clearTimeout(watchdog); automation.kill(); }
  } finally {
    host.kill();
    await rm(temporary, { recursive: true, force: true });
  }
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

test('desktop model smoke resolves generated release catalogs and launch environment', () => {
  assert.match(generatedCatalogCandidates[0], /packages[\\/]capture-runtime[\\/]dist[\\/]release[\\/]capture-engine-catalog\.json$/u);
  for (const candidate of generatedCatalogCandidates) {
    assert.doesNotMatch(candidate, /src[\\/]capture_runtime[\\/]assets[\\/]engine-catalog\.json/u);
  }

  const root = join(tmpdir(), 'capture-model-smoke-launch-env');
  const env = buildModelSmokeLaunchEnvironment(
    { PATH: 'C:\\Windows\\System32' },
    {
      root,
      appData: join(root, 'a'),
      localAppData: join(root, 'l'),
      temporary: join(root, 't'),
      webViewData: join(root, 'w'),
    },
    { pdf: 'owned-pdf', image: 'owned-image', audio: 'owned-audio' },
    { preferGpu: true, device: 'cuda' },
    false,
  );
  assert.equal(env.CAPTURE_SMOKE_APP_DATA_ROOT, join(root, 'a'));
  assert.equal(env.CAPTURE_SMOKE_FIXTURE_ROOT, root);
  assert.equal(env.CAPTURE_SMOKE_FIXTURE_PDF, 'owned-pdf');
  assert.equal(env.CAPTURE_SMOKE_FIXTURE_IMAGE, 'owned-image');
  assert.equal(env.CAPTURE_SMOKE_FIXTURE_AUDIO, 'owned-audio');
  assert.equal(env.CAPTURE_WHISPER_PREFER_GPU, 'true');
  assert.equal(env.CAPTURE_WHISPER_ALLOW_CPU_FALLBACK, 'false');

  const audioOnlyEnv = buildModelSmokeLaunchEnvironment(
    { PATH: 'C:\\Windows\\System32' },
    {
      root,
      appData: join(root, 'a'),
      localAppData: join(root, 'l'),
      temporary: join(root, 't'),
      webViewData: join(root, 'w'),
    },
    { pdf: 'owned-pdf', image: 'owned-image', audio: 'owned-audio' },
    { preferGpu: true, device: 'cuda' },
    true,
  );
  assert.equal(audioOnlyEnv.CAPTURE_WHISPER_ALLOW_CPU_FALLBACK, 'true');

  assert.equal(safeInputName('audio'), 'model-private-audio.mp3');
  assert.equal(mediaTypeFor('audio'), 'audio/mpeg');

  const firstDigest = normalizedTranscriptDigest(['  hello  ', 'world\n!']);
  const secondDigest = normalizedTranscriptDigest(['hello world !']);
  assert.equal(firstDigest, secondDigest);
  assert.match(firstDigest, /^[a-f0-9]{64}$/u);
  assert.throws(() => normalizedTranscriptDigest(['   ']), /transcript was empty/u);
});

type ModelFile = {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly licensePath: string | null;
  readonly noticePath: string | null;
};

function modelFile(path: string, notice: string | null, bytes = 1): ModelFile {
  return {
    path,
    bytes,
    sha256: sha256(Buffer.from(path)),
    licensePath: notice === null ? null : 'licenses/LICENSE.txt',
    noticePath: notice,
  };
}

const speechLockFiles: readonly ModelFile[] = [
  modelFile('licenses/LICENSE.txt', null),
  modelFile('licenses/NOTICE-fallback.md', null),
  modelFile('licenses/NOTICE-primary.md', null),
  modelFile('model/fallback/model.safetensors', 'licenses/NOTICE-fallback.md', 2),
  modelFile('model/primary/model.safetensors', 'licenses/NOTICE-primary.md', 3),
];
const cpuSpeechFiles = speechLockFiles.filter((item) => !item.path.includes('primary'));

type CatalogEntry = Record<string, unknown> & { contents?: Array<Record<string, unknown>> };

interface ModelContract {
  readonly lockBytes: Buffer;
  readonly lock: unknown;
  readonly lockHash: string;
  readonly requirements: CatalogEntry[];
}

function modelFilesFor(files: readonly ModelFile[], lockHash: string): Record<string, unknown> {
  return {
    artifactVersion: REAL_MODEL_RELEASE_VERSION,
    entryPoint: 'model',
    files,
    manifestSha256: sha256(canonicalJson({
      artifactVersion: REAL_MODEL_RELEASE_VERSION,
      entryPoint: 'model',
      files,
      manifestVersion: '1',
    })),
    sourceLockSha256: lockHash,
  };
}

function modelContract(speech: 'legacy' | 'contents'): ModelContract {
  const ocrFiles = [modelFile('model/pipeline.json', null)];
  const lock = {
    lockVersion: '2',
    releaseVersion: REAL_MODEL_RELEASE_VERSION,
    approval: { status: 'approved', blockers: [] },
    requirements: [
      {
        requirementId: 'windowsml-ocr',
        artifactVersion: REAL_MODEL_RELEASE_VERSION,
        entryPoint: 'model',
        files: ocrFiles,
      },
      {
        requirementId: 'speech-recognition',
        artifactVersion: REAL_MODEL_RELEASE_VERSION,
        entryPoint: 'model',
        files: speechLockFiles,
      },
    ],
    fixtures: [
      {
        kind: 'ocr',
        expectedEngine: 'windowsml-ocr',
        expectedDevice: 'windowsml-dml',
        expectedModel: 'pp-ocrv6-medium-windowsml',
        expectedText: 'sample',
        bytes: 8,
        pdfBytes: 9,
        sha256: 'a'.repeat(64),
        pdfSha256: 'b'.repeat(64),
      },
      {
        kind: 'whisper',
        expectedEngine: 'speech-recognition',
        expectedModel: 'tea-asr-1.1',
        expectedDevice: 'cuda',
        preferGpu: true,
        expectedNormalizedOutputSha256: 'e'.repeat(64),
        sha256: 'f'.repeat(64),
        bytes: 8,
        expectedSegmentCount: { minimum: 1, maximum: 2 },
      },
    ],
  };
  const lockBytes = canonicalJson(lock);
  const lockHash = sha256(lockBytes);
  const delivery = (requirementId: string, fileName: string, files: readonly ModelFile[]) => ({
    artifacts: [
      {
        role: 'worker',
        requirementId,
        artifactVersion: REAL_MODEL_RELEASE_VERSION,
        platform: 'windows',
        arch: 'x86_64',
        entryPoint: fileName.replace(/\.zip$/u, '.exe'),
        fileName,
        bytes: 4,
        sha256: 'c'.repeat(64),
        extractedBytes: 1,
        filesManifestSha256: 'd'.repeat(64),
        url: `https://example.test/${fileName}`,
      },
    ],
    modelFiles: modelFilesFor(files, lockHash),
    unavailableReason: null,
  });
  const cuda = delivery('speech-recognition', 'capture-engine-speech-recognition.zip', speechLockFiles);
  const cpu = delivery('speech-recognition', 'capture-engine-speech-recognition-cpu.zip', cpuSpeechFiles);
  return {
    lockBytes,
    lock,
    lockHash,
    requirements: [
      { requirementId: 'windowsml-ocr', ...delivery('windowsml-ocr', 'capture-engine-ocr.zip', ocrFiles) },
      speech === 'legacy'
        ? { requirementId: 'speech-recognition', ...cuda }
        : {
            requirementId: 'speech-recognition',
            contents: [{ id: 'cuda', ...cuda }, { id: 'cpu', ...cpu }],
          },
    ],
  };
}

function validateContract(contract: ModelContract) {
  const catalog = {
    catalogVersion: REAL_MODEL_CATALOG_VERSION,
    runtimeVersion: REAL_MODEL_RELEASE_VERSION,
    requirements: contract.requirements,
  };
  return validateSourceLockAndCatalog(contract.lockBytes, contract.lock, canonicalJson(catalog), catalog);
}

function speechContent(contract: ModelContract, id: 'cuda' | 'cpu'): Record<string, unknown> {
  const content = contract.requirements[1]?.contents?.find((item) => item.id === id);
  assert.ok(content);
  return content;
}

test('model catalog validation rejects a legacy speech delivery', () => {
  assert.throws(
    () => validateContract(modelContract('legacy')),
    /^Error: speech-recognition catalog must offer the cuda and cpu contents\.$/u,
  );
});

test('model catalog validation accepts cuda and cpu contents and serves the cuda worker', () => {
  assert.deepEqual(
    validateContract(modelContract('contents')).workerArchives.map((item) => item.fileName),
    ['capture-engine-ocr.zip', 'capture-engine-speech-recognition.zip'],
  );
});

test('model catalog validation rejects cuda model files that are not the full lock', () => {
  const contract = modelContract('contents');
  speechContent(contract, 'cuda').modelFiles = modelFilesFor(cpuSpeechFiles, contract.lockHash);
  assert.throws(
    () => validateContract(contract),
    /^Error: speech-recognition generated model files drifted from the source lock\.$/u,
  );
});

for (const kept of ['cpu', 'cuda'] as const) {
  test(`model catalog validation rejects a speech requirement that publishes only ${kept}`, () => {
    const contract = modelContract('contents');
    const speech = contract.requirements[1];
    assert.ok(speech?.contents);
    speech.contents = speech.contents.filter((item) => item.id === kept);
    assert.throws(
      () => validateContract(contract),
      /speech-recognition catalog must offer the cuda and cpu contents/u,
    );
  });
}

const fallbackModel = 'model/fallback/model.safetensors';
const cpuDrift = /speech-recognition cpu generated model files drifted from the source lock/u;
const cpuFileVariants: ReadonlyArray<readonly [string, readonly ModelFile[], RegExp]> = [
  [
    'a file outside the lock',
    [...cpuSpeechFiles, modelFile('model/fallback/unlocked.bin', 'licenses/NOTICE-fallback.md')],
    cpuDrift,
  ],
  [
    'a wrong size',
    cpuSpeechFiles.map((item) => (item.path === fallbackModel ? { ...item, bytes: item.bytes + 1 } : item)),
    cpuDrift,
  ],
  [
    'a wrong hash',
    cpuSpeechFiles.map((item) => (item.path === fallbackModel ? { ...item, sha256: '0'.repeat(64) } : item)),
    cpuDrift,
  ],
  ['a primary path', speechLockFiles, /speech-recognition cpu model files must not include primary paths/u],
  ['a missing expected path', cpuSpeechFiles.filter((item) => item.path !== 'licenses/NOTICE-fallback.md'), cpuDrift],
];

for (const [label, files, message] of cpuFileVariants) {
  test(`model catalog validation rejects a cpu content with ${label}`, () => {
    const contract = modelContract('contents');
    speechContent(contract, 'cpu').modelFiles = modelFilesFor(files, contract.lockHash);
    assert.throws(() => validateContract(contract), message);
  });
}

const cpuWorker = (cpu: Record<string, unknown>): Record<string, unknown> => {
  const [artifact] = cpu.artifacts as Array<Record<string, unknown>>;
  assert.ok(artifact);
  return artifact;
};
const cpuDeliveryVariants: ReadonlyArray<
  readonly [string, (cpu: Record<string, unknown>, lockHash: string) => void, RegExp]
> = [
  [
    'a worker of another version',
    (cpu) => {
      cpuWorker(cpu).artifactVersion = '0.0.1';
    },
    /speech-recognition cpu worker artifact version drifted/u,
  ],
  [
    'an invalid worker digest',
    (cpu) => {
      cpuWorker(cpu).sha256 = 'not-a-digest';
    },
    /speech-recognition cpu catalog artifact digests are invalid/u,
  ],
  [
    'model files of another version',
    (cpu, lockHash) => {
      cpu.modelFiles = { ...modelFilesFor(cpuSpeechFiles, lockHash), artifactVersion: '0.0.1' };
    },
    /speech-recognition cpu model artifact version drifted/u,
  ],
  [
    'model files bound to another lock',
    (cpu) => {
      cpu.modelFiles = modelFilesFor(cpuSpeechFiles, 'f'.repeat(64));
    },
    /speech-recognition cpu catalog model files are not bound to the source lock/u,
  ],
  [
    'a wrong model manifest digest',
    (cpu, lockHash) => {
      cpu.modelFiles = { ...modelFilesFor(cpuSpeechFiles, lockHash), manifestSha256: '0'.repeat(64) };
    },
    /speech-recognition cpu model manifest hash drifted/u,
  ],
  [
    'no delivery',
    (cpu) => {
      cpu.artifacts = [];
      cpu.modelFiles = null;
      cpu.unavailableReason = 'not published';
    },
    /speech-recognition cpu model delivery must be a JSON object/u,
  ],
];

for (const [label, change, message] of cpuDeliveryVariants) {
  test(`model catalog validation rejects a cpu content with ${label}`, () => {
    const contract = modelContract('contents');
    change(speechContent(contract, 'cpu'), contract.lockHash);
    assert.throws(() => validateContract(contract), message);
  });
}

test('cpu speech model files follow the rule the catalog generator applies', async () => {
  // test_model_source_lock.py checks cpu_speech_model_delivery against this sample.
  const sample = JSON.parse(
    await readFile(
      new URL('../../../packages/capture-runtime/tests/fixtures/cpu-speech-subset-samples.json', import.meta.url),
      'utf8',
    ),
  ) as { speechFiles: unknown[]; cpuPaths: string[] };
  assert.deepEqual(
    cpuSpeechModelFiles(sample.speechFiles).map((item) => item.path),
    sample.cpuPaths,
  );
});

function sampleExpectedProvenance(): Parameters<typeof assertCaptureRecord>[1] {
  return {
    sourceLockSha256: digest,
    catalogSha256: digest,
    selectedModelOptionId: 'qwen3.5-0.8b-v1',
    ocrText: 'sample ocr line',
    ocrImageSha256: digest,
    ocrImageBytes: 100,
    ocrPdfSha256: digest,
    ocrPdfBytes: 200,
    ocrEngine: 'windowsml-ocr',
    ocrModel: 'pp-ocrv6-medium-windowsml',
    ocrDevice: 'windowsml-dml',
    whisperEngine: 'speech-recognition',
    whisperModel: 'tea-asr-1.1',
    whisperDevice: 'cuda',
    whisperPreferGpu: true,
    whisperNormalizedOutputSha256: normalizedTranscriptDigest(['audio first sentence', 'audio second sentence']),
    whisperSegmentMinimum: 2,
    whisperSegmentMaximum: 3,
    whisperFixtureSha256: digest,
    whisperFixtureBytes: 1000,
    workerArchives: [],
  };
}

test('host smoke installs requirements and selected model purely via Tauri commands', async () => {
  const readySet = new Set<string>(['ollama-runtime']);
  let modelActive = false;
  const order: Array<'windowsml-ocr' | 'speech-recognition'> = [];
  const startedIds: string[] = [];

  const invoke: TauriInvoke = async (command, args) => {
    const input = args.input as Record<string, unknown> | undefined;
    if (command === 'runtime_requirements') {
      return {
        items: ['windowsml-ocr', 'ollama-runtime', 'capture-ollama-model', 'speech-recognition'].map((id) => ({
          requirementId: id,
          status: readySet.has(id) ? 'ready' : 'installable',
        })),
      };
    }
    if (command === 'runtime_start_installation') {
      const requirementId = String(input?.requirementId);
      assert.notEqual(requirementId, 'ollama-runtime');
      readySet.add(requirementId);
      return { installationId: `inst-${requirementId}` };
    }
    if (command === 'runtime_get_installation') {
      return { installationId: input?.id, status: 'completed' };
    }
    if (command === 'runtime_model_options') {
      return {
        items: [{ optionId: 'qwen3.5-0.8b-v1', status: modelActive ? 'active' : 'not-installed' }],
      };
    }
    if (command === 'runtime_start_model_installation') {
      assert.equal(input?.optionId, 'qwen3.5-0.8b-v1');
      modelActive = true;
      readySet.add('capture-ollama-model');
      return { installationId: 'model-inst-1', optionId: 'qwen3.5-0.8b-v1' };
    }
    if (command === 'runtime_get_model_installation') {
      return { installationId: 'model-inst-1', optionId: 'qwen3.5-0.8b-v1', status: 'completed' };
    }
    throw new Error(`Unexpected command: ${command}`);
  };

  await installConsentedRequirementsThroughTauri(['windowsml-ocr', 'ollama-runtime'], order, invoke);
  await installModelThroughTauri('qwen3.5-0.8b-v1', invoke, (id) => startedIds.push(id));
  await installConsentedRequirementsThroughTauri(['speech-recognition'], order, invoke);
  assert.deepEqual(order, ['windowsml-ocr', 'speech-recognition']);
  assert.deepEqual(startedIds, ['model-inst-1']);

  await assert.rejects(
    installModelThroughTauri('qwen3.5-0.8b-v1', async (command) => {
      if (command === 'runtime_model_options') return { items: [{ optionId: 'qwen3.5-0.8b-v1', status: 'not-installed' }] };
      throw new Error('start rejected');
    }),
    /^Error: Desktop model installation did not start\.$/u,
  );
});

test('host smoke verifies document OCR checkpoint, ocrEvidence, and cleanup via commands', async () => {
  const expected = sampleExpectedProvenance();
  for (const kind of ['pdf', 'image'] as const) {
    const documentId = kind === 'pdf' ? 'a'.repeat(32) : 'd'.repeat(32);
    const captureId = '11111111-1111-1111-1111-111111111111';
    let deleted = false;
    let gets = 0;
    const invoke: TauriInvoke = async (command, args) => {
      const request = args.request as Record<string, unknown> | undefined;
      const input = args.input as Record<string, unknown> | undefined;
      if (command === 'library_get') {
        if (deleted) throw new Error('not found');
        gets += 1;
        const raw = {
          sourceText: 'sample ocr line\nsecond line',
          extractionEngine: {
            engine: 'windowsml-ocr',
            model: 'pp-ocrv6-medium-windowsml',
            device: 'windowsml-dml',
            digest: `sha256:${digest}`,
          },
          segments: [
            { segmentId: 'seg-1', order: 0, locator: { kind: 'page', page: 1 }, text: 'sample ocr line' },
          ],
        };
        const ocrEvidence = {
          schemaVersion: 1,
          captureId,
          sourceSha256: digest,
          status: 'completed',
          pageCount: 1,
          pages: [],
          summary: { normalizedCharCount: 14, boxCount: 1, confidenceSummary: { scoreState: 'none', numericCount: 0, min: null, max: null, mean: null } },
          provenance: { status: 'resolved' },
          digest,
        };
        // First poll observes persistOcrCheckpoint$'s pre-cleanup write before captureId is cleared.
        if (gets === 1) {
          return {
            documentId,
            captureId,
            status: 'completed',
            stage: 'awaiting_structuring',
            raw,
            ocrEvidence,
          };
        }
        return {
          documentId,
          status: 'awaiting_confirmation',
          stage: 'awaiting_structuring',
          raw,
          ocrEvidence,
        };
      }
      if (command === 'library_delete') {
        assert.equal(request?.documentId, documentId);
        deleted = true;
        return null;
      }
      if (command === 'library_list') {
        return deleted ? [] : [{ documentId, status: 'awaiting_confirmation' }];
      }
      if (command === 'runtime_get_capture') {
        assert.equal(input?.id, captureId);
        throw new Error('HTTP 404');
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const summary = await assertCaptureRecord(
      {
        kind,
        fileName: kind === 'pdf' ? 'fixture.pdf' : 'fixture.png',
        mediaType: kind === 'pdf' ? 'application/pdf' : 'image/png',
        path: kind === 'pdf' ? 'fixture.pdf' : 'fixture.png',
        bytes: new Uint8Array([1]),
        sha256: digest,
        expectedOcrText: 'sample ocr line',
      },
      expected,
      documentId,
      invoke,
      { importedAt: Date.now() - 50, initialCaptureId: captureId },
    );
    if (summary.sourceKind === 'audio') {
      throw new Error('Expected a document summary.');
    }
    assert.equal(summary.sourceKind, kind);
    assert.equal(summary.ocrEvidencePersisted, true);
    assert.equal(summary.pageLocators, 1);
    assert.equal('structuringEngine' in summary, false);
    assert.equal('structuringModel' in summary, false);
    assert.equal('structuringDigest' in summary, false);
    assert.equal('structuredBlockCount' in summary, false);
    assert.equal(deleted, true);
  }
});

test('host smoke fails closed on document structured results, missing raw or ocrEvidence, or wrong checkpoint state', async () => {
  const documentId = 'b'.repeat(32);
  const expected = sampleExpectedProvenance();
  const baseInput = {
    kind: 'pdf' as const,
    fileName: 'fixture.pdf',
    mediaType: 'application/pdf',
    path: 'fixture.pdf',
    bytes: new Uint8Array([1]),
    sha256: digest,
    expectedOcrText: 'sample ocr line',
  };
  const baseRaw = {
    sourceText: 'sample ocr line',
    extractionEngine: {
      engine: 'windowsml-ocr',
      model: 'pp-ocrv6-medium-windowsml',
      device: 'windowsml-dml',
      digest: `sha256:${digest}`,
    },
    segments: [{ segmentId: 'seg-1', order: 0, locator: { kind: 'page', page: 1 }, text: 'sample ocr line' }],
  };
  const baseOcrEvidence = {
    schemaVersion: 1,
    captureId: '11111111-1111-1111-1111-111111111111',
    sourceSha256: digest,
    status: 'completed',
    digest,
  };

  await assert.rejects(
    assertCaptureRecord(baseInput, expected, documentId, async (command) => {
      assert.equal(command, 'library_get');
      return {
        documentId,
        status: 'completed',
        stage: 'completed',
        raw: baseRaw,
        result: {
          structuringEngine: {
            engine: expectedStructuringEngine,
            model: expectedStructuringModel,
            digest: `sha256:${digest}`,
          },
          blocks: [{ blockId: 'blk-1', sourceSegmentId: 'seg-1' }],
        },
      };
    }),
    /documents are now structured and this check must be extended/u,
  );

  await assert.rejects(
    assertCaptureRecord(baseInput, expected, documentId, async () => ({
      documentId,
      status: 'awaiting_confirmation',
      stage: 'awaiting_structuring',
      ocrEvidence: baseOcrEvidence,
    })),
    /without persisting raw extraction/u,
  );

  await assert.rejects(
    assertCaptureRecord(baseInput, expected, documentId, async () => ({
      documentId,
      status: 'awaiting_confirmation',
      stage: 'awaiting_structuring',
      raw: baseRaw,
    })),
    /without persisting ocrEvidence/u,
  );

  await assert.rejects(
    assertCaptureRecord(baseInput, expected, documentId, async () => ({
      documentId,
      status: 'awaiting_confirmation',
      stage: 'awaiting_structuring',
      raw: baseRaw,
      ocrEvidence: { ...baseOcrEvidence, status: 'failed' },
    })),
    /completed/u,
  );

  await assert.rejects(
    assertCaptureRecord(baseInput, expected, documentId, async () => ({
      documentId,
      status: 'awaiting_confirmation',
      stage: 'awaiting_structuring',
      raw: baseRaw,
      ocrEvidence: { ...baseOcrEvidence, digest: `sha256:${digest}` },
    })),
    /digest/u,
  );

  await assert.rejects(
    assertCaptureRecord(baseInput, expected, documentId, async () => ({
      documentId,
      status: 'completed',
      stage: 'awaiting_structuring',
      raw: baseRaw,
      ocrEvidence: baseOcrEvidence,
    })),
    /unexpected terminal state status=completed stage=awaiting_structuring/u,
  );

  await assert.rejects(
    assertCaptureRecord(baseInput, expected, documentId, async () => ({
      documentId,
      status: 'awaiting_confirmation',
      stage: 'completed',
      raw: baseRaw,
      ocrEvidence: baseOcrEvidence,
    })),
    /unexpected terminal state status=awaiting_confirmation stage=completed/u,
  );

  await assert.rejects(
    assertCaptureRecord(baseInput, expected, documentId, async () => ({
      documentId,
      status: 'failed',
      stage: 'extracting',
      errorCode: 'extraction_failed',
    })),
    /status=failed; stage=extracting; errorCode=extraction_failed; mediaKind=pdf\./u,
  );
});

test('host smoke verifies recording partials, segments, structuring, and streaming cleanup', async () => {
  const documentId = 'c'.repeat(32);
  const captureId = '22222222-2222-2222-2222-222222222222';
  const expected = sampleExpectedProvenance();
  const segments = [
    { segmentId: 'seg-0', order: 0, locator: { kind: 'time', startMs: 0, endMs: 2_000 }, text: 'audio first sentence' },
    { segmentId: 'seg-1', order: 1, locator: { kind: 'time', startMs: 2_000, endMs: 5_000 }, text: 'audio second sentence' },
  ];
  const oracle = deriveProgressiveAudioOracleEvidence({
    sourceSha256: digest,
    sourceBytes: 1_000,
    coveredUntilMs: PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS,
    partialRevision: 2,
    segments: segments.map((seg) => ({
      order: seg.order,
      startMs: seg.locator.startMs,
      endMs: seg.locator.endMs,
      text: seg.text,
    })),
    extraction: {
      engine: 'speech-recognition',
      model: 'tea-asr-1.1',
      device: 'cuda',
      digest: `sha256:${digest}`,
    },
  });
  let deleted = false;
  let polls = 0;

  const invoke: TauriInvoke = async (command, args) => {
    const input = args.input as Record<string, unknown> | undefined;
    if (command === 'library_get') {
      if (deleted) throw new Error('not found');
      polls += 1;
      if (polls === 1) {
        return { documentId, status: 'processing', captureId };
      }
      return {
        documentId,
        status: 'completed',
        raw: {
          sourceText: 'audio first sentence\naudio second sentence',
          extractionEngine: {
            engine: 'speech-recognition',
            model: 'tea-asr-1.1',
            device: 'cuda',
            digest: `sha256:${digest}`,
          },
          segments,
        },
        result: {
          extractionEngine: {
            engine: 'speech-recognition',
            model: 'tea-asr-1.1',
            device: 'cuda',
            digest: `sha256:${digest}`,
          },
          structuringEngine: {
            engine: expectedStructuringEngine,
            model: expectedStructuringModel,
            digest: `sha256:${digest}`,
          },
          blocks: [
            { blockId: 'blk-0', sourceSegmentId: 'seg-0' },
            { blockId: 'blk-1', sourceSegmentId: 'seg-1' },
          ],
        },
      };
    }
    if (command === 'runtime_get_streaming_partial') {
      assert.equal(input?.id, captureId);
      return {
        captureId,
        source: { sha256: digest, bytes: 1_000 },
        coveredUntilMs: PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS,
        revision: 2,
        sourceText: 'audio first sentence\naudio second sentence',
        segments,
        extractionEngine: oracle.extraction,
      };
    }
    if (command === 'library_delete') {
      deleted = true;
      return null;
    }
    if (command === 'library_list') {
      return deleted ? [] : [{ documentId, status: 'completed' }];
    }
    if (command === 'runtime_get_streaming_capture') {
      assert.equal(input?.id, captureId);
      throw new Error('HTTP 404');
    }
    throw new Error(`Unexpected command: ${command}`);
  };

  const summary = await assertCaptureRecord(
    {
      kind: 'audio',
      fileName: 'fixture.mp3',
      mediaType: 'audio/mpeg',
      path: 'fixture.mp3',
      bytes: new Uint8Array([1]),
      sha256: digest,
    },
    expected,
    documentId,
    invoke,
    { importedAt: Date.now() - 50, initialCaptureId: captureId, oracle },
  );
  if (summary.sourceKind !== 'audio') {
    throw new Error('Expected a recording summary.');
  }
  assert.equal(summary.extractionEngine, 'speech-recognition');
  assert.equal(summary.device, 'cuda');
  assert.equal(summary.timeLocators, 2);
  assert.equal(summary.structuredBlockCount, 2);
  assert.equal(deleted, true);

  await assert.rejects(
    assertCaptureRecord(
      {
        kind: 'audio',
        fileName: 'fixture.mp3',
        mediaType: 'audio/mpeg',
        path: 'fixture.mp3',
        bytes: new Uint8Array([1]),
        sha256: digest,
      },
      expected,
      documentId,
      async (command) => {
        if (command === 'runtime_get_streaming_partial') {
          return {
            captureId,
            source: { sha256: digest, bytes: 1_000 },
            coveredUntilMs: PROGRESSIVE_AUDIO_SAMPLE_INTERVAL_MS,
            revision: 2,
            sourceText: 'audio first sentence\naudio second sentence',
            segments,
            extractionEngine: oracle.extraction,
          };
        }
        return {
          documentId,
          status: 'completed',
          raw: {
            sourceText: 'audio first sentence\naudio second sentence',
            extractionEngine: {
              engine: 'speech-recognition',
              model: 'tea-asr-1.1',
              device: 'cuda',
              digest: `sha256:${digest}`,
            },
            segments,
          },
          result: {
            extractionEngine: {
              engine: 'speech-recognition',
              model: 'tea-asr-1.1',
              device: 'cuda',
              digest: `sha256:${digest}`,
            },
            structuringEngine: {
              engine: expectedStructuringEngine,
              model: expectedStructuringModel,
              digest: `sha256:${digest}`,
            },
            blocks: [{ blockId: 'blk-0', sourceSegmentId: 'missing-segment' }],
          },
        };
      },
      { importedAt: Date.now() - 50, initialCaptureId: captureId, oracle },
    ),
    /referenced unknown raw segment/u,
  );

  await assert.rejects(
    deleteLibraryDocument(documentId, async (command) => {
      if (command === 'library_delete') return null;
      if (command === 'library_list') return [];
      if (command === 'library_get') throw new Error('not found');
      return { captureId, status: 'completed' };
    }, { captureId, streaming: true }),
    /retained the smoke capture/u,
  );
});
