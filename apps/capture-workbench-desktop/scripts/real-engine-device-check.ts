/**
 * Real-engine device check at the runtime API (manual, Windows, not a release
 * gate): verifies that OCR, speech recognition and speaker identification run
 * on the device the design assigns them, not only that they return text.
 *
 * It starts the locally built release runtime
 * (`capture-runtime:build-release-artifacts`, output
 * `packages/capture-runtime/dist/release`) once per scenario with that
 * scenario's settings, installs what the scenario needs through
 * `/v2/runtime/installations` with the worker archives served from a loopback
 * mirror of that output (the catalog's release URLs do not exist before the
 * release; models still come from the catalog's HTTPS sources and the shared
 * engine cache), runs the captures, and meanwhile samples:
 *   - the Windows GPU engine counters of the runtime's own process tree,
 *     grouped by adapter LUID (discrete versus integrated GPU), and its CPU time;
 *   - `nvidia-smi` utilization and memory, when the NVIDIA driver is present.
 * Each scenario writes the designed device (with its rule), the reported one
 * (capture provenance, `ocrCompute` from readiness, GPU fallback warnings,
 * failure stage) and the observed one to JSON and Markdown.
 *
 * Usage (after building the release artifacts):
 *   node apps/capture-workbench-desktop/scripts/real-engine-device-check.ts \
 *     --pdf <file> --image <file> --audio <file> [--scenarios a,b] \
 *     [--run-tree <kept tree from an earlier run>] [--report <markdown path>]
 *   --list prints the scenarios.
 *   --observe <process name> --observe-into <directory> only samples the
 *   devices of that process's trees (for example capture-workbench-dev-host.exe
 *   during smoke-real-engines) until the printed session stop file exists.
 *
 * A local run keeps its tree (`pnpm run kept-run-trees -- --list`).
 * `--run-tree` reuses the shared installs, except for the fresh CPU pack.
 * On GitHub Actions only a scratch tree created by this run is deleted.
 *
 * Private inputs are read by path only. Their names, their contents and the
 * recognized text never reach the evidence or the console; the runtime sees a
 * synthetic file name. The bearer token is generated per runtime start and
 * redacted before any runtime output is written to disk.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { catalogDeliveries } from './practical-installed.ts';
import {
  decideVerdict,
  deviceScenarios,
  formatCleanupFailure,
  formatResultSummary,
  parseNvidiaSamples,
  parseWindowsSamples,
  preflightScenario,
  renderMarkdownReport,
  summarizeObservation,
  summarizeResults,
  type CaptureInput,
  type CaptureObservation,
  type DeviceScenario,
  type GpuAdapter,
  type OcrComputeReport,
  type RemainingProcess,
  type ReportedCapture,
  type ScenarioResult,
} from './real-engine-devices.ts';
import { request, reservePort } from './real-media-smoke.ts';
import { appRoot } from './stage-runtime.ts';
import { isTerminalCaptureStatus, startV2Capture, type CaptureOperation } from './v2-capture-flow.ts';

const workspaceRoot = resolve(appRoot, '..', '..');
const scriptName = 'capture-workbench-desktop:check-real-engine-devices';
const runtimeExecutableName = 'capture-runtime-x86_64-pc-windows-msvc.exe';
const workspaceEvidenceDirectory = join(workspaceRoot, 'tmp', 'capture-workbench-desktop', 'real-engine-device-check');
const installationTimeoutMs = 90 * 60_000;
const captureTimeoutMs = 60 * 60_000;
const readyTimeoutMs = 200_000;
const runtimeCleanupWaitMs = 35_000;
const ownedRuntimeObserverTimeoutMs = 30_000;
const sampleIntervalSeconds = 2;

interface RunOptions {
  readonly inputs: Partial<Record<CaptureInput, string>>;
  readonly scenarios: readonly DeviceScenario[];
  readonly releaseDirectory: string;
  readonly runTree: string;
  readonly reportPath?: string;
  readonly adapters: readonly GpuAdapter[];
  readonly nvidiaPresent: boolean;
  readonly driverPresent: boolean;
}

interface StartedRuntime {
  readonly child: ChildProcess;
  readonly port: number;
  readonly token: string;
}

interface RawCaptureView {
  readonly extractionEngine?: {
    readonly engine?: string;
    readonly model?: string;
    readonly device?: string | null;
    readonly stageMs?: Record<string, number> | null;
  };
  readonly diarizationEngine?: { readonly device?: string | null } | null;
  readonly warnings?: readonly string[];
}

const mediaTypes: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      pdf: { type: 'string' },
      image: { type: 'string' },
      audio: { type: 'string' },
      scenarios: { type: 'string' },
      'release-dir': { type: 'string' },
      'run-tree': { type: 'string' },
      report: { type: 'string' },
      list: { type: 'boolean' },
      observe: { type: 'string' },
      'observe-into': { type: 'string' },
    },
    allowPositionals: false,
  });
  if (process.platform !== 'win32') throw new Error('The real-engine device check runs on Windows only.');
  const all = deviceScenarios();
  if (values.list) {
    for (const scenario of all) process.stdout.write(`${scenario.id}\t${scenario.summary}\n`);
    return;
  }
  const adapters = discoverAdapters();
  if (values.observe) {
    if (!values['observe-into']) throw new Error('--observe needs --observe-into <directory>.');
    await observeProcesses(values.observe, resolve(values['observe-into']), adapters);
    return;
  }
  const driverPresent = existsSync(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'nvcuda.dll'));
  const selectedIds = values.scenarios?.split(',').map((id) => id.trim()).filter(Boolean);
  const scenarios = selectedIds ? selectedIds.map((id) => {
    const scenario = all.find((item) => item.id === id);
    if (!scenario) throw new Error(`Unknown scenario ${id}; --list shows the scenarios.`);
    return scenario;
  }) : all;
  const inputs: Partial<Record<CaptureInput, string>> = {};
  const runnable = scenarios.filter((scenario) => !preflightScenario(scenario, adapters, driverPresent));
  for (const input of new Set(runnable.flatMap((scenario) => scenario.captures))) {
    const value = values[input]?.trim();
    if (!value) throw new Error(`--${input} is required by the selected scenarios.`);
    const metadata = await stat(value).catch(() => undefined);
    if (!metadata?.isFile() || metadata.size === 0) throw new Error(`--${input} must name a non-empty file.`);
    inputs[input] = resolve(value);
  }
  const releaseDirectory = resolve(values['release-dir'] ?? join(workspaceRoot, 'packages', 'capture-runtime', 'dist', 'release'));
  for (const name of runnable.length ? [runtimeExecutableName, 'capture-engine-catalog.json'] : []) {
    if (!existsSync(join(releaseDirectory, name))) {
      throw new Error(`${name} is missing in ${releaseDirectory}; build it with capture-runtime:build-release-artifacts.`);
    }
  }
  let scratchRoot: string | undefined;
  if (!values['run-tree'] && process.env['GITHUB_ACTIONS'] === 'true') {
    const scratchDirectory = join(workspaceRoot, 'tmp');
    await mkdir(scratchDirectory, { recursive: true });
    scratchRoot = await checkedChild(scratchDirectory, workspaceRoot);
  }
  const runTree = values['run-tree'] ? await validateRunTree(values['run-tree'])
    : scratchRoot ? await mkdtemp(join(scratchRoot, '.devices-')) : await validateRunTree(createRunTree());
  const scratchIdentity = scratchRoot ? await lstat(runTree) : undefined;
  const nvidiaPresent = spawnSync('nvidia-smi', ['-L'], { windowsHide: true, stdio: 'ignore' }).status === 0;
  try {
    const results = await run({
      inputs,
      scenarios,
      releaseDirectory,
      runTree,
      ...(values.report ? { reportPath: resolve(values.report) } : {}),
      adapters,
      nvidiaPresent,
      driverPresent,
    });
    const summary = summarizeResults(results);
    process.stdout.write(`${formatResultSummary(summary)}\n`);
    process.exitCode = summary.exitCode;
  } finally {
    if (!scratchRoot) {
      process.stdout.write(`Kept the run tree at ${runTree}; remove it with pnpm run kept-run-trees -- --remove ${runTree}\n`);
    } else if (scratchIdentity && dirname(runTree) === scratchRoot) {
      const current = await lstat(runTree);
      if (current.isDirectory() && current.dev === scratchIdentity.dev && current.ino === scratchIdentity.ino && await realpath(runTree) === runTree) {
        await rm(runTree, { recursive: true, force: true });
      }
    }
  }
}

async function run(options: RunOptions): Promise<readonly ScenarioResult[]> {
  const canRun = options.scenarios.some((scenario) => !preflightScenario(scenario, options.adapters, options.driverPresent));
  const evidenceDirectory = await mkdtemp(join(options.runTree, 'evidence-'));
  const mirrorPort = canRun ? await reservePort() : 0;
  const mirror = canRun ? await startWorkerMirror(options.releaseDirectory, mirrorPort) : undefined;
  const results: ScenarioResult[] = [];
  const preamble = [
    `Runtime: \`${join(options.releaseDirectory, runtimeExecutableName)}\`. Run tree: \`${options.runTree}\`.`,
    `Adapters: ${options.adapters.map((adapter) => `${adapter.adapterClass} ${adapter.luid} ${adapter.description}`).join('; ') || 'none'}. NVIDIA driver: ${options.driverPresent ? 'present' : 'absent'}.`,
  ];
  try {
    for (const [index, scenario] of options.scenarios.entries()) {
      process.stdout.write(`[${new Date().toISOString()}] scenario ${scenario.id}: start\n`);
      const result = await runScenario(scenario, options, mirrorPort, evidenceDirectory);
      results.push(result);
      process.stdout.write(`[${new Date().toISOString()}] scenario ${scenario.id}: ${result.verdict}${result.reasons.length ? ` (${result.reasons.join('; ')})` : ''}\n`);
      await writeRunReport(options, evidenceDirectory, preamble, results, options.scenarios.slice(index + 1).map((item) => item.id));
    }
  } finally {
    if (mirror) await new Promise<void>((resolveClose) => mirror.close(() => resolveClose()));
  }
  return results;
}

async function runScenario(
  scenario: DeviceScenario,
  options: RunOptions,
  mirrorPort: number,
  runEvidence: string,
): Promise<ScenarioResult> {
  const evidenceDirectory = await mkdtemp(join(runEvidence, `${scenario.id}-`));
  const captures: ReportedCapture[] = [];
  const observations: Partial<Record<CaptureInput, CaptureObservation>> = {};
  const unavailable = preflightScenario(scenario, options.adapters, options.driverPresent);
  let ocrCompute: OcrComputeReport | null = null;
  let failure: string | undefined;
  let installedPack: string | undefined;
  let runtime: StartedRuntime | undefined;
  try {
    if (!unavailable) {
      const appData = scenario.appData === 'cpu-pack' ? await mkdtemp(join(options.runTree, 'cpu-')) : join(options.runTree, 'cuda');
      await mkdir(appData, { recursive: true });
      const checkedAppData = await checkedChild(appData, options.runTree);
      const runtimeData = join(checkedAppData, 'runtime');
      await mkdir(runtimeData, { recursive: true });
      await checkedChild(runtimeData, checkedAppData);
      const active = await startRuntime(options, scenario, checkedAppData, evidenceDirectory, mirrorPort);
      runtime = active;
      await waitForReady(active);
      await installRequirements(active, scenario.requirements, scenario.appData === 'cpu-pack');
      await waitForReady(active);
      ocrCompute = await readOcrCompute(active);
      if (scenario.requirements.includes('speech-recognition')) installedPack = await readInstalledPack(appData);
      const runtimePid = active.child.pid;
      if (runtimePid === undefined) throw new Error('Capture Runtime started without a process id.');
      for (const input of scenario.captures) {
        const source = options.inputs[input];
        if (source === undefined) throw new Error(`No ${input} input was given for ${scenario.id}.`);
        const directory = join(evidenceDirectory, input);
        await mkdir(directory);
        const sampler = startSamplers({ pid: runtimePid, appData }, directory, options.nvidiaPresent);
        let complete: boolean;
        try {
          const baseline = await waitForSample(directory);
          captures.push(await captureAndReport(active, input, source, scenario.identifySpeakers));
          const captureEnded = new Date().toISOString();
          complete = baseline && await waitForSample(directory, captureEnded);
        } finally {
          sampler.stop();
        }
        if (complete) {
          observations[input] = {
            extraction: await readObservation(directory, options.adapters, scenario.expectation.engine),
            ...(scenario.identifySpeakers ? { speaker: await readObservation(directory, options.adapters, 'speaker-diarization') } : {}),
          };
        }
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (runtime) await cleanupOwnedRuntime(runtime.child).catch((error: unknown) => {
      failure ??= `runtime cleanup: ${error instanceof Error ? error.message : String(error)}`;
    });
  }
  const decided = failure ? { verdict: 'failed' as const, reasons: [runtime ? failure.replaceAll(runtime.token, '[token]') : failure] }
    : decideVerdict({ scenario, captures, ocrCompute, observations, installedPack, unavailable });
  const result: ScenarioResult = {
    scenario: scenario.id,
    summary: scenario.summary,
    expectation: scenario.expectation,
    environment: scenario.environment,
    ocrCompute,
    captures,
    observations,
    installedPack,
    verdict: decided.verdict,
    reasons: decided.reasons,
    evidenceDirectory,
  };
  await writeFile(join(evidenceDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await writeFile(
    join(evidenceDirectory, 'result.md'),
    renderMarkdownReport({ title: `Device check: ${scenario.id}`, preamble: [scenario.summary], results: [result], pending: [] }),
    'utf8',
  );
  return result;
}

async function startRuntime(
  options: RunOptions,
  scenario: DeviceScenario,
  appData: string,
  evidenceDirectory: string,
  mirrorPort: number,
): Promise<StartedRuntime> {
  const port = await reservePort();
  const token = randomBytes(32).toString('hex');
  const temp = await mkdtemp(join(options.runTree, 'temp-'));
  const logPath = join(evidenceDirectory, 'runtime.log');
  writeFileSync(logPath, '', { flag: 'wx' });
  const child = spawn(
    join(options.releaseDirectory, runtimeExecutableName),
    ['serve', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: options.releaseDirectory,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: runtimeEnvironment({ appData, temp, port, token, mirrorPort, scenario: scenario.environment }),
    },
  );
  const { stdout, stderr } = child;
  if (stdout === null || stderr === null) throw new Error('Capture Runtime output is not piped.');
  for (const output of [stdout, stderr]) {
    createInterface({ input: output, crlfDelay: Infinity }).on('line', (line: string) => {
      appendFileSync(logPath, `${line.replaceAll(token, '[token]')}\n`, 'utf8');
    });
  }
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn);
    child.once('error', rejectSpawn);
  });
  return { child, port, token };
}

function runtimeEnvironment(input: {
  readonly appData: string;
  readonly temp: string;
  readonly port: number;
  readonly token: string;
  readonly mirrorPort: number;
  readonly scenario: Readonly<Record<string, string>>;
}): NodeJS.ProcessEnv {
  // Ambient Capture and Ollama settings must not change what a scenario tests.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => {
      const upper = name.toUpperCase();
      return !upper.startsWith('CAPTURE_') && !upper.startsWith('OLLAMA_');
    }),
  );
  return {
    ...inherited,
    TEMP: input.temp,
    TMP: input.temp,
    CAPTURE_HOST: '127.0.0.1',
    CAPTURE_PORT: String(input.port),
    CAPTURE_API_TOKEN: input.token,
    CAPTURE_ALLOWED_HOSTS: `127.0.0.1:${input.port}`,
    CAPTURE_ALLOWED_ORIGINS: 'http://tauri.localhost,tauri://localhost',
    CAPTURE_ENABLE_API_DOCS: 'false',
    CAPTURE_APP_DATA_DIR: join(input.appData, 'runtime'),
    CAPTURE_STRUCTURING_PROVIDER: 'host',
    CAPTURE_EXTRACTION_PROVIDER: 'runtime',
    CAPTURE_RETENTION_HOURS: '24',
    CAPTURE_MAX_UPLOAD_BYTES: String(2 * 1024 * 1024 * 1024),
    CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN: '1',
    CAPTURE_SMOKE_WORKER_MIRROR_URL: `http://127.0.0.1:${input.mirrorPort}`,
    ...input.scenario,
  };
}

async function waitForReady(runtime: StartedRuntime): Promise<void> {
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null) throw new Error(`The runtime exited with code ${runtime.child.exitCode} before readiness; see runtime.log.`);
    const ready = await request<{ readonly ready?: boolean }>(runtime.port, runtime.token, '/v2/health/ready').catch(() => undefined);
    if (ready?.ready) return;
    await delay(1_000);
  }
  throw new Error('The runtime did not become ready in time.');
}

async function readOcrCompute(runtime: StartedRuntime): Promise<OcrComputeReport | null> {
  const ready = await request<{ readonly ocrCompute?: OcrComputeReport | null }>(runtime.port, runtime.token, '/v2/health/ready');
  const value = ready.ocrCompute;
  return value
    ? { mode: value.mode, adapterClass: value.adapterClass, reasonCode: value.reasonCode ?? null, noticeCode: value.noticeCode ?? null }
    : null;
}

async function installRequirements(runtime: StartedRuntime, requirementIds: readonly string[], fresh: boolean): Promise<void> {
  for (const requirementId of requirementIds) {
    const listed = await request<{ readonly items: readonly { readonly requirementId: string; readonly status: string; readonly detail?: string | null }[] }>(
      runtime.port, runtime.token, '/v2/runtime/requirements');
    const requirement = listed.items.find((item) => item.requirementId === requirementId);
    if (!requirement) throw new Error(`The runtime does not offer ${requirementId}.`);
    if (requirement.status === 'ready' && !fresh) continue;
    if (requirement.status !== 'installable') {
      throw new Error(`${requirementId} is ${requirement.status}${requirement.detail ? ` (${requirement.detail})` : ''}.`);
    }
    process.stdout.write(`[${new Date().toISOString()}]   installing ${requirementId}\n`);
    const started = await request<{ readonly installationId: string }>(runtime.port, runtime.token, '/v2/runtime/installations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-idempotency-key': randomUUID() },
      body: JSON.stringify({ requirementId, consent: true }),
    });
    const deadline = Date.now() + installationTimeoutMs;
    for (;;) {
      const current = await request<{ readonly status: string; readonly error?: { readonly code?: string; readonly message?: string } | null }>(
        runtime.port, runtime.token, `/v2/runtime/installations/${started.installationId}`);
      if (current.status === 'completed') break;
      if (!['queued', 'running'].includes(current.status)) {
        throw new Error(`Installing ${requirementId} ended as ${current.status}: ${current.error?.code ?? current.error?.message ?? 'no detail'}.`);
      }
      if (Date.now() > deadline) throw new Error(`Installing ${requirementId} timed out.`);
      await delay(2_000);
    }
  }
}

async function captureAndReport(
  runtime: StartedRuntime,
  input: CaptureInput,
  path: string,
  identifySpeakers: boolean,
): Promise<ReportedCapture> {
  const extension = extname(path).toLowerCase();
  const mediaType = mediaTypes[extension];
  if (!mediaType) throw new Error(`--${input} has an unsupported file type.`);
  const created = await startV2Capture({
    request: (requestPath, init) => request(runtime.port, runtime.token, requestPath, init),
    // A synthetic name: the private file name never reaches the runtime.
    fileName: `device-check${extension}`,
    kind: input === 'audio' ? 'recording' : input,
    mediaType,
    sourceBytes: await readFile(path).catch((error: NodeJS.ErrnoException) => {
      const code = error.code;
      throw new Error(`Could not read ${input} fixture (${code && /^[A-Z][A-Z0-9_]{1,30}$/u.test(code) ? code : 'READ_ERROR'}).`);
    }),
    structuringMode: 'host',
    ...(input === 'audio' && identifySpeakers ? { identifySpeakers: true } : {}),
  });
  try {
    const deadline = Date.now() + captureTimeoutMs;
    let current: CaptureOperation & { readonly error?: { readonly code?: string; readonly stage?: string | null } | null };
    for (;;) {
      current = await request(runtime.port, runtime.token, `/v2/captures/${created.captureId}`);
      if (current.status === 'awaiting_structuring' || isTerminalCaptureStatus(current.status)) break;
      if (Date.now() > deadline) throw new Error(`The ${input} capture did not finish in time.`);
      await delay(1_000);
    }
    if (current.status !== 'awaiting_structuring') {
      return {
        input,
        status: current.status,
        fallbackWarnings: [],
        stages: [],
        ...(current.error?.code ? { errorCode: current.error.code } : {}),
        errorStage: current.error?.stage ?? null,
      };
    }
    const raw = await request<RawCaptureView>(runtime.port, runtime.token, `/v2/captures/${created.captureId}/raw`);
    return {
      input,
      status: current.status,
      engine: raw.extractionEngine?.engine,
      model: raw.extractionEngine?.model,
      device: raw.extractionEngine?.device ?? null,
      diarizationDevice: raw.diarizationEngine?.device ?? null,
      // Only the runtime's own fallback notices; other warnings may quote the source.
      fallbackWarnings: (raw.warnings ?? [])
        .filter((warning) => /GPU fallback/u.test(warning))
        .map((warning) => warning.slice(0, 120)),
      stages: Object.keys(raw.extractionEngine?.stageMs ?? {}),
    };
  } finally {
    await request<void>(runtime.port, runtime.token, `/v2/captures/${created.captureId}`, { method: 'DELETE' }).catch(() => undefined);
  }
}

interface Samplers {
  stop(): void;
}

// Samples the GPU engine counters of the runtime's process tree by adapter LUID
// (pid_<pid>_luid_0x<high>_0x<low>_..._engtype_<type>), its CPU time, and the
// machine's total CPU, through the WMI performance classes: they are not
// localized, and they read the GPU engine instances faster than Get-Counter.
// nvidia-smi is queried once per sample: its own loop (-l) buffers its output
// and loses it when it is stopped.
const windowsSamplerScript = String.raw`param([int]$RootPid, [string]$RootName, [string]$EngineRoot, [string]$Out, [string]$NvidiaOut, [int]$IntervalSeconds)
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $time = (Get-Date).ToUniversalTime().ToString('o')
  $gpuOk = $true
  $all = @()
  $formatted = @()
  $raw = @()
  try {
    $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate, KernelModeTime, UserModeTime -ErrorAction Stop)
    $formatted = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -Property Name, UtilizationPercentage -ErrorAction Stop)
    $raw = @(Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUEngine -Property Name, RunningTime -ErrorAction Stop)
  } catch { $gpuOk = $false }
  $owned = [System.Collections.Generic.HashSet[int]]::new()
  if ($RootPid -and ($all | Where-Object ProcessId -eq $RootPid)) { [void]$owned.Add($RootPid) }
  if ($RootName) { foreach ($process in $all) { if ($process.Name -eq $RootName) { [void]$owned.Add([int]$process.ProcessId) } } }
  do {
    $changed = $false
    foreach ($process in $all) {
      if ($owned.Contains([int]$process.ParentProcessId) -and $owned.Add([int]$process.ProcessId)) { $changed = $true }
    }
  } while ($changed)
  $lines = @()
  $attribution = @{}
  $identities = @{}
  $cpuSeconds = 0.0
  foreach ($process in $all) {
    $processId = [int]$process.ProcessId
    if (!$owned.Contains($processId)) { continue }
    if (!$process.ExecutablePath -or !$process.CreationDate) { $gpuOk = $false; continue }
    $worker = 'runtime-tree'
    if ($EngineRoot -and $process.ExecutablePath.StartsWith(($EngineRoot + '\'), [StringComparison]::OrdinalIgnoreCase)) {
      $requirement = $process.ExecutablePath.Substring($EngineRoot.Length + 1).Split('\')[0]
      if ($requirement -in @('text-recognition', 'speech-recognition', 'speaker-diarization')) { $worker = $requirement }
    }
    $attribution[$processId] = $worker
    $identity = [string]$processId + ':' + $process.CreationDate.ToUniversalTime().Ticks
    $identities[$processId] = $identity
    if ($null -ne $process.KernelModeTime -and $null -ne $process.UserModeTime) {
      $seconds = ([double]$process.KernelModeTime + [double]$process.UserModeTime) / 10000000
      $cpuSeconds += $seconds
      $lines += 'worker,' + $time + ',' + $identity + ',' + $worker + ',' + $seconds.ToString('0.0000000', [cultureinfo]::InvariantCulture)
    }
  }
  $sum = @{}
  foreach ($sample in $formatted) {
    if ($sample.Name -match '^pid_(\d+)_luid_0x([0-9a-f]{8})_0x([0-9a-f]{8})_phys_\d+_eng_\d+_engtype_(.+)$') {
      $scope = if ($owned.Contains([int]$Matches[1])) { 'owned' } else { 'other' }
      $worker = $attribution[[int]$Matches[1]]
      $key = $scope + ',' + ($Matches[2] + $Matches[3]).ToLowerInvariant() + ',' + $Matches[4] + ',' + $worker
      $sum[$key] = [double]$sum[$key] + $sample.UtilizationPercentage
    }
  }
  # Cumulative busy time (100 ns units) of the runtime's own engines: unlike a
  # utilization sample it also counts a GPU burst shorter than the interval.
  foreach ($sample in $raw) {
    if ($sample.Name -match '^pid_(\d+)_luid_0x([0-9a-f]{8})_0x([0-9a-f]{8})_phys_\d+_eng_(\d+)_engtype_(.+)$' -and $identities.ContainsKey([int]$Matches[1])) {
      $lines += 'busy,' + $time + ',' + $identities[[int]$Matches[1]] + ',' + ($Matches[2] + $Matches[3]).ToLowerInvariant() + ',' + $Matches[4] + ',' + $Matches[5] + ',' + $sample.RunningTime + ',' + $attribution[[int]$Matches[1]]
    }
  }
  foreach ($key in $sum.Keys) {
    $parts = $key.Split(',')
    if ($sum[$key] -gt 0) { $lines += 'gpu,' + $time + ',' + ($parts[0..2] -join ',') + ',' + $sum[$key].ToString([cultureinfo]::InvariantCulture) + ',' + $parts[3] }
  }
  $total = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
  $lines += 'cpu,' + $time + ',' + $cpuSeconds.ToString([cultureinfo]::InvariantCulture) + ',' + $total + ',' + $owned.Count + ',' + $gpuOk
  Add-Content -LiteralPath $Out -Value $lines -Encoding UTF8
  if ($NvidiaOut) {
    $nvidia = & nvidia-smi --query-gpu=timestamp,utilization.gpu,memory.used --format=csv,noheader,nounits
    if ($nvidia) { Add-Content -LiteralPath $NvidiaOut -Value $nvidia -Encoding UTF8 }
  }
  Start-Sleep -Seconds $IntervalSeconds
}
`;

function startSamplers(
  root: { readonly pid: number; readonly appData: string } | { readonly processName: string },
  evidenceDirectory: string,
  nvidiaPresent: boolean,
): Samplers {
  const scriptPath = join(evidenceDirectory, 'device-sampler.ps1');
  writeFileSync(scriptPath, windowsSamplerScript, 'utf8');
  const children: ChildProcess[] = [
    spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
        ...('pid' in root ? ['-RootPid', String(root.pid), '-EngineRoot', join(root.appData, 'runtime', 'engines')] : ['-RootName', root.processName]),
        '-Out', join(evidenceDirectory, 'windows-devices.csv'),
        ...(nvidiaPresent ? ['-NvidiaOut', join(evidenceDirectory, 'nvidia.csv')] : []),
        '-IntervalSeconds', String(sampleIntervalSeconds)],
      { windowsHide: true, stdio: 'ignore' },
    ),
  ];
  for (const child of children) child.on('error', () => { process.stderr.write('Device sampler could not start.\n'); });
  return {
    stop() {
      for (const child of children) {
        if (child.exitCode === null && child.pid) {
          spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        }
      }
    },
  };
}

/**
 * Samples the devices used by every process tree rooted at a process of this
 * name (for example the dev host during the localhost smoke) until the file
 * `stop` appears in the directory, then writes observation.json there.
 */
