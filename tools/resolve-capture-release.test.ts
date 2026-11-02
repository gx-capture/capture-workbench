import './test-temp-root.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  formatGithubOutput,
  parseArguments,
  resolveCaptureRelease,
  type CaptureReleaseSource,
  type ReleaseSummary,
} from './resolve-capture-release.ts';

const RUNTIME_SIGNER =
  'gx-capture/capture-workbench/.github/workflows/_publish-runtime-github-release.yml';
const FULL_SIGNER =
  'gx-capture/capture-workbench/.github/workflows/_publish-github-release.yml';

type FakeAsset = {
  readonly bytes: string;
  readonly signers: readonly string[];
};

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const id = (seed: string) => sha(`candidate:${seed}`);
const contractSet = (seed: string) => sha(`contract-set:${seed}`);

function runtimeManifest(version: string, contracts = contractSet(version)) {
  return JSON.stringify({
    schemaVersion: '1',
    candidateKind: 'runtime',
    releaseVersion: version,
    candidateId: id(`runtime-${version}`),
    contractSetSha256: contracts,
  });
}

function candidateManifest(version: string) {
  return JSON.stringify({
    schemaVersion: '1',
    candidateId: id(version),
    contractSetSha256: contractSet(version),
  });
}

function releaseManifest(version: string, classification = 'additive') {
  return JSON.stringify({
    schemaVersion: '1',
    status: 'released',
    candidateId: id(version),
    releaseTag: `v${version}`,
    releaseVersion: version,
    components: { candidateManifestSha256: sha(candidateManifest(version)) },
    contractClassification: { classification, baselineRelease: '0.6.3' },
  });
}

/**
 * A fake GitHub: v0.6.3 and v0.8.0 went through the full route, v0.7.2 and
 * v0.8.1 through Route A only, v0.9.0 was published and then superseded by
 * v0.8.0, plus a draft and a prerelease that must never be chosen.
 */
class FakeGitHub implements CaptureReleaseSource {
  readonly releases: ReleaseSummary[] = [
    { tag: 'v0.6.3', draft: false, prerelease: false },
    { tag: 'v0.7.2', draft: false, prerelease: false },
    { tag: 'v0.8.0', draft: false, prerelease: false },
    { tag: 'v0.8.1', draft: false, prerelease: false },
    { tag: 'v0.9.0', draft: false, prerelease: false },
    { tag: 'v0.9.1-rc.1', draft: false, prerelease: true },
    { tag: 'v1.0.0', draft: true, prerelease: false },
  ];
  readonly assets = new Map<string, FakeAsset>();
  stable = {
    schemaVersion: '1',
    channel: 'stable',
    releaseTag: 'v0.8.0' as string | null,
    manifestSha256: sha(releaseManifest('0.8.0')) as string | null,
    manifestAssetName: 'capture-release-manifest-v1.json',
    updatedAt: '2026-11-02T00:00:00.000Z' as string | null,
  };
  index: Record<string, Record<string, string>> = {};
  private readonly directory = mkdtempSync(join(tmpdir(), 'resolve-release-'));
  private readonly downloaded = new Map<string, FakeAsset>();

  constructor() {
    for (const version of ['0.6.3', '0.7.2', '0.8.0', '0.8.1', '0.9.0'])
      this.setAsset(
        version,
        'capture-runtime-candidate-manifest.json',
        runtimeManifest(version),
        [RUNTIME_SIGNER],
      );
    for (const version of ['0.6.3', '0.8.0', '0.9.0']) {
      this.setAsset(
        version,
        'capture-release-manifest-v1.json',
        releaseManifest(version),
        [FULL_SIGNER],
      );
      this.setAsset(
        version,
        'candidate-manifest.json',
        candidateManifest(version),
        [FULL_SIGNER],
      );
      this.index[`v${version}`] = {
        status: 'released',
        manifestSha256: sha(releaseManifest(version)),
        candidateId: id(version),
      };
    }
    this.index['v0.9.0'] = {
      ...this.index['v0.9.0'],
      status: 'superseded',
      supersededBy: 'v0.8.0',
      reason: 'Defective OCR worker.',
    };
  }

  setAsset(
    version: string,
    name: string,
    bytes: string,
    signers: readonly string[],
  ) {
    this.assets.set(`v${version}/${name}`, { bytes, signers });
  }

  listReleases() {
    return this.releases;
  }

