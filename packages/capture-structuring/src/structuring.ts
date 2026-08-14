import type {
  CaptureBlock,
  CaptureDocument,
  CaptureEngine,
  RawCaptureSegment,
  RawCapture,
} from '@gx-capture/capture-runtime-client';
import {
  CAPTURE_DOCUMENT_SCHEMA,
  CAPTURE_DOCUMENT_SCHEMA_VERSION,
} from '@gx-capture/capture-runtime-client';
import Ajv2020, {
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  CAPTURE_BLOCK_TYPES,
  CONTEXT_RESERVE_TOKENS,
  DEFAULT_STRUCTURING_NUM_CTX,
  DEFAULT_STRUCTURING_NUM_PREDICT,
  ESTIMATED_BYTES_PER_TOKEN,
  IDENTITY_TEXT_PREVIEW_CHARACTERS,
  MIN_REQUEST_TOKENS,
  OLLAMA_CAPTURE_BLOCK_BATCH_SCHEMA,
  OLLAMA_IDENTITY_BLOCK_BATCH_SCHEMA,
  OUTPUT_RESERVE_TOKENS,
  structuringBatchSchema,
} from './constants.js';
import type {
  CaptureSemanticBlock,
  StructuringBatchPlan,
  StructuringBatchPrompt,
  StructuringSchema,
  StructureCaptureOptions,
} from './contracts.js';
import { StructuringValidationError } from './contracts.js';

/**
 * Selects the provider response schema for identity or translated structuring.
 *
 * @param targetLanguage Translation language, or `undefined` for identity mode.
 * @returns The grammar-compatible schema for the requested operation.
 */
export function ollamaStructuringBatchSchema(
  targetLanguage: string | undefined,
): StructuringSchema {
  return targetLanguage === undefined
    ? OLLAMA_IDENTITY_BLOCK_BATCH_SCHEMA
    : OLLAMA_CAPTURE_BLOCK_BATCH_SCHEMA;
}

/**
 * Narrows an unknown value to a non-array object record.
 *
 * @param value Value to inspect.
 * @returns Whether the value is a record suitable for property access.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Compiles the generated CaptureDocument schema once for SDK-local checks.
 *
 * @returns A reusable JSON Schema validator.
 */
function createDocumentSchemaValidator(): ValidateFunction {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
  });
  addFormats(ajv);
  return ajv.compile(CAPTURE_DOCUMENT_SCHEMA as unknown as AnySchema);
}

const documentSchemaValidator = createDocumentSchemaValidator();

/**
 * Converts Ajv's JSON Pointer path into the SDK issue shape.
 *
 * @param errors JSON Schema validation errors returned by Ajv.
 * @returns Machine-readable validation locations and messages.
 */
function schemaErrorIssues(
  errors: ErrorObject[] | null,
): readonly Readonly<Record<string, unknown>>[] {
  return (errors ?? []).map((error) => {
    const location = error.instancePath
      .split('/')
      .filter(Boolean)
      .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    const params = error.params as Record<string, unknown>;
    if (error.keyword === 'required' && typeof params['missingProperty'] === 'string') {
      location.push(params['missingProperty']);
    }
    return {
      location,
      message: error.message ?? 'schema validation failed',
      keyword: error.keyword,
    };
  });
}

/**
 * Validates a complete candidate against the generated document schema.
 *
 * @param document Decoded candidate object at the trust boundary.
 * @throws {@link StructuringValidationError} when schema validation fails.
 */
function validateDocumentSchema(document: Record<string, unknown>): void {
  if (!documentSchemaValidator(document)) {
    throw new StructuringValidationError(
      'structuring output does not satisfy CaptureDocument',
      schemaErrorIssues(documentSchemaValidator.errors),
    );
  }
}

/**
 * Estimates JSON token usage from UTF-8 byte length.
 *
 * @param value Value that will be serialized as JSON.
 * @returns Conservative token estimate with a minimum of one token.
 */
function jsonTokens(value: unknown): number {
  return Math.max(
    1,
    Math.ceil(new TextEncoder().encode(JSON.stringify(value)).byteLength / ESTIMATED_BYTES_PER_TOKEN),
  );
}

/**
 * Estimates text token usage from UTF-8 byte length.
 *
 * @param value Text that will be sent to or returned by the provider.
 * @returns Conservative token estimate with a minimum of one token.
 */
