import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const workspaceRoot = resolve(import.meta.dirname, '..');
const bundleRoot = join(
  workspaceRoot,
  'dist',
  'apps',
  'capture-workbench',
  'browser',
);
const forbiddenMarkers = [
  'deterministic',
  'isolated-ollama-fake',
  'host-provider-fake',
  'windowsml-fake',
  'whisper-fake',
  'unknown fake capture',
  'unknown fake installation',
  'capture fakes',
];

const javascriptFiles = await collectJavascriptFiles(bundleRoot);
if (javascriptFiles.length === 0) {
  throw new Error(`No production JavaScript bundles found under ${bundleRoot}`);
}

const violations = [];
for (const file of javascriptFiles) {
  const contents = await readFile(file, 'utf8');
  const normalizedContents = contents.toLowerCase();
  for (const marker of forbiddenMarkers) {
    if (normalizedContents.includes(marker)) {
      violations.push(`${relative(workspaceRoot, file)} contains ${JSON.stringify(marker)}`);
    }
  }
}

if (violations.length > 0) {
  throw new Error(
    `Production Capture Workbench contains deterministic fixture code:\n${violations.join('\n')}`,
  );
}

console.log(
  `Verified ${javascriptFiles.length} production JavaScript bundle(s): deterministic fixtures are absent.`,
);

async function collectJavascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJavascriptFiles(path)));
    } else if (entry.isFile() && extname(entry.name) === '.js') {
      files.push(path);
    }
  }
  return files.sort();
}