  readReleaseIndexFile(name: 'stable.json' | 'releases.json') {
    return JSON.stringify(
      name === 'stable.json'
        ? this.stable
        : { schemaVersion: '1', releases: this.index },
    );
  }

  downloadAsset(tag: string, assetName: string) {
    const asset = this.assets.get(`${tag}/${assetName}`);
    if (!asset) throw new Error(`release asset not found: ${tag}/${assetName}`);
    mkdirSync(join(this.directory, tag), { recursive: true });
    const path = join(this.directory, tag, assetName);
    writeFileSync(path, asset.bytes);
    this.downloaded.set(path, asset);
    return path;
  }

  verifyAttestation(path: string, signerWorkflow: string) {
    if (!this.downloaded.get(path)?.signers.includes(signerWorkflow))
      throw new Error(`no attestation from ${signerWorkflow}`);
  }
}

test('route-a picks the newest unsuperseded runtime release and verifies the runtime signer', () => {
  const github = new FakeGitHub();
  const result = resolveCaptureRelease(github, {
    mode: 'route-a',
    currentVersion: '0.7.2',
  });
  assert.deepEqual(result, {
    tag: 'v0.8.1',
    version: '0.8.1',
    manifestSha256: sha(runtimeManifest('0.8.1')),
    contractClassification: 'manual-review',
    contractSetSha256: contractSet('0.8.1'),
    changed: true,
  });
});

test('route-a reports no-impact when the contract set equals the pinned one', () => {
  const github = new FakeGitHub();
  github.setAsset(
    '0.8.1',
    'capture-runtime-candidate-manifest.json',
    runtimeManifest('0.8.1', contractSet('0.8.0')),
    [RUNTIME_SIGNER],
  );
  const result = resolveCaptureRelease(github, {
    mode: 'route-a',
    currentVersion: 'v0.8.0',
    currentContractSetSha256: contractSet('0.8.0'),
  });
  assert.equal(result.tag, 'v0.8.1');
  assert.equal(result.contractClassification, 'no-impact');
});

test('stable follows stable.json, not the newest release, and verifies the full-release signer', () => {
  const github = new FakeGitHub();
  const result = resolveCaptureRelease(github, {
    mode: 'stable',
    currentVersion: '0.7.2',
  });
  assert.deepEqual(result, {
    tag: 'v0.8.0',
    version: '0.8.0',
    manifestSha256: sha(releaseManifest('0.8.0')),
    contractClassification: 'additive',
    contractSetSha256: contractSet('0.8.0'),
    changed: true,
  });
});

test('the pinned version is a no-op in both modes', () => {
  const github = new FakeGitHub();
  const routeA = resolveCaptureRelease(github, {
    mode: 'route-a',
    currentVersion: '0.8.1',
  });
  assert.equal(routeA.changed, false);
  assert.equal(routeA.contractClassification, 'no-impact');
  const stable = resolveCaptureRelease(github, {
    mode: 'stable',
    currentVersion: '0.8.0',
  });
  assert.equal(stable.changed, false);
  assert.match(formatGithubOutput(stable), /^changed=false$/mu);
});

test('route-a skips superseded releases and fails when only superseded ones remain', () => {
  const github = new FakeGitHub();
  github.releases.splice(0, github.releases.length, {
    tag: 'v0.9.0',
    draft: false,
    prerelease: false,
  });
  assert.throws(
    () =>
      resolveCaptureRelease(github, {
        mode: 'route-a',
        currentVersion: '0.8.0',
      }),
    /No published, unsuperseded Capture runtime release/u,
  );
});

test('stable fails closed when the pointer names a superseded release', () => {
  const github = new FakeGitHub();
  github.stable = {
    ...github.stable,
    releaseTag: 'v0.9.0',
    manifestSha256: sha(releaseManifest('0.9.0')),
  };
  assert.throws(
    () =>
      resolveCaptureRelease(github, {
        mode: 'stable',
        currentVersion: '0.8.0',
      }),
    /does not reference a released index entry/u,
  );
});

test('stable fails closed on a release manifest digest mismatch', () => {
  const github = new FakeGitHub();
  github.setAsset(
    '0.8.0',
    'capture-release-manifest-v1.json',
    releaseManifest('0.8.0', 'no-impact'),
    [FULL_SIGNER],
  );
  assert.throws(
    () =>
      resolveCaptureRelease(github, {
        mode: 'stable',
        currentVersion: '0.7.2',
      }),
    /digest does not match release-index\/stable.json/u,
  );
});

