import {
  CAPTURE_DOCUMENT_SCHEMA_SHA256,
  CAPTURE_DOCUMENT_SCHEMA_VERSION,
  CAPTURE_DOCUMENT_V1_JSON_SCHEMA as CAPTURE_CONTRACT_DOCUMENT_SCHEMA,
} from '@gx-capture/capture-contracts';
import type { CaptureDocumentContractV1 } from './contracts';

export const CAPTURE_DOCUMENT_V1_JSON_SCHEMA = deepFreeze(
  CAPTURE_CONTRACT_DOCUMENT_SCHEMA,
);

/** SHA-256 of the canonical CRLF-terminated Windows release schema bytes. */
export const CAPTURE_DOCUMENT_V1_SCHEMA_SHA256 = CAPTURE_DOCUMENT_SCHEMA_SHA256;

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
