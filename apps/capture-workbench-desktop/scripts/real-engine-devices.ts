// The pure part of the real-engine device check (real-engine-device-check.ts):
// the scenarios with their designed devices, the parsing of the device samples
// taken during a scenario, and the verdict that compares the designed device
// with the reported one (capture provenance, OCR readiness) and the observed
// one (GPU engine and CPU samples of the runtime's own processes).

export type AdapterClass = 'dedicated' | 'integrated' | 'software';

export interface GpuAdapter {
  /** 16 lowercase hex digits: high part, then low part. */
  readonly luid: string;
  readonly adapterClass: AdapterClass;
  readonly description: string;
}

export type ObservedDevice = 'dedicated-gpu' | 'integrated-gpu' | 'cpu';
export type AppDataKind = 'cuda-pack' | 'cpu-pack';
export type CaptureInput = 'pdf' | 'image' | 'audio';

export interface ScenarioExpectation {
  readonly engine: 'text-recognition' | 'speech-recognition';
  readonly device: 'directml' | 'cuda' | 'cpu';
  readonly model?: string;
  readonly ocrAdapterClass?: 'dedicated' | 'integrated';
  readonly diarizationDevice?: 'cpu';
  readonly observed: ObservedDevice;
  /** The design rule and where it is written. */
  readonly rule: string;
}

export interface DeviceScenario {
  readonly id: string;
  readonly summary: string;
  readonly appData: AppDataKind;
  readonly requirements: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly captures: readonly CaptureInput[];
  readonly identifySpeakers: boolean;
  readonly expectation: ScenarioExpectation;
}

const speechDevelopmentEnvironment = {
  CAPTURE_SPEECH_RECOGNITION_MODEL: 'tea-asr-1.1-mini',
  CAPTURE_SPEECH_PREFER_GPU: 'true',
  CAPTURE_SPEECH_RECOGNITION_ALLOW_CPU_FALLBACK: 'false',
} as const;

/**
 * What OCR selects on this machine by design: a discrete GPU before an
 * integrated one (OcrComputePlan.select). Whether DirectML can use the adapter
 * is decided by the runtime; the check names the hardware the design prefers.
 */
export function designedOcrAdapter(
  adapters: readonly GpuAdapter[],
): 'dedicated' | 'integrated' | undefined {
  if (adapters.some((adapter) => adapter.adapterClass === 'dedicated')) return 'dedicated';
  if (adapters.some((adapter) => adapter.adapterClass === 'integrated')) return 'integrated';
  return undefined;
}

