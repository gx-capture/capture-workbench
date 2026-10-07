import { computed, signal } from '@angular/core';

/** Languages the desktop app ships text for. */
export type DesktopLocale = 'zh-TW' | 'en';

export const DESKTOP_LOCALES: readonly DesktopLocale[] = ['zh-TW', 'en'];
export const DESKTOP_LOCALE_STORAGE_KEY = 'capture-workbench.locale';
const DEFAULT_DESKTOP_LOCALE: DesktopLocale = 'zh-TW';

/** Every piece of text the desktop app shows. */
export interface DesktopMessages {
  readonly languageName: string;
  readonly language: string;
  readonly navigation: string;
  readonly workspaceNavigation: string;
  readonly queue: string;
  readonly history: string;
  readonly searchDocuments: string;
  readonly searchPlaceholder: string;
  readonly statusFilter: string;
  readonly all: string;
  readonly ready: string;
  readonly notReady: string;
  readonly title: string;
  readonly noModel: string;
  readonly setupTitle: string;
  readonly needsSetup: string;
  readonly manualRepair: string;
  readonly awaitingInstall: string;
  readonly installing: string;
  readonly agreeAndInstall: string;
  readonly installDone: string;
  readonly installFailed: string;
  readonly installRunning: string;
  readonly model: string;
  readonly downloadingModel: string;
  readonly agreeAndDownloadModel: string;
  readonly modelSeparate: string;
  readonly modelProgress: string;
  readonly downloading: (name: string) => string;
  readonly cannotStart: string;
  readonly reconnect: string;
  readonly dropHere: string;
  readonly chooseFiles: string;
  readonly supportedFiles: string;
  readonly myDocuments: string;
  readonly noDocuments: string;
  readonly documentDetail: string;
  readonly stepRecognition: string;
  readonly stepStructuring: string;
  readonly stepSave: string;
  readonly recognizedText: string;
  readonly structuredResult: string;
  readonly cancelProcessing: string;
  readonly retry: string;
  readonly exportText: string;
  readonly exportJson: string;
  readonly delete: string;
  readonly cancelFirst: string;
  readonly notFinished: string;
  readonly selectDocument: string;
  readonly gpuAcceleration: string;
  readonly cpuNotice: string;
  readonly starting: string;
  readonly startTimeout: (detail: string) => string;
  readonly canceled: string;
  readonly desktopOnly: string;
  readonly whisperNeeded: string;
  readonly missingRawResult: string;
  readonly manualRequirement: (name: string, detail: string) => string;
  readonly finishInstallThenRetry: string;
  readonly requirementFailed: (name: string) => string;
  readonly recheck: string;
  readonly cancelBeforeDelete: string;
  readonly waitBeforeDelete: string;
  readonly confirmDelete: string;
  readonly modelPhase: {
    readonly queued: string;
    readonly failed: string;
    readonly cancelled: string;
    readonly completed: string;
    readonly starting: string;
    readonly downloading: string;
    readonly configuring: string;
  };
  readonly stage: Readonly<Record<string, string | undefined>>;
  readonly status: Readonly<Record<string, string | undefined>>;
}

