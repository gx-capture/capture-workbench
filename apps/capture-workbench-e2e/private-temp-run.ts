// What a Playwright run of the e2e and e2e-dev-host targets needs so that
// nothing of it stays in the shared temp directory. Both targets preload
// tools/test-temp-root.ts (an import here would cross the Nx project
// boundary): the coordinator and every process it starts use its private temp
// root, which the coordinator removes on a normal exit (a forced termination
// skips that), also when a tree-kill of a web server left files there.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Nx 24 refuses a socket path of 108 characters or more (measured on Windows,
// where the path is a named pipe under `\\.\pipe\nx\`).
const NX_LONGEST_SOCKET_PATH = 107;
const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\nx\\';
// The longest socket name Nx puts in the directory: the dev server's readiness
// socket, `fp<pid>-ready-<n>.sock`, with the largest Windows process id.
const LONGEST_SOCKET_NAME = 'fp4294967295-ready-999.sock';

/**
 * The socket directory for the Workbench dev server that Nx runs. A directory
 * set in NX_SOCKET_DIR is kept. Otherwise it is a short directory in the run's
 * private root; when the socket path there could be too long for Nx, the run
 * stops before it starts rather than putting sockets in the shared temp
 * directory.
 */
export function devServerSocketDirectory(
  privateRoot: string,
  configured: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  if (configured) return configured;
  const directory = join(privateRoot, 'nx');
  const prefix = platform === 'win32' ? WINDOWS_PIPE_PREFIX : '';
  const longest = prefix.length + directory.length + 1 + LONGEST_SOCKET_NAME.length;
  if (longest > NX_LONGEST_SOCKET_PATH) {
    throw new Error(
      `An Nx socket path in this run's private temp root (${directory}) can reach ${longest} characters; ` +
        `Nx accepts at most ${NX_LONGEST_SOCKET_PATH}. Set NX_SOCKET_DIR to a short directory of your own ` +
        '(for example C:\\nx-sockets) and run again.',
    );
  }
  return directory;
}

/**
 * Undefined when the process does not run under that private root: a direct
 * `playwright test`, or a tool that only reads the config. Call it before the
 * config loads Nx's preset.
 */
export function privateTempRun(workspaceRoot: string) {
  const privateRoot = tmpdir();
  const sharedTemp = process.env['CAPTURE_TEST_SHARED_TEMP'];
  if (!sharedTemp || sharedTemp === privateRoot) return undefined;
  // Nx, which the config loads for its preset, copies its native binding under
  // the temp directory and keeps it loaded until the process exits, so the
  // coordinator could never remove its private root. For this run only, Nx
  // keeps that copy in the workspace's own Nx data directory (git-ignored,
  // cleared by `nx reset`).
  process.env['NX_NATIVE_FILE_CACHE_DIRECTORY'] ??= join(workspaceRoot, '.nx', 'workspace-data', 'native-file-cache');
  // The Workbench dev server runs under Nx. For the dev server's readiness
  // signal Nx opens a socket in a directory it creates under the temp
  // directory and never removes without a daemon, and under the private root
  // its default path there is too long for Nx. Its sockets go to a short
  // directory in the private root instead (or to NX_SOCKET_DIR when that is
  // set), and no daemon is started that would outlive the run. The choice is
  // made once, in the coordinator, and set for every process of the run: the
  // workers load this config again under their own, deeper private roots.
  const socketDirectory = devServerSocketDirectory(privateRoot, process.env['NX_SOCKET_DIR']);
  process.env['NX_SOCKET_DIR'] = socketDirectory;
  return {
    devServerEnvironment: { NX_SOCKET_DIR: socketDirectory, NX_DAEMON: 'false' },
  };
}
