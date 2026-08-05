export * from './generated/contracts.js';
import { GENERATED_CAPTURE_DOCUMENT_V1_JSON_SCHEMA } from './generated/capture-document-v1-schema.js';

export interface CaptureDocumentJsonSchemaNode {
  readonly [key: string]: unknown;
  readonly pattern?: string;
}

export interface CaptureDocumentJsonSchemaDefinition {
  readonly properties: Readonly<{
    readonly [key: string]: CaptureDocumentJsonSchemaNode;
    readonly digest: CaptureDocumentJsonSchemaNode;
  }>;
}

export interface CaptureDocumentJsonSchema {
  readonly [key: string]: unknown;
  readonly $id: string;
  readonly $defs: Readonly<{
    readonly CaptureBlockV1: CaptureDocumentJsonSchemaDefinition;
    readonly CaptureEngineV1: CaptureDocumentJsonSchemaDefinition;
    readonly [name: string]: CaptureDocumentJsonSchemaDefinition;
  }>;
}

/** The pinned canonical CaptureDocumentV1 schema used by the runtime. */
export const CAPTURE_DOCUMENT_V1_JSON_SCHEMA =
  GENERATED_CAPTURE_DOCUMENT_V1_JSON_SCHEMA as unknown as CaptureDocumentJsonSchema;