async function observeProcesses(processName: string, parent: string, adapters: readonly GpuAdapter[]): Promise<void> {
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'session-'));
  const stopFile = join(directory, 'stop');
  const nvidiaPresent = spawnSync('nvidia-smi', ['-L'], { windowsHide: true, stdio: 'ignore' }).status === 0;
  const samplers = startSamplers({ processName }, directory, nvidiaPresent);
  process.stdout.write(`Sampling the devices of ${processName} into ${directory}; create ${stopFile} to stop.\n`);
  try {
    while (!existsSync(stopFile)) await delay(1_000);
  } finally {
    samplers.stop();
  }
  const observation = await readObservation(directory, adapters);
  if (!observation.matchingProcessObserved) process.stdout.write('Not observed: no matching process was sampled.\n');
  process.stdout.write(`${JSON.stringify(observation)}\n`);
}

async function waitForSample(directory: string, after?: string): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const windows = parseWindowsSamples(await readFile(join(directory, 'windows-devices.csv'), 'utf8').catch(() => ''));
    if (windows.cpu.some((sample) => !after || Date.parse(sample.time) > Date.parse(after))) return true;
    await delay(250);
  }
  return false;
}

async function readObservation(evidenceDirectory: string, adapters: readonly GpuAdapter[], worker?: string) {
  const windows = parseWindowsSamples(await readFile(join(evidenceDirectory, 'windows-devices.csv'), 'utf8').catch(() => ''));
  const nvidia = parseNvidiaSamples(await readFile(join(evidenceDirectory, 'nvidia.csv'), 'utf8').catch(() => ''));
  const observation = summarizeObservation({ ...windows, nvidia, adapters, worker });
  await writeFile(join(evidenceDirectory, `${worker ?? 'observation'}.json`), `${JSON.stringify(observation, null, 2)}\n`, 'utf8');
  return observation;
}

