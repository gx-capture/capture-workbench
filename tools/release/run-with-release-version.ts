import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RELEASE_VERSION } from './release-intent.ts';

/** Keep Nx target arguments stable while reading the declared release at execution time. */
export function releaseArguments(
  args: readonly string[],
  version = RELEASE_VERSION,
): string[] {
  return args.map((argument) =>
    argument.replaceAll('{releaseVersion}', version),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('Pass an executable and its arguments.');
  const result = spawnSync(command, releaseArguments(args), {
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