export function deviceScenarios(adapters: readonly GpuAdapter[]): readonly DeviceScenario[] {
  const ocrAdapter = designedOcrAdapter(adapters);
  return [
    {
      id: 'ocr-default',
      summary: 'OCR of the PDF and the image with the default settings',
      appData: 'cuda-pack',
      requirements: ['text-recognition'],
      environment: {},
      captures: ['pdf', 'image'],
      identifySpeakers: false,
      expectation: {
        engine: 'text-recognition',
        device: ocrAdapter ? 'directml' : 'cpu',
        ...(ocrAdapter ? { ocrAdapterClass: ocrAdapter } : {}),
        observed: ocrAdapter === 'dedicated'
          ? 'dedicated-gpu'
          : ocrAdapter === 'integrated' ? 'integrated-gpu' : 'cpu',
        rule:
          'OCR runs on DirectML on a usable discrete GPU, else a usable integrated GPU, else on the CPU with notice ocr_cpu_fallback; no CPU retry after a selected GPU fails (.agents/DECISIONS/gpu-ocr-directml.md; truth table in .agents/SPECS/capture-runtime-042-p2-hardening.md).',
      },
    },
    {
      id: 'speech-development',
      summary: 'Transcription with the development settings: TEA-ASR 1.1 mini, GPU preferred, no CPU fallback',
      appData: 'cuda-pack',
      requirements: ['speech-recognition'],
      environment: speechDevelopmentEnvironment,
      captures: ['audio'],
      identifySpeakers: false,
      expectation: {
        engine: 'speech-recognition',
        device: 'cuda',
        model: 'tea-asr-1.1-mini',
        observed: 'dedicated-gpu',
        rule:
          'A development test transcribes with TEA-ASR 1.1 mini on CUDA and refuses a CPU result (AGENTS.md "Speech development tests").',
      },
    },
    {
      id: 'speech-gpu-preference-off',
      summary: 'Transcription with the GPU preference off',
      appData: 'cuda-pack',
      requirements: ['speech-recognition'],
      environment: { ...speechDevelopmentEnvironment, CAPTURE_SPEECH_PREFER_GPU: 'false' },
      captures: ['audio'],
      identifySpeakers: false,
      expectation: {
        engine: 'speech-recognition',
        device: 'cpu',
        model: 'tea-asr-1.1-mini',
        observed: 'cpu',
        rule:
          'Speech recognition tries CUDA only when the GPU preference is on (CAPTURE_SPEECH_PREFER_GPU; the desktop setting speech-gpu-settings.json); otherwise it runs on the CPU (speech_recognition.py device probe).',
      },
    },
    {
      id: 'speaker-identification',
      summary: 'Transcription with speaker identification, development speech settings',
      appData: 'cuda-pack',
      requirements: ['speech-recognition', 'speaker-diarization'],
      environment: speechDevelopmentEnvironment,
      captures: ['audio'],
      identifySpeakers: true,
      expectation: {
        engine: 'speech-recognition',
        device: 'cuda',
        model: 'tea-asr-1.1-mini',
        diarizationDevice: 'cpu',
        observed: 'dedicated-gpu',
        rule:
          'Speaker identification ships with CPU-only PyTorch, so it runs on the CPU (packages/capture-runtime/pyproject.toml [tool.uv]); speech recognition keeps the development settings.',
      },
    },
    {
      id: 'speech-cpu-pack',
      summary: 'Transcription on a fresh installation of the cpu pack',
      appData: 'cpu-pack',
      requirements: ['speech-recognition'],
      environment: {
        CAPTURE_SPEECH_RECOGNITION_VARIANT: 'cpu',
        CAPTURE_SPEECH_RECOGNITION_ALLOW_CPU_FALLBACK: 'false',
      },
      captures: ['audio'],
      identifySpeakers: false,
      expectation: {
        engine: 'speech-recognition',
        device: 'cpu',
        model: 'tea-asr-1.1-mini',
        observed: 'cpu',
        rule:
          'The cpu pack runs TEA-ASR 1.1 mini on the CPU and carries no CUDA runtime (AGENTS.md "Speech development tests"; speech_recognition.py).',
      },
    },
  ];
}

export interface GpuSample {
  readonly time: string;
  readonly owned: boolean;
  readonly luid: string;
  readonly engineType: string;
  readonly utilization: number;
}

export interface CpuSample {
  readonly time: string;
  readonly ownedCpuSeconds: number;
  readonly totalPercent: number;
  readonly ownedProcesses: number;
}

export interface NvidiaSample {
  readonly time: string;
  readonly utilization: number;
  readonly memoryUsedMiB: number;
}

export interface GpuBusySample {
  readonly time: string;
  /** One engine of one process: pid, LUID and engine index. */
  readonly engine: string;
  readonly luid: string;
  readonly engineType: string;
  /** Cumulative busy time in 100 ns units. */
  readonly runningTime: number;
}

/**
 * Reads the Windows sampler's lines:
 * `gpu,<time>,<owned|other>,<luid>,<engine type>,<utilization %>`,
 * `busy,<time>,<pid>,<luid>,<engine index>,<engine type>,<running time>` (the
 * runtime's own engines only) and
 * `cpu,<time>,<owned CPU seconds>,<total CPU %>,<owned process count>`.
 */
export function parseWindowsSamples(text: string): {
  readonly gpu: readonly GpuSample[];
  readonly busy: readonly GpuBusySample[];
  readonly cpu: readonly CpuSample[];
} {
  const gpu: GpuSample[] = [];
  const busy: GpuBusySample[] = [];
  const cpu: CpuSample[] = [];
  for (const line of text.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const fields = line.trim().split(',');
    if (fields[0] === 'busy' && fields.length === 7) {
      const runningTime = Number(fields[6]);
      if (/^\d+$/u.test(fields[2]) && /^[0-9a-f]{16}$/u.test(fields[3]) && Number.isFinite(runningTime)) {
        busy.push({
          time: fields[1],
          engine: `${fields[2]}:${fields[3]}:${fields[4]}`,
          luid: fields[3],
          engineType: fields[5],
          runningTime,
        });
      }
    } else if (fields[0] === 'gpu' && fields.length === 6) {
      const utilization = Number(fields[5]);
      if ((fields[2] === 'owned' || fields[2] === 'other')
        && /^[0-9a-f]{16}$/u.test(fields[3])
        && Number.isFinite(utilization)) {
        gpu.push({
          time: fields[1],
          owned: fields[2] === 'owned',
          luid: fields[3],
          engineType: fields[4],
          utilization,
        });
      }
    } else if (fields[0] === 'cpu' && fields.length === 5) {
      const values = fields.slice(2).map(Number);
      if (values.every(Number.isFinite)) {
        cpu.push({
          time: fields[1],
          ownedCpuSeconds: values[0],
          totalPercent: values[1],
          ownedProcesses: values[2],
        });
      }
    }
  }
  return { gpu, busy, cpu };
}

