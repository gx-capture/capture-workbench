import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  assertArtifactDigest,
  assertCatalogMatchesReceipt,
  assertCanonicalReceiptArchiveListing,
  assertRegularReceiptArchiveEntry,
  canonicalJson,
  createReceipt,
  readCanonicalReceiptArchive,
  selectTrustedArtifact,
  selectTrustedMainCiRun,
  selectTrustedRun,
  validateReceipt,
} from './model-candidate-receipt.ts';

const nowMs = Date.parse('2026-07-30T12:00:00Z');
const commitSha = 'a'.repeat(40);
const sourceLockSha256 = 'b'.repeat(64);
const workflowPath = '.github/workflows/model-candidate.yml';
const expected = {
  artifactName: `capture-model-receipt-v0.3.5-${commitSha}`,
  commitSha,
  sourceLockSha256,
  version: '0.3.5',
  workflowPath,
};

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function writeZip(path, entries, { compress = false } = {}) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, rawContent] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const content = Buffer.from(rawContent);
    const payload = compress ? deflateRawSync(content) : content;
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(compress ? 8 : 0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(compress ? 8 : 0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...localParts, centralDirectory, end]));
}

function workflow() {
  return { id: 17, path: workflowPath, state: 'active' };
}

function run(overrides = {}) {
  return {
    conclusion: 'success',
    created_at: '2026-07-30T11:00:00Z',
    event: 'workflow_dispatch',
    head_sha: commitSha,
    id: 23,
    path: workflowPath,
    status: 'completed',
    updated_at: '2026-07-30T11:30:00Z',
    workflow_id: 17,
    ...overrides,
  };
}

function artifact(overrides = {}) {
  return {
    created_at: '2026-07-30T11:31:00Z',
    digest: `sha256:${'c'.repeat(64)}`,
    expired: false,
    expires_at: '2026-08-01T11:31:00Z',
    id: 29,
    name: expected.artifactName,
    size_in_bytes: 1024,
    workflow_run: { head_sha: commitSha, id: 23 },
    ...overrides,
  };
}

function mainCiWorkflow(overrides = {}) {
  return {
    id: 31,
    path: '.github/workflows/ci.yml',
    state: 'active',
    ...overrides,
  };
}

function mainCiRun(overrides = {}) {
  return {
    conclusion: 'success',
    created_at: '2026-07-30T10:00:00Z',
    event: 'push',
    head_branch: 'main',
    head_sha: commitSha,
    id: 37,
    path: '.github/workflows/ci.yml',
    status: 'completed',
    updated_at: '2026-07-30T10:30:00Z',
    workflow_id: 31,
    ...overrides,
  };
}

test('trusted receipt selection binds workflow, run, SHA, freshness, and artifact', () => {
  const trusted = selectTrustedRun(
    workflow(),
    { total_count: 1, workflow_runs: [run()] },
    expected,
    { maxAgeMs: 24 * 60 * 60 * 1000, nowMs },
  );
  assert.equal(trusted.run.id, 23);
  assert.equal(
    selectTrustedArtifact(
      { artifacts: [artifact()], total_count: 1 },
      expected,
      trusted.run,
      { nowMs },
    ).id,
    29,
  );
});

test('trusted main CI selection requires one exact successful main push run', () => {
  const expectedMainCi = {
    branch: 'main',
    commitSha,
    workflowPath: '.github/workflows/ci.yml',
  };
  assert.equal(
    selectTrustedMainCiRun(
      mainCiWorkflow(),
      { total_count: 1, workflow_runs: [mainCiRun()] },
      expectedMainCi,
      { nowMs },
    ).run.id,
    37,
  );

  for (const candidate of [
    mainCiRun({ event: 'pull_request' }),
    mainCiRun({ head_branch: 'feature' }),
    mainCiRun({ head_sha: 'd'.repeat(40) }),
    mainCiRun({ conclusion: 'cancelled' }),
    mainCiRun({ conclusion: 'skipped' }),
    mainCiRun({
      path: '.github/workflows/release.yml',
      workflow_id: 41,
    }),
  ]) {
    assert.throws(
      () =>
        selectTrustedMainCiRun(
          mainCiWorkflow(),
          { total_count: 1, workflow_runs: [candidate] },
          expectedMainCi,
          { nowMs },
        ),
      /exactly one/u,
    );
  }
  assert.throws(
    () =>
      selectTrustedMainCiRun(
        mainCiWorkflow(),
        {
          total_count: 2,
          workflow_runs: [mainCiRun(), mainCiRun({ id: 38 })],
        },
        expectedMainCi,
        { nowMs },
      ),
    /found 2/u,
  );
  assert.throws(
    () =>
      selectTrustedMainCiRun(
        mainCiWorkflow({ path: '.github/workflows/release.yml' }),
        { total_count: 1, workflow_runs: [mainCiRun()] },
        expectedMainCi,
        { nowMs },
      ),
    /identity/u,
  );
});

