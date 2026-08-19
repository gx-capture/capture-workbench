import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

export type AcceptanceStatus = 'running' | 'completed' | 'failed';

export interface AcceptanceRun {
  readonly project: string;
  readonly runId: string;
  readonly recordVideo: boolean;
  readonly artifactRoot: string;
}

export interface AcceptanceArtifactInput {
  readonly path: string;
  readonly kind: 'video' | 'screenshot' | 'trace' | 'report' | 'log' | 'other';
}

export interface AcceptanceArtifact {
  readonly path: string;
  readonly kind: AcceptanceArtifactInput['kind'];
  readonly bytes: number;
  readonly sha256: string;
}

export interface AcceptanceManifestInput {
  readonly project: string;
  readonly runId: string;
  readonly status: AcceptanceStatus;
  readonly recordVideo: boolean;
  readonly artifacts: readonly AcceptanceArtifactInput[];
  readonly errors?: readonly string[];
  readonly consoleErrors?: readonly string[];
  readonly pageErrors?: readonly string[];
  readonly cleanup: {
    readonly app: boolean;
    readonly sidecar: boolean;
    readonly cdpPort: boolean;
    readonly temporaryAppData: boolean;
  };
  readonly fixture?: {
    readonly name: string;
    readonly sha256: string;
  };
}

