import type {
  CaptureBlockV1,
  CaptureEngineV1,
  RawCaptureSegmentV1,
  RawCaptureV1,
} from '@gx-capture/capture-contracts';

/** JSON Schema object supplied to an LLM generation provider. */
export type StructuringSchema = Readonly<Record<string, unknown>>;

/** JSON response accepted from a host-owned LLM callback. */
export type StructuringCandidate = Uint8Array | string;

/** Prompt payload sent to the host-owned LLM generation callback. */
export type StructuringBatchPrompt = Readonly<{
  /** Human-readable instruction for the bounded semantic task. */
  instruction: string;
  /** Optional target language, or `null` for identity structuring. */
  targetLanguage: string | null;
  /** Bounded raw segment payloads made available to the model. */
  rawSegments: readonly Readonly<Record<string, unknown>>[];
}>;

/** The minimal semantic fields that may cross the untrusted LLM boundary. */
export type CaptureSemanticBlockV1 = Readonly<{
  /** Stable identifier binding the semantic result to one raw segment. */
  sourceSegmentId: string;
  /** Semantic block classification selected by the model. */
  type: CaptureBlockV1['type'];
  /** Translated text; omitted for identity structuring. */
  targetText?: string;
}>;

/** Host callback used by the brain-agnostic SDK to obtain one JSON candidate. */
export type LlmGenerate = (
  prompt: StructuringBatchPrompt,
  schema: StructuringSchema,
) => StructuringCandidate | PromiseLike<StructuringCandidate>;

/** Error raised when an LLM candidate cannot be safely projected. */
export class StructuringValidationError extends Error {
  /** Machine-readable validation issue details, when available. */
  readonly issues: readonly Readonly<Record<string, unknown>>[];

  /**
   * Creates a structuring validation error.
   *
   * @param message Human-readable failure description.
   * @param issues Optional locations and details for the failure.
   */
  constructor(
    message: string,
    issues: readonly Readonly<Record<string, unknown>>[] = [],
  ) {
    super(message);
    this.name = 'StructuringValidationError';
    this.issues = issues;
  }
}

/** Token-budget accounting for one host LLM request. */
export interface StructuringBatchPlan {
  /** Raw segments included in this request, in source order. */
  readonly segments: readonly RawCaptureSegmentV1[];
  /** Estimated input token count including fixed prompt/schema overhead. */
  readonly inputTokens: number;
  /** Estimated output token count including fixed response overhead. */
  readonly outputTokens: number;
}

/** Inputs required to structure one raw capture through a host-owned LLM. */
export interface StructureCaptureOptions {
  /** Canonical raw capture whose provenance must be preserved. */
  readonly raw: RawCaptureV1;
  /** Host callback that performs the actual LLM generation. */
  readonly llmGenerate: LlmGenerate;
  /** Trusted identity of the engine that produced the structured result. */
  readonly structuringEngine: CaptureEngineV1;
  /**
   * Optional semantic response schema. Defaults to the canonical Capture
   * schema; Ollama hosts may pass an Ollama-compatible schema explicitly.
   */
  readonly schema?: StructuringSchema;
  /** Optional translation target; omission selects identity structuring. */
  readonly targetLanguage?: string;
  /** Trusted completion timestamp assigned by the host. */
  readonly completedAt: string;
  /** Optional maximum context budget for each request. */
  readonly numCtx?: number;
  /** Optional maximum generation budget for each request. */
  readonly numPredict?: number;
}
