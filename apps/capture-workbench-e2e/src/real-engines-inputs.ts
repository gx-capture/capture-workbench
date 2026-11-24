import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const PROGRESSIVE_AUDIO_ENV = 'CAPTURE_REAL_ENGINES_PROGRESSIVE_AUDIO';
export const PROGRESSIVE_AUDIO_ORACLE_ENV = 'CAPTURE_REAL_ENGINES_PROGRESSIVE_AUDIO_ORACLE';

export function progressiveAudioPaths(env: NodeJS.ProcessEnv):
  { readonly audioPath: string; readonly oraclePath: string } | undefined {
  const audio = env[PROGRESSIVE_AUDIO_ENV];
  const oracle = env[PROGRESSIVE_AUDIO_ORACLE_ENV];
  if (audio === undefined && oracle === undefined) return undefined;
  const audioPath = audio?.trim();
  const oraclePath = oracle?.trim();
  if (!audioPath || !oraclePath) {
    throw new Error(`Set both ${PROGRESSIVE_AUDIO_ENV} and ${PROGRESSIVE_AUDIO_ORACLE_ENV}.`);
  }
  return { audioPath, oraclePath };
}

type SpeechRecognition = { readonly device?: string | null; readonly model: string };

export function requireMatchingProgressiveSpeech(
  oracle: { readonly speechPack: string; readonly extraction: SpeechRecognition },
  installedPack: string,
  observed: SpeechRecognition | undefined,
): void {
  if (oracle.speechPack === installedPack && oracle.extraction.device === observed?.device
    && oracle.extraction.model === observed?.model) return;
  throw new Error(
    `Progressive audio oracle uses ${oracle.speechPack} pack, ${oracle.extraction.device} device and ${oracle.extraction.model} model. `
    + `The installation uses ${installedPack} pack, ${observed?.device ?? 'unknown'} device and ${observed?.model ?? 'unknown'} model. Regenerate the oracle for this installation.`,
  );
}

// Canonicalize the nearest existing ancestor before creating any directories.
// lstat keeps dangling symlinks from being treated as ordinary missing paths.
function resolveDirectory(path: string): string {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(resolveDirectory(parent), relative(parent, path));
  }
  const canonical = realpathSync.native(path);
  if (!statSync(canonical).isDirectory()) throw new Error(`Expected a directory at ${path}.`);
  return canonical;
}

export function requirePrivateDirectory(path: string, workspaceRoot: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute directory path.`);
  const canonical = resolveDirectory(resolve(path));
  const workspace = realpathSync.native(workspaceRoot);
  const fromWorkspace = relative(workspace, canonical);
  if (!fromWorkspace || (!isAbsolute(fromWorkspace)
    && fromWorkspace !== '..' && !fromWorkspace.startsWith(`..${sep}`))) {
    throw new Error(`${label} must be outside the workspace. Resolved path: ${canonical}.`);
  }
  return canonical;
}