function textTokens(value: string): number {
  return Math.max(
    1,
    Math.ceil(new TextEncoder().encode(value).byteLength / ESTIMATED_BYTES_PER_TOKEN),
  );
}

/**
 * Projects one raw segment into the bounded model prompt.
 *
 * Identity mode receives only a short preview so the model cannot echo full
 * source text; translation mode needs the complete segment for translation.
 *
 * @param segment Raw segment to project.
 * @param targetLanguage Translation language, or `undefined` for identity mode.
 * @returns The model-visible segment payload.
 */
function promptSegment(
  segment: RawCaptureSegment,
  targetLanguage: string | undefined,
): Readonly<Record<string, unknown>> {
  if (targetLanguage === undefined) {
    return {
      sourceSegmentId: segment.segmentId,
      textPreview: segment.text.slice(0, IDENTITY_TEXT_PREVIEW_CHARACTERS),
    };
  }
  return { ...segment };
}

/**
 * Builds one bounded semantic instruction payload for the host LLM.
 *
 * The prompt explicitly excludes trusted provenance fields. The SDK rebuilds
 * those fields after validating the model-owned semantic response.
 *
 * @param segments Raw segments assigned to one batch.
 * @param targetLanguage Translation language, or `undefined` for identity mode.
 * @returns Prompt and bounded raw segment payload for the host callback.
 */
export function buildStructuringBatchPrompt(
  segments: readonly RawCaptureSegment[],
  targetLanguage?: string,
): StructuringBatchPrompt {
  const instruction =
    targetLanguage === undefined
      ? 'Return exactly one CaptureIdentityBlockBatch JSON object with one block for every raw segment. Preserve sourceSegmentId and choose the semantic type. Do not emit targetText, sourceText, locators, block IDs, or any provenance; the SDK projects trusted source text for targetText. Do not add markdown or hidden reasoning.'
      : 'Return exactly one CaptureBlockBatch JSON object with one block for every raw segment. Preserve sourceSegmentId and choose the semantic type. Translate only targetText to targetLanguage. Do not emit sourceText, locators, block IDs, or any provenance. Do not add markdown or hidden reasoning.';
  return {
    instruction,
    targetLanguage: targetLanguage ?? null,
    rawSegments: segments.map((segment) =>
      promptSegment(segment, targetLanguage),
    ),
  };
}

/**
 * Plans conservative token-bounded batches in raw segment order.
 *
 * @param segments Raw segments to partition into provider requests.
 * @param options Optional target language and provider token budgets.
 * @returns Batch plans with input/output token estimates.
 * @throws {@link StructuringValidationError} when one segment cannot fit.
 * @throws {Error} when the configured budgets are internally inconsistent.
 */
export function planStructuringBatches(
  segments: readonly RawCaptureSegment[],
  options: {
    readonly targetLanguage?: string;
    readonly numCtx?: number;
    readonly numPredict?: number;
    readonly schema?: StructuringSchema;
  },
): StructuringBatchPlan[] {
  const numCtx = options.numCtx ?? DEFAULT_STRUCTURING_NUM_CTX;
  const numPredict = options.numPredict ?? DEFAULT_STRUCTURING_NUM_PREDICT;
  if (numPredict <= OUTPUT_RESERVE_TOKENS) {
    throw new Error('Capture structuring output budget is too small');
  }
  if (numCtx <= numPredict + CONTEXT_RESERVE_TOKENS) {
    throw new Error('Capture structuring context budget is too small');
  }
  const inputLimit = numCtx - numPredict - CONTEXT_RESERVE_TOKENS;
  const outputLimit = numPredict - OUTPUT_RESERVE_TOKENS;
  const emptyPrompt = buildStructuringBatchPrompt([], options.targetLanguage);
  const schema = options.schema ?? structuringBatchSchema(options.targetLanguage);
  const fixedInput = jsonTokens({
    prompt: emptyPrompt,
    format: schema,
  });
  const fixedOutput = jsonTokens({ blocks: [] });
  if (fixedInput >= inputLimit || fixedOutput >= outputLimit) {
    throw new StructuringValidationError(
      'Capture structuring schema does not fit the configured provider budget.',
    );
  }

  const plans: StructuringBatchPlan[] = [];
  let current: RawCaptureSegment[] = [];
  let currentInput = fixedInput;
  let currentOutput = fixedOutput;
  for (const segment of segments) {
    const segmentInput = jsonTokens(
      promptSegment(segment, options.targetLanguage),
    );
    const projected = {
      sourceSegmentId: segment.segmentId,
      type: segment.locator.kind === 'time' ? 'transcript' : 'paragraph',
      ...(options.targetLanguage === undefined
        ? {}
        : { targetText: segment.text }),
    };
    const segmentOutput =
      jsonTokens(projected) +
      (options.targetLanguage === undefined
        ? 0
        : Math.ceil(textTokens(segment.text) / 2));
    let nextInput = currentInput + segmentInput;
    let nextOutput = currentOutput + segmentOutput;
    if (
      current.length > 0 &&
      (nextInput > inputLimit || nextOutput > outputLimit)
    ) {
      plans.push({
        segments: current,
        inputTokens: currentInput,
        outputTokens: currentOutput,
      });
      current = [];
      currentInput = fixedInput;
      currentOutput = fixedOutput;
      nextInput = currentInput + segmentInput;
      nextOutput = currentOutput + segmentOutput;
    }
    if (nextInput > inputLimit || nextOutput > outputLimit) {
      throw new StructuringValidationError(
        `Raw segment ${segment.segmentId} exceeds the provider token budget.`,
        [{ location: ['rawSegments', String(segment.order)], message: 'must fit one structuring batch' }],
      );
    }
    current.push(segment);
    currentInput = nextInput;
    currentOutput = nextOutput;
  }
  if (current.length > 0) {
    plans.push({
      segments: current,
      inputTokens: currentInput,
      outputTokens: currentOutput,
    });
  }
  return plans;
}