/** Reads `nvidia-smi --query-gpu=timestamp,utilization.gpu,memory.used --format=csv,noheader,nounits`. */
export function parseNvidiaSamples(text: string): readonly NvidiaSample[] {
  const samples: NvidiaSample[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const fields = line.split(',').map((field) => field.trim());
    if (fields.length !== 3) continue;
    const utilization = Number(fields[1]);
    const memoryUsedMiB = Number(fields[2]);
    const time = fields[0].replace(/^\uFEFF/u, '');
    if (time && Number.isFinite(utilization) && Number.isFinite(memoryUsedMiB)) {
      samples.push({ time, utilization, memoryUsedMiB });
    }
  }
  return samples;
}

// Engines that do the work of a model: 3D and compute queues (DirectML and
// CUDA submit there). Copy engines only move data.
const workEngineTypes = /^(3d|compute|cuda)/iu;
// An adapter counts as used when the runtime's engines were busy on it for at
// least this long, or when it shows in this many samples at this utilization;
// the runtime's own adapter probe touches the GPU only briefly.
export const BUSY_SECONDS = 0.5;
export const ACTIVE_UTILIZATION_PERCENT = 5;
export const ACTIVE_SAMPLE_COUNT = 2;

export interface AdapterUse {
  readonly luid: string;
  readonly adapterClass: AdapterClass | 'unknown';
  readonly description: string;
  readonly busySeconds: number;
  readonly activeSamples: number;
  readonly maxUtilization: number;
}

/** Busy seconds of the runtime's work engines per adapter over the sampled span. */
export function busySecondsByAdapter(samples: readonly GpuBusySample[]): Map<string, number> {
  const work = samples.filter((sample) => workEngineTypes.test(sample.engineType));
  const firstTime = work.reduce<string | undefined>((first, sample) => (first === undefined || sample.time < first ? sample.time : first), undefined);
  const engines = new Map<string, { luid: string; baseline: number; last: number }>();
  for (const sample of work) {
    const engine = engines.get(sample.engine);
    if (!engine) {
      // An engine seen from the first sample counts from there; one that
      // appears later belongs to a process started during the span.
      engines.set(sample.engine, {
        luid: sample.luid,
        baseline: sample.time === firstTime ? sample.runningTime : 0,
        last: sample.runningTime,
      });
    } else {
      engine.last = Math.max(engine.last, sample.runningTime);
    }
  }
  const byAdapter = new Map<string, number>();
  for (const engine of engines.values()) {
    byAdapter.set(engine.luid, (byAdapter.get(engine.luid) ?? 0) + (engine.last - engine.baseline) / 1e7);
  }
  return byAdapter;
}

export interface DeviceObservation {
  readonly sampleCount: number;
  readonly ownedAdapterUse: readonly AdapterUse[];
  readonly ownedCpuSeconds: number;
  readonly maxTotalCpuPercent: number;
  readonly nvidiaSampleCount: number;
  readonly nvidiaMaxUtilization: number | null;
  readonly nvidiaMemoryRiseMiB: number | null;
  readonly observedDevice: ObservedDevice | null;
}

