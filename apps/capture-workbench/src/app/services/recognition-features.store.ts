import {
  computed,
  DestroyRef,
  effect,
  Injectable,
  inject,
  signal,
} from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize } from 'rxjs';
import type {
  CaptureRequirementId,
  RuntimeInstallation,
  RuntimeModelOption,
  RuntimeRequirement,
} from '@gx-capture/capture-workbench-ui';
import { DesktopRuntimeClientService } from './desktop-runtime-client.service';
import { DesktopWorkspaceInstallationService } from './desktop-workspace-installation.service';
import {
  activeModelOption as selectActiveModelOption,
  errorMessage,
  installationPercent,
  uninstallFailureMessage,
  isFeatureReady,
  modelInstallationPercent,
  modelInstallationPhase,
  modelSelectionRequired as selectModelSelectionRequired,
  type RecognitionFeature,
  selectFeatureMissing,
  selectInstallableRequirements,
  selectRecognitionEngines,
  selectRequestedMissing,
  selectSpeechPack,
} from './desktop-workspace.selectors';
import { desktopMessages } from '../i18n/desktop-messages';

export const FIRST_RUN_DISMISSED_STORAGE_KEY =
  'capture-workbench.first-run-dismissed';

const FIRST_RUN_UNIT_IDS: readonly CaptureRequirementId[] = [
  'windowsml-ocr',
  'speech-recognition',
  'speaker-diarization',
];

function readFirstRunDismissed(): boolean {
  try {
    return (
      globalThis.localStorage?.getItem(FIRST_RUN_DISMISSED_STORAGE_KEY) ===
      'true'
    );
  } catch {
    return false;
  }
}

@Injectable({ providedIn: 'root' })
/**
 * Recognition features state: runtime requirements, per-feature readiness,
 * unit installations, first-run choice, and re-attaching after a reload.
 */
export class RecognitionFeaturesStore {
  private readonly runtime = inject(DesktopRuntimeClientService);
  private readonly installation = inject(DesktopWorkspaceInstallationService);
  private readonly destroyRef = inject(DestroyRef);

  readonly runtimeStarted = this.runtime.started;
  readonly installing = this.installation.installing;
  readonly activeInstallation = this.installation.activeInstallation;
  readonly activeModelInstallation = this.installation.activeModelInstallation;
  readonly selectedModelOptionId = this.installation.selectedModelOptionId;
  readonly installationPercent = computed(() =>
    installationPercent(this.activeInstallation()),
  );
  readonly modelInstallationPercent = computed(() =>
    modelInstallationPercent(this.activeModelInstallation()),
  );
  readonly modelInstallationPhase = computed(() =>
    modelInstallationPhase(this.activeModelInstallation()),
  );

  readonly requestedRequirements = signal<ReadonlySet<CaptureRequirementId>>(
    new Set(),
  );
  readonly message = signal('');
  readonly firstRunDismissed = signal<boolean>(readFirstRunDismissed());
  private readonly removingIds = signal<ReadonlySet<CaptureRequirementId>>(
    new Set(),
  );
  private readonly removalErrors = signal<
    ReadonlyMap<CaptureRequirementId, string>
  >(new Map());
  /**
   * Requirement returned by uninstall. It covers the runtime list until that
   * list leaves `ready`, so readiness updates before the reload lands.
   */
  private readonly uninstalled = signal<
    ReadonlyMap<CaptureRequirementId, RuntimeRequirement>
  >(new Map());

  private reattachedForStart = false;

  readonly requirementsResource = rxResource<
    readonly RuntimeRequirement[],
    { readonly ready: true } | undefined
  >({
    defaultValue: [],
    params: () => (this.runtimeStarted() ? { ready: true } : undefined),
    stream: ({ abortSignal }) => this.runtime.getRequirements(abortSignal),
  });

  readonly modelOptionsResource = rxResource<
    readonly RuntimeModelOption[],
    { readonly ready: true } | undefined
  >({
    defaultValue: [],
    params: () => (this.runtimeStarted() ? { ready: true } : undefined),
    stream: ({ abortSignal }) => this.runtime.getModelOptions(abortSignal),
  });

  readonly requirements = computed(() => {
    const listed = this.requirementsResource.value();
    const removed = this.uninstalled();
    if (removed.size === 0) return listed;
    return listed.map((item) => {
      const override = removed.get(item.requirementId);
      if (!override || item.status !== 'ready') return item;
      return override;
    });
  });

  get modelOptions() {
    return this.modelOptionsResource.value;
  }

  readonly ocrReady = computed(() => isFeatureReady(this.requirements(), 'ocr'));
  readonly asrReady = computed(() => isFeatureReady(this.requirements(), 'asr'));
  readonly speakersReady = computed(() =>
    isFeatureReady(this.requirements(), 'asr.speakers'),
  );