/**
 * Calculates adaptive provider options for one planned batch.
 *
 * @param plan Batch whose estimated usage drives the request budgets.
 * @param options Optional maximum context and generation budgets.
 * @returns A tuple of `[numCtx, numPredict]` for the provider request.
 */
export function structuringBatchGenerationOptions(
  plan: StructuringBatchPlan,
  options: {
    readonly maxNumCtx?: number;
    readonly maxNumPredict?: number;
  } = {},
): readonly [number, number] {
  const maxNumCtx = options.maxNumCtx ?? DEFAULT_STRUCTURING_NUM_CTX;
  const maxNumPredict = options.maxNumPredict ?? DEFAULT_STRUCTURING_NUM_PREDICT;
  const numPredict = Math.min(
    maxNumPredict,
    Math.max(MIN_REQUEST_TOKENS, plan.outputTokens + OUTPUT_RESERVE_TOKENS),
  );
  const numCtx = Math.min(
    maxNumCtx,
    Math.max(
      MIN_REQUEST_TOKENS,
      plan.inputTokens + numPredict + CONTEXT_RESERVE_TOKENS,
    ),
  );
  return [numCtx, numPredict];
}

/**
 * Decodes a provider candidate when it is represented as JSON bytes or text.
 *
 * @param candidate Raw provider result or an already-decoded value.
 * @returns Decoded candidate value.
 * @throws {@link StructuringValidationError} when bytes/text are invalid JSON.
 */
function decodeCandidate(candidate: Uint8Array | string | unknown): unknown {
  if (candidate instanceof Uint8Array) {
    try {
      return JSON.parse(new TextDecoder().decode(candidate));
    } catch (error) {
      throw new StructuringValidationError('structuring output is not valid UTF-8 JSON', [
        { cause: error },
      ]);
    }
  }
  if (typeof candidate === 'string') {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      throw new StructuringValidationError('structuring output is not valid JSON', [
        { cause: error },
      ]);
    }
  }
  return candidate;
}

/**
 * Serializes a value for deterministic provenance comparison.
 *
 * @param value Value to serialize.
 * @returns JSON representation used for equality checks.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * Checks that an object contains exactly the expected keys.
 *
 * @param value Object to inspect.
 * @param keys Allowed key set.
 * @returns Whether the object has exactly the supplied keys.
 */
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key));
}

/**
 * Validates the model-owned semantic fields for one block.
 *
 * @param value Candidate block to validate.
 * @param targetLanguage Translation language, or `undefined` for identity mode.
 * @param index Block index used in validation issue locations.
 * @throws {@link StructuringValidationError} when forbidden or invalid fields appear.
 */
