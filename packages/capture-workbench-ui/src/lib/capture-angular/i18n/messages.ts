import type { CaptureWorkbenchLabels } from '../../contracts';

/** Languages the workbench ships text for. */
export type CaptureWorkbenchLocale = 'zh-TW' | 'en';

export const DEFAULT_CAPTURE_WORKBENCH_LOCALE: CaptureWorkbenchLocale = 'zh-TW';

/**
 * Every piece of text the workbench shows. The keys shared with
 * `CaptureWorkbenchLabels` can be overridden by the host through `config.labels`.
 */
export interface CaptureWorkbenchMessages {
  readonly title: string;
  /** Shown above the title only when the host sets it. */
  readonly eyebrow?: string;
  readonly chooseFiles: string;
  readonly emptyState: string;
  readonly runtimeTitle: string;
  /** Shown in the setup card when ready, only when the host sets it. */
  readonly runtimeReady?: string;
  readonly installRuntime: string;
  readonly retryRuntime: string;
  readonly cancel: string;
  readonly reconcile: string;
  readonly cancelAndReconcile: string;
  readonly remove: string;
  readonly exportJson: string;
  readonly exportText: string;
  readonly exportRaw: string;
  readonly reviewTitle: string;
  /** Shown under the review title only when the host sets it. */
  readonly reviewDescription?: string;
  readonly originalText: string;
  readonly reviewedText: string;
  readonly restoreOriginal: string;
  readonly confirmReview: string;
  readonly discardReview: string;

  readonly checking: string;
  readonly requiredComponents: string;
  readonly manualAction: string;
  readonly unavailableHere: string;
  readonly installing: string;
  readonly manualInstall: string;
  readonly edited: string;
  readonly unknownProgress: string;
  readonly model: string;
  readonly rawText: string;
  readonly gpuAcceleration: string;
  readonly cpuNotice: string;
  readonly captureTasks: string;
  readonly page: (page: number) => string;
  readonly segment: (order: number) => string;
  readonly runtimeStatus: Readonly<Record<string, string | undefined>>;
  readonly requirementStatus: Readonly<Record<string, string | undefined>>;
  readonly taskStatus: Readonly<Record<string, string | undefined>>;
  /** Only the stages that tell the user something the status does not. */
  readonly taskStage: Readonly<Record<string, string | undefined>>;
}

const ZH_TW: CaptureWorkbenchMessages = {
  title: '文件擷取',
  chooseFiles: '選擇檔案',
  emptyState: '加入 PDF、圖片或錄音。',
  runtimeTitle: '設定',
  installRuntime: '下載並安裝',
  retryRuntime: '重新檢查',
  cancel: '取消',
  reconcile: '檢查狀態',
  cancelAndReconcile: '取消',
  remove: '移除',
  exportJson: '匯出 JSON',
  exportText: '匯出文字',
  exportRaw: '匯出原始文字',
  reviewTitle: '確認文字',
  originalText: '原始辨識',
  reviewedText: '要儲存的文字',
  restoreOriginal: '還原',
  confirmReview: '儲存',
  discardReview: '捨棄',
  checking: '檢查中…',
  requiredComponents: '必要元件',
  manualAction: '請自行完成這個步驟，再重新檢查。',
  unavailableHere: '這台電腦無法使用。',
  installing: '正在安裝',
  manualInstall: '無法自動安裝。請自行完成這個步驟，再重新檢查。',
  edited: '已修改',
  unknownProgress: '無法確認這個檔案的進度。請檢查狀態或取消。',
  model: '模型',
  rawText: '原始文字',
  gpuAcceleration: 'GPU 加速',
  cpuNotice: '沒有可用的 GPU，文字辨識會比較慢。',
  captureTasks: '擷取工作',
  page: (page) => `第 ${page} 頁`,
  segment: (order) => `第 ${order} 段`,
  runtimeStatus: {
    checking: '檢查中',
    ready: '已就緒',
    'needs-setup': '需要設定',
    incompatible: '需要更新',
    error: '無法使用',
  },
  requirementStatus: {
    ready: '已安裝',
    missing: '未安裝',
    installable: '未安裝',
    manual_action_required: '需要處理',
    unavailable: '無法使用',
  },
  taskStatus: {
    queued: '等待中',
    processing: '處理中',
    awaiting_confirmation: '待確認',
    reconciliation_required: '需要處理',
    completed: '完成',
    failed: '失敗',
    canceled: '已取消',
  },
  taskStage: {
    uploading: '上傳中',
    extracting: '文字辨識中',
    structuring: '整理中',
  },
};