async function readInstalledPack(appData: string): Promise<string | undefined> {
  try {
    const state = JSON.parse(await readFile(join(appData, 'runtime', 'engines', 'speech-recognition', 'active.json'), 'utf8'));
    return state?.contentId === 'cuda' || state?.contentId === 'cpu' ? state.contentId : undefined;
  } catch {
    return undefined;
  }
}

async function startWorkerMirror(releaseDirectory: string, port: number): Promise<Server> {
  const catalog = JSON.parse(await readFile(join(releaseDirectory, 'capture-engine-catalog.json'), 'utf8')) as {
    readonly requirements?: readonly Record<string, unknown>[];
  };
  const files = new Map<string, number>();
  for (const requirement of catalog.requirements ?? []) {
    for (const delivery of catalogDeliveries(requirement)) {
      for (const artifact of Array.isArray(delivery.artifacts) ? delivery.artifacts as Record<string, unknown>[] : []) {
        const parts = Array.isArray(artifact['parts']) ? artifact['parts'] as Record<string, unknown>[] : [];
        const names = parts.length ? parts.map((part) => part['fileName']) : [artifact['fileName']];
        for (const name of names) {
          if (typeof name !== 'string' || !/^[\w.-]+$/u.test(name)) throw new Error('The catalog names an unsafe worker file.');
          const metadata = await stat(join(releaseDirectory, name)).catch(() => undefined);
          if (!metadata?.isFile()) throw new Error(`Worker file ${name} is missing in ${releaseDirectory}.`);
          files.set(`/${name}`, metadata.size);
        }
      }
    }
  }
  const server = createServer((incoming, response) => {
    const size = incoming.method === 'GET' && incoming.url ? files.get(incoming.url) : undefined;
    if (size === undefined || !incoming.url) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-length': String(size), 'content-type': 'application/octet-stream' });
    createReadStream(join(releaseDirectory, incoming.url.slice(1))).pipe(response);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolveListen());
  });
  return server;
}