function assertSemanticBlock(
  value: unknown,
  targetLanguage: string | undefined,
  index: number,
): asserts value is CaptureSemanticBlock {
  if (!isRecord(value)) {
    throw new StructuringValidationError('structuring batch semantic fields are invalid', [
      { location: ['blocks', String(index)], message: 'must be an object' },
    ]);
  }
  const keys = targetLanguage === undefined
    ? ['sourceSegmentId', 'type']
    : ['sourceSegmentId', 'type', 'targetText'];
  if (!exactKeys(value, keys)) {
    throw new StructuringValidationError(
      'structuring batch semantic fields do not satisfy CaptureBlockBatch',
      [{ location: ['blocks', String(index)], message: 'contains forbidden provenance fields' }],
    );
  }
  if (
    typeof value['sourceSegmentId'] !== 'string' ||
    value['sourceSegmentId'].trim().length === 0 ||
    typeof value['type'] !== 'string' ||
    !CAPTURE_BLOCK_TYPES.includes(value['type'] as CaptureBlock['type']) ||
    (targetLanguage !== undefined &&
      (typeof value['targetText'] !== 'string' || value['targetText'].trim().length === 0))
  ) {
    throw new StructuringValidationError(
      'structuring batch semantic fields do not satisfy CaptureBlockBatch',
      [{ location: ['blocks', String(index)], message: 'contains an invalid semantic field' }],
    );
  }
}

/**
 * Validates a minimal semantic batch and reconstructs trusted block fields.
 *
 * IDs, order, locators, and source text are derived exclusively from the
 * supplied raw segments; those fields are never trusted from the LLM.
 *
 * @param candidate JSON bytes, JSON text, or a decoded batch candidate.
 * @param segments Raw segments covered by this batch, in source order.
 * @param options Optional translation language controlling target-text rules.
 * @returns Canonical blocks with trusted provenance and model-owned semantics.
 * @throws {@link StructuringValidationError} when coverage or semantics fail.
 */
export function validateStructuringBatch(
  candidate: Uint8Array | string | unknown,
  segments: readonly RawCaptureSegment[],
  options: { readonly targetLanguage?: string } = {},
): CaptureBlock[] {
  const decoded = decodeCandidate(candidate);
  if (!isRecord(decoded) || !exactKeys(decoded, ['blocks']) || !Array.isArray(decoded['blocks'])) {
    throw new StructuringValidationError('structuring batch must be one JSON object');
  }
  const semanticBlocks = decoded['blocks'];
  if (semanticBlocks.length !== segments.length) {
    throw new StructuringValidationError(
      'structuring batch must cover every supplied segment exactly once',
      [{ location: ['blocks'], message: 'count must equal raw segments' }],
    );
  }
  return semanticBlocks.map((value, index) => {
    assertSemanticBlock(value, options.targetLanguage, index);
    const segment = segments[index];
    if (value.sourceSegmentId !== segment.segmentId) {
      throw new StructuringValidationError(
        'structuring batch must retain ordered source segment identity',
        [{ location: ['blocks', String(index), 'sourceSegmentId'], message: 'must equal the ordered raw segment identifier' }],
      );
    }
    return {
      blockId: `block-${segment.segmentId}`,
      order: index,
      type: value.type,
      sourceSegmentId: segment.segmentId,
      locator: segment.locator,
      sourceText: segment.text,
      targetText:
        options.targetLanguage === undefined ? segment.text : value.targetText,
    };
  });
}

/**
 * Validates a complete candidate against raw-capture provenance.
 *
 * @param candidate JSON bytes, JSON text, or a decoded document candidate.
 * @param raw Canonical raw capture whose trusted fields must be preserved.
 * @returns A provenance-validated CaptureDocument value.
 * @throws {@link StructuringValidationError} when provenance checks fail.
 */
