/** Generated from the private worker-stage policy source; do not edit. */
export const WORKER_STAGE_POLICY_SCHEMA_VERSION = "1" as const;
export const MAX_WORKER_DIAGNOSTIC_STAGES = 32 as const;
export const MAX_WORKER_DIAGNOSTIC_STAGE_LENGTH = 128 as const;
export const WORKER_STAGE_EXCEPTION_NAMES = new Set<string>([
  "arithmeticerror",
  "assertionerror",
  "attributeerror",
  "connectionerror",
  "engineruntimeunavailableerror",
  "eoferror",
  "filenotfounderror",
  "importerror",
  "indexerror",
  "keyerror",
  "memoryerror",
  "modulenotfounderror",
  "nameerror",
  "notexisterror",
  "notimplementederror",
  "ocrexecutionevidenceerror",
  "ocrinferencecleanuperror",
  "oserror",
  "overflowerror",
  "paddleresultnormalizationerror",
  "permissionerror",
  "runtimeerror",
  "timeouterror",
  "typeerror",
  "unknown",
  "unknownexecutionprovidererror",
  "valueerror",
  "zerodivisionerror",
]);
export const WORKER_STAGE_EXACT_STAGES = new Set<string>([
  "ocr-output-empty",
  "ocr-dml-device-id-mismatch",
  "ocr-dml-device-id-unobservable",
  "ocr-execution-evidence-prepare",
  "ocr-native-map-after",
  "ocr-native-map-before",
  "ocr-paddle-factory",
  "ocr-pdf-render-complete",
  "ocr-pdf-render-start",
  "ocr-pipeline-create-complete",
  "ocr-pipeline-create-failed-unknown",
  "ocr-pipeline-create-start",
  "ocr-predict-complete",
  "ocr-predict-failed-unknown",
  "ocr-predict-start",
  "ocr-probe-assets-missing-unknown",
  "ocr-probe-assets-ready",
  "ocr-probe-complete",
  "ocr-probe-modules-missing-unknown",
  "ocr-probe-modules-ready",
  "ocr-probe-modules-start",
  "ocr-probe-providers-error",
  "ocr-probe-providers-unknown",
  "ocr-probe-start",
  "ocr-provider-evidence-failed-unknown",
  "ocr-provider-evidence-start",
  "ocr-provider-evidence-unknown",
  "python-import-av-complete",
  "python-import-av-start",
  "python-import-capture-runtime-complete",
  "python-import-capture-runtime-start",
  "python-import-ctranslate-complete",
  "python-import-ctranslate-start",
  "python-import-engine-adapters-complete",
  "python-import-engine-adapters-dependency-failed",
  "python-import-engine-adapters-failed",
  "python-import-engine-adapters-module-missing",
  "python-import-engine-adapters-os-failed",
  "python-import-engine-adapters-os-failed-winerror-unknown",
  "python-import-engine-adapters-start",
  "python-import-faster-whisper-complete",
  "python-import-faster-whisper-start",
  "python-import-onnxruntime-complete",
  "python-import-onnxruntime-failed-unknown",
  "python-import-onnxruntime-start",
  "python-import-paddleocr-complete",
  "python-import-paddleocr-failed-unknown",
  "python-import-paddleocr-start",
  "python-import-pdfium-complete",
  "python-import-pdfium-start",
  "python-import-pillow-complete",
  "python-import-pillow-start",
  "python-import-worker-contracts-complete",
  "python-import-worker-contracts-dependency-failed",
  "python-import-worker-contracts-failed",
  "python-import-worker-contracts-module-missing",
  "python-import-worker-contracts-os-failed",
  "python-import-worker-contracts-os-failed-winerror-unknown",
  "python-import-worker-contracts-start",
  "python-import-worker-server-complete",
  "python-import-worker-server-dependency-failed",
  "python-import-worker-server-failed",
  "python-import-worker-server-module-missing",
  "python-import-worker-server-os-failed",
  "python-import-worker-server-os-failed-winerror-unknown",
  "python-import-worker-server-start",
  "whisper-assets-probe-complete",
  "whisper-assets-probe-start",
  "whisper-device-probe-complete",
  "whisper-device-probe-start",
  "whisper-gpu-fallback",
  "whisper-model-load-cpu-complete",
  "whisper-model-load-cpu-failed-unknown",
  "whisper-model-load-cpu-fallback-float32",
  "whisper-model-load-cpu-reused",
  "whisper-model-load-cpu-start",
  "whisper-model-load-cuda-complete",
  "whisper-model-load-cuda-failed-unknown",
  "whisper-model-load-cuda-reused",
  "whisper-model-load-cuda-start",
  "whisper-output-empty",
  "whisper-output-empty-window",
  "whisper-transcription-call-complete",
  "whisper-transcription-call-start",
  "whisper-transcription-complete",
  "whisper-transcription-iteration-start",
  "worker-entry-start",
  "worker-process-entry-missing",
  "worker-process-exit-before-response",
  "worker-process-exit-nonzero",
  "worker-process-no-response",
  "worker-process-response-error",
  "worker-process-termination",
  "worker-process-timeout",
  "worker-stage-sequence-truncated",
]);
export const WORKER_STAGE_FAMILY_PATTERNS: readonly RegExp[] = [
  new RegExp(`^(?:ocr-probe-modules-missing-[0-9]{1,3})$`, 'u'),
  new RegExp(`^(?:ocr-probe-assets-missing-[0-9]{1,4})$`, 'u'),
  new RegExp(`^(?:ocr-probe-providers-[0-9]{1,6}-cpu-(?:yes|no)-dml-(?:yes|no))$`, 'u'),
  new RegExp(`^(?:ocr-provider-evidence-dml-[0-9]{1,6}-cpu-[0-9]{1,6})$`, 'u'),
  new RegExp(`^(?:ocr-(?:pipeline-create|predict|provider-evidence)-failed-(?:arithmeticerror|assertionerror|attributeerror|connectionerror|engineruntimeunavailableerror|eoferror|filenotfounderror|importerror|indexerror|keyerror|memoryerror|modulenotfounderror|nameerror|notexisterror|notimplementederror|ocrexecutionevidenceerror|ocrinferencecleanuperror|oserror|overflowerror|paddleresultnormalizationerror|permissionerror|runtimeerror|timeouterror|typeerror|unknown|unknownexecutionprovidererror|valueerror|zerodivisionerror))$`, 'u'),
  new RegExp(`^(?:python-import-(?:onnxruntime|paddleocr)-failed-(?:arithmeticerror|assertionerror|attributeerror|connectionerror|engineruntimeunavailableerror|eoferror|filenotfounderror|importerror|indexerror|keyerror|memoryerror|modulenotfounderror|nameerror|notexisterror|notimplementederror|ocrexecutionevidenceerror|ocrinferencecleanuperror|oserror|overflowerror|paddleresultnormalizationerror|permissionerror|runtimeerror|timeouterror|typeerror|unknown|unknownexecutionprovidererror|valueerror|zerodivisionerror))$`, 'u'),
  new RegExp(`^(?:python-import-(?:onnxruntime|paddleocr)-failed-(?:arithmeticerror|assertionerror|attributeerror|connectionerror|engineruntimeunavailableerror|eoferror|filenotfounderror|importerror|indexerror|keyerror|memoryerror|modulenotfounderror|nameerror|notexisterror|notimplementederror|ocrexecutionevidenceerror|ocrinferencecleanuperror|oserror|overflowerror|paddleresultnormalizationerror|permissionerror|runtimeerror|timeouterror|typeerror|unknown|unknownexecutionprovidererror|valueerror|zerodivisionerror)-(?:missing-module|native-load|cannot-import-symbol|partial-init|other)-(?:onnxruntime|paddleocr|paddlex|unknown))$`, 'u'),
  new RegExp(`^(?:python-import-(?:onnxruntime|paddleocr)-failed-(?:arithmeticerror|assertionerror|attributeerror|connectionerror|engineruntimeunavailableerror|eoferror|filenotfounderror|importerror|indexerror|keyerror|memoryerror|modulenotfounderror|nameerror|notexisterror|notimplementederror|ocrexecutionevidenceerror|ocrinferencecleanuperror|oserror|overflowerror|paddleresultnormalizationerror|permissionerror|runtimeerror|timeouterror|typeerror|unknown|unknownexecutionprovidererror|valueerror|zerodivisionerror)-native-load-(?:onnxruntime|paddleocr|paddlex|unknown)-(?:dependency-missing|symbol-missing|bad-image|initialization-failed|resource-exhausted|blocked|side-by-side|unknown)-(?:onnxruntime|directml|opencv|numpy|pandas|shapely|pyclipper|pillow|pydantic-core|rpds|tokenizers|chardet|charset-normalizer|aiohttp|multidict|yarl|frozenlist|propcache|vc-runtime|python-runtime|paddlex|paddleocr|unknown))$`, 'u'),
  new RegExp(`^(?:python-import-(?:engine-adapters|worker-contracts|worker-server)-os-failed-winerror-[0-9]{1,5})$`, 'u'),
  new RegExp(`^(?:whisper-model-load-(?:cpu|cuda)-failed-(?:arithmeticerror|assertionerror|attributeerror|connectionerror|engineruntimeunavailableerror|eoferror|filenotfounderror|importerror|indexerror|keyerror|memoryerror|modulenotfounderror|nameerror|notexisterror|notimplementederror|ocrexecutionevidenceerror|ocrinferencecleanuperror|oserror|overflowerror|permissionerror|runtimeerror|timeouterror|typeerror|unknown|unknownexecutionprovidererror|valueerror|zerodivisionerror))$`, 'u'),
  new RegExp(`^(?:worker-process-(?:timeout|exit-before-response|no-response|response-error|exit-nonzero)-bootloader)$`, 'u'),
];
export const WORKER_STAGE_UNKNOWN_PREFIXES: readonly (readonly [string, string])[] = [
  ["ocr-probe-modules-missing-", "ocr-probe-modules-missing-unknown"] as const,
  ["ocr-probe-assets-missing-", "ocr-probe-assets-missing-unknown"] as const,
  ["ocr-probe-providers-", "ocr-probe-providers-unknown"] as const,
  ["ocr-provider-evidence-dml-", "ocr-provider-evidence-unknown"] as const,
  ["ocr-pipeline-create-failed-", "ocr-pipeline-create-failed-unknown"] as const,
  ["ocr-predict-failed-", "ocr-predict-failed-unknown"] as const,
  ["ocr-provider-evidence-failed-", "ocr-provider-evidence-failed-unknown"] as const,
  ["python-import-onnxruntime-failed-", "python-import-onnxruntime-failed-unknown"] as const,
  ["python-import-paddleocr-failed-", "python-import-paddleocr-failed-unknown"] as const,
  ["python-import-engine-adapters-os-failed-winerror-", "python-import-engine-adapters-os-failed-winerror-unknown"] as const,
  ["python-import-worker-contracts-os-failed-winerror-", "python-import-worker-contracts-os-failed-winerror-unknown"] as const,
  ["python-import-worker-server-os-failed-winerror-", "python-import-worker-server-os-failed-winerror-unknown"] as const,
];
export const WORKER_STAGE_BUILDER_NAMES = new Set<string>([
  "ocr_import_failure_stage",
  "ocr_import_stage",
  "ocr_probe_missing_stage",
  "ocr_probe_providers_stage",
  "ocr_probe_readiness_stage",
  "ocr_provider_evidence_stage",
  "ocr_stage_failure",
  "whisper_import_os_failure_stage",
  "whisper_import_stage",
  "whisper_model_load_stage",
  "whisper_output_stage",
  "whisper_stage",
]);
export const WORKER_STAGE_STARTUP_HEAD_COUNT = 16 as const;
export const WORKER_STAGE_FAILURE_TAIL_COUNT = 8 as const;
export const WORKER_STAGE_CRITICAL_STAGES = new Set<string>([
  "ocr-native-map-before",
  "ocr-paddle-factory",
  "ocr-native-map-after",
  "ocr-execution-evidence-prepare",
  "ocr-dml-device-id-unobservable",
  "ocr-dml-device-id-mismatch",
]);

const workerStageNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const whisperModelFailurePattern = /^whisper-model-load-(cpu|cuda)-failed-.+$/u;

export function sanitizeWorkerStage(stage: unknown): string | null {
  if (typeof stage !== 'string' || stage.length > MAX_WORKER_DIAGNOSTIC_STAGE_LENGTH) return null;
  if (!workerStageNamePattern.test(stage)) return null;
  if (
    WORKER_STAGE_EXACT_STAGES.has(stage) ||
    WORKER_STAGE_FAMILY_PATTERNS.some((pattern) => pattern.test(stage))
  ) return stage;
  for (const [prefix, sentinel] of WORKER_STAGE_UNKNOWN_PREFIXES) {
    if (stage.startsWith(prefix)) return sentinel;
  }
  const modelFailure = whisperModelFailurePattern.exec(stage);
  return modelFailure === null ? null : `whisper-model-load-${modelFailure[1]}-failed-unknown`;
}

export function isAllowedWorkerStage(stage: unknown): stage is string {
  return typeof stage === 'string' && sanitizeWorkerStage(stage) === stage;
}

export function boundWorkerStageSequence(stages: readonly string[]): readonly string[] {
  stages = stages.flatMap((stage) => {
    const safeStage = sanitizeWorkerStage(stage);
    return safeStage === null ? [] : [safeStage];
  });
  if (stages.length <= MAX_WORKER_DIAGNOSTIC_STAGES) return [...stages];
  const realCapacity = MAX_WORKER_DIAGNOSTIC_STAGES - 1;
  const selected = new Set<number>();
  for (
    let index = 0;
    index < Math.min(WORKER_STAGE_STARTUP_HEAD_COUNT, stages.length);
    index += 1
  ) {
    selected.add(index);
  }
  for (
    let index = Math.max(0, stages.length - WORKER_STAGE_FAILURE_TAIL_COUNT);
    index < stages.length;
    index += 1
  ) {
    selected.add(index);
  }
  // Represent each critical semantic kind once; repeated markers cannot
  // consume the bounded diagnostic budget.
  const firstCritical = new Set<string>();
  stages.forEach((stage, index) => {
    if (WORKER_STAGE_CRITICAL_STAGES.has(stage) && !firstCritical.has(stage)) {
      selected.add(index);
      firstCritical.add(stage);
    }
  });
  for (let index = 0; index < stages.length && selected.size < realCapacity; index += 1) {
    selected.add(index);
  }
  const omitted = stages.findIndex((_stage, index) => !selected.has(index));
  const bounded: string[] = [];
  let markerAdded = false;
  stages.forEach((stage, index) => {
    if (!markerAdded && index === omitted) {
      bounded.push('worker-stage-sequence-truncated');
      markerAdded = true;
    }
    if (selected.has(index)) bounded.push(stage);
  });
  if (!markerAdded) bounded.push('worker-stage-sequence-truncated');
  return bounded;
}
