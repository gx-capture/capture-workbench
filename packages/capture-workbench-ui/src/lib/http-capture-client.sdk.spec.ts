import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CAPTURE_DOCUMENT_SCHEMA_SHA256,
  RUNTIME_VERSION,
  CAPTURE_CONTRACT_SET_SHA256,
  type RuntimeTransport,
  type RuntimeTransportRequest,
} from '@gx-capture/capture-runtime-client';
import { firstValueFrom } from 'rxjs';

import { HttpCaptureClient } from './http-capture-client';

describe('HttpCaptureClient SDK delegation', () => {
  it('negotiates the allowlisted v2 ContractSet before returning readiness', async () => {
    const bundle = readFileSync(
      resolve(
        process.cwd(),
        'packages/capture-runtime-client/src/private/assets/contract-set.json',
      ),
    );
    const paths: string[] = [];
    const transport: RuntimeTransport = {
      request: async (request: RuntimeTransportRequest) => {
        paths.push(request.path);
        if (request.path === '/v2/health/ready') {
          return jsonResponse({
            ready: true,
            service: 'capture-runtime',
            runtimeVersion: RUNTIME_VERSION,
            apiVersion: '2.0',
            captureDocumentSchemaVersion: '2',
            captureDocumentSchemaSha256:
              CAPTURE_DOCUMENT_SCHEMA_SHA256,
            contractSetVersion: '2',
            capabilities: {
              captureKinds: ['pdf'],
              structuringModes: ['host', 'runtime'],
              supportsCancellation: true,
              supportsRawDiagnostics: true,
              maxUploadBytes: 1024,
              maxChunkBytes: 1024 * 1024,
              checkpointIntervalMs: 300_000,
              heartbeatIntervalMs: 5_000,
              stallTimeoutMs: 90_000,
              supportsProgressiveRecording: true,
            },
          });
        }
        if (request.path === '/meta/v2/contracts') {
          return jsonResponse({
            catalogVersion: '2',
            runtimeVersion: RUNTIME_VERSION,
            contractSetVersion: '2',
            surfaces: [{ id: 'v2' }],
            sha256: CAPTURE_CONTRACT_SET_SHA256,
            href: `/meta/v2/contracts/sha256/${CAPTURE_CONTRACT_SET_SHA256}`,
          });
        }
        if (
          request.path ===
          `/meta/v2/contracts/sha256/${CAPTURE_CONTRACT_SET_SHA256}`
        ) {
          return new Response(bundle, {
            headers: {
              'Content-Type': 'application/json',
              ETag: `"${CAPTURE_CONTRACT_SET_SHA256}"`,
              'X-Contract-SHA256': CAPTURE_CONTRACT_SET_SHA256,
            },
          });
        }
        return jsonResponse(
          { error: { code: 'not_found', message: 'Not found.' } },
          404,
        );
      },
    };

    const client = new HttpCaptureClient({ transport });
    await expect(firstValueFrom(client.getReady())).resolves.toMatchObject({
      ready: true,
      service: 'capture-runtime',
    });
    expect(paths).toEqual([
      '/v2/health/ready',
      '/meta/v2/contracts',
      `/meta/v2/contracts/sha256/${CAPTURE_CONTRACT_SET_SHA256}`,
    ]);
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