function discoverAdapters(): readonly GpuAdapter[] {
  // The runtime's own DXGI enumeration (OCR adapter selection), from source.
  const code = [
    'import json',
    'from capture_runtime.ocr.infrastructure.ocr_preflight import NativeOcrAdapterMapLease',
    'lease = NativeOcrAdapterMapLease()',
    'try:',
    '    _, ordinary = lease.enumerate_tables()',
    'finally:',
    '    lease.close()',
    'print(json.dumps([{"luid": a.luid, "adapterClass": "software" if a.is_software else a.adapter_class.value, "description": a.description} for a in ordinary]))',
  ].join('\n');
  const result = spawnSync('uv', ['run', '--no-sync', '--python', '3.13', 'python', '-c', code], {
    cwd: join(workspaceRoot, 'packages', 'capture-runtime'),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`Could not enumerate the GPU adapters: ${(result.stderr || String(result.error ?? '')).trim().slice(-400)}`);
  const listed = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1) ?? '[]') as { luid: string | null; adapterClass: string; description: string }[];
  return listed
    .filter((item): item is GpuAdapter => typeof item.luid === 'string'
      && ['dedicated', 'integrated', 'software'].includes(item.adapterClass));
}

// Workspace tooling is another Nx project, so the check uses its command line
// rather than importing it.
function keptRoot(): string {
  const configured = process.env['CAPTURE_KEPT_RUN_TREES_ROOT']?.trim();
  if (configured && !isAbsolute(configured)) throw new Error('CAPTURE_KEPT_RUN_TREES_ROOT must be absolute.');
  return resolve(configured || join(workspaceRoot, '..', '.kept-run-trees'));
}

