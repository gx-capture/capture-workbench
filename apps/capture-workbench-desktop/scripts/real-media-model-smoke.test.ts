import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertNoAmbientModelOverrides,
  assertRealMediaModelEvidence,
  canonicalJson,
  nativeDialogUiAutomationScript,
  nativeOpenDialogUiAutomation,
  REAL_MODEL_CATALOG_VERSION,
  REAL_MODEL_DEPENDENCY_ORDER_SCOPE,
  REAL_MODEL_RELEASE_VERSION,
  normalizedOcrTextDigest,
  requirementCompletedAfterConsent,
  safeUiAutomationDiagnostics,
  sha256,
  windowsPowerShellExecutable,
} from './real-media-model-smoke.ts';

const digest = 'a'.repeat(64);

function validEvidence() {
  return {
    evidenceKind: 'real-model-enabled-tauri-ui-smoke',
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

test('canonical JSON hashing is deterministic for release contract binding', () => {
  const left = canonicalJson({ z: 1, a: { y: true, x: false } });
  const right = canonicalJson({ a: { x: false, y: true }, z: 1 });
  assert.deepEqual(left, right);
  assert.match(sha256(left), /^[a-f0-9]{64}$/u);
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

test('native dialog helper resolves PowerShell without relying on PATH', () => {
  assert.equal(
    windowsPowerShellExecutable('C:\\Windows'),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
});

test('native dialog UIA script is process-owned, localization-independent, and metadata-only', () => {
  const script = nativeDialogUiAutomationScript();
  assert.match(script, /UIAutomationClient/u);
  assert.match(script, /GetWindowThreadProcessId/u);
  assert.match(script, /GW_OWNER/u);
  assert.match(script, /FileNameControlHost/u);
  assert.match(script, /(?:'1001'|'1148')/u);
  assert.match(script, /ValuePattern/u);
  assert.match(script, /InvokePattern/u);
  assert.match(script, /SendMessageTimeoutText/u);
  assert.match(script, /Write-ElementDiagnostics 'TOP'/u);
  assert.doesNotMatch(script, /Current\.Name|NameProperty/u);
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
  await writeFile(fixture, 'picker probe\n', 'utf8');
  const hostScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
$result = $dialog.ShowDialog()
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
      },
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  try {
    assert.ok(host.pid, 'The Windows common-dialog test host must expose a PID.');
    await nativeOpenDialogUiAutomation(fixture, host.pid);
    const exitCode = host.exitCode ?? await new Promise<number | null>((resolvePromise, reject) => {
      host.once('error', reject);
      host.once('close', resolvePromise);
    });
    assert.equal(exitCode, 0, 'The common dialog must return the exact benign fixture selected by UIA.');
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
    'model-option-select',
    'model-install',
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
  assert.doesNotMatch(source, /FindWindow\('#32770'/u);
  assert.doesNotMatch(source, /async function nativeOpenDialog\(/u);
  assert.doesNotMatch(source, /SetWindowText|FindWindow\(|SendMessage\(/u);
  assert.match(source, /model-private-audio\.mp3/u);
  assert.match(source, /CAPTURE_REAL_MEDIA_MODEL_OCR_TEXT_SHA256/u);
  assert.match(source, /private OCR output oracle/u);
  assert.doesNotMatch(source, /Get-CimInstance|Win32_Process/u);
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
  assert.match(source, /selectedModelOptionId: 'qwen3\.5-0\.8b-v1'/u);
  assert.match(source, /modelDependencyOrderScope: REAL_MODEL_DEPENDENCY_ORDER_SCOPE/u);
  assert.doesNotMatch(source, /pids\.unshift\(/u);
  assert.match(source, /releaseGateSatisfied: false/u);
  assert.match(source, /localProductionPreflight: true/u);
  assert.match(source, /consumerE2e: false/u);
});
