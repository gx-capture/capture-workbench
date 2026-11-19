export interface FakeDesktopOptions {
  readonly cudaAvailable?: boolean;
  readonly editedResults?: boolean;
  readonly completeInstallOnPoll?: number;
  readonly holdRunningUntilCancel?: boolean;
  /**
   * Fail the status request of each runtime or model installation
   * (`runtime_get_installation`, `runtime_get_structuring_model_installation`)
   * this many times in a row before answering.
   */
  readonly failInstallStatusChecks?: number;
  /**
   * Answer the first status request of each runtime or model installation
   * with HTTP 404, as a restarted runtime would. A runtime installation stays
   * in the installation list (its next status request answers again); a model
   * installation is gone, so every later read of it answers 404 too.
   */
  readonly answerInstallStatusNotFoundOnce?: boolean;
  /** Once a status request was answered 404, answer each installation listing this much later. */
  readonly slowListingAfterNotFoundMs?: number;
  readonly initialRunningInstallations?: readonly Record<string, unknown>[];
  /** Script capture commands so one OCR file can reach raw text. */
  readonly ocrJourney?: boolean;
  /** Keep the fake library in sessionStorage so a reload still lists it. */
  readonly persistLibrary?: boolean;
  /** Simulated installation phases with visible elapsed-time progress. */
  readonly installTimeline?: {
    readonly startResponseMs?: number;
    readonly preparingMs: number;
    readonly downloadMs: number;
    readonly installingMs: number;
  };
}

export interface FakeDesktopConfig {
  readonly runtimeRequirements: readonly Record<string, unknown>[];
  readonly runtimeVersion: string;
  readonly installOptions: FakeDesktopOptions;
  readonly pdfFixtureBase64: string;
}

/**
 * Installs a simulated Tauri desktop bridge onto `globalThis`.
 *
 * This function MUST remain completely self-contained: it is serialised with
 * `Function.prototype.toString()` (by Playwright and by `preview-server.ts`)
 * and evaluated alone inside the browser page. Do not reference any import,
 * module-level helper/constant, or Node API inside its body.
 */
