import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertCanonicalAuthorityContainment,
  openFilesystemAuthority,
} from './filesystem-authority.ts';

test('ancestor junction aliases are accepted while direct and child reparses are rejected', async (t) => {
  const physicalRoot = await mkdtemp(join(tmpdir(), 'capture-filesystem-authority-physical-'));
  const aliasRoot = join(
    tmpdir(),
    `capture-filesystem-authority-alias-${process.pid}-${Date.now()}`,
  );
  const outsideRoot = await mkdtemp(join(tmpdir(), 'capture-filesystem-authority-outside-'));
  const authorityRoot = join(aliasRoot, 'authority');
  const directRootLink = join(aliasRoot, 'direct-root-link');
  const insideTarget = join(physicalRoot, 'authority', 'inside-target');
  const insideChildLink = join(authorityRoot, 'inside-child-link');
  const outsideChildLink = join(authorityRoot, 'outside-child-link');

  try {
    try {
      await symlink(physicalRoot, aliasRoot, 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('real junction creation is unavailable in this environment');
        return;
      }
      throw error;
    }
    assert.notEqual(await realpath(aliasRoot), aliasRoot);
    await mkdir(authorityRoot, { recursive: true });
    await writeFile(join(authorityRoot, 'safe.txt'), 'safe', 'utf8');
    await mkdir(insideTarget, { recursive: true });

    const authority = await openFilesystemAuthority(authorityRoot);
    assert.equal(
      await authority.resolveFile(join(authorityRoot, 'safe.txt'), 'safe file'),
      join(authority.canonicalRoot, 'safe.txt'),
    );

    await symlink(join(physicalRoot, 'authority'), directRootLink, 'junction');
    await assert.rejects(
      openFilesystemAuthority(directRootLink),
      /link|regular directory/u,
    );

    await symlink(insideTarget, insideChildLink, 'junction');
    await assert.rejects(
      authority.resolveDirectory(insideChildLink, 'inside child link'),
      /link|regular directory/u,
    );

    await symlink(outsideRoot, outsideChildLink, 'junction');
    await assert.rejects(
      authority.resolveDirectory(outsideChildLink, 'outside child link'),
      /link|regular directory/u,
    );

    const nestedAuthority = await openFilesystemAuthority(join(authorityRoot, 'inside-target'));
    assertCanonicalAuthorityContainment(
      authority,
      nestedAuthority,
      'nested authority',
    );
  } finally {
    await rm(directRootLink, { force: true });
    await rm(insideChildLink, { force: true });
    await rm(outsideChildLink, { force: true });
    await rm(aliasRoot, { force: true });
    await rm(physicalRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});
