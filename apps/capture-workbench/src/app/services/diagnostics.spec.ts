import type { OcrComputePreflight } from '@gx-capture/capture-workbench-ui';
import type { DesktopLibraryDetail, DesktopRuntimeStatus } from '../contracts';
import { DESKTOP_MESSAGES } from '../i18n/desktop-messages';
import {
  buildDiagnosticsDocumentView,
  buildDiagnosticsRuntimeView,
  buildDocumentProvenance,
} from './diagnostics';

describe('diagnostics pure functions', () => {
  const messages = DESKTOP_MESSAGES['zh-TW'];

  it('builds the runtime view for starting, ready, and error states', () => {
    const preflight: OcrComputePreflight = {
      apiVersion: '2.0',
      schemaVersion: '1',
      service: 'capture-runtime',
      runtimeVersion: '0.0.0-test',
      contractSetVersion: '2',
      contractSetSha256: 'a'.repeat(64),
      workerSha256: 'b'.repeat(64),
      mode: 'gpu',
      adapterClass: 'dedicated',
      reasonCode: null,
      userNoticeRequired: false,
      noticeCode: null,
    };
    const readyStatus: DesktopRuntimeStatus = {
      status: 'ready',
      detail: 'Ready',
      runtimeVersion: '0.0.0-test',
      apiVersion: '2.0',
      contractSetVersion: '2',
      ocrCompute: preflight,
    };

    expect(
      buildDiagnosticsRuntimeView({
        state: 'ready',
        runtimeStatusMessage: '',
        runtimeStatus: readyStatus,
        ocrCompute: preflight,
        messages,
      }),
    ).toEqual({
      state: 'ready',
      statusLabel: messages.ready,
      errorMessage: null,
      runtimeVersion: '0.0.0-test',
      apiVersion: '2.0',
      contractSetVersion: '2',
      contractSetSha256: 'a'.repeat(64),
    });

    expect(
      buildDiagnosticsRuntimeView({
        state: 'starting',
        runtimeStatusMessage: messages.starting,
        runtimeStatus: { status: 'starting', detail: messages.starting },
        ocrCompute: null,
        messages,
      }),
    ).toEqual({
      state: 'starting',
      statusLabel: messages.starting,
      errorMessage: null,
      runtimeVersion: null,
      apiVersion: null,
      contractSetVersion: null,
      contractSetSha256: null,
    });

    expect(
      buildDiagnosticsRuntimeView({
        state: 'error',
        runtimeStatusMessage: 'Sidecar failed',
        runtimeStatus: { status: 'failed', detail: 'Fallback detail' },
        ocrCompute: null,
        messages,
      }),
    ).toEqual({
      state: 'error',
      statusLabel: messages.diagnosticsRuntimeError,
      errorMessage: 'Sidecar failed',
      runtimeVersion: null,
      apiVersion: null,
      contractSetVersion: null,
      contractSetSha256: null,
    });

    // The readiness check itself failed: there is no status object at all.
    expect(
      buildDiagnosticsRuntimeView({
        state: 'error',
        runtimeStatusMessage: 'No desktop host',
        runtimeStatus: null,
        ocrCompute: null,
        messages,
      }),
    ).toEqual({
      state: 'error',
      statusLabel: messages.diagnosticsRuntimeError,
      errorMessage: 'No desktop host',
      runtimeVersion: null,
      apiVersion: null,
      contractSetVersion: null,
      contractSetSha256: null,
    });
  });

  it.each([
    {
      engine: 'text-recognition',
      model: 'pp-ocrv6-medium',
      device: 'directml',
    },
    {
      engine: 'windowsml-ocr',
      model: 'pp-ocrv6-medium-windowsml',
      device: 'windowsml-dml',
    },
  ])('displays recorded $engine provenance from an unstructured document', (identity) => {
    const extraction = { ...identity, digest: `sha256:${'e'.repeat(64)}` };
    const detail: DesktopLibraryDetail = {
      documentId: 'c'.repeat(32),
      fileName: 'scan.pdf',
      mediaType: 'application/pdf',
      byteLength: 1024,
      createdAtMs: 1,
      updatedAtMs: 2,
      status: 'completed',
      raw: {
        schemaVersion: '2',
        diagnosticOnly: true,
        source: {
          sha256: 'd'.repeat(64),
          fileName: 'scan.pdf',
          mediaType: 'application/pdf',
          bytes: 1024,
        },
        segments: [],
        sourceText: 'hello',
        extractionEngine: extraction,
        createdAt: '2026-11-16T00:00:00Z',
      } as unknown as DesktopLibraryDetail['raw'],
    };

    expect(buildDocumentProvenance(detail)).toEqual({
      extraction,
      structuring: null,
    });
    expect(buildDiagnosticsDocumentView(detail)).toEqual({
      documentId: 'c'.repeat(32),
      fileName: 'scan.pdf',
      extraction,
      structuring: null,
      evidence: null,
      canExportJson: true,
    });
  });

  it('computes provenance and evidence summary for a document with structured result and evidence', () => {
    const detail: DesktopLibraryDetail = {
      documentId: 'f'.repeat(32),
      fileName: 'contract.pdf',
      mediaType: 'application/pdf',
      byteLength: 2048,
      createdAtMs: 1,
      updatedAtMs: 2,
      status: 'completed',
      result: {
        targetText: 'structured',
        extractionEngine: {
          engine: 'text-recognition',
          model: 'ocr-v1',
          device: 'dml',
          digest: `sha256:${'1'.repeat(64)}`,
        },
        structuringEngine: {
          engine: 'ollama',
          model: 'qwen-test',
          digest: `sha256:${'2'.repeat(64)}`,
        },
      } as unknown as DesktopLibraryDetail['result'],
      ocrEvidence: {
        schemaVersion: 1,
        captureId: 'cap-1',
        sourceSha256: '3'.repeat(64),
        status: 'completed',
        pageCount: 3,
        pages: [],
        summary: {
          normalizedCharCount: 100,
          boxCount: 5,
          confidenceSummary: {
            scoreState: 'none',
            numericCount: 0,
            min: null,
            max: null,
            mean: null,
          },
        },
        provenance: {
          status: 'resolved',
          runtimeVersion: '0.0.0-test',
          contractSha256: '4'.repeat(64),
          engine: 'text-recognition',
          model: 'ocr-v1',
          modelDigest: `sha256:${'1'.repeat(64)}`,
          device: 'dml',
          profileId: 'p1',
          profileSpecSha256: '5'.repeat(64),
          workerSha256: '6'.repeat(64),
        },
        digest: '7'.repeat(64),
      },
    };

    expect(buildDiagnosticsDocumentView(detail)).toEqual({
      documentId: 'f'.repeat(32),
      fileName: 'contract.pdf',
      extraction: {
        engine: 'text-recognition',
        model: 'ocr-v1',
        device: 'dml',
        digest: `sha256:${'1'.repeat(64)}`,
      },
      structuring: {
        engine: 'ollama',
        model: 'qwen-test',
        device: null,
        digest: `sha256:${'2'.repeat(64)}`,
      },
      evidence: {
        status: 'completed',
        pageCount: 3,
        digest: '7'.repeat(64),
      },
      canExportJson: true,
    });
  });
});