export function installFakeDesktop(config: FakeDesktopConfig): void {
  const { runtimeRequirements, runtimeVersion, installOptions, pdfFixtureBase64 } = config;
  interface TauriTestGlobal {
    isTauri: boolean;
    __captureInvokedCommands: string[];
    __captureStartedRequirementIds: string[];
    __captureCreatedPdfPageNumbers: (readonly number[] | null)[];
    __TAURI_INTERNALS__: {
      invoke: (command: string, args?: unknown) => Promise<unknown>;
      metadata: {
        currentWindow: { label: string };
        currentWebview: { label: string };
      };
      transformCallback: (...args: unknown[]) => number;
    };
    __captureDropSources?: (fileName: string) => void;
    __captureNativeSourcesReady?: boolean;
  }
  const target = globalThis as unknown as TauriTestGlobal;
  let nextCallbackId = 1;
  let nextInstallSeq = 1;
  const callbacks = new Map<number, (eventData: unknown) => void>();
  let sourceChannel: { onmessage?: (batch: unknown) => void } | undefined;
  let sequence = 0;
  const selected = new Map<string, { selectionToken: string; fileName: string; byteLength: number; mediaType: string }>();
  const batchFor = (fileName: string) => {
    const selectionToken = (++sequence).toString(16).padStart(32, '0');
    const item = { selectionToken, fileName, byteLength: 12,
      mediaType: fileName.endsWith('.png') ? 'image/png' : fileName.endsWith('.jpg') || fileName.endsWith('.jpeg') ? 'image/jpeg' : 'application/pdf' };
    selected.set(selectionToken, item);
    return { selections: [item], rejected: [] };
  };
  const sendBatch = (batch: unknown) => {
    sourceChannel?.onmessage?.(batch);
  };
  const mutableRequirements = runtimeRequirements.map((item) => ({ ...item }));
  const installations = new Map<string, Record<string, unknown>>();
  const pollCounts = new Map<string, number>();
  const statusFailures = new Map<string, number>();
  const statusNotFoundAnswered = new Set<string>();
  /** The simulated failure for this status request, if any. */
  const statusRequestFailure = (installationId: string): Error | null => {
    if (installOptions.answerInstallStatusNotFoundOnce && !statusNotFoundAnswered.has(installationId)) {
      statusNotFoundAnswered.add(installationId);
      return new Error('Capture Runtime request was rejected with HTTP 404.');
    }
    const failedSoFar = statusFailures.get(installationId) ?? 0;
    if (failedSoFar >= (installOptions.failInstallStatusChecks ?? 0)) return null;
    statusFailures.set(installationId, failedSoFar + 1);
    return new Error('Capture Runtime response could not be read.');
  };
  const modelInstallations = new Map<string, Record<string, unknown>>();
  let nextModelInstallSeq = 1;
  /** The model option a completed model installation made active. */
  let activeModelOptionId = 'qwen3.5-0.8b-v1';
  const installStartedAtMs = new Map<string, number>();
  const installDownloadBytes = new Map<string, number>();
  const syncTimelineInstallation = (record: Record<string, unknown>): void => {
    const timeline = installOptions.installTimeline;
    if (!timeline || record['status'] !== 'running') return;
    const id = String(record['installationId'] ?? '');
    const startedAt = installStartedAtMs.get(id) ?? Date.now();
    const elapsed = Math.max(0, Date.now() - startedAt);
    const totalBytes = installDownloadBytes.get(id) ?? 10_500_000_000;
    if (elapsed < timeline.preparingMs) {
      record['status'] = 'running';
      record['progress'] = 0.05;
      record['downloadedBytes'] = null;
      record['downloadBytes'] = null;
      return;
    }
    if (elapsed < timeline.preparingMs + timeline.downloadMs) {
      const downloadElapsed = elapsed - timeline.preparingMs;
      const share = timeline.downloadMs > 0
        ? Math.min(1, Math.max(0, downloadElapsed / timeline.downloadMs))
        : 1;
      const downloadedBytes = totalBytes > 0
        ? Math.min(totalBytes - 1, Math.floor(totalBytes * share))
        : 0;
      record['status'] = 'running';
      record['downloadBytes'] = totalBytes;
      record['downloadedBytes'] = downloadedBytes;
      record['progress'] = totalBytes > 0 ? (downloadedBytes / totalBytes) * 0.9 : 0;
      return;
    }
    if (elapsed < timeline.preparingMs + timeline.downloadMs + timeline.installingMs) {
      record['status'] = 'running';
      record['downloadBytes'] = totalBytes;
      record['downloadedBytes'] = totalBytes;
      record['progress'] = 0.95;
      return;
    }
    record['status'] = 'completed';
    record['downloadBytes'] = totalBytes;
    record['downloadedBytes'] = totalBytes;
    record['progress'] = 1;
    const req = mutableRequirements.find(
      (item) => item['requirementId'] === record['requirementId'],
    );
    if (req) {
      req['status'] = 'ready';
    }
  };
  let cancelledOnce = false;
  let preferGpu = true;
  const historyId = 'a'.repeat(32);
  const libraryKey = 'capture-workbench.e2e-ocr-library';
  interface StoredDoc {
    documentId: string;
    fileName: string;
    mediaType: string;
    byteLength: number;
    createdAtMs: number;
    updatedAtMs: number;
    status: string;
    stage?: string;
    captureId?: string;
    captureOptions?: Record<string, unknown>;
    hasRaw?: boolean;
    pageCount?: number;
    durationMs?: number;
  }
  const historyDocument = (): StoredDoc => ({
    documentId: historyId,
    fileName: 'history.pdf',
    mediaType: 'application/pdf',
    byteLength: 2048,
    createdAtMs: 1,
    updatedAtMs: 1,
    status: 'completed',
    stage: 'completed',
    pageCount: 3,
  });
  let documents: StoredDoc[] = [historyDocument()];
  const rawByDocument = new Map<string, unknown>();
  const editsByDocument = new Map<string, Record<string, unknown>>();
  if (installOptions.editedResults) {
    rawByDocument.set(historyId, {
      sourceText: 'recognized page',
      segments: [
        { segmentId: 'page-3', order: 0, locator: { kind: 'page', page: 3 }, text: 'recognized page' },
      ],
      extractionEngine: {
        engine: 'text-recognition',
        model: 'pp-ocrv6-medium',
        digest: `sha256:${'d'.repeat(64)}`,
        device: 'directml',
      },
    });
    editsByDocument.set(historyId, { schemaVersion: 1, updatedAtMs: 1,
      ocrPages: { '3': 'Edited page three' }, transcriptLines: {}, speakerNames: { sp1: 'Named speaker' } });
    const recordingId = 'b'.repeat(32);
    documents.push({ ...historyDocument(), documentId: recordingId, fileName: 'meeting.mp3', mediaType: 'audio/mpeg', pageCount: undefined, durationMs: 65_000 });
    rawByDocument.set(recordingId, { sourceText: 'recognized line', speakers: [{ speakerId: 'sp1', displayName: 'Recognized speaker' }], segments: [
      { segmentId: 'line-1', order: 0, locator: { kind: 'time', startMs: 0, endMs: 1000 }, speaker: 'sp1', text: 'recognized line' },
    ] });
    editsByDocument.set(recordingId, { schemaVersion: 1, updatedAtMs: 1,
      ocrPages: {}, transcriptLines: { 'line-1': 'Edited transcript line' }, speakerNames: { sp1: 'Named speaker' } });
  }
  const rememberLibrary = (): void => {
    if (!installOptions.persistLibrary) return;
    sessionStorage.setItem(libraryKey, JSON.stringify({
      documents,
      raw: [...rawByDocument.entries()],
      edits: [...editsByDocument.entries()],
    }));
  };
  if (installOptions.persistLibrary) {
    try {
      const stored = sessionStorage.getItem(libraryKey);
      if (stored) {
        const parsed = JSON.parse(stored) as {
          documents?: StoredDoc[];
          raw?: readonly (readonly [string, unknown])[];
          edits?: readonly (readonly [string, Record<string, unknown>])[];
        };
        if (Array.isArray(parsed.documents) && parsed.documents.length > 0) {
          documents = parsed.documents;
        }
        for (const entry of parsed.raw ?? []) {
          if (Array.isArray(entry) && typeof entry[0] === 'string') {
            rawByDocument.set(entry[0], entry[1]);
          }
        }
        for (const [id, edits] of parsed.edits ?? []) editsByDocument.set(id, edits);
      }
    } catch {
      documents = [historyDocument()];
      rawByDocument.clear();
      editsByDocument.clear();
    }
    if (!documents.some((item) => item.documentId === historyId)) {
      documents = [historyDocument(), ...documents];
    }
  }
  const listedSummary = (document: StoredDoc): StoredDoc => {
    const hasRaw = rawByDocument.has(document.documentId) || document.hasRaw === true;
    const raw = rawByDocument.get(document.documentId) as {
      ocrPageScope?: { sourcePageCount?: number; processedPageNumbers?: readonly number[] };
      segments?: readonly { text: string; locator: { kind: string; page?: number; endMs?: number } }[];
    } | undefined;
    const summary = hasRaw ? { ...document, hasRaw: true } : { ...document };
    if (/^(audio|video)\//u.test(document.mediaType)) {
      const durationMs = Math.max(0, ...(raw?.segments ?? [])
        .filter((segment) => segment.locator.kind === 'time')
        .map((segment) => segment.locator.endMs ?? 0));
      delete summary.pageCount;
      if (durationMs > 0) summary.durationMs = durationMs;
    } else if (raw) {
      const pages = new Set([
        ...(raw.segments ?? []).filter((segment) =>
          segment.locator.kind === 'page' && segment.text.trim() !== '',
        ).map((segment) => segment.locator.page),
        ...(raw.ocrPageScope?.processedPageNumbers ?? []),
      ]);
      const chosen = document.captureOptions?.['pdfPageCount'];
      summary.pageCount = raw.ocrPageScope?.sourcePageCount
        ?? (pages.size > 0 ? pages.size :
          document.mediaType === 'application/pdf' ? (typeof chosen === 'number' ? chosen : undefined) : 1);
    }
    return summary;
  };
  let ocrPolls = 0;
  let activeOcrPages: readonly number[] | null = null;
  const ocrCaptureId = 'capture-ocr-1';
  const sourceSha = 'a'.repeat(64);
  const ocrJob = (status: string): Record<string, unknown> => ({
    protocolVersion: '2',
    ingestionId: 'ingestion-ocr-1',
    captureId: ocrCaptureId,
    partialRevision: 0,
    lastEventSequence: 0,
    createdAt: '2026-07-20T00:00:00Z',
    updatedAt: '2026-07-20T00:00:00Z',
    status,
    progress: status === 'extracting' ? 0.75 : 1,
    pagesDone: 9,
    pagesTotal: 12,
    source: {
      sha256: sourceSha,
      fileName: 'charge.pdf',
      mediaType: 'application/pdf',
      bytes: 12,
    },
  });
  const ocrProvenance = {
    status: 'resolved',
    engine: 'text-recognition',
    model: 'pp-ocrv6-medium',
    modelDigest: `sha256:${'d'.repeat(64)}`,
    device: 'RTX4060',
    profileId: 'profile-1',
    profileSpecSha256: 'e'.repeat(64),
  };
  const ocrProjection = (): Record<string, unknown> => {
    const pageNumbers = activeOcrPages ?? [1];
    return {
      apiVersion: '2.0',
      schemaVersion: '3',
      captureId: ocrCaptureId,
      status: 'completed',
      source: {
        sha256: sourceSha,
        fileName: 'charge.pdf',
        mediaType: 'application/pdf',
        bytes: 12,
      },
      pages: pageNumbers.map((page) => ({
        page,
        status: 'recognized',
        raster: { width: 1200, height: 800, scale: 1, coordinateSystem: 'pixel' },
        text: `OCR text ${page}`,
        boxes: [{
          polygon: [
            { x: 100, y: 120 },
            { x: 220, y: 120 },
            { x: 220, y: 160 },
            { x: 100, y: 160 },
          ],
          text: `OCR text ${page}`,
          confidence: 0.875,
        }],
        confidence: 0.875,
        provenance: ocrProvenance,
      })),
      processedPageCount: pageNumbers.length,
      runtimeVersion,
      contractSetSha256: 'a'.repeat(64),
      provenance: ocrProvenance,
      createdAt: '2026-07-20T00:00:00Z',
    };
  };
  const ocrRaw = (): Record<string, unknown> => {
    const pageNumbers = activeOcrPages ?? [1, 2];
    const pageText = (page: number) => page === 1 ? '第一頁' : page === 2 ? '第二頁' : `第 ${page} 頁`;
    return {
      schemaVersion: '2',
      diagnosticOnly: true,
      source: {
        sha256: sourceSha,
        fileName: 'charge.pdf',
        mediaType: 'application/pdf',
        bytes: 12,
      },
      segments: pageNumbers.map((page, index) => ({
        segmentId: `seg-${page}`,
        order: index,
        locator: { kind: 'page', page },
        text: pageText(page),
      })),
      sourceText: pageNumbers.map(pageText).join('\n'),
      extractionEngine: {
        engine: 'text-recognition',
        model: 'pp-ocrv6-medium',
        digest: `sha256:${'d'.repeat(64)}`,
        device: 'directml',
      },
      createdAt: '2026-07-20T00:00:00Z',
    };
  };

  for (const initial of installOptions.initialRunningInstallations ?? []) {
    const id = String(initial['installationId']);
    const record: Record<string, unknown> = { ...initial };
    installations.set(id, record);
    pollCounts.set(id, 0);
    if (installOptions.installTimeline) {
      installStartedAtMs.set(id, Date.now());
      const req = mutableRequirements.find(
        (item) => item['requirementId'] === initial['requirementId'],
      );
      const targetBytes =
        typeof initial['downloadBytes'] === 'number'
          ? (initial['downloadBytes'] as number)
          : typeof req?.['downloadBytes'] === 'number'
            ? (req['downloadBytes'] as number)
            : 10_500_000_000;
      installDownloadBytes.set(id, targetBytes);
      syncTimelineInstallation(record);
    }
  }

  target.isTauri = true;
  target.__captureInvokedCommands = [];
  target.__captureStartedRequirementIds = [];
  target.__captureCreatedPdfPageNumbers = [];
  target.__captureDropSources = (fileName) => sendBatch(batchFor(fileName));
  target.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main' },
    },
    transformCallback: (...args: unknown[]) => {
      const id = nextCallbackId++;
      const callback = args[0];
      if (typeof callback === 'function') {
        callbacks.set(id, callback as (eventData: unknown) => void);
      }
      return id;
    },
    invoke: (command: string, rawArgs?: unknown): Promise<unknown> => {
      target.__captureInvokedCommands.push(command);
      const args = (rawArgs ?? {}) as {
        readonly input?: {
          readonly id?: string;
          readonly installationId?: string;
          readonly requirementId?: string;
          readonly optionId?: string;
        };
        readonly request?: Record<string, unknown>;
        readonly update?: Record<string, unknown>;
        readonly onEvent?: { onmessage?: (batch: unknown) => void };
      };
      if (command === 'desktop_runtime_status') {
        return Promise.resolve({ status: 'ready', detail: 'Capture Runtime 已準備完成。' });
      }
      if (command === 'desktop_speech_gpu_status') {
        return Promise.resolve({
          cudaAvailable: Boolean(installOptions.cudaAvailable),
          preferGpu,
        });
      }
      if (command === 'desktop_set_speech_prefer_gpu') {
        const payload = rawArgs as { readonly preferGpu?: boolean } | undefined;
        preferGpu = Boolean(payload?.preferGpu);
        return Promise.resolve({
          cudaAvailable: Boolean(installOptions.cudaAvailable),
          preferGpu,
        });
      }
      if (command === 'runtime_ready') {
        return Promise.resolve({
          ready: true,
          service: 'capture-runtime',
          apiVersion: '2.0',
          runtimeVersion,
          captureDocumentSchemaVersion: '2',
          contractSetVersion: '2',
          capabilities: {
            captureKinds: ['pdf', 'image', 'recording'],
            structuringModes: ['runtime', 'host'],
            supportsCancellation: true,
            supportsRawDiagnostics: true,
            maxUploadBytes: 50 * 1024 * 1024,
            maxChunkBytes: 4 * 1024 * 1024,
            checkpointIntervalMs: 300_000,
            heartbeatIntervalMs: 5_000,
            stallTimeoutMs: 90_000,
            supportsProgressiveRecording: true,
          },
          ocrCompute: {
            apiVersion: '2.0',
            schemaVersion: '1',
            service: 'capture-runtime',
            runtimeVersion,
            contractSetVersion: '2',
            contractSetSha256: 'a'.repeat(64),
            workerSha256: 'b'.repeat(64),
            mode: 'gpu',
            adapterClass: 'dedicated',
            reasonCode: null,
            userNoticeRequired: false,
            noticeCode: null,
          },
        });
      }
      if (command === 'runtime_requirements') {
        return Promise.resolve({ items: mutableRequirements.map((item) => ({ ...item })) });
      }
      if (command === 'runtime_list_installations') {
        const listing = () => {
          if (installOptions.installTimeline) {
            for (const item of installations.values()) {
              syncTimelineInstallation(item);
            }
          }
          // Newest first, like the runtime.
          return { items: [...installations.values()].reverse().map((item) => ({ ...item })) };
        };
        const slowMs = installOptions.slowListingAfterNotFoundMs ?? 0;
        if (slowMs > 0 && statusNotFoundAnswered.size > 0) {
          return new Promise((resolve) => {
            setTimeout(() => resolve(listing()), slowMs);
          });
        }
        return Promise.resolve(listing());
      }
      if (command === 'runtime_start_installation') {
        const requirementId = String(args.input?.requirementId ?? 'speech-recognition');
        target.__captureStartedRequirementIds.push(requirementId);
        const startInstallation = (): Record<string, unknown> => {
          const installationId = `inst-${nextInstallSeq++}`;
          const req = mutableRequirements.find((item) => item['requirementId'] === requirementId);
          const downloadBytes =
            typeof req?.['downloadBytes'] === 'number' ? (req['downloadBytes'] as number) : 10_500_000_000;
          const record: Record<string, unknown> = {
            installationId,
            requirementId,
            status: 'running',
            progress: 0.5,
            downloadedBytes: Math.round(downloadBytes / 2),
            downloadBytes,
            createdAt: '2026-11-03T00:00:00Z',
            updatedAt: '2026-11-03T00:00:00Z',
          };
          installations.set(installationId, record);
          pollCounts.set(installationId, 0);
          if (installOptions.installTimeline) {
            installStartedAtMs.set(installationId, Date.now());
            installDownloadBytes.set(installationId, downloadBytes);
            syncTimelineInstallation(record);
          }
          return { ...record };
        };
        const rawDelay = installOptions.installTimeline?.startResponseMs ?? 0;
        const startResponseMs = Number.isFinite(rawDelay) && rawDelay > 0 ? rawDelay : 0;
        if (startResponseMs === 0) {
          return Promise.resolve(startInstallation());
        }
        // In the real runtime the installation exists only once the start request
        // is answered, so create the record and start the timeline clock then.
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(startInstallation());
          }, startResponseMs);
        });
      }
      if (command === 'runtime_get_installation') {
        const id = String(args.input?.id ?? args.input?.installationId ?? '');
        const record = installations.get(id);
        if (!record) {
          return Promise.reject(new Error('Capture Runtime request was rejected with HTTP 404.'));
        }
        const failure = statusRequestFailure(id);
        if (failure) return Promise.reject(failure);
        if (installOptions.installTimeline) {
          syncTimelineInstallation(record);
          return Promise.resolve({ ...record });
        }
        const count = (pollCounts.get(id) ?? 0) + 1;
        pollCounts.set(id, count);
        const holdRunning = Boolean(installOptions.holdRunningUntilCancel) && !cancelledOnce;
        const targetPolls = installOptions.completeInstallOnPoll ?? 1;
        if (!holdRunning && record['status'] === 'running' && count >= targetPolls) {
          record['status'] = 'completed';
          record['progress'] = 1;
          record['downloadedBytes'] = record['downloadBytes'];
          const req = mutableRequirements.find(
            (item) => item['requirementId'] === record['requirementId'],
          );
          if (req) {
            req['status'] = 'ready';
          }
        }
        return Promise.resolve({ ...record });
      }
      if (command === 'runtime_cancel_installation') {
        const id = String(args.input?.id ?? args.input?.installationId ?? '');
        cancelledOnce = true;
        const record = installations.get(id) ?? {
          installationId: id,
          requirementId: 'speech-recognition',
        };
        record['status'] = 'cancelled';
        installations.set(id, record);
        return Promise.resolve({ ...record });
      }
      if (command === 'runtime_uninstall_requirement') {
        const requirementId = String(args.input?.requirementId ?? '');
        const inUse = [...installations.values()].some((item) =>
          item['requirementId'] === requirementId
          && (item['status'] === 'queued' || item['status'] === 'running'));
        if (inUse) {
          return Promise.reject(
            new Error('Capture Runtime request was rejected with HTTP 409.'),
          );
        }
        return new Promise((resolve) => {
          setTimeout(() => {
            const req = mutableRequirements.find(
              (item) => item['requirementId'] === requirementId,
            );
            if (req) req['status'] = 'installable';
            resolve(req ? { ...req } : {
              requirementId,
              displayName: requirementId,
              status: 'installable',
              kind: requirementId,
              requiredFor: ['capture'],
              installStrategy: 'runtime-catalog',
              detail: null,
            });
          }, 1500);
        });
      }
      if (command === 'runtime_start_structuring_model_installation') {
        const installationId = `model-inst-${nextModelInstallSeq++}`;
        const record: Record<string, unknown> = {
          installationId,
          optionId: String(args.input?.optionId ?? ''),
          status: 'running',
          progress: 0.1,
          createdAt: '2026-11-03T00:00:00Z',
          updatedAt: '2026-11-03T00:00:00Z',
        };
        modelInstallations.set(installationId, record);
        return Promise.resolve({ ...record });
      }
      if (command === 'runtime_get_structuring_model_installation') {
        const id = String(args.input?.id ?? '');
        const record = modelInstallations.get(id);
        if (!record) {
          return Promise.reject(new Error('Capture Runtime request was rejected with HTTP 404.'));
        }
        const failure = statusRequestFailure(id);
        if (failure) {
          // A restarted runtime no longer has the model installation: later reads agree.
          if (failure.message.includes('HTTP 404')) modelInstallations.delete(id);
          return Promise.reject(failure);
        }
        // Each answered status request moves the download on by a tenth.
        if (record['status'] === 'running') {
          const progress = Math.min(1, Math.round((Number(record['progress'] ?? 0) + 0.1) * 10) / 10);
          record['progress'] = progress;
          if (progress >= 1) {
            record['status'] = 'completed';
            activeModelOptionId = String(record['optionId'] ?? activeModelOptionId);
          }
        }
        return Promise.resolve({ ...record });
      }
      if (command === 'runtime_structuring_model_options') {
        return Promise.resolve({
          catalogSha256: 'a'.repeat(64),
          items: [
            {
              optionId: 'qwen3.5-0.8b-v1',
              displayName: 'Qwen 3.5 0.8B',
              modelReference: 'qwen3.5:0.8b',
              expectedDigest: null,
              downloadBytes: null,
              profileId: 'qwen3.5-0.8b-structure-v1',
              profileSpecSha256: 'b'.repeat(64),
              status: activeModelOptionId === 'qwen3.5-0.8b-v1' ? 'active' : 'not-installed',
            },
            {
              optionId: 'qwen3.5-2b-v1',
              displayName: 'Qwen 3.5 2B',
              modelReference: 'qwen3.5:2b',
              expectedDigest: null,
              downloadBytes: null,
              profileId: 'qwen3.5-2b-structure-v1',
              profileSpecSha256: 'c'.repeat(64),
              status: activeModelOptionId === 'qwen3.5-2b-v1' ? 'active' : 'not-installed',
            },
            {
              optionId: 'qwen3.5-4b-v1',
              displayName: 'Qwen 3.5 4B',
              modelReference: 'qwen3.5:4b',
              expectedDigest: null,
              downloadBytes: null,
              profileId: 'qwen3.5-4b-structure-v1',
              profileSpecSha256: 'd'.repeat(64),
              status: activeModelOptionId === 'qwen3.5-4b-v1' ? 'active' : 'not-installed',
            },
          ],
        });
      }
      if (command === 'library_list') {
        return Promise.resolve(documents.map((item) => listedSummary(item)));
      }
      if (command === 'library_select_sources') return Promise.resolve(batchFor('charge.pdf'));
      if (command === 'library_watch_native_sources') {
        sourceChannel = args.onEvent;
        target.__captureNativeSourcesReady = true;
        return Promise.resolve(null);
      }
      if (command === 'library_discard_selections') {
        const tokens = args.request?.['selectionTokens'];
        if (Array.isArray(tokens)) for (const token of tokens) selected.delete(String(token));
        return Promise.resolve(null);
      }
      if (command === 'library_import_selection') {
        const request = args.request ?? {};
        const token = String(request['selectionToken'] ?? '');
        const selection = selected.get(token);
        if (!selection) return Promise.reject(new Error('Selected source is no longer available. Choose it again.'));
        selected.delete(token);
        const { fileName, mediaType } = selection;
        const options = request['captureOptions'];
        const pdfPageCount = options !== null && typeof options === 'object'
          ? (options as { readonly pdfPageCount?: unknown }).pdfPageCount
          : undefined;
        const pdfPageNumbers = options !== null && typeof options === 'object'
          ? (options as { readonly pdfPageNumbers?: unknown }).pdfPageNumbers
          : undefined;
        const document: StoredDoc = {
          documentId: selection.selectionToken,
          fileName,
          mediaType,
          byteLength: 12,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
          status: 'queued',
          stage: 'uploading',
          ...(typeof pdfPageCount === 'number'
            ? { captureOptions: { pdfPageCount } }
            : Array.isArray(pdfPageNumbers)
              ? { captureOptions: { pdfPageNumbers } }
              : {}),
        };
        documents = [
          document,
          ...documents.filter((item) => item.documentId !== document.documentId),
        ];
        rememberLibrary();
        return Promise.resolve(listedSummary(document));
      }
      if (command === 'library_get') {
        const documentId = String(args.request?.['documentId'] ?? '');
        const current = documents.find((item) => item.documentId === documentId);
        if (!current) return Promise.reject(new Error(`Unknown document: ${documentId}`));
        return Promise.resolve({
          ...listedSummary(current),
          ...(rawByDocument.has(documentId) ? { raw: rawByDocument.get(documentId) } : {}),
          ...(editsByDocument.has(documentId) ? { edits: editsByDocument.get(documentId) } : {}),
        });
      }
      if (command === 'library_export') {
        const documentId = String(args.request?.['documentId'] ?? '');
        const format = String(args.request?.['format'] ?? '');
        const pageLabel = String(args.request?.['pageLabel'] ?? '');
        const current = documents.find((item) => item.documentId === documentId);
        const raw = rawByDocument.get(documentId) as {
          sourceText: string;
          segments: readonly { segmentId: string; order: number; text: string; speaker?: string;
            locator: { kind: string; page?: number; startMs?: number; endMs?: number } }[];
        } | undefined;
        if (!current || !raw || !['text', 'markdown', 'srt', 'vtt', 'json'].includes(format)) {
          return Promise.reject(new Error('Export unavailable'));
        }
        const recording = /^(audio|video)\//u.test(current.mediaType);
        if (!recording && (format === 'srt' || format === 'vtt')) return Promise.reject(new Error('Recording required'));
        if ((format === 'text' || format === 'markdown') &&
          (pageLabel.length > 40 || pageLabel.split('{page}').length !== 2)) {
          return Promise.reject(new Error('Invalid page label'));
        }
        const edits = editsByDocument.get(documentId) as {
          ocrPages: Record<string, string>; transcriptLines: Record<string, string>; speakerNames: Record<string, string>;
        } | undefined;
        const segments = [...raw.segments].sort((a, b) => a.order - b.order);
        const time = (ms: number): string => {
          const value = Math.max(0, Math.floor(ms));
          return `${String(Math.floor(value / 3600000)).padStart(2, '0')}:${String(Math.floor(value / 60000) % 60).padStart(2, '0')}:${String(Math.floor(value / 1000) % 60).padStart(2, '0')}${format === 'srt' ? ',' : '.'}${String(value % 1000).padStart(3, '0')}`;
        };
        let content: string;
        if (format === 'json') content = JSON.stringify(raw);
        else if (format === 'srt' || format === 'vtt') {
          content = (format === 'vtt' ? 'WEBVTT\n\n' : '') + segments.map((segment, index) =>
            `${index + 1}\n${time(segment.locator.startMs ?? 0)} --> ${time(segment.locator.endMs ?? 0)}\n${edits?.transcriptLines[segment.segmentId] ?? segment.text}\n`,
          ).join('\n');
        } else if (recording) {
          content = segments.map((segment) => {
            const name = segment.speaker ? edits?.speakerNames[segment.speaker] ?? segment.speaker : '';
            return `${name ? `${name}: ` : ''}${edits?.transcriptLines[segment.segmentId] ?? segment.text}`;
          }).join('\n');
        } else {
          const pages = [...new Set(segments.filter((segment) => segment.locator.kind === 'page').map((segment) => segment.locator.page ?? 1))].sort((a, b) => a - b);
          content = pages.map((number) => {
            const text = edits?.ocrPages[String(number)] ?? segments.filter((segment) => segment.locator.page === number).map((segment) => segment.text).join('\n');
            return `${format === 'markdown' ? '## ' : ''}${pageLabel.replace('{page}', String(number))}\n\n${text}`;
          }).join('\n\n') || raw.sourceText;
        }
        const extensions: Readonly<Record<string, string>> = { text: 'txt', markdown: 'md', srt: 'srt', vtt: 'vtt', json: 'json' };
        const mediaTypes: Readonly<Record<string, string>> = { text: 'text/plain', markdown: 'text/markdown', srt: 'application/x-subrip', vtt: 'text/vtt', json: 'application/json' };
        const extension = extensions[format];
        const mediaType = mediaTypes[format];
        return Promise.resolve({ fileName: `${current.fileName.replace(/\.[^.]+$/u, '')}.${extension}`, mediaType, content });
      }
      if (command === 'library_save_edits') {
        const documentId = String(args.request?.['documentId'] ?? '');
        if (!documents.some((item) => item.documentId === documentId)) return Promise.reject(new Error('Unknown document'));
        if (!rawByDocument.has(documentId)) return Promise.reject(new Error('edits require a raw result.'));
        const maps = args.request?.['edits'] as {
          ocrPages: Record<string, string>; transcriptLines: Record<string, string>; speakerNames: Record<string, string>;
        };
        const edits = { ...maps, schemaVersion: 1, updatedAtMs: Date.now() };
        if ([maps.ocrPages, maps.transcriptLines, maps.speakerNames].every((map) => Object.keys(map).length === 0)) editsByDocument.delete(documentId);
        else editsByDocument.set(documentId, edits);
        rememberLibrary();
        return Promise.resolve(edits);
      }
      if (command === 'library_delete') {
        const documentId = String(args.request?.['documentId'] ?? '');
        documents = documents.filter((item) => item.documentId !== documentId);
        rawByDocument.delete(documentId);
        editsByDocument.delete(documentId);
        rememberLibrary();
        return Promise.resolve(null);
      }
      if (command === 'library_source_bytes') {
        const documentId = String(args.request?.['documentId'] ?? '');
        const current = documents.find((item) => item.documentId === documentId);
        if (!current) return Promise.reject(new Error(`Unknown document: ${documentId}`));
        if (current.mediaType === 'application/pdf') {
          const binary = atob(pdfFixtureBase64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
          }
          return Promise.resolve(bytes.buffer);
        }
        return Promise.resolve(
          new Uint8Array([
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0,
            0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10,
            73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180,
            0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
          ]).buffer,
        );
      }
      if (command === 'library_update_capture') {
        const update = args.update ?? {};
        const documentId = String(update['documentId'] ?? '');
        const current = documents.find((item) => item.documentId === documentId);
        if (!current) return Promise.reject(new Error(`Unknown document: ${documentId}`));
        if (update['raw'] !== undefined && update['raw'] !== null) {
          if (rawByDocument.has(documentId)) editsByDocument.delete(documentId);
          rawByDocument.set(documentId, update['raw']);
          current.hasRaw = true;
        }
        if (typeof update['status'] === 'string') current.status = update['status'];
        if (typeof update['stage'] === 'string') current.stage = update['stage'];
        if (typeof update['captureId'] === 'string') current.captureId = update['captureId'];
        if (update['clearCaptureId'] === true) delete current.captureId;
        current.updatedAtMs = Date.now();
        rememberLibrary();
        return Promise.resolve(listedSummary(current));
      }
      if (installOptions.ocrJourney && command === 'runtime_create_capture') {
        ocrPolls = 0;
        const input = (args.input ?? {}) as { readonly pdfPageNumbers?: readonly number[] };
        activeOcrPages = Array.isArray(input.pdfPageNumbers) ? [...input.pdfPageNumbers] : null;
        target.__captureCreatedPdfPageNumbers.push(activeOcrPages);
        return Promise.resolve(ocrJob('extracting'));
      }
      if (installOptions.ocrJourney && command === 'runtime_get_capture') {
        ocrPolls += 1;
        if (ocrPolls <= 4) return Promise.resolve(ocrJob('extracting'));
        return Promise.resolve(ocrJob('awaiting_structuring'));
      }
      if (installOptions.ocrJourney && command === 'runtime_get_raw') {
        return Promise.resolve(ocrRaw());
      }
      if (installOptions.ocrJourney && command === 'runtime_get_ocr') {
        return Promise.resolve(ocrProjection());
      }
      if (installOptions.ocrJourney && command === 'runtime_delete_capture') {
        return Promise.resolve(null);
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    },
  };
}

export function fakeRequirement(
  requirementId: string,
  displayName: string,
  status: string,
  downloadBytes?: number,
): Record<string, unknown> {
  return {
    requirementId,
    displayName,
    status,
    kind: requirementId,
    requiredFor: ['capture'],
    installStrategy: 'runtime-catalog',
    detail: '需要使用者同意後才能安裝。',
    ...(downloadBytes !== undefined ? { downloadBytes } : {}),
  };
}
