import type { CaptureWorkbenchLocale } from './messages';

/**
 * What a user should know about an optional unit before downloading it: what
 * the model does, which languages it suits, the hardware it runs on, what the
 * download contains and its license. The byte size is not here; hosts format
 * the runtime requirement's `downloadBytes`.
 */
export interface CaptureUnitGuide {
  readonly name: string;
  readonly summary: string;
  readonly languages: string;
  readonly hardware: string;
  readonly download: string;
  readonly license: string;
}

// The facts other than download size follow the pinned model cards in the
// release model-source lock (TEA-ASR-1.1 bda08df, TEA-ASR-1.1-mini 98c5804,
// Nemotron-3-Diarization f667ed7) and the 0.8.0 worker archives; update them
// with the lock. Sizes come from the runtime's downloadBytes.
const ZH_TW: Readonly<Record<string, CaptureUnitGuide>> = {
  'speech-recognition': {
    name: '台灣語音轉文字（TEA-ASR 1.1）',
    summary:
      '專為台灣華語調校的語音辨識模型，直接寫出繁體中文與台灣慣用詞；中英夾雜時保留英文原文，不會翻成中文。逐字稿附每句的時間點。',
    languages:
      '適用：台灣華語，以及華語夾雜英語的日常對話、會議與課堂錄音。日語、英語等其他語言需由主程式指定語言，但模型未針對它們調校；台語、客語不在訓練範圍內。',
    hardware:
      '有 NVIDIA GPU 時在 GPU 上執行 TEA-ASR 1.1（約 20 億參數）；沒有 GPU 時在 CPU 上執行同一個模型，速度明顯較慢。',
    download: '兩種大小的辨識模型、對齊時間點的 Qwen3 模型與 GPU 執行環境。',
    license:
      'TEA-ASR 採 MIT 授權，基礎模型 Qwen3-ASR 採 Apache-2.0。全程在這台電腦上執行，錄音不會上傳。',
  },
  'speaker-diarization': {
    name: '說話者辨識（NVIDIA Nemotron 3 Diarization）',
    summary:
      '標出每段話是哪一位說的，一段錄音最多分出 8 位說話者。結果先以匿名代號呈現並附一段試聽，由您填上名字。',
    languages:
      '依聲音特徵分辨，不看內容，以華語與英語錄音訓練。需搭配台灣語音轉文字一起使用。',
    hardware: '在 CPU 上執行，不需要 GPU。',
    download: '說話者辨識模型與 CPU 執行環境。',
    license: '模型採 OpenMDW-1.1 授權。全程在這台電腦上執行，錄音不會上傳。',
  },
};

const EN: Readonly<Record<string, CaptureUnitGuide>> = {
  'speech-recognition': {
    name: 'Taiwan speech-to-text (TEA-ASR 1.1)',
    summary:
      'A speech recognition model tuned for Taiwan Mandarin. It writes Traditional Chinese with Taiwan vocabulary, keeps English words in mixed Mandarin–English speech instead of translating them, and times every sentence.',
    languages:
      'Suited to Taiwan Mandarin, including everyday conversation, meetings and lectures that mix in English. Other languages such as Japanese or English can be requested by the host app, but the model is not tuned for them; Taiwanese Hokkien and Hakka are outside its training.',
    hardware:
      'With an NVIDIA GPU it runs TEA-ASR 1.1 (about 2 billion parameters) on the GPU; without one it runs the same model on the CPU, which is much slower.',
    download:
      'Recognition models in two sizes, a Qwen3 model that aligns the times, and the GPU runtime.',
    license:
      'TEA-ASR is MIT-licensed; its base model Qwen3-ASR is Apache-2.0. Everything runs on this computer; recordings are never uploaded.',
  },
  'speaker-diarization': {
    name: 'Speaker identification (NVIDIA Nemotron 3 Diarization)',
    summary:
      'Marks who said each part, telling up to 8 speakers apart in one recording. Speakers first appear as anonymous labels with a sample to play, and you type their names.',
    languages:
      'It tells voices apart without reading the words and was trained on Mandarin and English recordings. It works together with Taiwan speech-to-text.',
    hardware: 'Runs on the CPU; no GPU needed.',
    download: 'The speaker-identification model and the CPU runtime.',
    license:
      'The model is under the OpenMDW-1.1 license. Everything runs on this computer; recordings are never uploaded.',
  },
};

/** Model guides for optional units, by locale and requirement id. */
export const CAPTURE_UNIT_GUIDES: Readonly<
  Record<CaptureWorkbenchLocale, Readonly<Record<string, CaptureUnitGuide | undefined>>>
> = { 'zh-TW': ZH_TW, en: EN };
