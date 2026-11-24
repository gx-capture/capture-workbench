import {
  fakeRequirement,
  type FakeDesktopConfig,
  type FakeDesktopOptions,
} from './fake-desktop.ts';

export interface PreviewScenario {
  readonly label: string;
  readonly description: string;
  readonly requirements: readonly Record<string, unknown>[];
  readonly options: FakeDesktopOptions;
}

export const DEFAULT_PREVIEW_SCENARIO = 'ready';

const DEFAULT_INSTALL_TIMELINE = {
  startResponseMs: 500,
  preparingMs: 2000,
  downloadMs: 20000,
  installingMs: 6000,
};

function scenarioRequirements(status: string): readonly Record<string, unknown>[] {
  return [
    fakeRequirement('text-recognition', 'Text recognition', status, 296_000_000),
    fakeRequirement('speech-recognition', '本機語音轉文字', status, 10_500_000_000),
    fakeRequirement('speaker-diarization', '說話者辨識', status, 714_000_000),
  ];
}

export const PREVIEW_SCENARIOS: Readonly<Record<string, PreviewScenario>> = {
  ready: {
    label: '已就緒（預設）',
    description: '三個辨識功能皆已安裝，具備 CUDA GPU、範例紀錄與編輯結果，可直接檢視完整操作流程。',
    requirements: scenarioRequirements('ready'),
    options: {
      cudaAvailable: true,
      editedResults: true,
      persistLibrary: true,
      ocrJourney: true,
      installTimeline: DEFAULT_INSTALL_TIMELINE,
    },
  },
  'first-run': {
    label: '首次啟動（尚未安裝）',
    description: '三個辨識功能皆尚未安裝，可檢視首次安裝卡片與模擬準備、下載、安裝階段進度。',
    requirements: scenarioRequirements('installable'),
    options: {
      cudaAvailable: true,
      persistLibrary: true,
      ocrJourney: true,
      installTimeline: DEFAULT_INSTALL_TIMELINE,
    },
  },
  'live-transcript': {
    label: '轉錄進行中（逐步顯示逐字稿）',
    description: '語音轉文字已安裝。在錄音轉逐字稿選擇檔案後，模擬執行環境依自己的時間軸分三句逐步發布逐字稿，然後經過等待結構化、結構化並完成；查詢時若還沒有新事件，回覆為空，畫面保留已發布的句子。模擬執行環境在開始後 startDelay 發布第一句，其後每隔安裝準備階段的時間（受 speed 縮放）發布一句，畫面在下一次查詢後顯示。',
    requirements: scenarioRequirements('ready'),
    options: {
      cudaAvailable: true,
      persistLibrary: true,
      ocrJourney: true,
      recordingJourney: true,
      installTimeline: DEFAULT_INSTALL_TIMELINE,
    },
  },
  'earlier-run': {
    label: '上次執行留下的檔案（已中斷）',
    description: '三個辨識功能皆已安裝。文件轉文字的佇列裡有上次執行留下的檔案：一份停在處理中並保有執行環境連結（已中斷，可重新開始）、一份先前版本以等待中保留了文字（已中斷，只能檢視）、一份先前版本清除失敗的失敗紀錄（需要處理，可重新開始）。啟動時 Workbench 請執行環境刪除這些連結的擷取。',
    requirements: scenarioRequirements('ready'),
    options: {
      cudaAvailable: true,
      persistLibrary: true,
      ocrJourney: true,
      earlierRunRows: true,
      installTimeline: DEFAULT_INSTALL_TIMELINE,
    },
  },
  'no-gpu': {
    label: '無 NVIDIA GPU',
    description: '三個辨識功能皆已安裝，但模擬沒有 CUDA GPU 的電腦環境，可供檢視 CPU 運算狀態。',
    requirements: scenarioRequirements('ready'),
    options: {
      cudaAvailable: false,
      editedResults: true,
      persistLibrary: true,
      ocrJourney: true,
      installTimeline: DEFAULT_INSTALL_TIMELINE,
    },
  },
  'install-status-recovers': {
    label: '安裝進度暫時查不到（重試後恢復）',
    description: '三個辨識功能尚未安裝；每筆辨識功能或模型安裝的進度查詢先失敗兩次，進度卡保留進度並提示持續重試，恢復後提示消失。',
    requirements: scenarioRequirements('installable'),
    options: {
      cudaAvailable: true,
      persistLibrary: true,
      ocrJourney: true,
      installTimeline: DEFAULT_INSTALL_TIMELINE,
      failInstallStatusChecks: 2,
    },
  },
  'install-status-unavailable': {
    label: '安裝進度長時間查不到（持續重試）',
    description: '三個辨識功能尚未安裝；每筆安裝的進度查詢連續失敗約兩分半鐘，期間進度卡保留最後進度並提示持續重試，之後恢復。',
    requirements: scenarioRequirements('installable'),
    options: {
      cudaAvailable: true,
      persistLibrary: true,
      ocrJourney: true,
      installTimeline: DEFAULT_INSTALL_TIMELINE,
      failInstallStatusChecks: 20,
    },
  },
  'install-status-not-found': {
    label: '安裝進度查無此安裝（自清單接回）',
    description: '三個辨識功能尚未安裝；每筆安裝的第一次進度查詢回覆查無此安裝，辨識功能自安裝清單接回並完成，模型安裝則移除進度並重新載入選項。',
    requirements: scenarioRequirements('installable'),
    options: {
      cudaAvailable: true,
      persistLibrary: true,
      ocrJourney: true,
      installTimeline: DEFAULT_INSTALL_TIMELINE,
      answerInstallStatusNotFoundOnce: true,
    },
  },
  'install-status-not-found-slow-listing': {
    label: '安裝進度查無此安裝（清單回覆緩慢）',
    description: '三個辨識功能尚未安裝；每筆安裝的第一次進度查詢回覆查無此安裝，之後的安裝清單要 15 秒才回覆，可在接回期間取消安裝。',
    requirements: scenarioRequirements('installable'),
    options: {
      cudaAvailable: true,
      persistLibrary: true,
      ocrJourney: true,
      installTimeline: DEFAULT_INSTALL_TIMELINE,
      answerInstallStatusNotFoundOnce: true,
      slowListingAfterNotFoundMs: 15_000,
    },
  },
};

export function previewScenarioConfig(
  name: string,
  speed: number,
  runtimeVersion: string,
  pdfFixtureBase64: string,
  startDelayMs?: number,
): FakeDesktopConfig {
  const scenario = PREVIEW_SCENARIOS[name];
  if (!scenario) {
    throw new Error(`Unknown preview scenario: ${name}`);
  }
  const baseTimeline = scenario.options.installTimeline ?? DEFAULT_INSTALL_TIMELINE;
  // startResponseMs simulates fixed IPC/runtime startup latency rather than phase
  // duration, so it is not scaled by `speed` (an explicit startDelayMs overrides it).
  const startResponseMs = startDelayMs ?? baseTimeline.startResponseMs ?? 0;
  return {
    runtimeRequirements: scenario.requirements,
    runtimeVersion,
    installOptions: {
      ...scenario.options,
      installTimeline: {
        startResponseMs,
        preparingMs: Math.max(1, Math.round(baseTimeline.preparingMs / speed)),
        downloadMs: Math.max(1, Math.round(baseTimeline.downloadMs / speed)),
        installingMs: Math.max(1, Math.round(baseTimeline.installingMs / speed)),
      },
    },
    pdfFixtureBase64,
  };
}
