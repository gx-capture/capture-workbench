import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Runs `cargo test`, then reruns only the failed tests once. Process-spawning
// launcher tests are timing-sensitive on loaded CI runners; a real regression
// still fails because every failed test must pass on its exact rerun.

const MAX_RETRIED_TESTS = 5;

export function parseFailedTests(output: string): string[] {
  const failures = /\nfailures:\r?\n((?:[ \t]{4}\S+\r?\n)+)/gu;
  const names = new Set<string>();
  for (const match of output.matchAll(failures)) {
    for (const line of match[1].split(/\r?\n/u)) {
      const name = line.trim();
      if (name) names.add(name);
    }
  }
  return [...names];
}

export function passedTestCount(output: string): number {
  let passed = 0;
  for (const match of output.matchAll(/test result: ok\. (\d+) passed/gu)) {
    passed += Number(match[1]);
  }
  return passed;
}

function cargoTest(args: readonly string[]): {
  status: number;
  output: string;
} {
  const result = spawnSync('cargo', ['test', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(output);
  return { status: result.status ?? 1, output };
}

function main(argv: readonly string[]): number {
  const first = cargoTest(argv);
  if (first.status === 0) return 0;
  const failed = parseFailedTests(first.output);
  if (failed.length === 0 || failed.length > MAX_RETRIED_TESTS) {
    return first.status;
  }
  process.stdout.write(
    `\nRetrying ${failed.length} failed test(s) once: ${failed.join(', ')}\n`,
  );
  for (const name of failed) {
    const retry = cargoTest([...argv, '--', '--exact', name]);
    // An exact filter that matches nothing still exits 0; require the test
    // ran (the same module can be compiled into more than one test binary).
    if (retry.status !== 0 || passedTestCount(retry.output) < 1) return 1;
  }
  return 0;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  process.exit(main(process.argv.slice(2)));
}
