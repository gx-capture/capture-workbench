import { computed, signal } from '@angular/core';

/** Languages the desktop app ships text for. */
export type DesktopLocale = 'zh-TW' | 'en';

export const DESKTOP_LOCALES: readonly DesktopLocale[] = ['zh-TW', 'en'];
export const DESKTOP_LOCALE_STORAGE_KEY = 'capture-workbench.locale';
const DEFAULT_DESKTOP_LOCALE: DesktopLocale = 'zh-TW';

/** Pages the shell's left navigation leads to. */
export type ShellRoute = 'ocr' | 'asr' | 'history' | 'settings';

/** Every piece of text the desktop app shows. */
export interface DesktopMessages {
  readonly historyType: string;
  readonly historyKindOcr: string;
  readonly historyRecording: string;
  readonly historyExtent: string;
  readonly historyUpdated: string;
  readonly historySubtitle: string;
  readonly historyCount: (count: number) => string;
  readonly historyNoMatches: string;
  readonly historyDeleteFailed: string;
  readonly historyDeleteNamed: (name: string) => string;
  readonly statusDiagnosticsLabel: string;
  readonly sourceRejections: Readonly<Record<'unsupported' | 'empty' | 'tooLarge' | 'notRegularFile' | 'notLocal' | 'unreadable' | 'limitReached', (count: number) => string>>;
  readonly languageName: string;
  readonly language: string;
  readonly queue: string;
  readonly searchDocuments: string;
  readonly searchPlaceholder: string;
  readonly statusFilter: string;
  readonly all: string;
  readonly ready: string;
  readonly notReady: string;
  readonly mainNavigation: string;
  readonly nav: Readonly<Record<ShellRoute, string>>;
  readonly noModel: string;
  readonly needsSetup: string;
  readonly model: string;
  readonly downloadingModel: string;
  readonly agreeAndDownloadModel: string;
  readonly modelSeparate: string;
  readonly modelProgress: string;
  readonly downloading: (name: string) => string;
  readonly reconnect: string;
  readonly chooseFiles: string;
  readonly noDocuments: string;
  readonly exportJson: string;
  readonly delete: string;
  readonly gpuAcceleration: string;
  readonly cpuNotice: string;
  readonly starting: string;
  readonly startTimeout: (detail: string) => string;
  readonly canceled: string;
  readonly desktopOnly: string;
  readonly speechUnitNeeded: string;
  readonly speakerUnitNeeded: string;
  readonly offerInstall: string;
  readonly requirementReady: string;
  readonly requirementUnavailable: string;
  readonly guideDetails: string;
  readonly guideSummary: string;
  readonly guideLanguages: string;
  readonly guideHardware: string;
  readonly guideLicense: string;
  readonly useGpuForSpeech: string;
  readonly speakerName: string;
  readonly noSample: string;
  readonly largeRecordingPlaybackUnavailable: string;
  readonly playFrom: (time: string) => string;
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
  readonly installProgressPreparing: string;
  readonly installProgressInstalling: string;
  readonly cancel: string;
  readonly cancelInstall: string;
  readonly retryInstall: string;
  readonly removeRequirement: string;
  readonly removeRequirementNamed: (name: string) => string;
  readonly removeRequirementTitle: (name: string) => string;
  readonly removeRequirementBody: (name: string, size: string | null) => string;
  readonly removeRequirementCancel: string;
  readonly removingRequirement: string;
  readonly removeBlockedInstalling: string;
  readonly removeBlockedCapture: string;
  readonly removeRequirementInUse: string;
  readonly removeRequirementNotUninstallable: string;
  readonly removeRequirementNotFound: string;
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
  readonly engineColAction: string;
  readonly requirementName: Readonly<Record<string, string | undefined>>;
  readonly requirementPurpose: Readonly<Record<string, string | undefined>>;
  readonly requirementStatus: Readonly<Record<string, string | undefined>>;
  readonly ocrSubtitle: string;
  readonly ocrDropHint: string;
  readonly ocrDropSupported: string;
  readonly ocrDropNotInstalledHint: string;
  readonly ocrPagesLabel: string;
  readonly ocrPagesPlaceholder: string;
  readonly ocrQueueTitle: string;
  readonly ocrQueueCount: (count: number) => string;
  readonly queueColFile: string;
  readonly queueColPages: string;
  readonly queueColStatus: string;
  readonly queueColAction: string;
  readonly captureStatusWaiting: string;
  readonly captureStatusProcessing: string;
  readonly captureStatusDone: string;
  readonly captureStatusNeedsAttention: string;
  readonly captureStatusCancelled: string;
  readonly ocrNeedsRequirement: (size: string | null) => string;
  readonly ocrPageProgress: (done: number, total: number) => string;
  readonly ocrProgressNamed: (name: string) => string;
  readonly captureView: string;
  readonly ocrExportTxt: string;
  readonly captureRestart: string;
  readonly captureInterrupted: string;
  readonly ocrInterruptedHint: string;
  readonly captureRetry: string;
  readonly ocrPageSelectionInvalid: string;
  readonly ocrInstallNamed: (name: string) => string;
  readonly captureCancelNamed: (name: string) => string;
  readonly captureRetryNamed: (name: string) => string;
  readonly captureRestartNamed: (name: string) => string;
  readonly captureViewNamed: (name: string) => string;
  readonly ocrExportNamed: (name: string) => string;
  readonly asrSubtitle: string;
  readonly asrInstallTitle: string;
  readonly asrInstallHint: string;
  readonly asrEmptyTitle: string;
  readonly asrEmptyHintInstall: string;
  readonly asrEmptyHintReady: string;
  readonly asrDropSectionLabel: string;
  readonly asrDropHint: string;
  readonly asrDropFormats: string;
  readonly asrLanguageLabel: string;
  readonly asrSpokenLanguage: Readonly<Record<'zh' | 'en' | 'ja', string>>;
  readonly asrSpeakersLabel: string;
  readonly asrSpeakersNoPartialHint: string;
  readonly asrSpeakersOptionalTitle: string;
  readonly asrInstallSpeakers: (size: string | null) => string;
  readonly asrInstallingSpeakers: (percent: number) => string;
  readonly asrPreparingSpeakers: string;
  readonly asrFinishingSpeakers: string;
  readonly asrHeardOf: (heard: string, total: string) => string;
  readonly asrLiveProgressLabel: (fileName: string) => string;
  readonly asrLivePartialNote: string;
  readonly asrQueueSummary: (count: number) => string;
  readonly asrColDuration: string;
  readonly asrSpeakerCount: (count: number) => string;
  readonly asrPlaybackUnsupported: string;
  readonly asrExport: string;
  readonly asrExportNamed: (name: string) => string;
  readonly asrInstallNamed: (name: string) => string;
  readonly resultEdited: string;
  readonly resultRestore: string;
  readonly resultEditText: string;
  readonly resultSaving: string;
  readonly resultSaved: string;
  readonly resultSaveFailed: string;
  readonly resultRetrySave: string;
  readonly resultPageTooLong: string;
  readonly resultLineTooLong: string;
  readonly resultNameInvalid: string;
  readonly resultEditsUnreadable: string;
  readonly resultBack: string;
  readonly resultTitle: string;
  readonly resultNavigation: string;
  readonly resultTabContent: string;
  readonly resultTabSpeakers: string;
  readonly resultTabDetails: string;
  readonly resultTabExport: string;
  readonly exportPlainText: string;
  readonly exportMarkdown: string;
  readonly exportSrt: string;
  readonly exportVtt: string;
  readonly exportDownload: string;
  readonly exportCopyNote: string;
  readonly exportPlainTextDesc: string;
  readonly exportRecordingPlainTextDesc: string;
  readonly exportMarkdownDesc: string;
  readonly exportSrtDesc: string;
  readonly exportVttDesc: string;
  readonly exportCopy: string;
  readonly exportCopied: string;
  readonly exportDownloaded: string;
  readonly exportInProgress: string;
  readonly exportFailed: string;
  readonly exportCopyFailed: string;
  readonly exportPageLabel: string;
  readonly resultLoading: string;
  readonly resultNotFound: string;
  readonly resultNoResultYet: string;
  readonly resultPdfPreviewFailed: string;
  readonly resultPdfPageCanvasLabel: (page: number) => string;
  readonly resultOcrEmpty: string;
  readonly resultPageLabel: (page: number, total: number) => string;
  readonly resultSelectedPageLabel: (page: number, position: number, total: number) => string;
  readonly resultPreviousPage: string;
  readonly resultNextPage: string;
  readonly resultColTime: string;
  readonly resultColSpeaker: string;
  readonly resultColText: string;
  readonly resultNoSpeakers: string;
  readonly resultDetailFileName: string;
  readonly resultDetailMediaType: string;
  readonly resultDetailSize: string;
  readonly resultDetailStatus: string;
  readonly resultDetailCreatedAt: string;
  readonly resultDetailUpdatedAt: string;
  readonly settingsNavigation: string;
  readonly settingsSubtitle: string;
  readonly settingsComputeTitle: string;
  readonly settingsGeneralTitle: string;
  readonly computeOcrTitle: string;
  readonly computeAsrTitle: string;
  readonly computeOcrPending: string;
  readonly computeOcrCpu: string;
  readonly computeOcrGpuDetected: string;
  readonly computeAsrPending: string;
  readonly computeAsrCudaDetected: string;
  readonly computeAsrCpuOnly: string;
  readonly computeSaving: string;
  readonly computeBusyHint: string;
  readonly settingsDiagnosticsTitle: string;
  readonly diagnosticsRuntimeTitle: string;
  readonly diagnosticsRuntimeError: string;
  readonly diagnosticsRuntimeVersion: string;
  readonly diagnosticsApiVersion: string;
  readonly diagnosticsContractSetVersion: string;
  readonly diagnosticsContractDigest: string;
  readonly diagnosticsModelTitle: string;
  readonly diagnosticsModelPurpose: string;
  readonly diagnosticsDocumentTitle: string;
  readonly diagnosticsDocumentLoadError: string;
  readonly diagnosticsExtractionProvenance: string;
  readonly diagnosticsStructuringProvenance: string;
  readonly diagnosticsProvenanceEngine: string;
  readonly diagnosticsProvenanceModel: string;
  readonly diagnosticsProvenanceDevice: string;
  readonly diagnosticsProvenanceDigest: string;
  readonly diagnosticsCopy: string;
  readonly diagnosticsCopyDigestNamed: (name: string) => string;
  readonly diagnosticsEvidenceTitle: string;
  readonly diagnosticsExportFailed: string;
  readonly diagnosticsBackToResult: string;
  readonly resultDetailDiagnostics: string;
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
  historyType: '類型',
  historyKindOcr: '文件',
  historyRecording: '錄音',
  historyExtent: '長度/頁數',
  historyUpdated: '更新時間',
  historySubtitle: '所有已加入的文件與錄音，依更新時間排列。',
  historyCount: (count) => `共 ${count} 筆`,
  historyNoMatches: '沒有符合篩選條件的紀錄。',
  historyDeleteFailed: '無法刪除文件，請稍後再試。',
  historyDeleteNamed: (name) => `刪除 ${name}`,
  statusDiagnosticsLabel: '診斷',
  language: '語言',
  queue: '處理佇列',
  searchDocuments: '搜尋文件',
  searchPlaceholder: '搜尋檔名',
  statusFilter: '處理狀態',
  all: '全部',
  ready: '已就緒',
  notReady: '尚未就緒',
  mainNavigation: '主要功能',
  nav: { ocr: '文件轉文字', asr: '錄音轉逐字稿', history: '紀錄', settings: '設定' },
  noModel: '未選擇模型',
  needsSetup: '處理文件前，需要先下載必要元件。',
  model: '模型',
  downloadingModel: '下載模型中…',
  agreeAndDownloadModel: '同意並下載模型',
  modelSeparate: '模型需另外下載。',
  modelProgress: '模型下載進度',
  downloading: (name) => `正在下載 ${name}。`,
  reconnect: '重新連線',
  chooseFiles: '選擇檔案',
  noDocuments: '尚未加入文件。',
  exportJson: '匯出 JSON',
  delete: '刪除',
  gpuAcceleration: 'GPU 加速',
  cpuNotice: '沒有可用的 GPU，文字辨識會比較慢。',
  starting: '正在啟動…',
  startTimeout: (detail) => `啟動逾時：${detail}`,
  canceled: '處理已取消。',
  desktopOnly: 'Capture Workbench 僅能在 Windows 桌面 App 中使用。',
  speechUnitNeeded: '處理錄音需要先下載台灣語音轉文字（TEA-ASR 1.1）。',
  speakerUnitNeeded: '辨識說話者需要額外安裝一個元件。',
  offerInstall: '安裝',
  requirementReady: '已安裝',
  requirementUnavailable: '無法下載',
  guideDetails: '詳細說明',
  guideSummary: '特性',
  guideLanguages: '適用語言',
  guideHardware: '硬體',
  guideLicense: '授權',
  useGpuForSpeech: '用 GPU 加速語音辨識',
  speakerName: '這位說話者的名字',
  noSample: '沒有可試聽的片段',
  largeRecordingPlaybackUnavailable: '大型錄音暫時無法播放，仍可查看逐字稿。',
  playFrom: (time) => `從 ${time} 播放`,
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
  installProgressPreparing: '正在準備安裝…',
  installProgressInstalling: '下載完成，正在安裝…',
  cancel: '取消',
  cancelInstall: '取消',
  retryInstall: '再試一次',
  removeRequirement: '移除',
  removeRequirementNamed: (name) => `移除${name}`,
  removeRequirementTitle: (name) => `移除${name}？`,
  removeRequirementBody: (name, size) =>
    size
      ? `這會刪除${name}（${size}）。已經做好的文件和逐字稿會留在這台電腦，之後可以再安裝。`
      : `這會刪除${name}。已經做好的文件和逐字稿會留在這台電腦，之後可以再安裝。`,
  removeRequirementCancel: '取消',
  removingRequirement: '正在移除',
  removeBlockedInstalling: '這項功能正在安裝',
  removeBlockedCapture: '有辨識正在使用它',
  removeRequirementInUse: '安裝或辨識還在進行，請稍後再移除',
  removeRequirementNotUninstallable: '這項功能無法從這裡移除',
  removeRequirementNotFound: '找不到這項功能',
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
  engineColAction: '動作',
  requirementName: {
    'windowsml-ocr': '文字辨識',
    'speech-recognition': '錄音轉文字',
    'speaker-diarization': '說話者辨識',
    'vertical-japanese-reader': '直書日文',
  },
  requirementPurpose: {
    'windowsml-ocr': '讀出掃描檔與照片的文字',
    'speech-recognition': '台灣華語與中英夾雜語音轉逐字稿',
    'speaker-diarization': '標出每段話是誰說的',
    'vertical-japanese-reader': '讀出直排日文頁面',
  },
  requirementStatus: {
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
  ocrPagesLabel: '頁碼',
  ocrPagesPlaceholder: '1-5, 8, 10-12',
  ocrQueueTitle: '佇列',
  ocrQueueCount: (count) => `${count} 個檔案`,
  queueColFile: '檔名',
  queueColPages: '頁數',
  queueColStatus: '狀態',
  queueColAction: '動作',
  captureStatusWaiting: '等待中',
  captureStatusProcessing: '處理中',
  captureStatusDone: '完成',
  captureStatusNeedsAttention: '需要處理',
  captureStatusCancelled: '已取消',
  ocrNeedsRequirement: (size) => size ? `需要文字辨識（${size}）` : '需要文字辨識',
  ocrPageProgress: (done, total) => `第 ${done}/${total} 頁`,
  ocrProgressNamed: (name) => `${name} 的進度`,
  captureView: '檢視',
  ocrExportTxt: '匯出 .txt',
  captureRestart: '重新開始',
  captureInterrupted: '已中斷',
  ocrInterruptedHint: '上次關閉程式時尚未完成。',
  captureRetry: '重試',
  ocrPageSelectionInvalid: '頁碼格式不正確，請輸入例如 1-5, 8, 10-12（最多 500 頁）。',
  ocrInstallNamed: (name) => `安裝文字辨識以處理 ${name}`,
  captureCancelNamed: (name) => `取消 ${name}`,
  captureRetryNamed: (name) => `重試 ${name}`,
  captureRestartNamed: (name) => `重新開始 ${name}`,
  captureViewNamed: (name) => `檢視 ${name}`,
  ocrExportNamed: (name) => `匯出 ${name} 的文字`,
  asrSubtitle: '把錄音轉成有時間標記的逐字稿。錄音不會離開這台電腦。',
  asrInstallTitle: '先安裝語音辨識',
  asrInstallHint: '下載期間其他功能照常可用。',
  asrEmptyTitle: '還沒有錄音',
  asrEmptyHintInstall: '安裝完成後，拖曳錄音或影片到這裡，或按「選擇檔案」。',
  asrEmptyHintReady: '拖曳錄音或影片到這裡，或按「選擇檔案」。',
  asrDropSectionLabel: '加入錄音',
  asrDropHint: '拖曳錄音或影片到這裡',
  asrDropFormats: 'MP3、M4A、WAV、MP4 等，每個檔案最長 90 分鐘、最大 2 GiB',
  asrLanguageLabel: '語言',
  asrSpokenLanguage: { zh: '中文', en: '英文', ja: '日文' },
  asrSpeakersLabel: '分辨說話者',
  asrSpeakersNoPartialHint: '分辨說話者時，要整段完成才看得到逐字稿。',
  asrSpeakersOptionalTitle: '說話者辨識（選用）',
  asrInstallSpeakers: (size) => `安裝說話者辨識${size ? `（${size}）` : ''}`,
  asrInstallingSpeakers: (percent) => `正在安裝說話者辨識 ${percent}%`,
  asrPreparingSpeakers: '正在準備安裝說話者辨識…',
  asrFinishingSpeakers: '說話者辨識下載完成，正在安裝…',
  asrHeardOf: (heard, total) => `已聽到 ${heard}／${total}`,
  asrLiveProgressLabel: (fileName) => `${fileName} 的進度`,
  asrLivePartialNote: '灰色的是即時結果，整段完成後會再校正。',
  asrQueueSummary: (count) => `${count} 個檔案，依加入順序處理`,
  asrColDuration: '長度',
  asrSpeakerCount: (count) => `${count} 位說話者`,
  asrPlaybackUnsupported: '這種格式無法在這裡播放，逐字稿照常可看。',
  asrExport: '匯出',
  asrExportNamed: (name) => `匯出 ${name} 的逐字稿`,
  asrInstallNamed: (name) => `安裝語音辨識以處理 ${name}`,
  resultEdited: '已編輯',
  resultRestore: '還原',
  resultEditText: '編輯文字',
  resultSaving: '儲存中',
  resultSaved: '已儲存',
  resultSaveFailed: '儲存失敗',
  resultRetrySave: '重試',
  resultPageTooLong: '頁面文字不可超過 1 MiB。',
  resultLineTooLong: '逐字稿文字不可超過 64 KiB。',
  resultNameInvalid: '說話者名字不可超過 100 個字元或包含控制字元。',
  resultEditsUnreadable: '無法讀取先前的修正；儲存新的修正會取代它們。',
  resultBack: '返回',
  resultTitle: '檢視結果',
  resultNavigation: '結果檢視導覽',
  resultTabExport: '匯出',
  exportPlainText: '純文字 (.txt)',
  exportMarkdown: 'Markdown (.md)',
  exportSrt: '字幕 SRT (.srt)',
  exportVtt: '字幕 WebVTT (.vtt)',
  exportDownload: '下載',
  exportCopyNote: '複製純文字內容到剪貼簿',
  exportPlainTextDesc: '純文字，可貼到任何地方',
  exportRecordingPlainTextDesc: '每行含時間與說話者',
  exportMarkdownDesc: '含標題，適合筆記軟體',
  exportSrtDesc: '影片字幕，多數播放器可用',
  exportVttDesc: '網頁影片字幕',
  exportCopy: '複製全部',
  exportCopied: '已複製',
  exportDownloaded: '已匯出',
  exportInProgress: '匯出中…',
  exportFailed: '匯出失敗，請重試。',
  exportCopyFailed: '複製失敗，請重試。',
  exportPageLabel: '第 {page} 頁',
  resultTabContent: '內容',
  resultTabSpeakers: '說話者',
  resultTabDetails: '詳細資訊',
  resultLoading: '正在載入結果…',
  resultNotFound: '找不到這份文件。',
  resultNoResultYet: '目前還沒有可檢視的結果。',
  resultPdfPreviewFailed: '無法顯示這份 PDF 的頁面影像，仍可查看辨識文字。',
  resultPdfPageCanvasLabel: (page) => `第 ${page} 頁的頁面影像`,
  resultOcrEmpty: '沒有辨識到文字。',
  resultPageLabel: (page, total) => `${page} / ${total}`,
  resultSelectedPageLabel: (page, position, total) => `第 ${page} 頁（${position} / ${total}）`,
  resultPreviousPage: '上一頁',
  resultNextPage: '下一頁',
  resultColTime: '時間',
  resultColSpeaker: '說話者',
  resultColText: '文字',
  resultNoSpeakers: '這段錄音沒有標記說話者。',
  resultDetailFileName: '檔名',
  resultDetailMediaType: '類型',
  resultDetailSize: '大小',
  resultDetailStatus: '狀態',
  resultDetailCreatedAt: '建立時間',
  resultDetailUpdatedAt: '更新時間',
  settingsNavigation: '設定導覽',
  settingsSubtitle: '管理辨識引擎、運算裝置與應用程式偏好設定。',
  settingsComputeTitle: '運算裝置',
  settingsGeneralTitle: '一般',
  computeOcrTitle: '文字辨識',
  computeAsrTitle: '語音轉文字',
  computeOcrPending: '尚未偵測到文字辨識運算裝置。',
  computeOcrCpu: 'CPU',
  computeOcrGpuDetected: '偵測到可用的 GPU（DirectML）',
  computeAsrPending: '正在偵測語音運算裝置…',
  computeAsrCudaDetected: '偵測到 CUDA GPU',
  computeAsrCpuOnly: 'CPU（未偵測到可用的 CUDA 驅動程式）',
  computeSaving: '正在儲存並重新啟動運算服務…',
  computeBusyHint: '安裝或辨識進行中，暫時無法變更此設定。',
  settingsDiagnosticsTitle: '診斷',
  diagnosticsRuntimeTitle: '執行環境',
  diagnosticsRuntimeError: '發生錯誤',
  diagnosticsRuntimeVersion: 'Runtime 版本',
  diagnosticsApiVersion: 'API 版本',
  diagnosticsContractSetVersion: '合約集版本',
  diagnosticsContractDigest: '合約雜湊',
  diagnosticsModelTitle: 'Ollama 模型',
  diagnosticsModelPurpose: '用於結構化辨識結果；目前主要功能尚未直接使用此設定。',
  diagnosticsDocumentTitle: '文件',
  diagnosticsDocumentLoadError: '無法載入文件診斷資訊。',
  diagnosticsExtractionProvenance: '辨識出處',
  diagnosticsStructuringProvenance: '結構化出處',
  diagnosticsProvenanceEngine: '引擎',
  diagnosticsProvenanceModel: '模型',
  diagnosticsProvenanceDevice: '裝置',
  diagnosticsProvenanceDigest: '雜湊',
  diagnosticsCopy: '複製',
  diagnosticsCopyDigestNamed: (name) => `複製${name}`,
  diagnosticsEvidenceTitle: 'OCR 證據摘要',
  diagnosticsExportFailed: '匯出 JSON 失敗，請重試。',
  diagnosticsBackToResult: '返回詳細資訊',
  resultDetailDiagnostics: '診斷資訊',
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
  historyType: 'Type',
  historyKindOcr: 'Document',
  historyRecording: 'Recording',
  historyExtent: 'Length / pages',
  historyUpdated: 'Updated',
  historySubtitle: 'All imported documents and recordings, sorted by most recently updated.',
  historyCount: (count) => `${count} ${count === 1 ? 'item' : 'items'}`,
  historyNoMatches: 'No records match the filters.',
  historyDeleteFailed: 'Could not delete the document. Please try again later.',
  historyDeleteNamed: (name) => `Delete ${name}`,
  statusDiagnosticsLabel: 'Diagnostics',
  language: 'Language',
  queue: 'Queue',
  searchDocuments: 'Search documents',
  searchPlaceholder: 'Search file names',
  statusFilter: 'Status',
  all: 'All',
  ready: 'Ready',
  notReady: 'Not ready',
  mainNavigation: 'Main',
  nav: { ocr: 'Document to text', asr: 'Recording to transcript', history: 'History', settings: 'Settings' },
  noModel: 'No model selected',
  needsSetup: 'Required components must be downloaded before processing.',
  model: 'Model',
  downloadingModel: 'Downloading model…',
  agreeAndDownloadModel: 'Agree and download model',
  modelSeparate: 'The model is downloaded separately.',
  modelProgress: 'Model download progress',
  downloading: (name) => `Downloading ${name}.`,
  reconnect: 'Try again',
  chooseFiles: 'Choose files',
  noDocuments: 'No documents yet.',
  exportJson: 'Export JSON',
  delete: 'Delete',
  gpuAcceleration: 'GPU acceleration on',
  cpuNotice: 'No GPU available. Text recognition will be slower.',
  starting: 'Starting…',
  startTimeout: (detail) => `Start-up timed out: ${detail}`,
  canceled: 'Processing was canceled.',
  desktopOnly: 'Capture Workbench runs only in the Windows desktop app.',
  speechUnitNeeded: 'Recordings need Taiwan speech-to-text (TEA-ASR 1.1) downloaded first.',
  speakerUnitNeeded: 'Telling speakers apart needs one more component installed.',
  offerInstall: 'Install',
  requirementReady: 'Installed',
  requirementUnavailable: 'Not downloadable',
  guideDetails: 'Details',
  guideSummary: 'What it does',
  guideLanguages: 'Languages',
  guideHardware: 'Hardware',
  guideLicense: 'License',
  useGpuForSpeech: 'Use the GPU for speech recognition',
  speakerName: "This speaker's name",
  noSample: 'No sample to play',
  largeRecordingPlaybackUnavailable: 'Playback of large recordings is not available yet. The transcript is still shown.',
  playFrom: (time) => `Play from ${time}`,
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
  installProgressPreparing: 'Preparing installation…',
  installProgressInstalling: 'Download complete, installing…',
  cancel: 'Cancel',
  cancelInstall: 'Cancel',
  retryInstall: 'Try again',
  removeRequirement: 'Remove',
  removeRequirementNamed: (name) => `Remove ${name}`,
  removeRequirementTitle: (name) => `Remove ${name}?`,
  removeRequirementBody: (name, size) =>
    size
      ? `This deletes ${name} (${size}). Documents and transcripts already saved stay on this computer, and you can install it again later.`
      : `This deletes ${name}. Documents and transcripts already saved stay on this computer, and you can install it again later.`,
  removeRequirementCancel: 'Cancel',
  removingRequirement: 'Removing',
  removeBlockedInstalling: 'This feature is installing',
  removeBlockedCapture: 'A recognition is using it',
  removeRequirementInUse:
    'An installation or recognition is still running. Try again when it finishes.',
  removeRequirementNotUninstallable: 'This feature cannot be removed from here.',
  removeRequirementNotFound: 'This feature was not found.',
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
  engineColAction: 'Action',
  requirementName: {
    'windowsml-ocr': 'Text recognition',
    'speech-recognition': 'Speech to text',
    'speaker-diarization': 'Speaker identification',
    'vertical-japanese-reader': 'Vertical Japanese',
  },
  requirementPurpose: {
    'windowsml-ocr': 'Read text from scans and photos',
    'speech-recognition':
      'Taiwan Mandarin and mixed Mandarin-English speech to transcript',
    'speaker-diarization': 'Mark who said each segment',
    'vertical-japanese-reader': 'Read vertical Japanese pages',
  },
  requirementStatus: {
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
  ocrPagesLabel: 'Pages',
  ocrPagesPlaceholder: '1-5, 8, 10-12',
  ocrQueueTitle: 'Queue',
  ocrQueueCount: (count) => `${count} file${count === 1 ? '' : 's'}`,
  queueColFile: 'File',
  queueColPages: 'Pages',
  queueColStatus: 'Status',
  queueColAction: 'Action',
  captureStatusWaiting: 'Waiting',
  captureStatusProcessing: 'Processing',
  captureStatusDone: 'Done',
  captureStatusNeedsAttention: 'Needs attention',
  captureStatusCancelled: 'Canceled',
  ocrNeedsRequirement: (size) => size ? `Text recognition is required (${size})` : 'Text recognition is required',
  ocrPageProgress: (done, total) => `Page ${done}/${total}`,
  ocrProgressNamed: (name) => `Progress for ${name}`,
  captureView: 'View',
  ocrExportTxt: 'Export .txt',
  captureRestart: 'Start again',
  captureInterrupted: 'Interrupted',
  ocrInterruptedHint: 'Not finished before the app was last closed.',
  captureRetry: 'Retry',
  ocrPageSelectionInvalid: 'Invalid page selection. Enter pages such as 1-5, 8, 10-12 (up to 500 pages).',
  ocrInstallNamed: (name) => `Install text recognition for ${name}`,
  captureCancelNamed: (name) => `Cancel ${name}`,
  captureRetryNamed: (name) => `Retry ${name}`,
  captureRestartNamed: (name) => `Start ${name} again`,
  captureViewNamed: (name) => `View ${name}`,
  ocrExportNamed: (name) => `Export text for ${name}`,
  asrSubtitle: 'Turn recordings into timed transcripts. Audio stays on this computer.',
  asrInstallTitle: 'Install speech recognition first',
  asrInstallHint: 'Other features stay usable during the download.',
  asrEmptyTitle: 'No recordings yet',
  asrEmptyHintInstall: 'Once installed, drag recordings or videos here or click Choose files.',
  asrEmptyHintReady: 'Drag recordings or videos here or click Choose files.',
  asrDropSectionLabel: 'Add recordings',
  asrDropHint: 'Drag recordings or videos here',
  asrDropFormats: 'MP3, M4A, WAV, MP4 and more — up to 90 minutes and 2 GiB per file',
  asrLanguageLabel: 'Language',
  asrSpokenLanguage: { zh: 'Chinese', en: 'English', ja: 'Japanese' },
  asrSpeakersLabel: 'Identify speakers',
  asrSpeakersNoPartialHint: 'When identifying speakers, the transcript appears once the full recording finishes.',
  asrSpeakersOptionalTitle: 'Speaker identification (optional)',
  asrInstallSpeakers: (size) => `Install speaker identification${size ? ` (${size})` : ''}`,
  asrInstallingSpeakers: (percent) => `Installing speaker identification ${percent}%`,
  asrPreparingSpeakers: 'Preparing speaker identification…',
  asrFinishingSpeakers: 'Speaker identification downloaded, installing…',
  asrHeardOf: (heard, total) => `Heard ${heard} / ${total}`,
  asrLiveProgressLabel: (fileName) => `Progress for ${fileName}`,
  asrLivePartialNote: 'Gray lines are live previews and will be refined once finished.',
  asrQueueSummary: (count) =>
    `${count} ${count === 1 ? 'file' : 'files'}, processed in import order`,
  asrColDuration: 'Duration',
  asrSpeakerCount: (count) => (count === 1 ? '1 speaker' : `${count} speakers`),
  asrPlaybackUnsupported: 'This recording cannot be played here; the transcript is still readable.',
  asrExport: 'Export',
  asrExportNamed: (name) => `Export transcript for ${name}`,
  asrInstallNamed: (name) => `Install speech recognition for ${name}`,
  resultEdited: 'Edited',
  resultRestore: 'Restore',
  resultEditText: 'Edit text',
  resultSaving: 'Saving',
  resultSaved: 'Saved',
  resultSaveFailed: 'Save failed',
  resultRetrySave: 'Retry',
  resultPageTooLong: 'Page text must not exceed 1 MiB.',
  resultLineTooLong: 'Line text must not exceed 64 KiB.',
  resultNameInvalid: 'Speaker names must not exceed 100 characters or contain control characters.',
  resultEditsUnreadable: 'Earlier corrections could not be read. Saving new corrections replaces them.',
  resultBack: 'Back',
  resultTitle: 'Result',
  resultNavigation: 'Result sections',
  resultTabExport: 'Export',
  exportPlainText: 'Plain text (.txt)',
  exportMarkdown: 'Markdown (.md)',
  exportSrt: 'Subtitles SRT (.srt)',
  exportVtt: 'Subtitles WebVTT (.vtt)',
  exportDownload: 'Download',
  exportCopyNote: 'Copies plain-text content to clipboard',
  exportPlainTextDesc: 'Plain text you can paste anywhere',
  exportRecordingPlainTextDesc: 'Each line includes timestamp and speaker',
  exportMarkdownDesc: 'With headings, suited for note-taking apps',
  exportSrtDesc: 'Video subtitles supported by most players',
  exportVttDesc: 'Subtitles for web video players',
  exportCopy: 'Copy all',
  exportCopied: 'Copied',
  exportDownloaded: 'Exported',
  exportInProgress: 'Exporting…',
  exportFailed: 'Export failed. Please try again.',
  exportCopyFailed: 'Copy failed. Please try again.',
  exportPageLabel: 'Page {page}',
  resultTabContent: 'Content',
  resultTabSpeakers: 'Speakers',
  resultTabDetails: 'Details',
  resultLoading: 'Loading result…',
  resultNotFound: 'Document not found.',
  resultNoResultYet: 'No result is available to review yet.',
  resultPdfPreviewFailed: 'Unable to display this PDF page image. The recognized text is still available.',
  resultPdfPageCanvasLabel: (page) => `Image of page ${page}`,
  resultOcrEmpty: 'No recognized text.',
  resultPageLabel: (page, total) => `${page} / ${total}`,
  resultSelectedPageLabel: (page, position, total) => `Page ${page} (${position} of ${total})`,
  resultPreviousPage: 'Previous page',
  resultNextPage: 'Next page',
  resultColTime: 'Time',
  resultColSpeaker: 'Speaker',
  resultColText: 'Text',
  resultNoSpeakers: 'No speakers were identified in this recording.',
  resultDetailFileName: 'File name',
  resultDetailMediaType: 'Type',
  resultDetailSize: 'Size',
  resultDetailStatus: 'Status',
  resultDetailCreatedAt: 'Created',
  resultDetailUpdatedAt: 'Updated',
  settingsNavigation: 'Settings navigation',
  settingsSubtitle: 'Manage recognition engines, compute devices, and application preferences.',
  settingsComputeTitle: 'Compute',
  settingsGeneralTitle: 'General',
  computeOcrTitle: 'Text recognition',
  computeAsrTitle: 'Speech to text',
  computeOcrPending: 'Text recognition compute device has not been detected yet.',
  computeOcrCpu: 'CPU',
  computeOcrGpuDetected: 'A compatible GPU was detected (DirectML)',
  computeAsrPending: 'Detecting speech compute device…',
  computeAsrCudaDetected: 'CUDA GPU detected',
  computeAsrCpuOnly: 'CPU (no CUDA driver detected)',
  computeSaving: 'Saving and restarting the compute service…',
  computeBusyHint: 'Cannot change this while an installation or recognition is running.',
  settingsDiagnosticsTitle: 'Diagnostics',
  diagnosticsRuntimeTitle: 'Runtime',
  diagnosticsRuntimeError: 'Error',
  diagnosticsRuntimeVersion: 'Runtime version',
  diagnosticsApiVersion: 'API version',
  diagnosticsContractSetVersion: 'Contract set version',
  diagnosticsContractDigest: 'Contract digest',
  diagnosticsModelTitle: 'Ollama model',
  diagnosticsModelPurpose: 'Used for structuring recognized results; main views do not use it directly yet.',
  diagnosticsDocumentTitle: 'Document',
  diagnosticsDocumentLoadError: 'Unable to load document diagnostics.',
  diagnosticsExtractionProvenance: 'Extraction provenance',
  diagnosticsStructuringProvenance: 'Structuring provenance',
  diagnosticsProvenanceEngine: 'Engine',
  diagnosticsProvenanceModel: 'Model',
  diagnosticsProvenanceDevice: 'Device',
  diagnosticsProvenanceDigest: 'Digest',
  diagnosticsCopy: 'Copy',
  diagnosticsCopyDigestNamed: (name) => `Copy ${name}`,
  diagnosticsEvidenceTitle: 'OCR evidence summary',
  diagnosticsExportFailed: 'Failed to export JSON. Please try again.',
  diagnosticsBackToResult: 'Back to details',
  resultDetailDiagnostics: 'Diagnostics',
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

export function desktopLanguageName(locale: DesktopLocale): string {
  return DESKTOP_MESSAGES[locale].languageName;
}

/** Switches the language and remembers the choice on this computer. */
export function setDesktopLocale(locale: DesktopLocale): void {
  desktopLocale.set(locale);
  try {
    globalThis.localStorage?.setItem(DESKTOP_LOCALE_STORAGE_KEY, locale);
  } catch {
    // The choice still applies for this session when storage is unavailable.
  }
}
