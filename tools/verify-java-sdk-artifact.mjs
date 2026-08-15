import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const pom = await readFile(join(root, 'packages/capture-runtime-client-java/pom.xml'), 'utf8');
const version = pom.match(/<version>(\d+\.\d+\.\d+(?:-[^<]+)?)<\/version>/u)?.[1] ?? '0.4.0';
const expected =
  process.env.CAPTURE_CONTRACT_SET_SHA256 ??
  (await readFile(join(root, 'packages/capture-runtime/src/capture_runtime/assets/contract-set.sha256'), 'utf8')).trim();
if (!/^[0-9a-f]{64}$/u.test(expected)) throw new Error('Expected Java SDK contract-set hash is invalid.');
const jar = join(root, 'packages/capture-runtime-client-java', 'target', `capture-runtime-client-${version}.jar`);
const listing = execFileSync(process.platform === 'win32' ? 'jar.exe' : 'jar', ['tf', jar], { encoding: 'utf8' });
if (!listing.split(/\r?\n/u).includes('capture-runtime-contract-set.sha256')) throw new Error('Java SDK jar is missing the contract-set hash resource.');
const extracted = execFileSync(process.platform === 'win32' ? 'jar.exe' : 'jar', ['xf', jar, 'capture-runtime-contract-set.sha256'], { cwd: join(root, 'packages/capture-runtime-client-java', 'target'), encoding: 'utf8' });
void extracted;
const actual = (await readFile(join(root, 'packages/capture-runtime-client-java', 'target', 'capture-runtime-contract-set.sha256'), 'utf8')).trim();
if (actual !== expected) throw new Error(`Java SDK contract-set hash differs: ${actual}`);
console.log('Verified Java SDK artifact contract-set hash.');
