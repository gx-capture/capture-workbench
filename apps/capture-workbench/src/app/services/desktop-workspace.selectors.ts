import type {
  CaptureOperation,
  CaptureRequirementId,
  RuntimeModelInstallation,
  RuntimeModelOption,
  RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import type {
  DesktopLibraryStatus,
  DesktopLibrarySummary,
} from '../contracts';
import type { DesktopCaptureOperation } from './desktop-runtime-client.service';

/** Pure workspace selectors and terminal mappings shared by the facade services. */

export const CORE_REQUIREMENTS = new Set<CaptureRequirementId>([
  'windowsml-ocr',
  'ollama-runtime',
]);

export const INSTALLATION_ORDER = new Map<CaptureRequirementId, number>([
  ['windowsml-ocr', 0],
  ['whisper-primary', 1],
  ['ollama-runtime', 2],
]);

/** Converts model installation progress to the percentage shown by the UI. */
export function modelInstallationPercent(
  installation: RuntimeModelInstallation | null,
): number {
  const progress = installation?.progress ?? 0;
  return Math.round(Math.min(Math.max(progress, 0), 1) * 100);
}

/** Maps a model installation state to its human-readable phase. */
export function modelInstallationPhase(
  installation: RuntimeModelInstallation | null,
): string {
  if (!installation) return '';
  if (installation.status === 'queued') return '等待開始';
  if (installation.status === 'failed') return '模型下載失敗';
  if (installation.status === 'cancelled') return '模型下載已取消';
  if (installation.status === 'completed') return '模型已準備完成';
  if (installation.progress < 0.1) return '啟動模型服務';
  if (installation.progress < 0.75) return '下載與驗證模型';
  return '建立 Workbench profile';
}

/** Selects requirements that block capture or were explicitly requested. */
export function selectCoreMissing(
  requirements: readonly RuntimeRequirement[],
  requestedRequirements: ReadonlySet<CaptureRequirementId>,
): readonly RuntimeRequirement[] {
  return requirements.filter(
    (requirement) =>
      (CORE_REQUIREMENTS.has(requirement.requirementId)
        || requestedRequirements.has(requirement.requirementId))
      && requirement.status !== 'ready',
  );
}

/** Selects and orders installable core requirements for one consent action. */
export function selectInstallableCoreRequirements(
  requirements: readonly RuntimeRequirement[],
  requestedRequirements: ReadonlySet<CaptureRequirementId>,
): readonly RuntimeRequirement[] {
  return selectCoreMissing(requirements, requestedRequirements)
    .filter((requirement) => requirement.status === 'installable')
    .slice()
    .sort(
      (left, right) =>
        (INSTALLATION_ORDER.get(left.requirementId) ?? Number.MAX_SAFE_INTEGER)
        - (INSTALLATION_ORDER.get(right.requirementId) ?? Number.MAX_SAFE_INTEGER),
    );
}

/** Indicates whether an active model option must be selected by the user. */
export function modelSelectionRequired(
  options: readonly RuntimeModelOption[],
): boolean {
  return options.length > 0 && !options.some((option) => option.status === 'active');
}

/** Returns the active model option, if the catalog has one. */
export function activeModelOption(
  options: readonly RuntimeModelOption[],
): RuntimeModelOption | null {
  return options.find((option) => option.status === 'active') ?? null;
}

/** Identifies audio media that uses the streaming capture path. */
export function isAudioMediaType(mediaType: string): boolean {
  return mediaType.startsWith('audio/');
}

/** Identifies non-terminal one-shot capture jobs. */
export function isActiveJob(job: DesktopCaptureOperation): boolean {
  return job.status === 'queued' || job.status === 'running';
}

/** Identifies non-terminal streaming operations. */
export function isActiveStreaming(operation: CaptureOperation): boolean {
  return operation.status === 'created'
    || operation.status === 'waiting_input'
    || operation.status === 'extracting'
    || operation.status === 'awaiting_structuring'
    || operation.status === 'structuring';
}

/** Maps a runtime terminal job to the library's persisted status vocabulary. */
export function terminalLibraryStatus(job: DesktopCaptureOperation): DesktopLibraryStatus {
  if (job.status === 'completed') return 'completed';
  if (job.status === 'cancelled') return 'canceled';
  return 'failed';
}

/** Derives a terminal library status from a persisted runtime stage. */
export function terminalStatusFromStage(stage?: string): DesktopLibraryStatus {
  if (stage === 'cancelled') return 'canceled';
  if (stage === 'failed') return 'failed';
  return 'completed';
}

/** Indicates whether a document already contains terminal data during recovery. */
export function hasCommittedTerminalData(document: DesktopLibrarySummary): boolean {
  return document.recoveryCode === 'runtime_cleanup_failed'
    || document.status === 'completed'
    || document.status === 'failed'
    || document.status === 'canceled';
}

/** Preserves an existing terminal status while recovering runtime cleanup. */
export function committedTerminalStatus(document: DesktopLibrarySummary): DesktopLibraryStatus {
  return document.status === 'completed'
    || document.status === 'failed'
    || document.status === 'canceled'
    ? document.status
    : terminalStatusFromStage(document.stage);
}

/** Converts a library terminal status to the runtime stage spelling. */
export function terminalStage(status?: DesktopLibraryStatus): string {
  if (status === 'canceled') return 'cancelled';
  if (status === 'failed') return 'failed';
  return 'completed';
}

/** Converts unknown errors to redacted messages safe for host-facing UI. */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveMessage(message);
}

/** Removes bearer and token-shaped values from user-visible diagnostics. */
export function redactSensitiveMessage(message: string): string {
  return message
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(
      /(?:authorization|bearerToken|access_token|token)\s*[:=]\s*["']?[^"'\s,;}]+/giu,
      (match) => `${match.slice(0, match.search(/[:=]/u) + 1)} [redacted]`,
    );
}

/** Maps a runtime stage to its workspace label. */
export function stageLabel(stage?: string): string {
  return ({
    uploading: '正在上傳來源',
    queued: '排隊等待處理',
    extracting: '正在執行 OCR',
    awaiting_structuring: '等待結構化',
    structuring: '正在使用 Ollama 結構化',
    persisting: '正在保存結果',
    recovery_required: '需要復原',
    completed: '已完成',
    failed: '處理失敗',
    cancelled: '已取消',
  } as Record<string, string>)[stage ?? ''] ?? '排隊等待處理';
}

/** Maps a library status to its workspace label. */
export function statusLabel(status: DesktopLibrarySummary['status']): string {
  return ({
    queued: '排隊等待處理',
    processing: '處理中',
    persisting: '正在保存',
    recovery_required: '需要復原',
    awaiting_confirmation: '等待確認',
    completed: '已完成',
    failed: '處理失敗',
    canceled: '已取消',
  } as Record<DesktopLibrarySummary['status'], string>)[status];
}