export interface AcceptanceManifest {
  readonly schemaVersion: 1;
  readonly project: string;
  readonly runId: string;
  readonly status: AcceptanceStatus;
  readonly recordVideo: boolean;
  readonly artifacts: readonly AcceptanceArtifact[];
  readonly errors: readonly string[];
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
  readonly cleanup: AcceptanceManifestInput['cleanup'];
  readonly fixture?: AcceptanceManifestInput['fixture'];
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export function createAcceptanceRun(
  environment: NodeJS.ProcessEnv,
  project: string,
  workspaceRoot: string,
): AcceptanceRun {
  if (!PROJECT_PATTERN.test(project)) {
    throw new Error(`Acceptance project name is invalid: ${project}`);
  }
  const runId = environment.E2E_ACCEPTANCE_RUN_ID?.trim();
  if (!runId) {
    throw new Error('E2E_ACCEPTANCE_RUN_ID must be set for acceptance runs.');
  }
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Acceptance run ID is invalid: ${runId}`);
  }
  const recordVideo = parseBoolean(environment.E2E_RECORD_VIDEO, 'E2E_RECORD_VIDEO');
  const projectRoot = resolve(workspaceRoot, 'output', 'playwright', project);
  const artifactRoot = resolve(
    environment.E2E_ARTIFACT_ROOT?.trim() || resolve(projectRoot, runId),
  );
  const relativeArtifactRoot = relative(projectRoot, artifactRoot);
  if (
    relativeArtifactRoot !== runId ||
    relativeArtifactRoot === '..' ||
    relativeArtifactRoot.startsWith(`..${sep}`) ||
    /^[A-Za-z]:/u.test(relativeArtifactRoot)
  ) {
    throw new Error('E2E_ARTIFACT_ROOT must equal output/playwright/<project>/<run-id>.');
  }
  return { project, runId, recordVideo, artifactRoot };
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value.trim() === '') return false;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  throw new Error(`${name} must be 0, 1, true, or false.`);
}

export async function sha256File(filePath: string): Promise<string> {
  const contents = await readFile(filePath);
  return createHash('sha256').update(contents).digest('hex');
}

export async function assertWebmArtifact(filePath: string): Promise<true> {
  const metadata = await stat(filePath).catch(() => undefined);
  if (!metadata?.isFile() || metadata.size === 0) {
    throw new Error(`Acceptance recording must be a non-empty WebM: ${redactAcceptanceText(filePath)}`);
  }
  const header = (await readFile(filePath)).subarray(0, 4);
  if (!header.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    throw new Error(`Acceptance recording is not an EBML/WebM file: ${redactAcceptanceText(filePath)}`);
  }
  return true;
}

export async function writeAcceptanceManifest(
  artifactRoot: string,
  input: AcceptanceManifestInput,
): Promise<string> {
  await mkdir(artifactRoot, { recursive: true });
  const artifacts: AcceptanceArtifact[] = [];
  for (const artifact of input.artifacts) {
    const absolutePath = resolve(artifact.path);
    const relativePath = relative(resolve(artifactRoot), absolutePath);
    if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === '..' || /^[A-Za-z]:/u.test(relativePath)) {
      throw new Error(`Acceptance artifact must stay inside its artifact root: ${redactAcceptanceText(artifact.path)}`);
    }
    await sanitizeTextArtifact(absolutePath);
    let metadata = await stat(absolutePath).catch(() => undefined);
    if (!metadata?.isFile()) {
      throw new Error(`Acceptance artifact is missing: ${redactAcceptanceText(artifact.path)}`);
    }
    if (artifact.kind === 'trace' || artifact.kind === 'report') {
      sanitizeAcceptanceArchive(absolutePath);
      metadata = await stat(absolutePath);
    }
    artifacts.push({
      path: relativePath.split(sep).join('/'),
      kind: artifact.kind,
      bytes: metadata.size,
      sha256: await sha256File(absolutePath),
    });
  }
  const manifest: AcceptanceManifest = {
    schemaVersion: 1,
    project: input.project,
    runId: input.runId,
    status: input.status,
    recordVideo: input.recordVideo,
    artifacts,
    errors: (input.errors ?? []).map(redactAcceptanceText),
    consoleErrors: (input.consoleErrors ?? []).map(redactAcceptanceText),
    pageErrors: (input.pageErrors ?? []).map(redactAcceptanceText),
    cleanup: input.cleanup,
    fixture: input.fixture,
  };
  const manifestPath = resolve(artifactRoot, 'acceptance-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifestPath;
}

async function sanitizeTextArtifact(filePath: string): Promise<void> {
  if (!/\.(?:html|json|jsonl|log|md|txt)$/iu.test(filePath)) return;
  const value = await readFile(filePath, 'utf8');
  if (filePath.toLowerCase().endsWith('.json')) {
    try {
      await writeFile(
        filePath,
        `${JSON.stringify(redactStructuredValue(JSON.parse(value)), null, 2)}\n`,
        'utf8',
      );
      return;
    } catch {
      // Fall through to text redaction for malformed diagnostic output.
    }
  }
  if (filePath.toLowerCase().endsWith('.jsonl')) {
    const lines = value.split(/\r?\n/u).map((line) => {
      if (!line.trim()) return line;
      try {
        return JSON.stringify(redactStructuredValue(JSON.parse(line)));
      } catch {
        return redactAcceptanceText(line);
      }
    });
    await writeFile(filePath, lines.join('\n'), 'utf8');
    return;
  }
  await writeFile(filePath, redactAcceptanceText(value), 'utf8');
}

function redactStructuredValue(value: unknown, key?: string): unknown {
  if (key && isSensitiveKey(key)) return '<redacted>';
  if (typeof value === 'string') return redactAcceptanceText(value);
  if (Array.isArray(value)) return value.map((item) => redactStructuredValue(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        redactStructuredValue(nested, key),
      ]),
    );
  }
  return value;
}

function isSensitiveKey(key: string): boolean {
  return /(?:authorization|token|secret|password|api[_-]?key|private[_-]?key)/iu.test(key);
}

function sanitizeAcceptanceArchive(filePath: string): void {
  if (!filePath.toLowerCase().endsWith('.zip')) return;
  const script = String.raw`
import os
import json
import re
import sys
import tempfile
import time
import zipfile

path = sys.argv[1]
bearer = re.compile(r'''Bearer\s+("[^"]*"|'[^']*'|[^\s,;}\]"']+)''', re.IGNORECASE)
credential = re.compile(r'''((?:"?(?:authorization|token|secret|password)"?)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\r\n,;}"'\]]+)''', re.IGNORECASE)
windows_path = re.compile(r'''[A-Za-z]:[\\/][^"'<>\r\n]+''')
unix_path = re.compile(r'''/(?:Users|private|home|tmp|var|workspace|software-dev)/[^"'<>\r\n]+''', re.IGNORECASE)

def redacted_value(value):
    if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
        return value[0] + '<redacted>' + value[0]
    return '<redacted>'

def redact(value):
    value = bearer.sub(lambda match: 'Bearer ' + redacted_value(match.group(1)), value)
    value = credential.sub(lambda match: match.group(1) + redacted_value(match.group(2)), value)
    value = windows_path.sub('<private-path>', value)
    return unix_path.sub('<private-path>', value)

def sensitive_key(key):
    return re.search(r'(?:authorization|token|secret|password|api[_-]?key|private[_-]?key)', key, re.IGNORECASE) is not None

def redact_object(value, key=None):
    if key is not None and sensitive_key(key):
        return '<redacted>'
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, list):
        return [redact_object(item) for item in value]
    if isinstance(value, dict):
        return {key: redact_object(item, key) for key, item in value.items()}
    return value

def scrub(payload, name):
    try:
        text = payload.decode('utf-8')
    except UnicodeDecodeError:
        return payload
    try:
        return json.dumps(redact_object(json.loads(text)), ensure_ascii=False, indent=2).encode('utf-8')
    except (TypeError, ValueError, json.JSONDecodeError):
        pass
    if name.lower().endswith(('.jsonl', '.ndjson')):
        lines = []
        parsed_any = False
        for line in text.splitlines(keepends=True):
            if not line.strip():
                lines.append(line)
                continue
            try:
                lines.append(json.dumps(redact_object(json.loads(line)), ensure_ascii=False) + ('\n' if line.endswith('\n') else ''))
                parsed_any = True
            except (TypeError, ValueError, json.JSONDecodeError):
                lines.append(redact(line))
        if parsed_any:
            return ''.join(lines).encode('utf-8')
    return redact(text).encode('utf-8')

with zipfile.ZipFile(path, 'r') as source:
    entries = [(info, scrub(source.read(info), info.filename)) for info in source.infolist()]
fd, temporary = tempfile.mkstemp(prefix='acceptance-redacted-', suffix='.zip', dir=os.path.dirname(path))
os.close(fd)
try:
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED) as target:
        for info, payload in entries:
            target.writestr(info, payload)
    for attempt in range(10):
        try:
            os.replace(temporary, path)
            break
        except PermissionError:
            if attempt == 9:
                raise
            time.sleep(0.25)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
