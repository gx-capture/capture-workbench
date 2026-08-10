import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const tauriRoot = new URL('../src-tauri/', import.meta.url);

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, tauriRoot), 'utf8');
}

test('model smoke fixture command is absent unless model-smoke-app-data is compiled', async () => {
  const [cargo, commands, app] = await Promise.all([
    source('Cargo.toml'),
    source('src/commands.rs'),
    source('src/lib.rs'),
  ]);
  assert.match(cargo, /model-smoke-app-data\s*=\s*\[\]/u);
  assert.match(
    app,
    /#\[cfg\(feature = "model-smoke-app-data"\)\]\s*mod model_smoke_fixtures;/u,
  );
  assert.match(
    commands,
    /#\[cfg\(feature = "model-smoke-app-data"\)\]\s*#\[tauri::command\]\s*pub async fn model_smoke_import_fixture/u,
  );
  assert.match(
    app,
    /#\[cfg\(feature = "model-smoke-app-data"\)\]\s*let builder = builder\.invoke_handler\(desktop_invoke_handler!\(\s*commands::model_smoke_import_fixture/u,
  );
  assert.match(
    app,
    /#\[cfg\(not\(feature = "model-smoke-app-data"\)\)\]\s*let builder = builder\.invoke_handler\(desktop_invoke_handler!\(\)\);/u,
  );
});

test('keyed fixture command delegates to the existing native import validation path', async () => {
  const [commands, registry] = await Promise.all([
    source('src/commands.rs'),
    source('src/model_smoke_fixtures.rs'),
  ]);
  assert.match(commands, /fixtures\.resolve\(&request\.fixture_key\)\?/u);
  assert.match(
    commands,
    /library\.import_source\(LibraryImportSourceRequest \{\s*source_path:/u,
  );
  assert.match(registry, /pub\(crate\) fixture_key: String/u);
  assert.doesNotMatch(registry, /pub\(crate\) source_path/u);
  for (const environmentName of [
    'CAPTURE_SMOKE_FIXTURE_ROOT',
    'CAPTURE_SMOKE_FIXTURE_PDF',
    'CAPTURE_SMOKE_FIXTURE_IMAGE',
    'CAPTURE_SMOKE_FIXTURE_AUDIO',
  ]) {
    assert.match(registry, new RegExp(environmentName, 'u'));
  }
  assert.match(registry, /fs::canonicalize\(source\)/u);
  assert.match(registry, /canonical\.starts_with\(&self\.root\)/u);
  assert.match(registry, /file_type\(\)\.is_symlink\(\)/u);
  assert.match(registry, /MAX_SOURCE_BYTES/u);
  assert.match(registry, /extension_allowed_for_key/u);
});

test('model smoke launcher uses only keyed injection and labels the picker bypass', async () => {
  const [smoke, projectText] = await Promise.all([
    readFile(new URL('./real-media-model-smoke.ts', import.meta.url), 'utf8'),
    readFile(new URL('../project.json', import.meta.url), 'utf8'),
  ]);
  const project = JSON.parse(projectText) as {
    targets: Record<string, { options: { command?: string }; metadata?: { description?: string } }>;
  };
  assert.match(smoke, /'model_smoke_import_fixture'/u);
  assert.match(smoke, /request: \{ fixtureKey \}/u);
  assert.doesNotMatch(smoke, /function importThroughUi/u);
  assert.match(smoke, /deterministic-feature-gated-picker-bypass/u);
  assert.match(smoke, /nativePickerExercised: false/u);
  assert.match(
    project.targets['build-model-smoke'].options.command ?? '',
    /--features model-smoke-app-data/u,
  );
  assert.doesNotMatch(
    project.targets.build.options.command ?? '',
    /model-smoke-app-data/u,
  );
  assert.match(
    project.targets['smoke-real-media-model'].metadata?.description ?? '',
    /deterministic picker bypass/u,
  );
});
