import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const HEX_SHA256 = /^[0-9a-f]{64}$/u;

function parseArguments(args: readonly string[]): {
  candidate: string;
  verification: string;
  status: string;
  output: string;
} {
  if (args.length !== 8) {
    throw new Error(
      'Use --candidate <directory> --verification <name> --status <status> --output <file>.',
    );
  }
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !['--candidate', '--verification', '--status', '--output'].includes(
        name,
      ) ||
      !value ||
      values.has(name)
    ) {
      throw new Error(
        'Use --candidate <directory> --verification <name> --status <status> --output <file>.',
      );
    }
    values.set(name, value);
  }
  const candidate = values.get('--candidate');
  const verification = values.get('--verification');
  const status = values.get('--status');
  const output = values.get('--output');
  if (!candidate || !verification || !status || !output) {
    throw new Error(
      'Use --candidate <directory> --verification <name> --status <status> --output <file>.',
    );
  }
  return {
    candidate: resolve(candidate),
    verification,
    status,
    output: resolve(output),
  };
}

async function main(): Promise<void> {
  const { candidate, verification, status, output } = parseArguments(
    process.argv.slice(2),
  );
  const manifest = JSON.parse(
    await readFile(`${candidate}/candidate-manifest.json`, 'utf8'),
  ) as { candidateId?: unknown };
  if (
    typeof manifest.candidateId !== 'string' ||
    !HEX_SHA256.test(manifest.candidateId)
  ) {
    throw new Error('Candidate manifest has no valid candidateId.');
  }
  await writeFile(
    output,
    `${JSON.stringify(
      {
        schemaVersion: '1',
        candidateId: manifest.candidateId,
        verification,
        status,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  process.stdout.write(
    `Candidate verification recorded for ${verification}: ${manifest.candidateId}.\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