`;
  const commands: readonly [string, readonly string[]][] = process.platform === 'win32'
    ? [['py', ['-3', '-c', script, filePath]], ['python', ['-c', script, filePath]]]
    : [['python3', ['-c', script, filePath]], ['python', ['-c', script, filePath]]];
  const diagnostics: string[] = [];
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
    if (result.status === 0) return;
    diagnostics.push(`${command}: ${String(result.stderr || '').trim()}`);
  }
  throw new Error(`Acceptance ZIP artifact could not be sanitized: ${redactAcceptanceText(filePath)} (${redactAcceptanceText(diagnostics.join(' | ')).slice(0, 240)})`);
}

export async function collectAcceptanceArtifactInputs(
  artifactRoot: string,
): Promise<AcceptanceArtifactInput[]> {
  const entries = await readdir(artifactRoot, { withFileTypes: true }).catch(() => []);
  const artifacts: AcceptanceArtifactInput[] = [];
  for (const entry of entries) {
    if (entry.name === 'acceptance-manifest.json') continue;
    const path = resolve(artifactRoot, entry.name);
    if (entry.isDirectory()) {
      artifacts.push(...await collectAcceptanceArtifactInputs(path));
    } else if (entry.isFile()) {
      artifacts.push({ path, kind: acceptanceArtifactKind(path) });
    }
  }
  return artifacts;
}

function acceptanceArtifactKind(path: string): AcceptanceArtifactInput['kind'] {
  if (path.endsWith('.webm')) return 'video';
  if (path.endsWith('.png')) return 'screenshot';
  if (path.endsWith('.zip')) return 'trace';
  if (path.endsWith('.html') || path.endsWith('.md')) return 'report';
  if (path.endsWith('.log') || path.endsWith('.json') || path.endsWith('.jsonl')) return 'log';
  return 'other';
}

export function redactAcceptanceText(value: string): string {
  return value
    .replace(
      /Bearer\s+("[^"]*"|'[^']*'|[^\s,;}\]"']+)/giu,
      (_match: string, secret: string) => `Bearer ${redactDelimitedValue(secret)}`,
    )
    .replace(
      /((?:"?(?:authorization|token|secret|password)"?)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\r\n,;}"'\]]+)/giu,
      (_match: string, prefix: string, secret: string) => `${prefix}${redactDelimitedValue(secret)}`,
    )
    .replace(/[A-Za-z]:[\\/][^"'<>\r\n]+/gu, '<private-path>')
    .replace(/\/(?:Users|private|home|tmp|var|workspace|software-dev)\/[^"'<>\r\n]+/giu, '<private-path>');
}

function redactDelimitedValue(value: string): string {
  const quote = value[0];
  return (quote === '"' || quote === "'") && value.at(-1) === quote
    ? `${quote}<redacted>${quote}`
    : '<redacted>';
}
