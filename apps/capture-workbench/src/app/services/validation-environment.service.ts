import { Injectable } from '@angular/core';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  Observable,
  defer,
  map,
  timer,
} from 'rxjs';
import {
  BACKEND_CONFIG_COMMAND,
  DEFAULT_RUNTIME_READINESS_POLL_INTERVAL_MS,
  DEFAULT_RUNTIME_READINESS_TIMEOUT_MS,
  DESKTOP_RUNTIME_STATUS_COMMAND,
} from '../constants';
import type {
  BackendConfig,
  DesktopRuntimeStatus,
  RuntimeReadinessPolling,
  ValidationClientEnvironment,
} from '../contracts';

@Injectable({ providedIn: 'root' })
export class ValidationEnvironmentService implements ValidationClientEnvironment {
  readonly tauri = isTauri();
  readonly search = globalThis.location?.search ?? '';
  readonly runtimeReadinessPolling: RuntimeReadinessPolling = {
    timeoutMs: DEFAULT_RUNTIME_READINESS_TIMEOUT_MS,
    pollIntervalMs: DEFAULT_RUNTIME_READINESS_POLL_INTERVAL_MS,
    now: () => globalThis.performance?.now() ?? Date.now(),
    wait: (milliseconds) => timer(milliseconds).pipe(map(() => undefined)),
    scheduleTimeout: (callback, milliseconds) => {
      const handle = globalThis.setTimeout(callback, milliseconds);
      return () => globalThis.clearTimeout(handle);
    },
  };

  loadDesktopRuntimeStatus(): Observable<DesktopRuntimeStatus> {
    return defer(() =>
      invoke<DesktopRuntimeStatus>(DESKTOP_RUNTIME_STATUS_COMMAND),
    );
  }

  loadBackendConfig(): Observable<BackendConfig> {
    return defer(() => invoke<BackendConfig>(BACKEND_CONFIG_COMMAND));
  }
}