test('stable fails closed on a candidate manifest digest mismatch', () => {
  const github = new FakeGitHub();
  github.setAsset(
    '0.8.0',
    'candidate-manifest.json',
    candidateManifest('0.8.1'),
    [FULL_SIGNER],
  );
  assert.throws(
    () =>
      resolveCaptureRelease(github, {
        mode: 'stable',
        currentVersion: '0.7.2',
      }),
    /candidate-manifest.json digest does not match/u,
  );
});

test('a manifest without the expected signer workflow is rejected', () => {
  const routeA = new FakeGitHub();
  routeA.setAsset(
    '0.8.1',
    'capture-runtime-candidate-manifest.json',
    runtimeManifest('0.8.1'),
    [FULL_SIGNER],
  );
  assert.throws(
    () =>
      resolveCaptureRelease(routeA, {
        mode: 'route-a',
        currentVersion: '0.7.2',
      }),
    /no attestation from .*_publish-runtime-github-release.yml/u,
  );
  const stable = new FakeGitHub();
  stable.setAsset(
    '0.8.0',
    'capture-release-manifest-v1.json',
    releaseManifest('0.8.0'),
    [RUNTIME_SIGNER],
  );
  assert.throws(
    () =>
      resolveCaptureRelease(stable, {
        mode: 'stable',
        currentVersion: '0.7.2',
      }),
    /no attestation from .*_publish-github-release.yml/u,
  );
  const unattested = new FakeGitHub();
  unattested.setAsset(
    '0.8.1',
    'capture-runtime-candidate-manifest.json',
    runtimeManifest('0.8.1'),
    [],
  );
  assert.throws(
    () =>
      resolveCaptureRelease(unattested, {
        mode: 'route-a',
        currentVersion: '0.7.2',
      }),
    /no attestation/u,
  );
});

test('malformed or mismatched manifests are rejected', () => {
  const notJson = new FakeGitHub();
  notJson.setAsset(
    '0.8.1',
    'capture-runtime-candidate-manifest.json',
    '{not json',
    [RUNTIME_SIGNER],
  );
  assert.throws(
    () =>
      resolveCaptureRelease(notJson, {
        mode: 'route-a',
        currentVersion: '0.7.2',
      }),
    /malformed JSON/u,
  );
  const wrongVersion = new FakeGitHub();
  wrongVersion.setAsset(
    '0.8.1',
    'capture-runtime-candidate-manifest.json',
    runtimeManifest('0.8.0'),
    [RUNTIME_SIGNER],
  );
  assert.throws(
    () =>
      resolveCaptureRelease(wrongVersion, {
        mode: 'route-a',
        currentVersion: '0.7.2',
      }),
    /does not describe v0.8.1/u,
  );
  const unknownClassification = new FakeGitHub();
  const manifest = releaseManifest('0.8.0', 'compatible');
  unknownClassification.setAsset(
    '0.8.0',
    'capture-release-manifest-v1.json',
    manifest,
    [FULL_SIGNER],
  );
  unknownClassification.stable = {
    ...unknownClassification.stable,
    manifestSha256: sha(manifest),
  };
  unknownClassification.index['v0.8.0'] = {
    ...unknownClassification.index['v0.8.0'],
    manifestSha256: sha(manifest),
  };
  assert.throws(
    () =>
      resolveCaptureRelease(unknownClassification, {
        mode: 'stable',
        currentVersion: '0.7.2',
      }),
    /does not describe v0.8.0/u,
  );
});

test('arguments are validated before anything is fetched', () => {
  assert.deepEqual(
    parseArguments([
      '--mode',
      'stable',
      '--current-version',
      '0.8.0',
      '--github-output',
      'out.txt',
    ]),
    {
      mode: 'stable',
      currentVersion: '0.8.0',
      currentContractSetSha256: undefined,
      githubOutput: 'out.txt',
    },
  );
  assert.throws(
    () => parseArguments(['--mode', 'latest', '--current-version', '0.8.0']),
    /--mode/u,
  );
  assert.throws(
    () => parseArguments(['--mode', 'stable', '--token', 'x']),
    /invalid/u,
  );
  assert.throws(
    () =>
      resolveCaptureRelease(new FakeGitHub(), {
        mode: 'stable',
        currentVersion: '0.8',
      }),
    /MAJOR.MINOR.PATCH/u,
  );
});
