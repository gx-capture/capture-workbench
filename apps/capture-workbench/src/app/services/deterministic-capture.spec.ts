import { TestBed } from '@angular/core/testing';
import {
  CAPTURE_DOCUMENT_V1_CONTRACT,
  type CaptureJobV1,
  type CaptureSourceKind,
  type CaptureStructuringMode,
  type RawCaptureV1,
} from '@gx-capture/capture-workbench';
import { DeterministicCaptureClientService } from './deterministic-capture.service';
import { DeterministicDocumentService } from './deterministic-document.service';
import { DeterministicStructuringProviderService } from './deterministic-structuring.service';

describe('deterministic capture services', () => {
  afterEach(() => TestBed.resetTestingModule());

  it.each([
    ['pdf', 'application/pdf', 'runtime'],
    ['image', 'image/png', 'runtime'],
    ['audio', 'audio/wav', 'host'],
  ] as const)(
    'creates a deterministic %s capture with the expected source and state',
    async (sourceKind, mediaType, structuringMode) => {
      const client = configureClient();
      const job = await createCapture(client, sourceKind, structuringMode);
      const raw = await readRaw(client, job.captureId);

      expect(raw.source).toMatchObject({
        fileName: `fixture.${sourceKind === 'audio' ? 'wav' : sourceKind}`,
        mediaType,
      });
      expect(raw.source.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(job.stage).toBe(
        structuringMode === 'runtime' ? 'completed' : 'awaiting_structuring',
      );
      expect(job.status).toBe(
        structuringMode === 'runtime' ? 'completed' : 'running',
      );
    },
  );

  it('preserves cancellation, commit, and structuring failure transitions', async () => {
    const client = configureClient();
    const documentService = TestBed.inject(DeterministicDocumentService);

    const canceled = await createCapture(client, 'pdf', 'host');
    const canceledResult = await updateJob(
      client.cancelCapture(canceled.captureId),
    );
    expect(canceledResult).toMatchObject({ status: 'cancelled', stage: 'cancelled' });

    const committed = await createCapture(client, 'image', 'host');
    const committedRaw = await readRaw(client, committed.captureId);
    const candidate = documentService.createCandidate(
      committedRaw,
      'host-provider-fake',
    );
    const committedResult = await updateJob(
      client.commitStructuredResult(committed.captureId, {
        clientRequestId: 'commit-1',
        candidate,
      }),
    );
    expect(committedResult).toMatchObject({ status: 'completed', stage: 'completed' });

    const failed = await createCapture(client, 'audio', 'host');
    const failedResult = await updateJob(
      client.reportStructuringFailure(failed.captureId, {
        code: 'provider_failed',
        message: 'Fixture provider failed.',
      }),
    );
    expect(failedResult).toMatchObject({
      status: 'failed',
      stage: 'failed',
      error: {
        code: 'provider_failed',
        stage: 'structuring',
      },
    });
  });

  it('builds a host candidate and rejects an incompatible document contract', async () => {
    const client = configureClient();
    const provider = TestBed.inject(DeterministicStructuringProviderService);
    const job = await createCapture(client, 'pdf', 'host');
    const raw = await readRaw(client, job.captureId);
    const progress: number[] = [];
    let candidate: unknown;
    provider
      .structure({
        raw,
        documentContract: CAPTURE_DOCUMENT_V1_CONTRACT,
        signal: new AbortController().signal,
        reportProgress: (percentage) => progress.push(percentage),
      })
      .subscribe({ next: (value) => (candidate = value) });

    await vi.waitFor(() => expect(candidate).toBeDefined());
    expect(progress).toEqual([50, 100]);

    let contractError: unknown;
    provider
      .structure({
        raw: { ...raw, schemaVersion: 'mismatch' as '1' },
        documentContract: CAPTURE_DOCUMENT_V1_CONTRACT,
        signal: new AbortController().signal,
        reportProgress: () => undefined,
      })
      .subscribe({ error: (error) => (contractError = error) });
    await vi.waitFor(() => expect(contractError).toBeInstanceOf(Error));
    expect(contractError).toEqual(
      expect.objectContaining({
        message: 'Capture document contract version mismatch.',
      }),
    );
  });
});

function configureClient(): DeterministicCaptureClientService {
  TestBed.configureTestingModule({
    providers: [
      DeterministicDocumentService,
      DeterministicStructuringProviderService,
      DeterministicCaptureClientService,
    ],
  });
  return TestBed.inject(DeterministicCaptureClientService);
}

async function createCapture(
  client: DeterministicCaptureClientService,
  sourceKind: CaptureSourceKind,
  structuringMode: CaptureStructuringMode,
): Promise<CaptureJobV1> {
  let result: CaptureJobV1 | undefined;
  const mediaType =
    sourceKind === 'pdf'
      ? 'application/pdf'
      : sourceKind === 'image'
        ? 'image/png'
        : 'audio/wav';
  const name = `fixture.${sourceKind === 'audio' ? 'wav' : sourceKind}`;
  const sourceContents = 'deterministic fixture text';
  const encodedContents = new TextEncoder().encode(sourceContents);
  const file = {
    name,
    type: mediaType,
    size: encodedContents.byteLength,
    text: () => Promise.resolve(sourceContents),
    arrayBuffer: () => Promise.resolve(encodedContents.buffer),
  } as unknown as File;
  client
    .createCapture({
      clientRequestId: `create-${sourceKind}`,
      file,
      sourceKind,
      structuringMode,
    })
    .subscribe({ next: (value) => (result = value) });
  await vi.waitFor(() => expect(result).toBeDefined());
  return result as CaptureJobV1;
}

async function readRaw(
  client: DeterministicCaptureClientService,
  captureId: string,
): Promise<RawCaptureV1> {
  let result: RawCaptureV1 | undefined;
  client.getRaw(captureId).subscribe({ next: (value) => (result = value) });
  await vi.waitFor(() => expect(result).toBeDefined());
  return result as RawCaptureV1;
}

async function updateJob(
  operation: import('rxjs').Observable<CaptureJobV1>,
): Promise<CaptureJobV1> {
  let result: CaptureJobV1 | undefined;
  operation.subscribe({ next: (value) => (result = value) });
  await vi.waitFor(() => expect(result).toBeDefined());
  return result as CaptureJobV1;
}
