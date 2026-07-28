import { Injectable, computed, inject, signal } from '@angular/core';
import {
  type CaptureJobV1,
  type CaptureRequirementId,
  type CaptureSourceKind,
  type RuntimeInstallationV1,
  type RuntimeRequirementV1,
} from '@gx-capture/capture-workbench';
import { firstValueFrom } from 'rxjs';
import type { DesktopLibraryDetail, DesktopLibrarySummary } from '../contracts';
import { DesktopLibraryService } from './desktop-library.service';
import { DesktopCaptureClient, DesktopRuntimeClientService } from './desktop-runtime-client.service';

type WorkspaceState = 'starting' | 'needs-setup' | 'ready' | 'error';

const CORE_REQUIREMENTS = new Set([
  'windowsml-ocr',
  'ollama-runtime',
  'capture-ollama-model',
]);

@Injectable({ providedIn: 'root' })
export class DesktopWorkspaceStore {
  readonly state = signal<WorkspaceState>('starting');
  readonly message = signal('正在連線到 Capture Runtime…');
  readonly requirements = signal<readonly RuntimeRequirementV1[]>([]);
  readonly documents = signal<readonly DesktopLibrarySummary[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly selected = signal<DesktopLibraryDetail | null>(null);
  readonly query = signal('');
  readonly statusFilter = signal('');
  readonly installing = signal(false);
  readonly activeInstallation = signal<RuntimeInstallationV1 | null>(null);
  readonly busyIds = signal<ReadonlySet<string>>(new Set());
  readonly requestedRequirements = signal<ReadonlySet<CaptureRequirementId>>(new Set());
  readonly canCapture = computed(() => this.state() === 'ready' && !this.installing());
  readonly coreMissing = computed(() =>
    this.requirements().filter(
      (requirement) =>
        (CORE_REQUIREMENTS.has(requirement.requirementId)
          || this.requestedRequirements().has(requirement.requirementId))
        && requirement.status !== 'ready',
    ),
  );

  private client?: DesktopCaptureClient;
  private readonly controllers = new Map<string, AbortController>();

  private readonly runtime = inject(DesktopRuntimeClientService);
  private readonly library = inject(DesktopLibraryService);

  async initialize(): Promise<void> {
    try {
      this.client = await this.runtime.getClient();
      await Promise.all([this.refreshRequirements(), this.refreshDocuments()]);
      this.state.set(this.coreMissing().length === 0 ? 'ready' : 'needs-setup');
      this.message.set(
        this.state() === 'ready'
          ? 'Capture Runtime 已準備完成，可以開始處理文件。'
          : '首次準備：請先同意安裝核心需求，才能進行 OCR 與結構化。',
      );
    } catch (error) {
      this.state.set('error');
      this.message.set(errorMessage(error));
    }
  }

  async refreshDocuments(): Promise<void> {
    try {
      this.documents.set(await this.library.list(this.query(), this.statusFilter()));
    } catch (error) {
      this.message.set(errorMessage(error));
    }
  }

  async select(documentId: string): Promise<void> {
    this.selectedId.set(documentId);
    try {
      this.selected.set(await this.library.get(documentId));
    } catch (error) {
      this.message.set(errorMessage(error));
    }
  }

  async updateQuery(query: string): Promise<void> {
    this.query.set(query);
    await this.refreshDocuments();
  }

  async updateStatusFilter(status: string): Promise<void> {
    this.statusFilter.set(status);
    await this.refreshDocuments();
  }

  async installCoreRequirements(): Promise<void> {
    if (!this.client || this.installing()) return;
    this.installing.set(true);
    try {
      for (const requirement of this.coreMissing()) {
        await this.installRequirement(requirement);
      }
      await this.refreshRequirements();
      this.state.set(this.coreMissing().length === 0 ? 'ready' : 'needs-setup');
      this.message.set(
        this.state() === 'ready'
          ? '核心需求已完成，現在可以處理文件。'
          : '仍有需求無法完成。請依畫面的指引修復後再試。',
      );
    } catch (error) {
      this.state.set('needs-setup');
      this.message.set(errorMessage(error));
    } finally {
      this.installing.set(false);
      this.activeInstallation.set(null);
    }
  }

  async addFiles(files: FileList | readonly File[]): Promise<void> {
    if (!this.client || !this.canCapture()) return;
    for (const file of Array.from(files)) {
      const sourceKind = sourceKindFor(file);
      if (!sourceKind) {
        this.message.set(`不支援「${file.name}」的檔案類型。`);
        continue;
      }
      if (sourceKind === 'audio' && !this.audioReady()) {
        this.requestedRequirements.update((current) => new Set([...current, 'whisper-primary']));
        this.state.set('needs-setup');
        this.message.set('音訊需要先安裝 Whisper 模型。');
        continue;
      }
      await this.captureNewFile(file);
    }
  }

  async retry(documentId: string): Promise<void> {
    if (!this.client || !this.canCapture()) return;
    try {
      await this.captureExisting(documentId);
    } catch (error) {
      this.message.set(errorMessage(error));
    }
  }

  async cancel(documentId: string): Promise<void> {
    this.controllers.get(documentId)?.abort();
  }

  async delete(documentId: string): Promise<void> {
    if (!globalThis.confirm('確定要刪除此文件及其保存的來源、OCR 與結構化結果嗎？')) return;
    try {
      await this.library.delete(documentId);
      if (this.selectedId() === documentId) {
        this.selectedId.set(null);
        this.selected.set(null);
      }
      await this.refreshDocuments();
    } catch (error) {
      this.message.set(errorMessage(error));
    }
  }

  async export(documentId: string, format: 'json' | 'text'): Promise<void> {
    try {
      const exported = await this.library.export(documentId, format);
      const blob = new Blob([exported.content], { type: exported.mediaType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = exported.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      this.message.set(errorMessage(error));
    }
  }

  formatBytes(bytes: number): string {
    return bytes < 1_000_000 ? `${Math.ceil(bytes / 1_000)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
  }

  formatDate(milliseconds: number): string {
    return new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(milliseconds);
  }

  stageLabel(stage?: string): string {
    return ({
      uploading: '正在上傳來源',
      queued: '等待處理',
      extracting: '正在進行 OCR',
      awaiting_structuring: '等待結構化',
      structuring: '正在使用 Ollama 結構化',
      completed: '已完成',
      failed: '處理失敗',
      cancelled: '已取消',
    } as Record<string, string>)[stage ?? ''] ?? '等待處理';
  }

  statusLabel(status: DesktopLibrarySummary['status']): string {
    return ({
      queued: '等待處理',
      processing: '處理中',
      awaiting_confirmation: '等待確認',
      completed: '已完成',
      failed: '處理失敗',
      canceled: '已取消',
    } as Record<DesktopLibrarySummary['status'], string>)[status];
  }

  private async captureNewFile(file: File): Promise<void> {
    try {
      const document = await this.library.createSource(file);
      await this.refreshDocuments();
      await this.select(document.documentId);
      await this.captureExisting(document.documentId);
    } catch (error) {
      this.message.set(errorMessage(error));
    }
  }

  private async captureExisting(documentId: string): Promise<void> {
    if (!this.client) return;
    const controller = new AbortController();
    let runtimeCaptureId: string | undefined;
    this.controllers.set(documentId, controller);
    this.markBusy(documentId, true);
    try {
      await this.library.updateCapture({ documentId, status: 'processing', stage: 'uploading' });
      const job = await firstValueFrom(this.client.createCapture(
        documentId,
        crypto.randomUUID(),
        controller.signal,
      ));
      runtimeCaptureId = job.captureId;
      const terminal = await this.waitForTerminal(documentId, job, controller.signal);
      await this.persistTerminal(documentId, terminal, controller.signal);
      await this.refreshDocuments();
      await this.select(documentId);
    } catch (error) {
      await this.library.updateCapture({
        documentId,
        status: controller.signal.aborted ? 'canceled' : 'failed',
        stage: controller.signal.aborted ? 'cancelled' : 'failed',
        errorCode: controller.signal.aborted ? 'cancelled' : 'capture_failed',
        errorMessage: controller.signal.aborted ? '使用者已取消處理。' : errorMessage(error),
      });
      await this.refreshDocuments();
      await this.select(documentId);
    } finally {
      if (runtimeCaptureId) {
        await firstValueFrom(this.client.deleteCapture(runtimeCaptureId)).catch(() => undefined);
      }
      this.controllers.delete(documentId);
      this.markBusy(documentId, false);
    }
  }

  private async waitForTerminal(
    documentId: string,
    initial: CaptureJobV1,
    signal: AbortSignal,
  ): Promise<CaptureJobV1> {
    if (!this.client) throw new Error('Capture Runtime 尚未準備完成。');
    let job = initial;
    while (job.status === 'queued' || job.status === 'running') {
      if (signal.aborted) {
        await firstValueFrom(this.client.cancelCapture(job.captureId, signal));
        throw new DOMException('處理已取消。', 'AbortError');
      }
      await this.library.updateCapture({ documentId, captureId: job.captureId, status: 'processing', stage: job.stage });
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 700));
      job = await firstValueFrom(this.client.getCapture(job.captureId, signal));
    }
    return job;
  }

  private async persistTerminal(
    documentId: string,
    job: CaptureJobV1,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.client) throw new Error('Capture Runtime 尚未準備完成。');
    const raw = await firstValueFrom(this.client.getRaw(job.captureId, signal));
    if (job.status === 'completed') {
      const result = await firstValueFrom(this.client.getResult(job.captureId, signal));
      await this.library.updateCapture({ documentId, captureId: job.captureId, status: 'completed', stage: 'completed', raw, result });
    } else {
      await this.library.updateCapture({
        documentId,
        captureId: job.captureId,
        status: job.status === 'cancelled' ? 'canceled' : 'failed',
        stage: job.stage,
        raw,
        errorCode: job.error?.code,
        errorMessage: job.error?.message,
      });
    }
  }

  private async refreshRequirements(): Promise<void> {
    if (!this.client) return;
    this.requirements.set(await firstValueFrom(this.client.getRequirements()));
  }

  private async installRequirement(requirement: RuntimeRequirementV1): Promise<void> {
    if (!this.client) return;
    if (requirement.status === 'manual_action_required') {
      throw new Error(`${requirement.displayName} 需要手動修復：${requirement.detail ?? '請檢查系統安裝指引。'}`);
    }
    const requirementId = requirement.requirementId;
    let installation = await firstValueFrom(this.client.startInstallation({
      clientRequestId: crypto.randomUUID(), requirementId, consent: true,
    }));
    while (installation.status === 'queued' || installation.status === 'running') {
      this.activeInstallation.set(installation);
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 750));
      installation = await firstValueFrom(this.client.getInstallation(installation.installationId));
    }
    this.activeInstallation.set(installation);
    if (installation.status !== 'completed') {
      throw new Error(installation.error?.message ?? `${requirementId} 安裝失敗。`);
    }
  }

  private audioReady(): boolean {
    return this.requirements().some(
      (requirement) => requirement.requirementId === 'whisper-primary' && requirement.status === 'ready',
    );
  }

  private markBusy(documentId: string, busy: boolean): void {
    this.busyIds.update((current) => {
      const next = new Set(current);
      if (busy) next.add(documentId); else next.delete(documentId);
      return next;
    });
  }
}

function sourceKindFor(file: File): CaptureSourceKind | null {
  return sourceKindForMediaType(file.type);
}

function sourceKindForMediaType(mediaType: string): CaptureSourceKind | null {
  if (mediaType === 'application/pdf') return 'pdf';
  if (mediaType.startsWith('image/')) return 'image';
  if (mediaType.startsWith('audio/')) return 'audio';
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
