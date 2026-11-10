import {
  DEFAULT_CAPTURE_WORKBENCH_LOCALE,
  type CaptureWorkbenchLocale,
} from './messages';

/**
 * Formats a download byte count the way the desktop app does
 * (`約 2.8 GB`, `約 144 MB`; English `~2.8 GB`, `~144 MB`).
 * A missing, non-finite, or non-positive count (an older runtime, or 0)
 * returns null so the UI shows no size instead of a guess.
 * The locale defaults to Traditional Chinese, which is what one-argument
 * desktop call sites display.
 */
export function formatApproximateBytes(
  bytes: number | null | undefined,
  locale: CaptureWorkbenchLocale = DEFAULT_CAPTURE_WORKBENCH_LOCALE,
): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }
  const amount = approximateAmount(bytes);
  return locale === 'en' ? `~${amount}` : `約 ${amount}`;
}

function approximateAmount(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    const gb = (bytes / 1_000_000_000).toFixed(1).replace(/\.0$/u, '');
    return `${gb} GB`;
  }
  if (bytes >= 1_000_000) {
    const mb = Math.round(bytes / 1_000_000);
    return `${mb} MB`;
  }
  const kb = Math.max(1, Math.round(bytes / 1_000));
  return `${kb} KB`;
}
