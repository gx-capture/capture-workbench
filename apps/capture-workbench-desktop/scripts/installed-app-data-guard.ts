import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface AppDataSnapshot {
  readonly directoryExists: boolean;
  readonly libraryExists: boolean;
  readonly index: { readonly mtimeNs: string; readonly bytes: string } | null;
}

export function assertRealAppDataUnchanged(before: AppDataSnapshot, after: AppDataSnapshot): void {
  if (before.directoryExists !== after.directoryExists ||
      before.libraryExists !== after.libraryExists ||
      before.index?.mtimeNs !== after.index?.mtimeNs ||
      before.index?.bytes !== after.index?.bytes) {
    throw new Error('Real product app-data changed during the installed smoke (directory existence or library index metadata). Isolation failed.');
  }
}

// Resolve via Windows' known-folder API through .NET, never an APPDATA override.
// This helper is invoked by the opt-in smoke only. No directory contents are read.
export function realProductAppDataDirectory(): string {
  try {
    if (process.platform !== 'win32') throw new Error();
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!systemRoot || !isAbsolute(systemRoot)) throw new Error();
    const roaming = execFileSync(
      join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)'],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!isAbsolute(roaming) || /[\r\n\0]/u.test(roaming)) throw new Error();
    return join(roaming, 'io.github.gx-capture.capture-workbench');
  } catch {
    throw new Error('Cannot resolve real Roaming AppData through the Windows known folder; refusing installed smoke.');
  }
}

export function snapshotRealAppData(directory: string): AppDataSnapshot {
  const metadata = (path: string) => {
    try {
      return statSync(path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Do not leak private paths through filesystem errors.
      throw new Error('Cannot inspect real product app-data metadata; isolation guard failed.');
    }
  };
  const root = metadata(directory);
  const library = root ? metadata(join(directory, 'library')) : null;
  const index = library ? metadata(join(directory, 'library', 'library-index-v1.json')) : null;
  return {
    directoryExists: root !== null,
    libraryExists: library !== null,
    index: index ? { mtimeNs: String(index.mtimeNs), bytes: String(index.size) } : null,
  };
}