async function checkedChild(path: string, parent: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Expected a real, direct child directory.');
  }
  const actual = await realpath(path);
  if (dirname(actual).toLowerCase() !== (await realpath(parent)).toLowerCase()) {
    throw new Error('Expected a real, direct child directory.');
  }
  return actual;
}

async function validateRunTree(path: string): Promise<string> {
  const tree = await checkedChild(path, await realpath(keptRoot()));
  const marker = join(tree, 'kept-run-tree.json');
  if (!(await lstat(marker)).isFile()) throw new Error('Expected a kept run tree marker.');
  const value = JSON.parse(await readFile(marker, 'utf8'));
  if (value?.script !== scriptName || !Number.isFinite(Date.parse(value.createdAt))) throw new Error('Expected a device-check kept run tree marker.');
  return tree;
}

function createRunTree(): string {
  const created = spawnSync(
    process.execPath,
    [join(workspaceRoot, 'tools', 'kept-run-trees.ts'), '--create', scriptName, 'devices'],
    { encoding: 'utf8', windowsHide: true },
  );
  const path = created.status === 0 ? created.stdout.trim() : '';
  if (!path) throw new Error(`Could not create the kept run tree: ${String(created.stderr || created.error || '').trim()}`);
  return path;
}

async function writeRunReport(
  options: RunOptions,
  evidenceDirectory: string,
  preamble: readonly string[],
  results: readonly ScenarioResult[],
  pending: readonly string[],
): Promise<void> {
  const markdown = renderMarkdownReport({ title: 'Real-engine device check', preamble, results, pending });
  const json = `${JSON.stringify({ adapters: options.adapters, nvidiaPresent: options.nvidiaPresent, results }, null, 2)}\n`;
  await mkdir(workspaceEvidenceDirectory, { recursive: true });
  for (const directory of [evidenceDirectory, workspaceEvidenceDirectory]) {
    await writeFile(join(directory, 'report.md'), markdown, 'utf8');
    await writeFile(join(directory, 'report.json'), json, 'utf8');
  }
  if (options.reportPath) await writeFile(options.reportPath, markdown, 'utf8');
}

