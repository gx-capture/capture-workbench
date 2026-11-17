// Runs `cargo check`, `cargo test`, or `cargo build` for the desktop crate
// against the deterministic staged runtime. tauri-build requires every bundle
// resource to exist, and a fresh checkout has no product runtime in
// `src-tauri/binaries`; the deterministic stage lives under
// `target/deterministic-qa/staged` so it never overwrites product resources.
// Only `bundle.resources` is taken from the QA config, so the crate still
// compiles with the product identity.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRoot } from './stage-runtime.ts';
import { deterministicQaPaths } from './deterministic-qa.ts';

const command = process.argv[2];
if (command !== 'check' && command !== 'test' && command !== 'build') {
  throw new Error('Use: cargo-deterministic-qa.ts check|test|build [--features <list>] [--lib] [--bin <name>]');
}
const missing = Object.values(deterministicQaPaths).filter((path) => !existsSync(path));
if (missing.length > 0) {
  throw new Error(`Run capture-workbench-desktop:stage-deterministic-runtime first; missing ${missing.join(', ')}`);
}
const tauriDir = join(appRoot, 'src-tauri');
const qaConfig = JSON.parse(readFileSync(join(tauriDir, 'tauri.deterministic-qa.conf.json'), 'utf8')) as {
  bundle: { resources: Record<string, string> };
};
const cargoArgs = [command, '--manifest-path', join(tauriDir, 'Cargo.toml')];
const extraArgs = process.argv.slice(3);
for (let index = 0; index < extraArgs.length; index += 1) {
  const flag = extraArgs[index];
  if (flag === '--lib') {
    cargoArgs.push('--lib');
  } else if (flag === '--features' || flag === '--bin') {
    const value = extraArgs[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}.`);
    }
    cargoArgs.push(flag, value);
    index += 1;
  } else {
    throw new Error(`Unknown cargo-deterministic-qa argument: ${flag}`);
  }
}
const result = spawnSync('cargo', cargoArgs, {
  env: { ...process.env, TAURI_CONFIG: JSON.stringify({ bundle: { resources: qaConfig.bundle.resources } }) },
  windowsHide: true,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
