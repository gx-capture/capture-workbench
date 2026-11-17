// Shared process and port helpers for tests that spawn `real-backend-server.ts`.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { connect as netConnect, createServer as createNetServer } from 'node:net';
import { resolve } from 'node:path';

const defaultWorkspaceRoot = resolve(import.meta.dirname, '..', '..', '..');

export function reserveFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createNetServer();
    srv.once('error', rejectPort);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((error) => {
        if (error) rejectPort(error);
        else resolvePort(port);
      });
    });
  });
}

export function waitForLauncherReady(
  child: ChildProcess,
  getStdout: () => string,
  getStderr: () => string,
  timeoutMs = 20_000,
): Promise<string> {
  return new Promise((resolveReady, rejectReady) => {
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      const out = getStdout();
      const newline = out.indexOf('\n');
      if (newline >= 0) {
        clearInterval(poll);
        resolveReady(out.slice(0, newline));
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        clearInterval(poll);
        rejectReady(
          new Error(`Launcher exited early (${String(child.exitCode)}): ${getStderr()}`),
        );
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(poll);
        rejectReady(new Error(`Launcher ready line timed out: ${getStderr()}`));
      }
    }, 50);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function launcherReadyLine(port: number, upstreamOrigin = 'http://localhost:4200'): RegExp {
  return new RegExp(
    `^Real-backend preview: http://127\\.0\\.0\\.1:${port}/__preview `
      + `\\(upstream ${escapeRegExp(upstreamOrigin)}, dev-host 127\\.0\\.0\\.1:(\\d+)\\)$`,
    'u',
  );
}

export function canConnect(port: number): Promise<boolean> {
  return new Promise((resolveResult) => {
    const socket = netConnect({ host: '127.0.0.1', port });
    socket.setTimeout(1_000);
    socket.once('connect', () => {
      socket.destroy();
      resolveResult(true);
    });
    const refused = (): void => {
      socket.destroy();
      resolveResult(false);
    };
    socket.once('error', refused);
    socket.once('timeout', refused);
  });
}

export function stopSpawnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveExit) => {
    const forceStop = (): void => {
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 5_000,
        });
      } else {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      forceStop();
      resolveExit();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
    if (process.platform === 'win32') {
      // Terminates Node, capture-workbench-dev-host, and any child workers in
      // the tree together.
      forceStop();
    } else {
      child.kill('SIGINT');
    }
  });
}

interface StartRealBackendLauncherOptions {
  readonly upstreamUrl?: string;
  readonly appDataDir?: string;
  readonly runtimeManifestPath?: string;
  readonly runtimeExecutablePath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly startupTimeoutMs?: number;
  readonly workspaceRoot?: string;
}

export interface StartedRealBackendLauncher {
  readonly port: number;
  readonly devHostPort: number;
  readonly baseUrl: string;
  readonly child: ChildProcess;
  stop: () => Promise<void>;
}

/**
 * Starts `real-backend-server.ts` on a free loopback port and waits until the
 * proxy and `capture-workbench-dev-host` are both listening.
 */
export async function startRealBackendLauncher(
  options: StartRealBackendLauncherOptions = {},
): Promise<StartedRealBackendLauncher> {
  const upstreamUrl = options.upstreamUrl ?? 'http://localhost:4200';
  const cwd = options.workspaceRoot ?? defaultWorkspaceRoot;
  const port = await reserveFreePort();
  const args = [
    'apps/capture-workbench-e2e/real-backend-server.ts',
    String(port),
    upstreamUrl,
  ];
  if (options.appDataDir) {
    args.push('--app-data', options.appDataDir);
  }
  if (options.runtimeManifestPath) {
    args.push('--runtime-manifest', options.runtimeManifestPath);
  }
  if (options.runtimeExecutablePath) {
    args.push('--runtime-executable', options.runtimeExecutablePath);
  }

  const mergedEnv: NodeJS.ProcessEnv = { ...process.env };
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (value === undefined) {
        delete mergedEnv[key];
      } else {
        mergedEnv[key] = value;
      }
    }
  }

  const child = spawn(process.execPath, args, {
    cwd,
    env: mergedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  try {
    const readyLine = await waitForLauncherReady(
      child,
      () => stdout,
      () => stderr,
      options.startupTimeoutMs,
    );
    const match = launcherReadyLine(port, new URL(upstreamUrl).origin).exec(readyLine.trimEnd());
    const devHostPort = Number(match?.[1]);
    if (!Number.isInteger(devHostPort) || devHostPort <= 0) {
      throw new Error(`Unexpected launcher ready line: ${readyLine.trimEnd()}`);
    }
    return {
      port,
      devHostPort,
      baseUrl: `http://127.0.0.1:${port}`,
      child,
      stop: () => stopSpawnedChild(child),
    };
  } catch (error) {
    await stopSpawnedChild(child);
    throw error;
  }
}