const EN: CaptureWorkbenchMessages = {
  title: 'Capture workbench',
  chooseFiles: 'Choose files',
  emptyState: 'Add a PDF, image, or audio recording.',
  runtimeTitle: 'Setup',
  installRuntime: 'Download and install',
  retryRuntime: 'Check again',
  cancel: 'Cancel',
  reconcile: 'Check status',
  cancelAndReconcile: 'Cancel',
  remove: 'Remove',
  exportJson: 'Export JSON',
  exportText: 'Export text',
  exportRaw: 'Export raw text',
  reviewTitle: 'Review text',
  originalText: 'Original',
  reviewedText: 'Text to save',
  restoreOriginal: 'Restore original',
  confirmReview: 'Save text',
  discardReview: 'Discard',
  checking: 'Checking…',
  requiredComponents: 'Required components',
  manualAction: 'Finish this step yourself, then check again.',
  unavailableHere: 'Not available on this computer.',
  installing: 'Installing',
  manualInstall:
    'This cannot be installed automatically. Finish the step yourself, then check again.',
  edited: 'Edited',
  unknownProgress:
    'Progress for this file is unknown. Check its status or cancel it.',
  model: 'Model',
  rawText: 'Raw text',
  gpuAcceleration: 'GPU acceleration on',
  cpuNotice: 'No GPU available. Text recognition will be slower.',
  captureTasks: 'Capture tasks',
  page: (page) => `Page ${page}`,
  segment: (order) => `Segment ${order}`,
  runtimeStatus: {
    checking: 'Checking',
    ready: 'Ready',
    'needs-setup': 'Setup needed',
    incompatible: 'Update needed',
    error: 'Unavailable',
  },
  requirementStatus: {
    ready: 'Installed',
    missing: 'Not installed',
    installable: 'Not installed',
    manual_action_required: 'Action needed',
    unavailable: 'Unavailable',
  },
  taskStatus: {
    queued: 'Waiting',
    processing: 'Processing',
    awaiting_confirmation: 'Needs review',
    reconciliation_required: 'Needs attention',
    completed: 'Done',
    failed: 'Failed',
    canceled: 'Canceled',
  },
  taskStage: {
    uploading: 'Uploading',
    extracting: 'Reading text',
    structuring: 'Organizing',
  },
};

export const CAPTURE_WORKBENCH_MESSAGES: Readonly<
  Record<CaptureWorkbenchLocale, CaptureWorkbenchMessages>
> = { 'zh-TW': ZH_TW, en: EN };

/** The text for a locale, with the host's `labels` taking precedence. */
export function resolveCaptureWorkbenchMessages(
  locale: CaptureWorkbenchLocale | undefined,
  labels: CaptureWorkbenchLabels | undefined,
): CaptureWorkbenchMessages {
  const base =
    CAPTURE_WORKBENCH_MESSAGES[locale ?? DEFAULT_CAPTURE_WORKBENCH_LOCALE] ??
    CAPTURE_WORKBENCH_MESSAGES[DEFAULT_CAPTURE_WORKBENCH_LOCALE];
  const overrides = Object.fromEntries(
    Object.entries(labels ?? {}).filter(([, value]) => value !== undefined),
  );
  return { ...base, ...overrides };
}
