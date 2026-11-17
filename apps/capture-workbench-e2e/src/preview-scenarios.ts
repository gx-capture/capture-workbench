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
    fakeRequirement('windowsml-ocr', 'WindowsML OCR', status, 144_000_000),
    fakeRequirement('speech-recognition', '本機語音轉文字', status, 2_800_000_000),
    fakeRequirement('speaker-diarization', '說話者辨識', status, 300_000_000),
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
