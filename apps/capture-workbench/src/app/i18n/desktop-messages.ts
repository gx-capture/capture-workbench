import { computed, signal } from '@angular/core';

/** Languages the desktop app ships text for. */
export type DesktopLocale = 'zh-TW' | 'en';

export const DESKTOP_LOCALES: readonly DesktopLocale[] = ['zh-TW', 'en'];
export const DESKTOP_LOCALE_STORAGE_KEY = 'capture-workbench.locale';
const DEFAULT_DESKTOP_LOCALE: DesktopLocale = 'zh-TW';

/** Pages the shell's left navigation leads to. */
export type ShellRoute = 'ocr' | 'asr' | 'history' | 'settings';
/** Pages whose intake still links to the history workspace. */
export type PlaceholderRoute = 'asr';

/** Every piece of text the desktop app shows. */
export interface DesktopMessages {
  readonly sourceRejections: Readonly<Record<'unsupported' | 'empty' | 'tooLarge' | 'notRegularFile' | 'notLocal' | 'unreadable' | 'limitReached', (count: number) => string>>;
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
  readonly mainNavigation: string;
  readonly nav: Readonly<Record<ShellRoute, string>>;
  readonly comingSoon: string;
  readonly placeholder: Readonly<
    Record<PlaceholderRoute, { readonly summary: string; readonly action: string }>
  >;
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
  readonly installProgress: string;
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
  readonly speakerUnitNeeded: string;
  readonly verticalReaderMissed: string;
  readonly offerInstall: string;
  readonly identifySpeakers: string;
  readonly speechPackTitle: string;
  readonly speechPackHint: string;
  readonly unitReady: string;
  readonly unitUnavailable: string;
  readonly guideSummary: string;
  readonly guideLanguages: string;
  readonly guideHardware: string;
  readonly guideLicense: string;
  readonly useGpuForSpeech: string;
  readonly speakers: string;
  readonly speakersHint: string;
  readonly speakerName: string;
  readonly loadSamples: string;
  readonly noSample: string;
  readonly transcript: string;
  readonly transcriptHint: string;
  readonly loadRecording: string;
  readonly largeRecordingPlaybackUnavailable: string;
  readonly playFrom: (time: string) => string;
  readonly liveTranscript: string;
  readonly heardUntil: (time: string) => string;
  readonly missingRawResult: string;
  readonly manualRequirement: (name: string, detail: string) => string;
  readonly finishInstallThenRetry: string;
  readonly requirementFailed: (name: string) => string;
  readonly recheck: string;
  readonly cancelBeforeDelete: string;
  readonly waitBeforeDelete: string;
  readonly confirmDelete: string;
  readonly confirmDeleteCancel: string;
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
  readonly installWithSize: (size?: string | null) => string;
  readonly installSelectedWithSize: (size?: string | null) => string;
  readonly downloadingProgress: (percent: number) => string;
  readonly cancelInstall: string;
  readonly retryInstall: string;
  readonly removeEngine: string;
  readonly removeEngineNamed: (name: string) => string;
  readonly removeEngineTitle: (name: string) => string;
  readonly removeEngineBody: (name: string, size: string | null) => string;
  readonly removeEngineCancel: string;
  readonly removingEngine: string;
  readonly removeBlockedInstalling: string;
  readonly removeBlockedCapture: string;
  readonly removeEngineInUse: string;
  readonly removeEngineNotUninstallable: string;
  readonly removeEngineNotFound: string;
  readonly later: string;
  readonly optionalSuffix: string;
  readonly firstRunTitle: string;
  readonly firstRunHint: string;
  readonly firstRunOcrLabel: string;
  readonly firstRunOcrSummary: string;
  readonly firstRunAsrLabel: string;
  readonly firstRunAsrSummary: string;
  readonly firstRunSpeakersLabel: string;
  readonly firstRunSpeakersSummary: string;
  readonly asrPanelHint: string;
  readonly settingsEnginesTitle: string;
  readonly engineColFeature: string;
  readonly engineColStatus: string;
  readonly engineColSize: string;
  readonly engineColPurpose: string;
  readonly engineColAction: string;
  readonly engineName: Readonly<Record<string, string | undefined>>;
  readonly enginePurpose: Readonly<Record<string, string | undefined>>;
  readonly engineStatus: Readonly<Record<string, string | undefined>>;
  readonly ocrSubtitle: string;
  readonly ocrDropHint: string;
  readonly ocrDropSupported: string;
  readonly ocrDropNotInstalledHint: string;
  readonly ocrAllPages: string;
  readonly ocrQueueTitle: string;
  readonly ocrQueueCount: (count: number) => string;
  readonly ocrColFile: string;
  readonly ocrColPages: string;
  readonly ocrColStatus: string;
  readonly ocrColAction: string;
  readonly ocrStatusWaiting: string;
  readonly ocrStatusProcessing: string;
  readonly ocrStatusDone: string;
  readonly ocrStatusNeedsAttention: string;
  readonly ocrStatusCancelled: string;
  readonly ocrNeedsEngine: (size: string | null) => string;
  readonly ocrPageProgress: (done: number, total: number) => string;
  readonly ocrProgressNamed: (name: string) => string;
  readonly ocrFirstPages: string;
  readonly ocrPagesUnit: string;
  readonly ocrView: string;
  readonly ocrExportTxt: string;
  readonly ocrRestart: string;
  readonly ocrInterrupted: string;
  readonly ocrInterruptedHint: string;
  readonly ocrRetry: string;
  readonly ocrPageCountInvalid: string;
  readonly ocrInstallNamed: (name: string) => string;
  readonly ocrCancelNamed: (name: string) => string;
  readonly ocrRetryNamed: (name: string) => string;
  readonly ocrRestartNamed: (name: string) => string;
  readonly ocrViewNamed: (name: string) => string;
  readonly ocrExportNamed: (name: string) => string;
}

