import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertAudioDeviceMatchesSourceLock,
  audioCheckpointSatisfied,
  assertCudaPathRetainedForAppLaunch,
  assertNoAmbientModelOverrides,
  assertRealMediaModelEvidence,
  canonicalJson,
  desktopRuntimeReady,
  NATIVE_SOURCE_BROKER_DIALOG_CLASSES,
  NATIVE_SOURCE_DIALOG_CLASSES,
  nativeDialogUiAutomationScript,
  nativeOpenDialogUiAutomation,
  REAL_MODEL_CATALOG_VERSION,
  REAL_MODEL_DEPENDENCY_ORDER_SCOPE,
  REAL_MODEL_AUDIO_CAPTURE_TIMEOUT_MS,
  PROGRESSIVE_AUDIO_CHECKPOINT_MS,
  REAL_MODEL_RELEASE_VERSION,
  REAL_MODEL_SOURCE_IMPORT_MODE,
  modelSmokeInjectedDocumentId,
  modelSmokeFixtureEnvironment,
  normalizedOcrTextDigest,
  requirementCompletedAfterConsent,
  runtimeModelOptionActive,
  runtimeRequirementsReady,
  safeSmokeFailureMessage,
  safeTerminalDocumentFailure,
  safeTerminalInstallationFailure,
  safeTerminalModelInstallationFailure,
  safeV2CaptureStage,
  safeUiAutomationDiagnostics,
  sha256,
  shouldUseBackendReuseReadiness,
  whisperCpuFallbackAllowedForSourceLock,
  windowsPowerShellExecutable,
} from './real-media-model-smoke.ts';
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

test('v2 backend capture state represents every streaming status as its own stage', () => {
  for (const status of [
    'created',
    'waiting_input',
    'extracting',
    'awaiting_structuring',
    'structuring',
    'completed',
    'failed',
    'cancelled',
  ]) {
    assert.equal(safeV2CaptureStage(status), status);
  }
  assert.equal(safeV2CaptureStage(null), 'unknown');
  assert.equal(safeV2CaptureStage('queued'), 'unknown');
  assert.equal(safeV2CaptureStage('legacy-stage'), 'unknown');
});