export function summarizeObservation(input: {
  readonly gpu: readonly GpuSample[];
  readonly busy?: readonly GpuBusySample[];
  readonly cpu: readonly CpuSample[];
  readonly nvidia: readonly NvidiaSample[];
  readonly adapters: readonly GpuAdapter[];
}): DeviceObservation {
  const perTick = new Map<string, Map<string, number>>();
  for (const sample of input.gpu) {
    if (!sample.owned || !workEngineTypes.test(sample.engineType)) continue;
    const byLuid = perTick.get(sample.time) ?? new Map<string, number>();
    // A sample sums the engines of one type; an adapter is at most fully busy.
    byLuid.set(sample.luid, Math.min(100, Math.max(byLuid.get(sample.luid) ?? 0, sample.utilization)));
    perTick.set(sample.time, byLuid);
  }
  const uses = new Map<string, { active: number; max: number; busySeconds: number }>();
  for (const byLuid of perTick.values()) {
    for (const [luid, utilization] of byLuid) {
      const use = uses.get(luid) ?? { active: 0, max: 0, busySeconds: 0 };
      if (utilization >= ACTIVE_UTILIZATION_PERCENT) use.active += 1;
      use.max = Math.max(use.max, utilization);
      uses.set(luid, use);
    }
  }
  for (const [luid, seconds] of busySecondsByAdapter(input.busy ?? [])) {
    const use = uses.get(luid) ?? { active: 0, max: 0, busySeconds: 0 };
    use.busySeconds = seconds;
    uses.set(luid, use);
  }
  const ownedAdapterUse: AdapterUse[] = [...uses.entries()]
    .map(([luid, use]): AdapterUse => {
      const adapter = input.adapters.find((item) => item.luid === luid);
      return {
        luid,
        adapterClass: adapter?.adapterClass ?? 'unknown',
        description: adapter?.description ?? '',
        busySeconds: Math.round(use.busySeconds * 100) / 100,
        activeSamples: use.active,
        maxUtilization: Math.round(use.max * 10) / 10,
      };
    })
    .sort((left, right) => right.busySeconds - left.busySeconds || right.activeSamples - left.activeSamples);
  const busy = ownedAdapterUse.filter((use) =>
    use.busySeconds >= BUSY_SECONDS || use.activeSamples >= ACTIVE_SAMPLE_COUNT);
  const sampleCount = input.cpu.length;
  const cpuSeconds = input.cpu.map((sample) => sample.ownedCpuSeconds);
  const observedDevice: ObservedDevice | null = sampleCount < ACTIVE_SAMPLE_COUNT
    ? null
    : busy.some((use) => use.adapterClass === 'dedicated')
      ? 'dedicated-gpu'
      : busy.some((use) => use.adapterClass === 'integrated')
        ? 'integrated-gpu'
        : 'cpu';
  const memory = input.nvidia.map((sample) => sample.memoryUsedMiB);
  return {
    sampleCount,
    ownedAdapterUse,
    ownedCpuSeconds: cpuSeconds.length > 1
      ? Math.round((Math.max(...cpuSeconds) - cpuSeconds[0]) * 10) / 10
      : 0,
    maxTotalCpuPercent: input.cpu.length
      ? Math.max(...input.cpu.map((sample) => sample.totalPercent))
      : 0,
    nvidiaSampleCount: input.nvidia.length,
    nvidiaMaxUtilization: input.nvidia.length
      ? Math.max(...input.nvidia.map((sample) => sample.utilization))
      : null,
    nvidiaMemoryRiseMiB: memory.length ? Math.max(...memory) - memory[0] : null,
    observedDevice,
  };
}

export interface ReportedCapture {
  readonly input: CaptureInput;
  readonly status: string;
  readonly engine?: string;
  readonly model?: string;
  readonly device?: string | null;
  readonly diarizationDevice?: string | null;
  readonly fallbackWarnings: readonly string[];
  readonly stages: readonly string[];
  readonly errorCode?: string;
  readonly errorStage?: string | null;
}

export interface OcrComputeReport {
  readonly mode?: string;
  readonly adapterClass?: string;
  readonly reasonCode?: string | null;
  readonly noticeCode?: string | null;
}

export type Verdict = 'pass' | 'mismatch' | 'failed' | 'inconclusive';

export function decideVerdict(input: {
  readonly expectation: ScenarioExpectation;
  readonly captures: readonly ReportedCapture[];
  readonly ocrCompute?: OcrComputeReport | null;
  readonly observation: DeviceObservation;
}): { readonly verdict: Verdict; readonly reasons: readonly string[] } {
  const { expectation, observation } = input;
  const failed = input.captures.filter((capture) => capture.status !== 'awaiting_structuring');
  if (input.captures.length === 0 || failed.length > 0) {
    return {
      verdict: 'failed',
      reasons: failed.length
        ? failed.map((capture) =>
          `${capture.input} capture ended as ${capture.status}${capture.errorCode ? ` (${capture.errorCode}${capture.errorStage ? ` at ${capture.errorStage}` : ''})` : ''}`)
        : ['no capture ran'],
    };
  }
  const reasons: string[] = [];
  for (const capture of input.captures) {
    if (capture.engine !== expectation.engine) {
      reasons.push(`${capture.input}: engine ${String(capture.engine)}, designed ${expectation.engine}`);
    }
    if (capture.device !== expectation.device) {
      reasons.push(`${capture.input}: reported device ${String(capture.device)}, designed ${expectation.device}`);
    }
    if (expectation.model && capture.model !== expectation.model) {
      reasons.push(`${capture.input}: model ${String(capture.model)}, designed ${expectation.model}`);
    }
    if (expectation.diarizationDevice && capture.diarizationDevice !== expectation.diarizationDevice) {
      reasons.push(`${capture.input}: speaker identification device ${String(capture.diarizationDevice)}, designed ${expectation.diarizationDevice}`);
    }
    if (capture.fallbackWarnings.length > 0) {
      reasons.push(`${capture.input}: reported a GPU fallback`);
    }
  }
  if (expectation.engine === 'text-recognition') {
    const designedMode = expectation.device === 'directml' ? 'gpu' : 'cpu-fallback';
    if (input.ocrCompute?.mode !== designedMode) {
      reasons.push(`OCR readiness mode ${String(input.ocrCompute?.mode)}, designed ${designedMode}`);
    }
    if (expectation.ocrAdapterClass && input.ocrCompute?.adapterClass !== expectation.ocrAdapterClass) {
      reasons.push(`OCR readiness adapter ${String(input.ocrCompute?.adapterClass)}, designed ${expectation.ocrAdapterClass}`);
    }
  }
  if (observation.observedDevice === null) {
    return { verdict: reasons.length ? 'mismatch' : 'inconclusive', reasons: [...reasons, 'too few device samples'] };
  }
  if (observation.observedDevice !== expectation.observed) {
    reasons.push(`observed ${observation.observedDevice}, designed ${expectation.observed}`);
  }
  return { verdict: reasons.length ? 'mismatch' : 'pass', reasons };
}