const ZH_TW: DesktopMessages = {
  sourceRejections: {
    unsupported: (count) => `不支援的檔案格式 (${count})`,
    empty: (count) => `檔案是空的 (${count})`,
    tooLarge: (count) => `檔案超過大小限制：錄音 2 GiB，文件與圖片 50 MiB (${count})`,
    notRegularFile: (count) => `必須選擇一般檔案 (${count})`,
    notLocal: (count) => `只能選擇本機磁碟的檔案 (${count})`,
    unreadable: (count) => `無法讀取檔案 (${count})`,
    limitReached: (count) => `已達選取數量上限 (${count})`,
  },
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
  mainNavigation: '主要功能',
  nav: { ocr: '文件轉文字', asr: '錄音轉逐字稿', history: '紀錄', settings: '設定' },
  comingSoon: '即將推出',
  placeholder: {
    asr: { summary: '把錄音轉成標有時間的逐字稿。', action: '前往紀錄加入錄音' },
  },
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
  installProgress: '安裝進度',
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
  whisperNeeded: '處理錄音需要先下載台灣語音轉文字（TEA-ASR 1.1）。',
  speakerUnitNeeded: '辨識說話者需要額外安裝一個元件。',
  verticalReaderMissed: '這份文件有直書日文的頁面。安裝直書日文閱讀器後重新處理，這些頁面會讀得更準。',
  offerInstall: '安裝',
  identifySpeakers: '辨識音訊中的說話者',
  speechPackTitle: '台灣語音包（選用）',
  speechPackHint: '處理錄音時才需要，PDF 與圖片不受影響。看完說明，依需要下載。',
  unitReady: '已安裝',
  unitUnavailable: '無法下載',
  guideSummary: '特性',
  guideLanguages: '適用語言',
  guideHardware: '硬體',
  guideLicense: '授權',
  useGpuForSpeech: '用 GPU 加速語音辨識',
  speakers: '說話者',
  speakersHint: '聽一段聲音後填上名字，匯出的文字會改用這個名字。',
  speakerName: '這位說話者的名字',
  loadSamples: '載入試聽片段',
  noSample: '沒有可試聽的片段',
  transcript: '逐字稿',
  transcriptHint: '點時間即可從那一刻播放錄音，核對聽到的內容。',
  loadRecording: '載入錄音',
  largeRecordingPlaybackUnavailable: '大型錄音暫時無法播放，仍可查看逐字稿。',
  playFrom: (time) => `從 ${time} 播放`,
  liveTranscript: '即時逐字稿',
  heardUntil: (time) => `已聽到 ${time}`,
  missingRawResult: 'Capture Runtime 未提供已完成工作的原始結果。',
  manualRequirement: (name, detail) => `${name} 需要手動處理：${detail}`,
  finishInstallThenRetry: '請完成安裝後再試。',
  requirementFailed: (name) => `${name} 安裝失敗。`,
  recheck: '安裝完成，正在重新檢查。',
  cancelBeforeDelete: '請先取消處理，再刪除文件。',
  waitBeforeDelete: '處理尚未結束，請稍候再刪除。',
  confirmDelete: '確定要刪除這份文件嗎？',
  confirmDeleteCancel: '取消',
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
    transcribing: '語音轉文字中',
    'identifying-speakers': '辨識說話者中',
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
  installWithSize: (size) => (size ? `安裝（${size}）` : '安裝'),
  installSelectedWithSize: (size) => (size ? `安裝所選（${size}）` : '安裝所選'),
  downloadingProgress: (percent) => `正在下載 ${percent}%`,
  cancelInstall: '取消',
  retryInstall: '再試一次',
  removeEngine: '移除',
  removeEngineNamed: (name) => `移除${name}`,
  removeEngineTitle: (name) => `移除${name}？`,
  removeEngineBody: (name, size) =>
    size
      ? `這會刪除${name}（${size}）。已經做好的文件和逐字稿會留在這台電腦，之後可以再安裝。`
      : `這會刪除${name}。已經做好的文件和逐字稿會留在這台電腦，之後可以再安裝。`,
  removeEngineCancel: '取消',
  removingEngine: '正在移除',
  removeBlockedInstalling: '這項功能正在安裝',
  removeBlockedCapture: '有辨識正在使用它',
  removeEngineInUse: '安裝或辨識還在進行，請稍後再移除',
  removeEngineNotUninstallable: '這項功能無法從這裡移除',
  removeEngineNotFound: '找不到這項功能',
  later: '稍後再說',
  optionalSuffix: '（選用）',
  firstRunTitle: '要安裝哪些辨識功能？',
  firstRunHint: '只下載你勾選的項目，之後也可以在「設定」裡加裝或移除。',
  firstRunOcrLabel: '文字辨識',
  firstRunOcrSummary: '讀出掃描檔與照片的文字',
  firstRunAsrLabel: '錄音轉文字',
  firstRunAsrSummary: '把錄音轉成逐字稿',
  firstRunSpeakersLabel: '說話者辨識',
  firstRunSpeakersSummary: '標出每段話是誰說的',
  asrPanelHint: '下載完成後即可將錄音轉為逐字稿；下載期間仍可使用其他功能。',
  settingsEnginesTitle: '辨識功能',
  engineColFeature: '功能',
  engineColStatus: '狀態',
  engineColSize: '大小',
  engineColPurpose: '用途',
  engineColAction: '動作',
  engineName: {
    'windowsml-ocr': '文字辨識',
    'speech-recognition': '錄音轉文字',
    'speaker-diarization': '說話者辨識',
    'vertical-japanese-reader': '直書日文',
  },
  enginePurpose: {
    'windowsml-ocr': '讀出掃描檔與照片的文字',
    'speech-recognition': '台灣華語與中英夾雜語音轉逐字稿',
    'speaker-diarization': '標出每段話是誰說的',
    'vertical-japanese-reader': '讀出直排日文頁面',
  },
  engineStatus: {
    ready: '已安裝',
    installable: '未安裝',
    missing: '未安裝',
    running: '安裝中',
    queued: '等待安裝',
    failed: '安裝失敗',
    cancelled: '已取消',
    manual_action_required: '需手動處理',
    unavailable: '無法安裝',
  },
  ocrSubtitle: '讀出掃描檔與照片裡的文字。檔案與結果都留在這台電腦。',
  ocrDropHint: '拖曳 PDF 或圖片到這裡',
  ocrDropSupported: '支援 PDF、PNG、JPG，單檔最大 50 MiB',
  ocrDropNotInstalledHint: '還沒安裝文字辨識也可以先加入，安裝完成後自動開始。',
  ocrAllPages: '全部',
  ocrQueueTitle: '佇列',
  ocrQueueCount: (count) => `${count} 個檔案`,
  ocrColFile: '檔名',
  ocrColPages: '頁數',
  ocrColStatus: '狀態',
  ocrColAction: '動作',
  ocrStatusWaiting: '等待中',
  ocrStatusProcessing: '處理中',
  ocrStatusDone: '完成',
  ocrStatusNeedsAttention: '需要處理',
  ocrStatusCancelled: '已取消',
  ocrNeedsEngine: (size) => size ? `需要文字辨識（${size}）` : '需要文字辨識',
  ocrPageProgress: (done, total) => `第 ${done}/${total} 頁`,
  ocrProgressNamed: (name) => `${name} 的進度`,
  ocrFirstPages: 'PDF 只辨識前',
  ocrPagesUnit: '頁',
  ocrView: '檢視',
  ocrExportTxt: '匯出 .txt',
  ocrRestart: '重新開始',
  ocrInterrupted: '已中斷',
  ocrInterruptedHint: '上次關閉程式時尚未完成。',
  ocrRetry: '重試',
  ocrPageCountInvalid: 'Capture PDF page selection is invalid.',
  ocrInstallNamed: (name) => `安裝文字辨識以處理 ${name}`,
  ocrCancelNamed: (name) => `取消 ${name}`,
  ocrRetryNamed: (name) => `重試 ${name}`,
  ocrRestartNamed: (name) => `重新開始 ${name}`,
  ocrViewNamed: (name) => `檢視 ${name}`,
  ocrExportNamed: (name) => `匯出 ${name} 的文字`,
};

