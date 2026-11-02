import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

type RemoteAsset = { name?: unknown };

export function run(
  command: string,
  args: readonly string[],
  allowFailure = false,
) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} failed with status ${String(result.status)}.`);
  }
  return result;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function parseReleaseArguments(
  args: readonly string[],
): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !['--candidate', '--tag', '--source-commit', '--output'].includes(name) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Use --candidate <directory> --tag <tag> --source-commit <sha> --output <file>.',
      );
    }
    values.set(name, value);
  }
  if (values.size !== 4) {
    throw new Error(
      'Use --candidate <directory> --tag <tag> --source-commit <sha> --output <file>.',
    );
  }
  return values;
}

export function parseRemoteReleaseInventory(stdout: string): {
  isDraft: boolean;
  remoteNames: Set<string>;
} {
  const payload = JSON.parse(stdout) as {
    isDraft?: unknown;
    assets?: unknown;
  };
  const isDraft = payload.isDraft === true;
  if (
    !Array.isArray(payload.assets) ||
    payload.assets.some(
      (item) =>
        !item ||
        typeof item !== 'object' ||
        typeof (item as RemoteAsset).name !== 'string',
    )
  ) {
    throw new Error('GitHub Release returned an invalid asset inventory.');
  }
  const remoteNames = new Set(
    (payload.assets as RemoteAsset[]).map((item) => item.name as string),
  );
  return { isDraft, remoteNames };
}
