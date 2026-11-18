/** The five statuses the capture queues show. The pipeline stage is only a progress step. */
export type CaptureUserStatus =
  | 'waiting'
  | 'processing'
  | 'done'
  | 'needs-attention'
  | 'cancelled';

export type CaptureStatusChipVariant = 'running' | 'waiting' | 'done' | 'error';

/** Maps a capture user status to its chip styling variant. */
export function captureStatusChipVariant(status: CaptureUserStatus): CaptureStatusChipVariant {
  switch (status) {
    case 'processing':
      return 'running';
    case 'done':
      return 'done';
    case 'needs-attention':
      return 'error';
    case 'waiting':
    case 'cancelled':
    default:
      return 'waiting';
  }
}

/** Returns the Tailwind CSS classes for the given chip variant. */
export function captureStatusChipClasses(variant: CaptureStatusChipVariant): string {
  switch (variant) {
    case 'running':
      return 'bg-secondary text-secondary-foreground';
    case 'waiting':
      return 'border border-border text-muted-foreground';
    case 'done':
      return 'bg-muted text-secondary-foreground';
    case 'error':
      return 'bg-destructive/10 text-destructive';
  }
}