test('replay, wrong event/conclusion, expiry, and ambiguity fail closed', () => {
  for (const candidate of [
    run({ head_sha: 'd'.repeat(40) }),
    run({ event: 'push' }),
    run({ conclusion: 'failure' }),
    run({ created_at: '2026-07-20T11:00:00Z' }),
  ]) {
    assert.throws(
      () =>
        selectTrustedRun(
          workflow(),
          { total_count: 1, workflow_runs: [candidate] },
          expected,
          { maxAgeMs: 24 * 60 * 60 * 1000, nowMs },
        ),
      /exactly one/u,
    );
  }
  assert.throws(
    () =>
      selectTrustedRun(
        workflow(),
        {
          total_count: 2,
          workflow_runs: [run(), run({ id: 24 })],
        },
        expected,
        { maxAgeMs: 24 * 60 * 60 * 1000, nowMs },
      ),
    /found 2/u,
  );
  assert.throws(
    () =>
      selectTrustedArtifact(
        { artifacts: [artifact({ expired: true })], total_count: 1 },
        expected,
        run(),
        { nowMs },
      ),
    /exactly one/u,
  );
});

test('wrong workflow identity and ambiguous artifacts fail closed', () => {
  assert.throws(
    () =>
      selectTrustedRun(
        { ...workflow(), path: '.github/workflows/other.yml' },
        { total_count: 1, workflow_runs: [run()] },
        expected,
        { maxAgeMs: 24 * 60 * 60 * 1000, nowMs },
      ),
    /identity/u,
  );
  assert.throws(
    () =>
      selectTrustedArtifact(
        {
          artifacts: [artifact(), artifact({ id: 30 })],
          total_count: 2,
        },
        expected,
        run(),
        { nowMs },
      ),
    /found 2/u,
  );
});

test('server digest detects downloaded artifact tamper', () => {
  const bytes = Buffer.from('receipt archive');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  assert.doesNotThrow(() => assertArtifactDigest(digest, bytes));
  assert.throws(
    () => assertArtifactDigest(digest, Buffer.from('tampered')),
    /server digest/u,
  );
});

test('receipt archive listing rejects traversal, directories, and duplicates', () => {
  assert.doesNotThrow(() =>
    assertCanonicalReceiptArchiveListing('model-candidate-receipt.json\r\n'),
  );
  for (const listing of [
    '../model-candidate-receipt.json\n',
    '/model-candidate-receipt.json\n',
    'nested/model-candidate-receipt.json\n',
    'model-candidate-receipt.json\nmodel-candidate-receipt.json\n',
    'model-candidate-receipt.json\nextra.json\n',
  ]) {
    assert.throws(
      () => assertCanonicalReceiptArchiveListing(listing),
      /exactly the canonical receipt file/u,
    );
  }
  assert.doesNotThrow(() =>
    assertRegularReceiptArchiveEntry(
      '-rw-r--r--  0 owner group 100 Jul 30 12:00 model-candidate-receipt.json\r\n',
    ),
  );
  for (const listing of [
    'lrwxr-xr-x  0 owner group 0 Jul 30 12:00 model-candidate-receipt.json\n',
    'drwxr-xr-x  0 owner group 0 Jul 30 12:00 model-candidate-receipt.json\n',
  ]) {
    assert.throws(
      () => assertRegularReceiptArchiveEntry(listing),
      /must be a regular file/u,
    );
  }
});