  readonly engines = computed(() =>
    selectRecognitionEngines(this.requirements()),
  );
  readonly speechPack = computed(() => selectSpeechPack(this.requirements()));
  readonly requestedMissing = computed(() =>
    selectRequestedMissing(this.requirements(), this.requestedRequirements()),
  );
  readonly installableRequestedRequirements = computed(() =>
    selectInstallableRequirements(
      this.requirements(),
      this.requestedRequirements(),
    ),
  );
  readonly modelSelectionRequired = computed(() =>
    selectModelSelectionRequired(this.modelOptions()),
  );
  readonly activeModelOption = computed(() =>
    selectActiveModelOption(this.modelOptions()),
  );

  readonly firstRunInstallableUnits = computed(() =>
    selectInstallableRequirements(this.requirements(), FIRST_RUN_UNIT_IDS),
  );
  readonly showFirstRunCard = computed(
    () =>
      !this.firstRunDismissed() &&
      (this.firstRunInstallableUnits().length > 0 || this.installing()),
  );

  /**
   * Drops an uninstall overlay once the runtime list no longer says ready.
   * A finished reinstall drops it in installRequirements, so the next ready
   * state is not stuck on not-installed.
   */
  private readonly releaseUninstalledOverlay = effect(() => {
    const removed = this.uninstalled();
    if (removed.size === 0) return;
    const listed = this.requirementsResource.value();
    if (listed.length === 0) return;
    const stale = [...removed.keys()].filter((requirementId) => {
      const listedUnit = listed.find(
        (item) => item.requirementId === requirementId,
      );
      return !listedUnit || listedUnit.status !== 'ready';
    });
    if (stale.length === 0) return;
    this.forgetUninstalled(stale);
  });

  private readonly reattachEffect = effect(() => {
    const started = this.runtimeStarted();
    if (!started) {
      this.reattachedForStart = false;
      return;
    }
    if (this.reattachedForStart) return;
    this.reattachedForStart = true;
    this.reattachInstallations();
  });

  /** Reloads requirements, model options, and re-attaches any running installation. */
  initialize(): void {
    this.firstRunDismissed.set(readFirstRunDismissed());
    this.requirementsResource.reload();
    this.modelOptionsResource.reload();
    if (this.runtimeStarted()) {
      this.reattachedForStart = true;
      this.reattachInstallations();
    }
  }

  /** Checks whether all requirement units for a feature are ready. */
  isFeatureReady(feature: RecognitionFeature): boolean {
    return isFeatureReady(this.requirements(), feature);
  }

  /** Returns requirement units for a feature that are not yet ready. */
  missingFor(feature: RecognitionFeature): readonly RuntimeRequirement[] {
    return selectFeatureMissing(this.requirements(), feature);
  }

  /** Latest installation record for a requirement unit, if any. */
  installationFor(
    requirementId: CaptureRequirementId,
  ): RuntimeInstallation | null {
    return this.installation.installationFor(requirementId);
  }

  /** Installs one recognition unit chosen by the user. */
  installUnit(requirementId: CaptureRequirementId): void {
    this.installUnits([requirementId]);
  }

  /** Installs the selected recognition units in deterministic order. */
  installUnits(requirementIds: readonly CaptureRequirementId[]): void {
    const installable = selectInstallableRequirements(
      this.requirements(),
      requirementIds,
    );
    this.installRequirements(installable);
  }

  /** Installs all requested missing units in deterministic order. */
  installRequestedRequirements(): void {
    this.installRequirements(this.installableRequestedRequirements());
  }

  /**
   * Retries a failed or cancelled installation; the runtime reuses the
   * files it already verified (they are cached by SHA-256).
   */
  retryInstallation(requirementId: CaptureRequirementId): void {
    this.installUnits([requirementId]);
  }

  /** True while this unit's uninstall request is in flight. */
  isRemoving(requirementId: CaptureRequirementId): boolean {
    return this.removingIds().has(requirementId);
  }

  /** The last uninstall error for this unit, if the runtime still reports it. */
  removalError(requirementId: CaptureRequirementId): string | null {
    return this.removalErrors().get(requirementId) ?? null;
  }

