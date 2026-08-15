import {
  CAPTURE_DOCUMENT_SCHEMA_SHA256,
  CAPTURE_DOCUMENT_SCHEMA_VERSION,
  CAPTURE_DOCUMENT_SCHEMA as CAPTURE_CONTRACT_DOCUMENT_SCHEMA,
} from '@gx-capture/capture-runtime-client';
import type { CaptureDocumentContract } from './contracts';

export const CAPTURE_DOCUMENT_SCHEMA = deepFreeze(
  CAPTURE_CONTRACT_DOCUMENT_SCHEMA,
);

/** SHA-256 of the canonical CRLF-terminated Windows release schema bytes. */
export const CAPTURE_DOCUMENT_SCHEMA_HASH = CAPTURE_DOCUMENT_SCHEMA_SHA256;

export const CAPTURE_DOCUMENT_CONTRACT: CaptureDocumentContract =
  deepFreeze({
    schemaVersion: CAPTURE_DOCUMENT_SCHEMA_VERSION,
    schemaSha256: CAPTURE_DOCUMENT_SCHEMA_HASH,
    jsonSchema: CAPTURE_DOCUMENT_SCHEMA,
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
