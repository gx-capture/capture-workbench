import type { CaptureBlock } from '@gx-capture/capture-runtime-client';

import type { StructuringSchema } from './contracts.js';

/** Default Ollama context budget used for bounded structuring requests. */
export const DEFAULT_STRUCTURING_NUM_CTX = 8_192;

/** Default Ollama generation budget used for bounded structuring requests. */
export const DEFAULT_STRUCTURING_NUM_PREDICT = 4_096;

/** Reserved context tokens for instructions, schema, and provider overhead. */
export const CONTEXT_RESERVE_TOKENS = 512;

/** Reserved output tokens for JSON completion overhead. */
export const OUTPUT_RESERVE_TOKENS = 256;

/** Conservative UTF-8 byte-to-token estimate used for request planning. */
export const ESTIMATED_BYTES_PER_TOKEN = 3;

/** Smallest provider request budget accepted by adaptive generation options. */
export const MIN_REQUEST_TOKENS = 256;

/** Maximum identity-mode source preview sent to the classifier. */
export const IDENTITY_TEXT_PREVIEW_CHARACTERS = 256;

/** Closed set of semantic block types accepted from the LLM. */
export const CAPTURE_BLOCK_TYPES = [
  'heading',
  'paragraph',
  'list-item',
  'table',
  'quote',
  'transcript',
] as const satisfies readonly CaptureBlock['type'][];

const semanticBlockDefinition = {
  type: 'object',
  additionalProperties: false,
  required: ['sourceSegmentId', 'type'],
  properties: {
    sourceSegmentId: { type: 'string', minLength: 1 },
    type: { enum: CAPTURE_BLOCK_TYPES },
    targetText: { type: 'string', minLength: 1, maxLength: 2_000_000 },
  },
} as const;

/** JSON Schema for translated semantic block batches. */
export const CAPTURE_BLOCK_BATCH_SCHEMA: StructuringSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'CaptureBlockBatch',
  type: 'object',
  additionalProperties: false,
  required: ['blocks'],
  properties: {
    blocks: {
      type: 'array',
      minItems: 1,
      items: { $ref: '#/$defs/CaptureSemanticBlock' },
    },
  },
  $defs: { CaptureSemanticBlock: semanticBlockDefinition },
};

/** JSON Schema for identity-mode semantic block batches. */
export const CAPTURE_IDENTITY_BLOCK_BATCH_SCHEMA: StructuringSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'CaptureIdentityBlockBatch',
  type: 'object',
  additionalProperties: false,
  required: ['blocks'],
  properties: {
    blocks: {
      type: 'array',
      minItems: 1,
      items: { $ref: '#/$defs/CaptureIdentitySemanticBlock' },
    },
  },
  $defs: {
    CaptureIdentitySemanticBlock: {
      type: 'object',
      additionalProperties: false,
      required: ['sourceSegmentId', 'type'],
      properties: {
        sourceSegmentId: { type: 'string', minLength: 1 },
        type: { enum: CAPTURE_BLOCK_TYPES },
      },
    },
  },
};

/**
 * Selects the canonical semantic response schema for the requested operation.
 *
 * @param targetLanguage Translation language, or `undefined` for identity mode.
 * @returns The canonical schema that every host can validate independently.
 */
export function structuringBatchSchema(
  targetLanguage: string | undefined,
): StructuringSchema {
  return targetLanguage === undefined
    ? CAPTURE_IDENTITY_BLOCK_BATCH_SCHEMA
    : CAPTURE_BLOCK_BATCH_SCHEMA;
}

/**
 * Removes string-length maxima from a provider grammar while retaining SDK
 * validation after generation.
 *
 * @param schema Source schema to clone and simplify.
 * @returns A deep-cloned schema suitable for Ollama grammar generation.
 */
function withoutStringMaxima(schema: StructuringSchema): StructuringSchema {
  const clone = structuredClone(schema) as Record<string, unknown>;
  const pending: unknown[] = [clone];
  while (pending.length > 0) {
    const current = pending.pop();
    if (isRecord(current)) {
      delete current['maxLength'];
      pending.push(...Object.values(current));
    } else if (Array.isArray(current)) {
      pending.push(...current);
    }
  }
  return clone;
}

/** Ollama-compatible schema for translated semantic block batches. */
export const OLLAMA_CAPTURE_BLOCK_BATCH_SCHEMA = withoutStringMaxima(
  CAPTURE_BLOCK_BATCH_SCHEMA,
);

/** Ollama-compatible schema for identity-mode semantic block batches. */
export const OLLAMA_IDENTITY_BLOCK_BATCH_SCHEMA = withoutStringMaxima(
  CAPTURE_IDENTITY_BLOCK_BATCH_SCHEMA,
);

/**
 * Narrows an unknown value to a non-array object record.
 *
 * @param value Value to inspect.
 * @returns Whether the value is a record suitable for property access.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
