import { decodeJson, type RuntimeResponseModel } from '../codec.js';
import type { RuntimeTransport } from '../contracts.js';

export {
  assertStructuringBatchSubmission,
  decodeError,
  decodeSse,
  parseJsonFrame,
} from '../codec.js';
export type { RuntimeResponseModel, SseFrame } from '../codec.js';

/** Decode a response through the package's strict wire-model validation. */
export async function decodeRuntimeJson<T>(
  response: Response,
  transport: RuntimeTransport,
  model?: RuntimeResponseModel,
): Promise<T> {
  return decodeJson<T>(response, transport, model);
}

/** Materialize upload bodies before hashing and chunking them. */
export async function bodyBytes(
  body: BodyInit | Uint8Array | ArrayBuffer,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** Compute a lowercase SHA-256 digest without exposing the mutable input view. */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', owned);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
