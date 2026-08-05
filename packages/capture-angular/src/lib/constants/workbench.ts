import { CAPTURE_RUNTIME_MAJOR, CAPTURE_RUNTIME_MINOR } from './runtime';
import type { ResolvedCaptureWorkbenchConfig } from '../contracts/workbench';

export const DEFAULT_CAPTURE_WORKBENCH_CONFIG: ResolvedCaptureWorkbenchConfig = {
  enabledSources: ['pdf', 'image', 'audio'],
  structuringMode: 'runtime',
  outputMode: 'json',
  multiple: true,
  targetLanguage: undefined,
  concurrency: 1,
  pollIntervalMs: 750,
  showRuntimeSetup: true,
  hostStructuringOwner: 'component',
  hostManagedHandshake: false,
  reviewBeforeCommit: false,
  reviewEditable: false,
  width: '100%',
  height: 'auto',
  density: 'comfortable',
  compatibleRuntimeMajor: CAPTURE_RUNTIME_MAJOR,
  compatibleRuntimeMinor: CAPTURE_RUNTIME_MINOR,
};