export function validateStructuringCandidate(
  candidate: unknown,
  raw: RawCapture,
): CaptureDocument {
  const document = decodeCandidate(candidate);
  if (!isRecord(document)) {
    throw new StructuringValidationError('structuring output must be a JSON object');
  }
  validateDocumentSchema(document);
  const mismatches: string[] = [];
  const provenance = {
    source: [document['source'], raw.source],
    rawSegments: [document['rawSegments'], raw.segments],
    sourceText: [document['sourceText'], raw.sourceText],
    extractionEngine: [document['extractionEngine'], raw.extractionEngine],
    createdAt: [document['createdAt'], raw.createdAt],
  } as const;
  for (const [field, [actual, expected]] of Object.entries(provenance)) {
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      mismatches.push(field);
    }
  }
  const rawWarnings = raw.warnings ?? [];
  const documentWarnings = Array.isArray(document['warnings'])
    ? document['warnings'].filter((value): value is string => typeof value === 'string')
    : [];
  if (!rawWarnings.every((warning) => documentWarnings.includes(warning))) {
    mismatches.push('warnings');
  }
  const blocks = document['blocks'];
  if (!Array.isArray(blocks) || blocks.length !== raw.segments.length) {
    mismatches.push('blocks');
  } else {
    for (const [index, block] of blocks.entries()) {
      const segment = raw.segments[index];
      if (!isRecord(block) ||
        block['blockId'] !== `block-${segment.segmentId}` ||
        block['order'] !== index ||
        block['sourceSegmentId'] !== segment.segmentId ||
        canonicalJson(block['locator']) !== canonicalJson(segment.locator) ||
        block['sourceText'] !== segment.text) {
        mismatches.push(`blocks.${index}`);
      }
    }
    if (document['targetText'] !== blocks.map((block) =>
      isRecord(block) ? block['targetText'] : undefined,
    ).join('\n')) {
      mismatches.push('targetText');
    }
  }
  if (document['schemaVersion'] !== CAPTURE_DOCUMENT_SCHEMA_VERSION ||
    typeof document['completedAt'] !== 'string' ||
    !isRecord(document['structuringEngine'])) {
    mismatches.push('document');
  }
  if (mismatches.length > 0) {
    throw new StructuringValidationError(
      'structured output changed extraction provenance or failed document validation',
      mismatches.map((field) => ({ location: [field], message: 'failed CaptureDocument validation' })),
    );
  }
  return document as unknown as CaptureDocument;
}

/**
 * Assembles the trusted document envelope around semantic blocks.
 *
 * @param raw Canonical raw capture supplying source and extraction provenance.
 * @param blocks Canonical blocks produced by {@link validateStructuringBatch}.
 * @param options Trusted engine identity and completion timestamp.
 * @returns A provenance-validated CaptureDocument value.
 * @throws {@link StructuringValidationError} when the document fails validation.
 */
export function assembleStructuringDocument(
  raw: RawCapture,
  blocks: readonly CaptureBlock[],
  options: { readonly engineIdentity: CaptureEngine; readonly completedAt: string },
): CaptureDocument {
  return validateStructuringCandidate(
    {
      schemaVersion: CAPTURE_DOCUMENT_SCHEMA_VERSION,
      source: raw.source,
      rawSegments: raw.segments,
      blocks,
      sourceText: raw.sourceText,
      targetText: blocks.map((block) => block.targetText).join('\n'),
      extractionEngine: raw.extractionEngine,
      structuringEngine: options.engineIdentity,
      warnings: raw.warnings ?? [],
      createdAt: raw.createdAt,
      completedAt: options.completedAt,
    },
    raw,
  );
}

/**
 * Runs the complete host-owned structuring flow for one raw capture.
 *
 * The SDK plans bounded requests, asks the host callback for semantic JSON,
 * reconstructs trusted provenance, and returns the canonical document. It
 * never selects, starts, or owns an LLM provider.
 *
 * @param options Raw capture, host callback, trusted engine identity, and budgets.
 * @returns The fully assembled CaptureDocument document.
 * @throws {@link StructuringValidationError} when a provider response is unsafe.
 */
export async function structureCapture(
  options: StructureCaptureOptions,
): Promise<CaptureDocument> {
  const plans = planStructuringBatches(options.raw.segments, {
    targetLanguage: options.targetLanguage,
    numCtx: options.numCtx,
    numPredict: options.numPredict,
    schema: options.schema,
  });
  const schema = options.schema ?? structuringBatchSchema(options.targetLanguage);
  const blocks: CaptureBlock[] = [];
  for (const plan of plans) {
    const candidate = await options.llmGenerate(
      buildStructuringBatchPrompt(plan.segments, options.targetLanguage),
      schema,
    );
    blocks.push(
      ...validateStructuringBatch(candidate, plan.segments, {
        targetLanguage: options.targetLanguage,
      }),
    );
  }
  return assembleStructuringDocument(options.raw, blocks, {
    engineIdentity: options.structuringEngine,
    completedAt: options.completedAt,
  });
}