async function cleanupOwnedRuntime(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) throw new Error('Owned Capture Runtime did not expose a PID.');
  const ownedPids = observeOwnedRuntimePids(pid);
  if (isProcessAlive(pid)) {
    const taskkill = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    const terminated = spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (terminated.error && isProcessAlive(pid)) throw terminated.error;
  }
  const deadline = Date.now() + runtimeCleanupWaitMs;
  let remaining = observeRemainingRuntime(ownedPids);
  while (Date.now() < deadline && (remaining.processes.length > 0 || remaining.listeners.length > 0)) {
    await delay(100);
    remaining = observeRemainingRuntime(ownedPids);
  }
  if (remaining.processes.length > 0 || remaining.listeners.length > 0) {
    throw new Error(formatCleanupFailure({ ...remaining, waitMs: runtimeCleanupWaitMs }));
  }
}

function observeOwnedRuntimePids(rootPid: number): readonly number[] {
  const parsed = runPowerShellJson(`
$rootPid = ${String(rootPid)}
$processes = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId | Select-Object ProcessId, ParentProcessId)
$owned = [System.Collections.Generic.HashSet[int]]::new()
[void]$owned.Add($rootPid)
do {
  $changed = $false
  foreach ($process in $processes) {
    if ($owned.Contains([int]$process.ParentProcessId) -and $owned.Add([int]$process.ProcessId)) {
      $changed = $true
    }
  }
} while ($changed)
[pscustomobject]@{ pids = @($owned | Sort-Object) } | ConvertTo-Json -Compress
`);
  const pids = (parsed as { readonly pids?: unknown })?.pids;
  if (!Array.isArray(pids) || !pids.every((item): item is number => Number.isSafeInteger(item) && item > 0)) {
    throw new Error('Owned Capture Runtime process tree evidence was malformed.');
  }
  return pids;
}

