import type { StructuringModelInstallation } from '@gx-capture/capture-workbench-ui';
import { desktopMessages, type DesktopMessages } from '../i18n/desktop-messages';

/** What an installation is doing, as the user sees it. */
export type InstallationProgressPhase =
  | 'preparing'
  | 'downloading'
  | 'installing';

export interface InstallationProgress {
  readonly phase: InstallationProgressPhase;
  /** Share of the download, 0 to 100. Only a figure to show while downloading. */
  readonly percent: number;
}

/** The fields of a runtime installation that describe its progress. */
export interface InstallationProgressSource {
  readonly progress: number;
  readonly downloadedBytes?: number | null;
  readonly downloadBytes?: number | null;
}

/**
 * The runtime reports this fixed share from the moment an installation starts
 * until it knows the download size. Showing it as download progress made the
 * figure step back (5 %, then 0 %) once the byte counts arrived.
 */
const PREPARING_PROGRESS = 0.05;

/**
 * Describes an installation that is queued or running.
 *
 * With byte counts the figure is the downloaded share, and it stays below 100
 * until every byte has arrived; from then on the requirement is being unpacked and
 * verified, which is its own phase rather than "downloading 100 %". Without
 * byte counts the runtime's overall progress stands in.
 */
export function installationProgress(
  installation: InstallationProgressSource | null | undefined,
): InstallationProgress {
  if (!installation) return { phase: 'preparing', percent: 0 };
  const total = installation.downloadBytes;
  const downloaded = installation.downloadedBytes;
  if (typeof total === 'number' && total > 0 && typeof downloaded === 'number') {
    if (downloaded >= total) return { phase: 'installing', percent: 100 };
    return {
      phase: 'downloading',
      percent: clampBelowComplete(Math.floor((downloaded / total) * 100)),
    };
  }
  if (!(installation.progress > PREPARING_PROGRESS)) {
    return { phase: 'preparing', percent: 0 };
  }
  if (installation.progress >= 1) return { phase: 'installing', percent: 100 };
  return {
    phase: 'downloading',
    percent: clampBelowComplete(Math.round(installation.progress * 100)),
  };
}

/** The one line that says what the installation is doing. */
export function installationProgressLabel(
  progress: InstallationProgress,
  messages: Pick<
    DesktopMessages,
    'installProgressPreparing' | 'downloadingProgress' | 'installProgressInstalling'
  >,
): string {
  if (progress.phase === 'preparing') return messages.installProgressPreparing;
  if (progress.phase === 'installing') return messages.installProgressInstalling;
  return messages.downloadingProgress(progress.percent);
}

function clampBelowComplete(percent: number): number {
  return Math.min(Math.max(percent, 0), 99);
}

/** Converts model installation progress to the percentage shown by the UI. */
export function modelInstallationPercent(
  installation: StructuringModelInstallation | null,
): number {
  return installationPercent(installation);
}

/** An installation's progress as a whole percentage, preferring byte counts when available. */
export function installationPercent(
  installation: {
    readonly progress: number;
    readonly downloadedBytes?: number | null;
    readonly downloadBytes?: number | null;
  } | null,
): number {
  if (!installation) return 0;
  const ratio =
    typeof installation.downloadBytes === 'number'
    && installation.downloadBytes > 0
    && typeof installation.downloadedBytes === 'number'
      ? installation.downloadedBytes / installation.downloadBytes
      : installation.progress;
  return Math.round(Math.min(Math.max(ratio, 0), 1) * 100);
}

/** Maps a model installation state to its human-readable phase. */
export function modelInstallationPhase(
  installation: StructuringModelInstallation | null,
): string {
  if (!installation) return '';
  const phase = desktopMessages().modelPhase;
  if (installation.status === 'queued') return phase.queued;
  if (installation.status === 'failed') return phase.failed;
  if (installation.status === 'cancelled') return phase.cancelled;
  if (installation.status === 'completed') return phase.completed;
  if (installation.progress < 0.1) return phase.starting;
  if (installation.progress < 0.75) return phase.downloading;
  return phase.configuring;
}
