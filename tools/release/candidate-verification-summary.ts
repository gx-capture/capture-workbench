import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CANDIDATE_VERIFICATION_SUMMARY =
  'candidate-verification-summary.json';
const LEGACY_SUMMARY = 'release-ledger.json';
const CAPTURE_DOCUMENT_SCHEMA = 'runtime/capture-document-v2.schema.json';

export type CandidateVerificationSummary = {
  readonly schemaVersion: '1';
  readonly candidateId: string;
  readonly sourceCommit: string;
  readonly candidateManifestSha256: string;
  readonly contractSetSha256: string;
  readonly captureDocumentSchemaSha256: string;
};

function allowsLegacySummary(version: unknown): boolean {
  if (typeof version !== 'string') return false;
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/u.exec(version);
  if (!match || Number(match[1]) !== 0) return false;
  const minor = Number(match[2]);
  // SemVer prereleases of the cutoff itself precede the final release.
  return (
    minor < 11 ||
    (minor === 11 && Number(match[3]) === 0 && Boolean(match[4]))
  );
}

export function verifyCandidateVerificationSummary(
  directory: string,
  manifest: Record<string, unknown>,
  candidateManifestSha256: string,
): void {
  const schemaAssets = Array.isArray(manifest.artifacts)
    ? manifest.artifacts.filter(
        (asset) => asset?.path === CAPTURE_DOCUMENT_SCHEMA,
      )
    : [];
  const schemaDigest: unknown = schemaAssets[0]?.sha256;
  const isDigest = (value: unknown): value is string =>
    typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
  if (
    schemaAssets.length !== 1 ||
    !isDigest(schemaDigest) ||
    !isDigest(manifest.contractSetSha256)
  ) {
    throw new Error(
      'Candidate manifest is missing the schema or contract-set digest.',
    );
  }

  let legacy = false;
  let text: string;
  try {
    text = readFileSync(join(directory, CANDIDATE_VERIFICATION_SUMMARY), 'utf8');
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
      !allowsLegacySummary(manifest.releaseVersion)
    ) {
      throw error;
    }
    legacy = true;
    text = readFileSync(join(directory, LEGACY_SUMMARY), 'utf8');
  }
  const summary = JSON.parse(text) as
    | (Partial<CandidateVerificationSummary> & Record<string, unknown>)
    | null;
  if (
    !summary ||
    summary.candidateId !== manifest.candidateId ||
    summary.sourceCommit !== manifest.sourceCommit ||
    summary.candidateManifestSha256 !== candidateManifestSha256 ||
    (legacy
      ? Object.hasOwn(summary, 'schemaVersion') ||
        summary.status !== 'candidate-verified' ||
        summary.version !== manifest.releaseVersion ||
        summary.releaseMode !== manifest.releaseMode ||
        summary.schemaSha256 !== schemaDigest ||
        !Array.isArray(summary.artifacts)
      : summary.schemaVersion !== '1' ||
        summary.contractSetSha256 !== manifest.contractSetSha256 ||
        summary.captureDocumentSchemaSha256 !== schemaDigest)
  ) {
    throw new Error(
      'Candidate verification summary does not match the candidate manifest.',
    );
  }
  for (const [path, expected] of [
    [CAPTURE_DOCUMENT_SCHEMA, schemaDigest],
    ['contracts/contract-set.json', manifest.contractSetSha256],
  ] as const) {
    const actual = createHash('sha256')
      .update(readFileSync(join(directory, path)))
      .digest('hex');
    if (actual !== expected)
      throw new Error(
        `Candidate verification summary digest mismatch for ${path}.`,
      );
  }
}