test('real receipt archives are streamed without filesystem extraction', () => {
  const root = mkdtempSync(join(tmpdir(), 'capture-receipt-archive-'));
  try {
    const canonicalArchive = join(root, 'canonical.zip');
    writeZip(canonicalArchive, [
      [
        'model-candidate-receipt.json',
        Buffer.from(canonicalJson({ ok: true })),
      ],
    ]);
    assert.deepEqual(readCanonicalReceiptArchive(canonicalArchive), {
      ok: true,
    });

    const nonCanonicalArchive = join(root, 'non-canonical.zip');
    writeZip(nonCanonicalArchive, [
      ['model-candidate-receipt.json', Buffer.from('{"ok":true}')],
    ]);
    assert.throws(
      () => readCanonicalReceiptArchive(nonCanonicalArchive),
      /canonical UTF-8 JSON/u,
    );

    for (const [name, entries] of [
      [
        'traversal.zip',
        [['../model-candidate-receipt.json', Buffer.from('{}\n')]],
      ],
      [
        'duplicate.zip',
        [
          ['model-candidate-receipt.json', Buffer.from('{}\n')],
          ['model-candidate-receipt.json', Buffer.from('{}\n')],
        ],
      ],
    ]) {
      const archive = join(root, name);
      writeZip(archive, entries);
      assert.throws(
        () => readCanonicalReceiptArchive(archive),
        /exactly the canonical receipt file/u,
      );
    }

    const oversizedArchive = join(root, 'oversized.zip');
    writeZip(
      oversizedArchive,
      [
        [
          'model-candidate-receipt.json',
          Buffer.alloc(8 * 1024 * 1024 + 1, 0x20),
        ],
      ],
      { compress: true },
    );
    assert.throws(
      () => readCanonicalReceiptArchive(oversizedArchive),
      /receipt size limit/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('receipt creation binds exact source-lock fixture expectations', () => {
  const root = mkdtempSync(join(tmpdir(), 'capture-receipt-create-'));
  try {
    const sourceLockPath = join(root, 'source-lock.json');
    const catalogPath = join(root, 'catalog.json');
    const evidencePath = join(root, 'evidence.json');
    const outputPath = join(root, 'receipt.json');
    const fixtures = [
      {
        kind: 'ocr',
        expectedDevice: 'windowsml-dml',
        expectedEngine: 'windowsml-ocr',
        expectedModel: 'pp-ocrv6-medium-windowsml',
        expectedText: 'CAPTURE OCR FIXTURE',
        sha256: '1'.repeat(64),
      },
      {
        kind: 'whisper',
        expectedDevice: 'cpu',
        expectedEngine: 'whisper-primary',
        expectedModel: 'fallback',
        expectedText: 'capture whisper fixture',
        sha256: '2'.repeat(64),
      },
    ];
    writeFileSync(sourceLockPath, canonicalJson({ fixtures }));
    const sourceLockDigest = createHash('sha256')
      .update(readFileSync(sourceLockPath))
      .digest('hex');
    const catalog = {
      catalogVersion: '2',
      runtimeVersion: '0.3.5',
      requirements: ['whisper-primary', 'windowsml-ocr'].map(
        (requirementId, index) => ({
          artifacts: [
            {
              bytes: 100 + index,
              sha256: String(index + 6).repeat(64),
            },
          ],
          requirementId,
          modelFiles: {
            entryCount: 1,
            extractedBytes: 1,
            manifestSha256: String(index + 3).repeat(64),
            sourceLockSha256: sourceLockDigest,
          },
        }),
      ),
    };
    writeFileSync(catalogPath, canonicalJson(catalog));
    const catalogDigest = createHash('sha256')
      .update(readFileSync(catalogPath))
      .digest('hex');
    const requirements = [
      {
        assertionsPassed: true,
        device: 'cpu',
        digest: `sha256:${'4'.repeat(64)}`,
        engine: 'whisper-primary',
        fixtureSha256: '2'.repeat(64),
        model: 'fallback',
        normalizedTextSha256: createHash('sha256')
          .update('capture whisper fixture')
          .digest('hex'),
        requirementId: 'whisper-primary',
        segmentCount: 1,
      },
      {
        assertionsPassed: true,
        device: 'windowsml-dml',
        digest: `sha256:${'5'.repeat(64)}`,
        engine: 'windowsml-ocr',
        fixtureSha256: '1'.repeat(64),
        model: 'pp-ocrv6-medium-windowsml',
        normalizedTextSha256: createHash('sha256')
          .update('CAPTURE OCR FIXTURE')
          .digest('hex'),
        requirementId: 'windowsml-ocr',
        segmentCount: 1,
      },
    ];
    const input = {
      catalog: catalogPath,
      commitSha,
      evidence: evidencePath,
      output: outputPath,
      runId: '23',
      sourceLock: sourceLockPath,
      version: '0.3.5',
      workflowId: '17',
      workflowPath,
    };
    writeFileSync(
      evidencePath,
      canonicalJson({
        catalogSha256: catalogDigest,
        evidenceVersion: '1',
        requirements: requirements.map((item) =>
          item.requirementId === 'windowsml-ocr'
            ? { ...item, device: 'cpu' }
            : item,
        ),
        sourceLockSha256: sourceLockDigest,
      }),
    );
    assert.throws(
      () => createReceipt(input),
      /evidence is incomplete or inconsistent/u,
    );
    writeFileSync(
      evidencePath,
      canonicalJson({
        catalogSha256: catalogDigest,
        evidenceVersion: '1',
        requirements,
        sourceLockSha256: sourceLockDigest,
      }),
    );
    assert.equal(createReceipt(input).sourceLockSha256, sourceLockDigest);
    assert.doesNotThrow(() =>
      assertCatalogMatchesReceipt(outputPath, catalogPath),
    );

    const workerDrift = structuredClone(catalog);
    workerDrift.requirements[0].artifacts[0] = {
      bytes: 999,
      sha256: '9'.repeat(64),
    };
    writeFileSync(catalogPath, canonicalJson(workerDrift));
    assert.doesNotThrow(() =>
      assertCatalogMatchesReceipt(outputPath, catalogPath),
    );

    for (const mismatch of [
      {
        ...structuredClone(catalog),
        runtimeVersion: '9.9.9',
      },
      (() => {
        const changed = structuredClone(catalog);
        changed.requirements[0].modelFiles.sourceLockSha256 = '8'.repeat(64);
        return changed;
      })(),
      (() => {
        const changed = structuredClone(catalog);
        changed.requirements[0].modelFiles.manifestSha256 = '7'.repeat(64);
        return changed;
      })(),
    ]) {
      writeFileSync(catalogPath, canonicalJson(mismatch));
      assert.throws(
        () => assertCatalogMatchesReceipt(outputPath, catalogPath),
        /model bindings do not match the trusted model candidate/u,
      );
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('receipt content cannot override server metadata or source lock', () => {
  const receipt = {
    catalogSha256: 'd'.repeat(64),
    commitSha,
    evidenceSha256: 'e'.repeat(64),
    modelManifests: [
      {
        entryCount: 1,
        extractedBytes: 1,
        manifestSha256: 'f'.repeat(64),
        requirementId: 'whisper-primary',
      },
      {
        entryCount: 1,
        extractedBytes: 1,
        manifestSha256: '1'.repeat(64),
        requirementId: 'windowsml-ocr',
      },
    ],
    receiptVersion: '1',
    runId: 23,
    sourceLockSha256,
    version: '0.3.5',
    workflowId: 17,
    workflowPath,
  };
  assert.doesNotThrow(() =>
    validateReceipt(receipt, expected, {
      run: run(),
      workflow: workflow(),
    }),
  );
  for (const override of [
    { runId: 999 },
    { workflowId: 999 },
    { sourceLockSha256: '9'.repeat(64) },
    { commitSha: '9'.repeat(40) },
  ]) {
    assert.throws(
      () =>
        validateReceipt({ ...receipt, ...override }, expected, {
          run: run(),
          workflow: workflow(),
        }),
      /identity or source binding/u,
    );
  }
});
