import type { DesktopMessages } from '../i18n/desktop-messages';

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
 * until every byte has arrived; from then on the unit is being unpacked and
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
