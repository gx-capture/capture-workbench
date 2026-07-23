import { Injectable, OnDestroy, signal } from '@angular/core';
import {
  type CaptureClient,
  type RuntimeInstallationV1,
  type RuntimeRequirementV1,
} from '../contracts';
import { MAX_INSTALLATIONS_PER_USER_ACTION } from '../constants';

@Injectable()
export class CaptureRuntimeInstallationService implements OnDestroy {
  readonly installation = signal<RuntimeInstallationV1 | null>(null);
  readonly error = signal<string | undefined>(undefined);
  private controller?: AbortController;

  ngOnDestroy(): void {
    this.controller?.abort();
  }

  clearError(): void {
    this.error.set(undefined);
  }

  async install(options: {
    readonly client: CaptureClient | null;
    readonly requirements: () => readonly RuntimeRequirementV1[];
    readonly pollIntervalMs: () => number;
    readonly reload: () => Promise<void>;
  }): Promise<void> {
    const { client } = options;
    if (!client || this.installation()) return;
    const installable = () =>
      options.requirements().filter((requirement) => requirement.status === 'installable');
    if (installable().length === 0) return;

    this.controller = new AbortController();
    const signal = this.controller.signal;
    const completedRequirementIds = new Set<string>();
    const requestIds = new Map<string, string>();
    let installationsStarted = 0;
    try {
      while (installationsStarted < MAX_INSTALLATIONS_PER_USER_ACTION) {
        const requirement = installable().find(
          (candidate) => !completedRequirementIds.has(candidate.requirementId),
        );
        if (!requirement) break;

        const request = {
          clientRequestId:
            requestIds.get(requirement.requirementId) ?? crypto.randomUUID(),
          requirementId: requirement.requirementId,
          consent: true,
        } as const;
        requestIds.set(requirement.requirementId, request.clientRequestId);
        installationsStarted += 1;

        let installation = await retryUncertainResponse(
          () => client.startInstallation(request, signal),
          signal,
        );
        this.installation.set(installation);
        while (installation.status === 'queued' || installation.status === 'running') {
          await abortableDelay(options.pollIntervalMs(), signal);
          installation = await client.getInstallation(installation.installationId, signal);
          this.installation.set(installation);
        }
        if (installation.status !== 'completed') break;
        completedRequirementIds.add(requirement.requirementId);
        this.installation.set(null);
        await options.reload();
      }

      if (
        installationsStarted === MAX_INSTALLATIONS_PER_USER_ACTION &&
        installable().some(
          (requirement) => !completedRequirementIds.has(requirement.requirementId),
        )
      ) {
        throw new Error('Runtime installation stopped after reaching the safety limit.');
      }
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        this.error.set(errorMessage(error, 'Runtime installation failed.'));
      }
    } finally {
      this.controller = undefined;
      if (this.installation()?.status === 'completed') this.installation.set(null);
      await options.reload();
    }
  }

  async cancel(client: CaptureClient | null): Promise<void> {
    const installation = this.installation();
    if (!installation || !client) return;
    this.controller?.abort();
    try {
      this.installation.set(await client.cancelInstallation(installation.installationId));
    } catch (error: unknown) {
      this.error.set(errorMessage(error, 'Unable to cancel runtime installation.'));
    }
  }
}

function retryUncertainResponse<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return operation().catch((error: unknown) => {
    throwIfAborted(signal);
    if (!isUncertainResponseFailure(error)) throw error;
    return operation();
  });
}

function isUncertainResponseFailure(error: unknown): boolean {
  if (isAbortError(error)) return false;
  const candidate = error as { readonly status?: unknown; readonly code?: unknown };
  if (candidate?.code === 'invalid_response') return true;
  if (typeof candidate?.status === 'number') return candidate.status === 0 || candidate.status >= 500;
  return error instanceof TypeError;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(createAbortError());
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(createAbortError());
      },
      { once: true },
    );
  });
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createAbortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