const ZH_TW: DesktopMessages = {
  languageName: '中文',
  language: '語言',
  navigation: 'Capture Workbench 導覽',
  workspaceNavigation: '工作區導覽',
  queue: '處理佇列',
  history: '歷史資料庫',
  searchDocuments: '搜尋文件',
  searchPlaceholder: '搜尋檔名',
  statusFilter: '處理狀態',
  all: '全部',
  ready: '已就緒',
  notReady: '尚未就緒',
  title: '文件擷取工作台',
  noModel: '未選擇模型',
  setupTitle: '首次設定',
  needsSetup: '處理文件前，需要先下載必要元件。',
  manualRepair: '需要手動修復。',
  awaitingInstall: '等待安裝。',
  installing: '安裝中…',
  agreeAndInstall: '同意並安裝',
  installDone: '安裝完成',
  installFailed: '安裝失敗',
  installRunning: '正在安裝',
  model: '模型',
  downloadingModel: '下載模型中…',
  agreeAndDownloadModel: '同意並下載模型',
  modelSeparate: '模型需另外下載。',
  modelProgress: '模型下載進度',
  downloading: (name) => `正在下載 ${name}。`,
  cannotStart: '無法啟動文件處理',
  reconnect: '重新連線',
  dropHere: '拖放檔案到這裡',
  chooseFiles: '選擇檔案',
  supportedFiles: '支援 PDF、圖片、音訊',
  myDocuments: '我的文件',
  noDocuments: '尚未加入文件。',
  documentDetail: '文件詳情',
  stepRecognition: '文字辨識',
  stepStructuring: '結構化',
  stepSave: '儲存',
  recognizedText: '辨識文字',
  structuredResult: '結構化結果',
  cancelProcessing: '取消處理',
  retry: '重新處理',
  exportText: '匯出文字',
  exportJson: '匯出 JSON',
  delete: '刪除',
  cancelFirst: '請先取消處理。',
  notFinished: '處理尚未結束。',
  selectDocument: '選擇文件查看結果',
  gpuAcceleration: 'GPU 加速',
  cpuNotice: '沒有可用的 GPU，文字辨識會比較慢。',
  starting: '正在啟動…',
  startTimeout: (detail) => `啟動逾時：${detail}`,
  canceled: '處理已取消。',
  desktopOnly: 'Capture Workbench 僅能在 Windows 桌面 App 中使用。',
  whisperNeeded: '選取的音訊需要額外安裝 Whisper。',
  missingRawResult: 'Capture Runtime 未提供已完成工作的原始結果。',
  manualRequirement: (name, detail) => `${name} 需要手動處理：${detail}`,
  finishInstallThenRetry: '請完成安裝後再試。',
  requirementFailed: (name) => `${name} 安裝失敗。`,
  recheck: '安裝完成，正在重新檢查。',
  cancelBeforeDelete: '請先取消處理，再刪除文件。',
  waitBeforeDelete: '處理尚未結束，請稍候再刪除。',
  confirmDelete: '確定要刪除這份文件嗎？',
  modelPhase: {
    queued: '等待開始',
    failed: '模型下載失敗',
    cancelled: '模型下載已取消',
    completed: '模型已就緒',
    starting: '啟動模型服務',
    downloading: '下載與驗證模型',
    configuring: '設定模型',
  },
  stage: {
    uploading: '上傳中',
    queued: '等待處理',
    extracting: '文字辨識中',
    awaiting_structuring: '等待結構化',
    structuring: '結構化中',
    persisting: '儲存中',
    recovery_required: '需要復原',
    completed: '已完成',
    failed: '處理失敗',
    cancelled: '已取消',
  },
  status: {
    queued: '等待處理',
    processing: '處理中',
    persisting: '儲存中',
    recovery_required: '需要復原',
    awaiting_confirmation: '等待確認',
    completed: '已完成',
    failed: '處理失敗',
    canceled: '已取消',
  },
};