function observeRemainingRuntime(pids: readonly number[]): {
  readonly processes: readonly RemainingProcess[];
  readonly listeners: readonly { readonly pid: number; readonly port: number }[];
} {
  if (pids.length === 0) return { processes: [], listeners: [] };
  const parsed = runPowerShellJson(`
$known = @(${pids.join(',')})
$live = @(Get-Process -Id $known -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.Id; name = [string]$_.ProcessName }
})
$knownSet = [System.Collections.Generic.HashSet[int]]::new()
foreach ($processId in $known) { [void]$knownSet.Add([int]$processId) }
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $knownSet.Contains([int]$_.OwningProcess) } |
  ForEach-Object { [pscustomobject]@{ pid = [int]$_.OwningProcess; port = [int]$_.LocalPort } })
[pscustomobject]@{ processes = @($live); listeners = @($listeners) } | ConvertTo-Json -Compress
`) as { readonly processes?: unknown; readonly listeners?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.processes) || !Array.isArray(parsed.listeners)) {
    throw new Error('Owned Capture Runtime process evidence was malformed.');
  }
  const processes = parsed.processes.map((entry): RemainingProcess => {
    const item = entry as { readonly pid?: unknown; readonly name?: unknown };
    if (!Number.isSafeInteger(item?.pid) || Number(item.pid) < 1 || typeof item?.name !== 'string') {
      throw new Error('Owned Capture Runtime process entry was malformed.');
    }
    return { pid: Number(item.pid), name: item.name };
  });
  const listeners = parsed.listeners.map((entry) => {
    const item = entry as { readonly pid?: unknown; readonly port?: unknown };
    if (
      !Number.isSafeInteger(item?.pid)
      || Number(item.pid) < 1
      || !Number.isSafeInteger(item?.port)
      || Number(item.port) < 1
      || Number(item.port) > 65_535
    ) {
      throw new Error('Owned Capture Runtime listener entry was malformed.');
    }
    return { pid: Number(item.pid), port: Number(item.port) };
  });
  return { processes, listeners };
}

function runPowerShellJson(script: string): unknown {
  const powershell = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: ownedRuntimeObserverTimeoutMs,
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code ?? 'none';
    const status = Number.isInteger(result.status) ? String(result.status) : 'none';
    throw new Error(`Owned Capture Runtime process observer failed (code=${code}; status=${status}).`);
  }
  return JSON.parse(result.stdout) as unknown;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
