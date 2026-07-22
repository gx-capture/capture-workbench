import {
  CAPTURE_DOCUMENT_SCHEMA_VERSION,
  type CaptureDocumentContractV1,
} from './contracts';
import {
  GENERATED_CAPTURE_DOCUMENT_V1_JSON_SCHEMA,
  GENERATED_CAPTURE_DOCUMENT_V1_SCHEMA_SHA256,
} from './generated/capture-document-v1-schema.generated';

export const CAPTURE_DOCUMENT_V1_JSON_SCHEMA = deepFreeze(
  GENERATED_CAPTURE_DOCUMENT_V1_JSON_SCHEMA,
);

/** SHA-256 of the canonical CRLF-terminated Windows release schema bytes. */
export const CAPTURE_DOCUMENT_V1_SCHEMA_SHA256 =
  GENERATED_CAPTURE_DOCUMENT_V1_SCHEMA_SHA256;

export const CAPTURE_DOCUMENT_V1_CONTRACT: CaptureDocumentContractV1 =
  deepFreeze({
    schemaVersion: CAPTURE_DOCUMENT_SCHEMA_VERSION,
    schemaSha256: CAPTURE_DOCUMENT_V1_SCHEMA_SHA256,
    jsonSchema: CAPTURE_DOCUMENT_V1_JSON_SCHEMA,
  });

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (
      child !== null &&
      typeof child === 'object' &&
      !Object.isFrozen(child)
    ) {
      deepFreeze(child);
    }
  }
  return Object.freeze(value);
}