test('terminal document failure represents v2 stages and source kind mismatches', () => {
  assert.equal(
    safeTerminalDocumentFailure('failed', 'created', 'source_kind_mismatch'),
    'Desktop capture terminated. status=failed; stage=created; errorCode=source_kind_mismatch.',
  );
  assert.equal(
    safeTerminalDocumentFailure('failed', 'waiting_input', 'progressive_failed'),
    'Desktop capture terminated. status=failed; stage=waiting_input; errorCode=progressive_failed.',
  );
  assert.equal(
    safeTerminalDocumentFailure('failed', 'legacy-stage', 'extraction_failed'),
    'Desktop capture terminated. status=failed; stage=unknown; errorCode=extraction_failed.',
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
    evidenceKind: 'real-model-enabled-tauri-ui-smoke',
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
      engine: 'whisper-primary',
      model: 'large-v3-turbo',
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
      engine: 'whisper-primary',
      model: 'large-v3-turbo',
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
      engine: 'whisper-primary',
      model: 'large-v3-turbo',
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
      engine: 'whisper-primary',
      model: 'large-v3-turbo',
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

test('model smoke waits for the exact retry action after selecting an injected document', async () => {
  const source = await readFile(new URL('./real-media-model-smoke.ts', import.meta.url), 'utf8');
  const cardClick = source.indexOf('await document.card.click();');
  const detailWait = source.indexOf("await detail.waitFor({ state: 'visible', timeout: 30_000 });", cardClick);
  const retryWait = source.indexOf("await retry.waitFor({ state: 'visible', timeout: 30_000 });");
  const retryCount = source.indexOf('if (await retry.count() !== 1)', retryWait);
  const captureReadyWait = source.indexOf('await waitForCaptureReady(page);', retryCount);
  const retryClick = source.indexOf('await retry.click();', retryCount);
  assert.ok(cardClick >= 0);
  assert.ok(detailWait > cardClick);
  assert.ok(retryWait > cardClick);
  assert.ok(retryCount > retryWait);
  assert.ok(captureReadyWait > retryCount);
  assert.ok(retryClick > retryCount);
  assert.ok(retryClick > captureReadyWait);
});

test('private OCR oracle hashes normalized source text without exposing its contents', () => {
  const first = normalizedOcrTextDigest('  private  PDF\noutput  ');
  const second = normalizedOcrTextDigest('private PDF output');
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.throws(() => normalizedOcrTextDigest('  '), /source text was empty/u);
});

test('setup accepts a ready requirement row disappearing after consent', () => {
  assert.equal(requirementCompletedAfterConsent('ready', true), true);
  assert.equal(requirementCompletedAfterConsent('', true), true);
  assert.equal(requirementCompletedAfterConsent('', false), false);
  assert.equal(requirementCompletedAfterConsent('installable', true), false);
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
  const message = safeSmokeFailureMessage(new Error(failure ?? ''), 0, []);
  assert.match(message, /failure=terminal-model-installation/u);
  assert.doesNotMatch(message, /PRIVATE|C:\\/u);
  assert.equal(safeTerminalModelInstallationFailure('running', null, 0.1), undefined);
  assert.match(
    safeSmokeFailureMessage(new Error('Desktop model installation did not start.'), 0, []),
    /failure=model-installation-start/u,
  );
});

test('native dialog helper resolves PowerShell without relying on PATH', () => {
  assert.equal(
    windowsPowerShellExecutable('C:\\Windows'),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
});

test('native dialog UIA script is process-owned, localization-independent, and metadata-only', () => {
  const script = nativeDialogUiAutomationScript();
  assert.deepEqual(NATIVE_SOURCE_DIALOG_CLASSES, ['#32770']);
  assert.deepEqual(NATIVE_SOURCE_BROKER_DIALOG_CLASSES, ['CabinetWClass']);
  assert.match(script, /UIAutomationClient/u);
  assert.match(script, /GetWindowThreadProcessId/u);
  assert.match(script, /EnumWindows/u);
  assert.match(script, /GetClassName/u);
  assert.match(script, /GW_OWNER/u);
  assert.match(script, /GetForegroundWindow/u);
  assert.match(script, /IsWindowEnabled/u);
  assert.match(script, /AttachThreadInput/u);
  assert.match(script, /BringWindowToTop/u);
  assert.match(script, /SetForegroundWindow/u);
  assert.match(script, /WindowPattern/u);
  assert.match(script, /IsModal/u);
  assert.match(script, /GetProcessById/u);
  assert.match(script, /ProcessName -cne 'explorer'/u);
  assert.match(script, /UIA\|stage=ready\|code=activated/u);
  assert.match(script, /UIA\|stage=target-window\|code=count-invalid/u);
  assert.match(script, /UIA\|stage=target-activation\|code=failed/u);
  assert.match(script, /baselineWindowHandles/u);
  assert.match(script, /targetMainWindowHandles/u);
  assert.match(script, /Tauri_Window/u);
  assert.match(script, /FileNameControlHost/u);
  assert.match(script, /(?:'1001'|'1148')/u);
  assert.match(script, /ValuePattern/u);
  assert.match(script, /InvokePattern/u);
  assert.match(script, /SendMessageTimeoutText/u);
  assert.match(script, /Write-ElementDiagnostics 'TOP'/u);
  assert.match(script, /commonDialogClasses -contains/u);
  assert.match(script, /brokerDialogClasses -contains/u);
  assert.match(script, /Test-BrokeredDialog/u);
  const eligibility = script.match(/\$facts\.Eligible =(?<criteria>[\s\S]*?)\n {2}\} catch/u)?.groups?.criteria || '';
  for (const criterion of [
    'ClassAllowed',
    'DifferentProcess',
    'ExplorerProcess',
    'Foreground',
    'Modal',
    'NewWindow',
    'SingleTarget',
    'TargetStillOwned',
    'TargetWasEnabled',
    'TargetDisabled',
  ]) {
    assert.match(eligibility, new RegExp(`\\$facts\\.${criterion}`, 'u'));
  }
  assert.doesNotMatch(script, /Current\.Name|NameProperty/u);
  assert.doesNotMatch(script, /GetWindowText/u);
  assert.doesNotMatch(script, /(?:Open|\u958b\u555f|\u6253\u5f00|\u958b\u304f).*Button/iu);
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

test('smoke failure output excludes OCR, audio, and document-name content', () => {
  const privateOcr = 'PRIVATE_CERT_OCR_SENTINEL';
  const privateAudio = 'PRIVATE_AUDIO_TRANSCRIPT_SENTINEL';
  const privateDocumentName = 'private-certificate-name.pdf';
  const message = safeSmokeFailureMessage(
    new Error(`${privateOcr} ${privateAudio}`),
    2,
    [
      {
        testId: 'document-raw',
        count: 1,
        statuses: ['completed'],
        rawText: privateOcr,
        documentNames: [privateDocumentName],
      },
      {
        testId: 'document-extraction-provenance',
        count: 1,
        engines: ['windowsml-ocr', privateOcr],
        devices: ['windowsml-dml'],
        transcript: privateAudio,
      },
    ],
    '{"status":"failed","stage":"failed","progressBand":"unknown","errorCode":"capture_failed"}',
  );
  assert.doesNotMatch(message, new RegExp(`${privateOcr}|${privateAudio}|${privateDocumentName}`, 'u'));
  assert.match(message, /failure=unexpected/u);
  assert.match(message, /windowsml-ocr/u);
  assert.match(message, /windowsml-dml/u);
  assert.match(message, /document-raw/u);
  assert.match(message, /Backend capture state: \{"status":"failed","stage":"failed","progressBand":"unknown","errorCode":"capture_failed"\}/u);
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
  const thrownMessage = safeSmokeFailureMessage(new Error(terminalFailure), 0, []);
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
      'Source extraction worker failed at stages whisper-model-load-cuda-failed-runtimeerror>whisper-gpu-fallback>whisper-model-load-cpu-failed-runtimeerror.',
      'audio',
    ),
    'Desktop capture terminated. status=failed; stage=failed; errorCode=extraction_failed; mediaKind=audio; workerStage=whisper-model-load-cuda-failed-runtimeerror>whisper-gpu-fallback>whisper-model-load-cpu-failed-runtimeerror.',
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

test('terminal Whisper installation failure is bounded and content-free', () => {
  const failure = safeTerminalInstallationFailure(
    'whisper-primary',
    'failed',
    'probing',
    'worker_failed',
    0.92,
    'worker failed at stage worker-process-response-error-bootloader',
  );
  assert.equal(
    failure,
    'Desktop runtime installation terminated. requirement=whisper-primary; status=failed; stage=probing; errorCode=worker_failed; progressBand=late; workerStage=worker-process-response-error-bootloader; failureReason=runtime-install-unexpected.',
  );
  const message = safeSmokeFailureMessage(new Error(failure), 0, []);
  assert.match(message, /failure=terminal-installation/u);
  assert.doesNotMatch(message, /PRIVATE|C:\\|worker failed/u);
  assert.equal(safeTerminalInstallationFailure('windowsml-ocr', 'failed', 'probing', 'x', 0.9), undefined);
  assert.equal(
    safeTerminalInstallationFailure(
      'whisper-primary',
      'failed',
      null,
      'installation_failed',
      0.7,
      'direct model download exhausted bounded retries',
    ),
    'Desktop runtime installation terminated. requirement=whisper-primary; status=failed; stage=unknown; errorCode=installation_failed; progressBand=download; failureReason=direct-model-retries-exhausted.',
  );
});

test('native dialog UIA script parses in Windows PowerShell', { skip: process.platform !== 'win32' }, () => {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const parser = `
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseInput(
  $env:CAPTURE_SMOKE_UIA_SCRIPT,
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
      env: {
        SystemRoot: systemRoot,
        Path: process.env.Path || process.env.PATH || '',
        CAPTURE_SMOKE_UIA_SCRIPT: nativeDialogUiAutomationScript(),
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

test('native dialog UIA helper selects a benign file through the Windows common dialog', {
  skip: process.platform !== 'win32' || process.env.CAPTURE_SMOKE_PICKER_TEST !== '1',
  timeout: 45_000,
}, async () => {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const temporary = await mkdtemp(join(tmpdir(), 'capture-picker-uia-'));
  const fixture = join(temporary, 'picker-probe.txt');
  const readySignal = join(temporary, 'open-dialog.signal');
  const activatedSignal = join(temporary, 'target-activated.signal');
  await writeFile(fixture, 'picker probe\n', 'utf8');
  const hostScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class CaptureSmokeNativeTarget {
  private const uint WM_DESTROY = 0x0002;
  private const uint WM_CLOSE = 0x0010;
  private const int SW_SHOWNOACTIVATE = 4;
  private const uint WS_OVERLAPPEDWINDOW = 0x00CF0000;
  private static readonly ManualResetEventSlim Ready = new ManualResetEventSlim(false);
  private static readonly WndProc WindowProcedure = HandleMessage;
  private static IntPtr windowHandle = IntPtr.Zero;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct WNDCLASSEX {
    public uint cbSize;
    public uint style;
    public WndProc lpfnWndProc;
    public int cbClsExtra;
    public int cbWndExtra;
    public IntPtr hInstance;
    public IntPtr hIcon;
    public IntPtr hCursor;
    public IntPtr hbrBackground;
    public string lpszMenuName;
    public string lpszClassName;
    public IntPtr hIconSm;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct MSG {
    public IntPtr hwnd;
    public uint message;
    public UIntPtr wParam;
    public IntPtr lParam;
    public uint time;
    public int x;
    public int y;
  }

  private delegate IntPtr WndProc(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  private static extern IntPtr GetModuleHandle(string moduleName);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern ushort RegisterClassEx(ref WNDCLASSEX windowClass);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern IntPtr CreateWindowEx(uint extendedStyle, string className, string windowName, uint style,
    int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);

  [DllImport("user32.dll")]
  private static extern bool ShowWindow(IntPtr hwnd, int command);

  [DllImport("user32.dll")]
  private static extern int GetMessage(out MSG message, IntPtr hwnd, uint minimum, uint maximum);

  [DllImport("user32.dll")]
  private static extern bool TranslateMessage(ref MSG message);

  [DllImport("user32.dll")]
  private static extern IntPtr DispatchMessage(ref MSG message);

  [DllImport("user32.dll")]
  private static extern IntPtr DefWindowProc(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern void PostQuitMessage(int exitCode);

  [DllImport("user32.dll")]
  private static extern bool PostMessage(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();

  public static IntPtr Start() {
    var thread = new Thread(RunWindowLoop) { IsBackground = true };
    thread.SetApartmentState(ApartmentState.STA);
    thread.Start();
    if (!Ready.Wait(5000) || windowHandle == IntPtr.Zero) {
      throw new InvalidOperationException("Native target window did not start.");
    }
    return windowHandle;
  }

  public static bool IsForeground(IntPtr expectedHandle) {
    return expectedHandle != IntPtr.Zero && GetForegroundWindow() == expectedHandle;
  }

  public static void Stop(IntPtr expectedHandle) {
    if (expectedHandle != IntPtr.Zero) {
      PostMessage(expectedHandle, WM_CLOSE, UIntPtr.Zero, IntPtr.Zero);
    }
  }

  private static void RunWindowLoop() {
    var instance = GetModuleHandle(null);
    var windowClass = new WNDCLASSEX {
      cbSize = (uint)Marshal.SizeOf(typeof(WNDCLASSEX)),
      lpfnWndProc = WindowProcedure,
      hInstance = instance,
      lpszClassName = "Tauri_Window"
    };
    if (RegisterClassEx(ref windowClass) == 0) {
      Ready.Set();
      return;
    }
    windowHandle = CreateWindowEx(0, "Tauri_Window", string.Empty, WS_OVERLAPPEDWINDOW,
      20, 20, 320, 200, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
    if (windowHandle == IntPtr.Zero) {
      Ready.Set();
      return;
    }
    ShowWindow(windowHandle, SW_SHOWNOACTIVATE);
    Ready.Set();
    MSG message;
    while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {
      TranslateMessage(ref message);
      DispatchMessage(ref message);
    }
  }

  private static IntPtr HandleMessage(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam) {
    if (message == WM_DESTROY) {
      PostQuitMessage(0);
      return IntPtr.Zero;
    }
    return DefWindowProc(hwnd, message, wParam, lParam);
  }
}
'@
$targetWindow = [CaptureSmokeNativeTarget]::Start()
$deadline = [DateTime]::UtcNow.AddSeconds(10)
while (-not (Test-Path -LiteralPath $env:CAPTURE_SMOKE_DIALOG_SIGNAL)) {
  if ([DateTime]::UtcNow -ge $deadline) { exit 4 }
  Start-Sleep -Milliseconds 25
}
if (-not [CaptureSmokeNativeTarget]::IsForeground($targetWindow)) { exit 5 }
Set-Content -LiteralPath $env:CAPTURE_SMOKE_ACTIVATED_SIGNAL -Value 'activated'
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
$owner = New-Object System.Windows.Forms.NativeWindow
$owner.AssignHandle($targetWindow)
try {
  $result = $dialog.ShowDialog($owner)
} finally {
  $owner.ReleaseHandle()
  [CaptureSmokeNativeTarget]::Stop($targetWindow)
}
if ($result -ne [System.Windows.Forms.DialogResult]::OK) { exit 2 }
if ($dialog.FileName -cne $env:CAPTURE_SMOKE_DIALOG_FILE) { exit 3 }
exit 0
`;
  const host = spawn(
    windowsPowerShellExecutable(systemRoot),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', hostScript],
    {
      env: {
        SystemRoot: systemRoot,
        Path: process.env.Path || process.env.PATH || '',
        TEMP: process.env.TEMP || '',
        TMP: process.env.TMP || '',
        CAPTURE_SMOKE_DIALOG_FILE: fixture,
        CAPTURE_SMOKE_DIALOG_SIGNAL: readySignal,
        CAPTURE_SMOKE_ACTIVATED_SIGNAL: activatedSignal,
      },
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  const hostExit = new Promise<number | null>((resolvePromise, reject) => {
    host.once('error', reject);
    host.once('close', resolvePromise);
  });
  try {
    assert.ok(host.pid, 'The Windows common-dialog test host must expose a PID.');
    await nativeOpenDialogUiAutomation(fixture, host.pid, async () => {
      await writeFile(readySignal, 'ready\n', 'utf8');
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          await access(activatedSignal);
          return;
        } catch {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
        }
      }
      assert.fail('The helper must foreground the exact PID-scoped target before the dialog opens.');
    });
    assert.equal(await hostExit, 0, 'The common dialog must return the exact benign fixture selected by UIA.');
  } finally {
    if (host.exitCode === null) host.kill();
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

test('desktop model smoke uses generated release catalog and WebView selectors', async () => {
  const source = await readFile(new URL('./real-media-model-smoke.ts', import.meta.url), 'utf8');
  assert.match(source, /['"]dist['"][\s\S]*['"]release['"][\s\S]*capture-engine-catalog\.json/u);
  assert.doesNotMatch(source, /src[\\/]capture_runtime[\\/]assets[\\/]engine-catalog\.json/u);
  for (const selector of [
    'runtime-setup',
    'runtime-requirement',
    'runtime-install',
    'model-selection',
    'model-option',
    'model-install',
    'model-install-progress',
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
  assert.match(source, /UIAutomationClient/u);
  assert.match(source, /AutomationIdProperty/u);
  assert.match(source, /ValuePattern/u);
  assert.match(source, /InvokePattern/u);
  assert.match(source, /CAPTURE_SMOKE_APP_PID/u);
  assert.match(source, /CAPTURE_WHISPER_PREFER_GPU/u);
  assert.doesNotMatch(source, /FindWindow\('#32770'/u);
  assert.doesNotMatch(source, /async function nativeOpenDialog\(/u);
  assert.doesNotMatch(source, /SetWindowText|FindWindow\(|SendMessage\(/u);
  assert.doesNotMatch(source, /locator\('body'\)\.innerText/u);
  assert.doesNotMatch(source, /function importThroughUi/u);
  assert.doesNotMatch(source, /selection\.count\(\)/u);
  assert.match(source, /invokeTauriCommand\(page, 'runtime_get_model_installation'/u);
  assert.match(source, /invokeTauriCommand\(page, 'runtime_model_options'/u);
  assert.match(source, /invokeTauriCommand\(page, 'model_smoke_import_fixture', \{\s*request: \{ fixtureKey \}/u);
  assert.match(source, /CAPTURE_SMOKE_FIXTURE_ROOT = runRoot/u);
  assert.match(source, /modelSmokeFixtureEnvironment\(\{/u);
  assert.match(source, /CAPTURE_SMOKE_FIXTURE_PDF: paths\.pdf/u);
  assert.match(source, /CAPTURE_SMOKE_FIXTURE_IMAGE: paths\.image/u);
  assert.match(source, /CAPTURE_SMOKE_FIXTURE_AUDIO: paths\.audio/u);
  assert.match(source, /sourceImportMode: REAL_MODEL_SOURCE_IMPORT_MODE/u);
  assert.match(source, /nativePickerExercised: false/u);
  assert.match(source, /await retry\.waitFor\(\{ state: 'visible', timeout: 30_000 \}\)/u);
  assert.match(source, /throwIfTerminalDocumentFailure/u);
  assert.match(source, /model-private-audio\.mp3/u);
  assert.match(source, /CAPTURE_REAL_MEDIA_MODEL_OCR_TEXT_SHA256/u);
  assert.match(source, /private OCR output oracle/u);
  assert.doesNotMatch(source, /Get-CimInstance|Win32_Process/u);
  assert.match(source, /audio\/mpeg/u);
  assert.match(source, /REAL_MODEL_AUDIO_CAPTURE_TIMEOUT_MS/u);
  assert.match(source, /data-covered-until-ms/u);
  assert.match(source, /progressive checkpoint/u);
  assert.match(source, /extractionDurationMs/u);
  assert.match(source, /normalizedTranscriptDigest/u);
  assert.ok(
    source.indexOf('UI raw extraction did not become visible')
      < source.indexOf('UI result and provenance did not become visible'),
    'The bounded extraction assertion must observe raw before waiting for the terminal result.',
  );
  assert.doesNotMatch(source, /sha256\(Buffer\.from\(rawText/u);
  assert.doesNotMatch(source, /digestFromProvenance/u);
  assert.match(source, /modelDependencyOrder: \[\.\.\.installationOrder\]/u);
  assert.match(source, /selectedModelOptionId: 'qwen3\.5-0\.8b-v1'/u);
  assert.match(source, /modelDependencyOrderScope: REAL_MODEL_DEPENDENCY_ORDER_SCOPE/u);
  assert.doesNotMatch(source, /pids\.unshift\(/u);
  assert.match(source, /releaseGateSatisfied: false/u);
  assert.match(source, /localProductionPreflight: true/u);
  assert.match(source, /consumerE2e: false/u);
});
