// Runs `cargo check` or `cargo test` for the desktop crate against the
// deterministic staged runtime. tauri-build requires every bundle resource to
// exist, and a fresh checkout has no product runtime in `src-tauri/binaries`;
// the deterministic stage lives under `target/deterministic-qa/staged` so it
// never overwrites product resources. Only `bundle.resources` is taken from the
// QA config, so the crate still compiles with the product identity.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRoot } from './stage-runtime.ts';
import { deterministicQaPaths } from './deterministic-qa.ts';

const command = process.argv[2];
if (process.argv.length !== 3 || (command !== 'check' && command !== 'test')) {
  throw new Error('Use: cargo-deterministic-qa.ts check|test');
}
const missing = Object.values(deterministicQaPaths).filter((path) => !existsSync(path));
if (missing.length > 0) {
  throw new Error(`Run capture-workbench-desktop:stage-deterministic-runtime first; missing ${missing.join(', ')}`);
}
const tauriDir = join(appRoot, 'src-tauri');
const qaConfig = JSON.parse(readFileSync(join(tauriDir, 'tauri.deterministic-qa.conf.json'), 'utf8')) as {
  bundle: { resources: Record<string, string> };
};
const result = spawnSync('cargo', [command, '--manifest-path', join(tauriDir, 'Cargo.toml')], {
  env: { ...process.env, TAURI_CONFIG: JSON.stringify({ bundle: { resources: qaConfig.bundle.resources } }) },
  windowsHide: true,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