export interface ScenarioResult {
  readonly scenario: string;
  readonly summary: string;
  readonly expectation: ScenarioExpectation;
  readonly environment: Readonly<Record<string, string>>;
  readonly ocrCompute: OcrComputeReport | null;
  readonly captures: readonly ReportedCapture[];
  readonly observation: DeviceObservation | null;
  readonly verdict: Verdict;
  readonly reasons: readonly string[];
  readonly evidenceDirectory: string;
}

function reportedDevice(result: ScenarioResult): string {
  const devices = result.captures.map((capture) =>
    `${capture.input}: ${capture.device ?? capture.status}${capture.model ? ` (${capture.model})` : ''}${capture.diarizationDevice ? `, speakers ${capture.diarizationDevice}` : ''}`);
  if (result.ocrCompute) {
    devices.push(`ocrCompute ${result.ocrCompute.mode ?? '?'}/${result.ocrCompute.adapterClass ?? '?'}${result.ocrCompute.reasonCode ? ` ${result.ocrCompute.reasonCode}` : ''}`);
  }
  return devices.join('; ') || 'none';
}

function observedDevice(observation: DeviceObservation | null): string {
  if (!observation) return 'not sampled';
  const busy = observation.ownedAdapterUse
    .filter((use) => use.busySeconds > 0 || use.activeSamples > 0)
    .map((use) => `${use.adapterClass} ${use.luid} busy ${use.busySeconds} s, max ${use.maxUtilization}% in ${use.activeSamples} samples`);
  return `${observation.observedDevice ?? 'unknown'} (${busy.join(', ') || 'no runtime GPU work'}; runtime CPU ${observation.ownedCpuSeconds} s; nvidia max ${observation.nvidiaMaxUtilization ?? '-'}%)`;
}

export function renderMarkdownReport(input: {
  readonly title: string;
  readonly preamble: readonly string[];
  readonly results: readonly ScenarioResult[];
  readonly pending: readonly string[];
}): string {
  const lines = [`# ${input.title}`, '', ...input.preamble, ''];
  lines.push('| Scenario | Designed | Reported | Observed | Verdict |', '| --- | --- | --- | --- | --- |');
  for (const result of input.results) {
    const designed = `${result.expectation.device}${result.expectation.model ? ` (${result.expectation.model})` : ''}${result.expectation.ocrAdapterClass ? `, ${result.expectation.ocrAdapterClass} adapter` : ''}${result.expectation.diarizationDevice ? `, speakers ${result.expectation.diarizationDevice}` : ''}; observed ${result.expectation.observed}`;
    lines.push(`| ${result.scenario} | ${designed} | ${reportedDevice(result)} | ${observedDevice(result.observation)} | ${result.verdict}${result.reasons.length ? `: ${result.reasons.join('; ')}` : ''} |`);
  }
  for (const scenario of input.pending) lines.push(`| ${scenario} | | | | not run yet |`);
  lines.push('', '## Rules', '');
  for (const result of input.results) {
    lines.push(`- ${result.scenario}: ${result.expectation.rule} Evidence: \`${result.evidenceDirectory}\`.`);
  }
  return `${lines.join('\n')}\n`;
}
