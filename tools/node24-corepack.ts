import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function node24CorepackCandidates(
  execPath: string = process.execPath,
): string[] {
  const nodeBin = dirname(execPath);
  const nodePrefix = dirname(nodeBin);
  return [
    join(nodeBin, 'node_modules', 'corepack', 'dist', 'corepack.js'),
    join(nodePrefix, 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'),
  ];
}

export function resolveNode24Corepack(
  execPath: string = process.execPath,
): string | undefined {
  return node24CorepackCandidates(execPath).find((candidate) =>
    existsSync(candidate),
  );
}