const EN: DesktopMessages = {
  sourceRejections: {
    unsupported: (count) => `Unsupported source format (${count})`,
    empty: (count) => `Empty source (${count})`,
    tooLarge: (count) => `Source exceeds the size limit: recordings 2 GiB, documents and images 50 MiB (${count})`,
    notRegularFile: (count) => `Source must be a regular file (${count})`,
    notLocal: (count) => `Source must be on a local disk (${count})`,
    unreadable: (count) => `Source cannot be read (${count})`,
    limitReached: (count) => `Selection limit reached (${count})`,
  },
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
  mainNavigation: 'Main',
  nav: { ocr: 'Document to text', asr: 'Recording to transcript', history: 'History', settings: 'Settings' },
  comingSoon: 'Coming soon',
  placeholder: {
    asr: { summary: 'Turn recordings into timed transcripts.', action: 'Add recordings in History' },
  },
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
  installProgress: 'Installation progress',
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
  whisperNeeded: 'Recordings need Taiwan speech-to-text (TEA-ASR 1.1) downloaded first.',
  speakerUnitNeeded: 'Telling speakers apart needs one more component installed.',
  verticalReaderMissed: 'This document has pages of vertical Japanese. Install the vertical Japanese reader and process it again to read them more accurately.',
  offerInstall: 'Install',
  identifySpeakers: 'Tell speakers apart in audio',
  speechPackTitle: 'Taiwan speech pack (optional)',
  speechPackHint: 'Only recordings need it; PDFs and images work without it. Read about each part, then download what you want.',
  unitReady: 'Installed',
  unitUnavailable: 'Not downloadable',
  guideSummary: 'What it does',
  guideLanguages: 'Languages',
  guideHardware: 'Hardware',
  guideLicense: 'License',
  useGpuForSpeech: 'Use the GPU for speech recognition',
  speakers: 'Speakers',
  speakersHint: 'Listen to a sample, then type a name. Exported text will use it.',
  speakerName: "This speaker's name",
  loadSamples: 'Load samples',
  noSample: 'No sample to play',
  transcript: 'Transcript',
  transcriptHint: 'Select a time to play the recording from that moment and check what was heard.',
  loadRecording: 'Load recording',
  largeRecordingPlaybackUnavailable: 'Playback of large recordings is not available yet. The transcript is still shown.',
  playFrom: (time) => `Play from ${time}`,
  liveTranscript: 'Live transcript',
  heardUntil: (time) => `Heard up to ${time}`,
  missingRawResult: 'The finished job returned no raw result.',
  manualRequirement: (name, detail) => `${name} needs a manual step: ${detail}`,
  finishInstallThenRetry: 'Finish the installation, then try again.',
  requirementFailed: (name) => `${name} could not be installed.`,
  recheck: 'Installed. Checking again.',
  cancelBeforeDelete: 'Cancel processing before deleting the document.',
  waitBeforeDelete: 'Processing has not finished. Delete the document later.',
  confirmDelete: 'Delete this document?',
  confirmDeleteCancel: 'Cancel',
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
    transcribing: 'Transcribing speech',
    'identifying-speakers': 'Telling speakers apart',
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
  installWithSize: (size) => (size ? `Install (${size})` : 'Install'),
  installSelectedWithSize: (size) =>
    size ? `Install selected (${size})` : 'Install selected',
  downloadingProgress: (percent) => `Downloading ${percent}%`,
  cancelInstall: 'Cancel',
  retryInstall: 'Try again',
  removeEngine: 'Remove',
  removeEngineNamed: (name) => `Remove ${name}`,
  removeEngineTitle: (name) => `Remove ${name}?`,
  removeEngineBody: (name, size) =>
    size
      ? `This deletes ${name} (${size}). Documents and transcripts already saved stay on this computer, and you can install it again later.`
      : `This deletes ${name}. Documents and transcripts already saved stay on this computer, and you can install it again later.`,
  removeEngineCancel: 'Cancel',
  removingEngine: 'Removing',
  removeBlockedInstalling: 'This feature is installing',
  removeBlockedCapture: 'A recognition is using it',
  removeEngineInUse:
    'An installation or recognition is still running. Try again when it finishes.',
  removeEngineNotUninstallable: 'This feature cannot be removed from here.',
  removeEngineNotFound: 'This feature was not found.',
  later: 'Maybe later',
  optionalSuffix: ' (optional)',
  firstRunTitle: 'Which recognition features do you want to install?',
  firstRunHint: 'Only checked items will be downloaded. You can add or remove them later in Settings.',
  firstRunOcrLabel: 'Text recognition',
  firstRunOcrSummary: 'Read text from scans and photos',
  firstRunAsrLabel: 'Speech to text',
  firstRunAsrSummary: 'Turn recordings into transcripts',
  firstRunSpeakersLabel: 'Speaker identification',
  firstRunSpeakersSummary: 'Mark who said each segment',
  asrPanelHint:
    'Once downloaded, you can transcribe recordings. The rest of the app stays usable during the download.',
  settingsEnginesTitle: 'Recognition features',
  engineColFeature: 'Feature',
  engineColStatus: 'Status',
  engineColSize: 'Size',
  engineColPurpose: 'Purpose',
  engineColAction: 'Action',
  engineName: {
    'windowsml-ocr': 'Text recognition',
    'speech-recognition': 'Speech to text',
    'speaker-diarization': 'Speaker identification',
    'vertical-japanese-reader': 'Vertical Japanese',
  },
  enginePurpose: {
    'windowsml-ocr': 'Read text from scans and photos',
    'speech-recognition':
      'Taiwan Mandarin and mixed Mandarin-English speech to transcript',
    'speaker-diarization': 'Mark who said each segment',
    'vertical-japanese-reader': 'Read vertical Japanese pages',
  },
  engineStatus: {
    ready: 'Installed',
    installable: 'Not installed',
    missing: 'Not installed',
    running: 'Installing',
    queued: 'Queued',
    failed: 'Failed',
    cancelled: 'Canceled',
    manual_action_required: 'Manual step required',
    unavailable: 'Unavailable',
  },
  ocrSubtitle: 'Read text from scans and photos. Files and results stay on this computer.',
  ocrDropHint: 'Drop a PDF or images here',
  ocrDropSupported: 'Supports PDF, PNG, JPG, up to 50 MiB per file',
  ocrDropNotInstalledHint: 'You can add files before text recognition is installed; they will start automatically once installation finishes.',
  ocrAllPages: 'All',
  ocrQueueTitle: 'Queue',
  ocrQueueCount: (count) => `${count} file${count === 1 ? '' : 's'}`,
  ocrColFile: 'File',
  ocrColPages: 'Pages',
  ocrColStatus: 'Status',
  ocrColAction: 'Action',
  ocrStatusWaiting: 'Waiting',
  ocrStatusProcessing: 'Processing',
  ocrStatusDone: 'Done',
  ocrStatusNeedsAttention: 'Needs attention',
  ocrStatusCancelled: 'Canceled',
  ocrNeedsEngine: (size) => size ? `Text recognition is required (${size})` : 'Text recognition is required',
  ocrPageProgress: (done, total) => `Page ${done}/${total}`,
  ocrProgressNamed: (name) => `Progress for ${name}`,
  ocrFirstPages: 'Recognise only first',
  ocrPagesUnit: 'pages',
  ocrView: 'View',
  ocrExportTxt: 'Export .txt',
  ocrRestart: 'Start again',
  ocrInterrupted: 'Interrupted',
  ocrInterruptedHint: 'Not finished before the app was last closed.',
  ocrRetry: 'Retry',
  ocrPageCountInvalid: 'Capture PDF page selection is invalid.',
  ocrInstallNamed: (name) => `Install text recognition for ${name}`,
  ocrCancelNamed: (name) => `Cancel ${name}`,
  ocrRetryNamed: (name) => `Retry ${name}`,
  ocrRestartNamed: (name) => `Start ${name} again`,
  ocrViewNamed: (name) => `View ${name}`,
  ocrExportNamed: (name) => `Export text for ${name}`,
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