const EN: DesktopMessages = {
  languageName: 'English',
  language: 'Language',
  navigation: 'Capture Workbench navigation',
  workspaceNavigation: 'Workspace',
  queue: 'Queue',
  history: 'History',
  searchDocuments: 'Search documents',
  searchPlaceholder: 'File name',
  statusFilter: 'Status',
  all: 'All',
  ready: 'Ready',
  notReady: 'Not ready',
  title: 'Capture Workbench',
  noModel: 'No model selected',
  setupTitle: 'First-time setup',
  needsSetup: 'Required components must be downloaded before processing.',
  manualRepair: 'Needs a manual fix.',
  awaitingInstall: 'Waiting to install.',
  installing: 'Installing…',
  agreeAndInstall: 'Agree and install',
  installDone: 'Installed',
  installFailed: 'Installation failed',
  installRunning: 'Installing',
  model: 'Model',
  downloadingModel: 'Downloading model…',
  agreeAndDownloadModel: 'Agree and download model',
  modelSeparate: 'The model is downloaded separately.',
  modelProgress: 'Model download progress',
  downloading: (name) => `Downloading ${name}.`,
  cannotStart: 'Document processing could not start',
  reconnect: 'Try again',
  dropHere: 'Drop files here',
  chooseFiles: 'Choose files',
  supportedFiles: 'PDF, images, and audio',
  myDocuments: 'My documents',
  noDocuments: 'No documents yet.',
  documentDetail: 'Document details',
  stepRecognition: 'Text recognition',
  stepStructuring: 'Structuring',
  stepSave: 'Save',
  recognizedText: 'Recognized text',
  structuredResult: 'Structured result',
  cancelProcessing: 'Cancel',
  retry: 'Process again',
  exportText: 'Export text',
  exportJson: 'Export JSON',
  delete: 'Delete',
  cancelFirst: 'Cancel processing first.',
  notFinished: 'Processing has not finished.',
  selectDocument: 'Select a document to see its result',
  gpuAcceleration: 'GPU acceleration on',
  cpuNotice: 'No GPU available. Text recognition will be slower.',
  starting: 'Starting…',
  startTimeout: (detail) => `Start-up timed out: ${detail}`,
  canceled: 'Processing was canceled.',
  desktopOnly: 'Capture Workbench runs only in the Windows desktop app.',
  whisperNeeded: 'Audio needs Whisper installed first.',
  missingRawResult: 'The finished job returned no raw result.',
  manualRequirement: (name, detail) => `${name} needs a manual step: ${detail}`,
  finishInstallThenRetry: 'Finish the installation, then try again.',
  requirementFailed: (name) => `${name} could not be installed.`,
  recheck: 'Installed. Checking again.',
  cancelBeforeDelete: 'Cancel processing before deleting the document.',
  waitBeforeDelete: 'Processing has not finished. Delete the document later.',
  confirmDelete: 'Delete this document?',
  modelPhase: {
    queued: 'Waiting to start',
    failed: 'Model download failed',
    cancelled: 'Model download canceled',
    completed: 'Model ready',
    starting: 'Starting the model service',
    downloading: 'Downloading and verifying the model',
    configuring: 'Setting up the model',
  },
  stage: {
    uploading: 'Uploading',
    queued: 'Waiting',
    extracting: 'Recognizing text',
    awaiting_structuring: 'Waiting to structure',
    structuring: 'Structuring',
    persisting: 'Saving',
    recovery_required: 'Needs recovery',
    completed: 'Done',
    failed: 'Failed',
    cancelled: 'Canceled',
  },
  status: {
    queued: 'Waiting',
    processing: 'Processing',
    persisting: 'Saving',
    recovery_required: 'Needs recovery',
    awaiting_confirmation: 'Needs review',
    completed: 'Done',
    failed: 'Failed',
    canceled: 'Canceled',
  },
};

export const DESKTOP_MESSAGES: Readonly<Record<DesktopLocale, DesktopMessages>> =
  { 'zh-TW': ZH_TW, en: EN };

function readStoredLocale(): DesktopLocale {
  try {
    const stored = globalThis.localStorage?.getItem(DESKTOP_LOCALE_STORAGE_KEY);
    return stored === 'en' || stored === 'zh-TW'
      ? stored
      : DEFAULT_DESKTOP_LOCALE;
  } catch {
    return DEFAULT_DESKTOP_LOCALE;
  }
}

/** The language in use. Traditional Chinese until the user chooses another. */
export const desktopLocale = signal<DesktopLocale>(readStoredLocale());

/** The text of the language in use. */
export const desktopMessages = computed(
  () => DESKTOP_MESSAGES[desktopLocale()],
);

/** Switches the language and remembers the choice on this computer. */
export function setDesktopLocale(locale: DesktopLocale): void {
  desktopLocale.set(locale);
  try {
    globalThis.localStorage?.setItem(DESKTOP_LOCALE_STORAGE_KEY, locale);
  } catch {
    // The choice still applies for this session when storage is unavailable.
  }
}