  /**
   * Removes an installed engine after the user confirms.
   * Refuses while that unit is installing; a capture in progress is refused
   * by the runtime and shown on the row.
   */
  removeUnit(requirementId: CaptureRequirementId): void {
    if (this.removingIds().has(requirementId)) return;
    const installation = this.installation.installationFor(requirementId);
    if (
      installation?.status === 'queued' ||
      installation?.status === 'running'
    ) {
      return;
    }
    if (!this.runtimeStarted()) return;
    const unit = this.requirements().find(
      (item) => item.requirementId === requirementId,
    );
    if (!unit || unit.status !== 'ready') return;
    this.removingIds.update(
      (current) => new Set([...current, requirementId]),
    );
    this.clearRemovalError(requirementId);
    this.runtime
      .uninstallRequirement(requirementId)
      .pipe(
        finalize(() => {
          this.removingIds.update((current) => {
            if (!current.has(requirementId)) return current;
            const next = new Set(current);
            next.delete(requirementId);
            return next;
          });
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (requirement) => {
          this.clearRemovalError(requirementId);
          this.rememberUninstalled(requirementId, requirement);
          this.requirementsResource.reload();
          this.runtime.reload();
        },
        error: (error: unknown) => {
          this.removalErrors.update((current) => {
            const next = new Map(current);
            next.set(requirementId, uninstallFailureMessage(error));
            return next;
          });
          this.requirementsResource.reload();
        },
      });
  }

  /** Cancels a running installation and stops the rest of its install queue. */
  cancelInstallation(installationId?: string): void {
    this.installation.cancelInstallation$(installationId).subscribe({
      next: () => {
        this.requirementsResource.reload();
      },
      error: (error: unknown) => {
        this.message.set(errorMessage(error));
        // Polling stopped with the cancel; pick the installation up again.
        this.reattachInstallations();
      },
    });
  }

  /** Remembers that the user dismissed the first-run setup card. */
  dismissFirstRun(): void {
    this.firstRunDismissed.set(true);
    try {
      globalThis.localStorage?.setItem(FIRST_RUN_DISMISSED_STORAGE_KEY, 'true');
    } catch {
      // Dismissal still applies for this session when storage is unavailable.
    }
  }

  /** Remembers the first-run choice and installs the selected units. */
  installFirstRunSelection(
    requirementIds: readonly CaptureRequirementId[],
  ): void {
    this.dismissFirstRun();
    this.installUnits(requirementIds);
  }

  /** Offer an optional unit that a finished capture said it missed. */
  requestUnit(requirementId: CaptureRequirementId): void {
    this.requestedRequirements.update(
      (current) => new Set([...current, requirementId]),
    );
  }

  /** Selects the model option used by the next installation command. */
  selectModelOption(optionId: string): void {
    this.installation.selectModelOption(optionId);
  }

  /** Starts the selected model installation and refreshes dependent resources. */
  installSelectedModel(): void {
    const optionId = this.selectedModelOptionId();
    if (!this.runtimeStarted() || this.installing() || !optionId) return;
    this.installation
      .installSelectedModel$(optionId)
      .pipe(
        finalize(() => {
          this.modelOptionsResource.reload();
          this.requirementsResource.reload();
        }),
      )
      .subscribe({
        error: (error: unknown) => this.message.set(errorMessage(error)),
      });
  }

  /** Re-attaches to any running installation reported by the runtime. */
  reattachInstallations(): void {
    if (!this.runtimeStarted() || this.installing()) return;
    this.installation.reattachInstallations$().subscribe({
      next: (terminal) => {
        if (terminal) {
          this.runtime.reload();
          this.requirementsResource.reload();
          if (terminal.status === 'completed') {
            this.message.set(desktopMessages().recheck);
          }
        }
      },
      error: (error: unknown) => {
        this.requirementsResource.reload();
        this.message.set(errorMessage(error));
      },
    });
  }

  private installRequirements(
    installable: readonly RuntimeRequirement[],
  ): void {
    if (!this.runtimeStarted() || this.installing()) return;
    if (installable.length === 0) return;
    const ids = installable.map((item) => item.requirementId);
    this.installation.installRequirements$(installable).subscribe({
      next: (installation) => {
        this.forgetUninstalled([installation.requirementId]);
      },
      complete: () => {
        this.runtime.reload();
        this.requirementsResource.reload();
        if (this.activeInstallation()?.status === 'completed') {
          this.message.set(desktopMessages().recheck);
        }
      },
      error: (error: unknown) => {
        this.forgetUninstalled(ids);
        this.requirementsResource.reload();
        this.message.set(errorMessage(error));
      },
    });
  }

  private rememberUninstalled(
    requirementId: CaptureRequirementId,
    requirement: RuntimeRequirement,
  ): void {
    this.uninstalled.update((current) => {
      const next = new Map(current);
      next.set(requirementId, requirement);
      return next;
    });
  }

  private forgetUninstalled(ids: readonly CaptureRequirementId[]): void {
    if (ids.length === 0) return;
    this.uninstalled.update((current) => {
      if (!ids.some((id) => current.has(id))) return current;
      const next = new Map(current);
      for (const id of ids) next.delete(id);
      return next;
    });
  }

  private clearRemovalError(requirementId: CaptureRequirementId): void {
    this.removalErrors.update((current) => {
      if (!current.has(requirementId)) return current;
      const next = new Map(current);
      next.delete(requirementId);
      return next;
    });
  }
}
