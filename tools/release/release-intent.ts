import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const workspaceRoot = resolve(import.meta.dirname, '../..');
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const API_VERSION_PATTERN = /^\d+\.\d+$/u;
const SCHEMA_VERSION_PATTERN = /^\d+$/u;

export interface ReleaseIntent {
  releaseVersion: string;
  runtimeApiVersion: string;
  documentSchemaVersion: string;
}

export function rejectDuplicateJsonKeys(
  content: string,
  sourcePath: string,
): void {
  let index = 0;

  const skipWhitespace = (): void => {
    while (index < content.length && /\s/u.test(content[index])) index += 1;
  };

  const readStringToken = (): string => {
    const start = index;
    if (content[index] !== '"') {
      throw new Error(`Expected a JSON object key in ${sourcePath}.`);
    }
    index += 1;
    while (index < content.length) {
      const character = content[index];
      if (character === '\\') {
        index += 2;
        continue;
      }
      index += 1;
      if (character === '"') return content.slice(start, index);
    }
    throw new Error(`Unterminated JSON string in ${sourcePath}.`);
  };

  const readValue = (path: readonly string[]): void => {
    skipWhitespace();
    const character = content[index];
    if (character === '"') {
      readStringToken();
      return;
    }
    if (character === '{') {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (content[index] === '}') {
        index += 1;
        return;
      }
      while (index < content.length) {
        skipWhitespace();
        const key = JSON.parse(readStringToken()) as string;
        if (keys.has(key)) {
          throw new Error(
            `Duplicate JSON key ${[...path, key].join('.')} in ${sourcePath}.`,
          );
        }
        keys.add(key);
        skipWhitespace();
        if (content[index] !== ':') {
          throw new Error(`Missing JSON colon for ${key} in ${sourcePath}.`);
        }
        index += 1;
        readValue([...path, key]);
        skipWhitespace();
        if (content[index] === '}') {
          index += 1;
          return;
        }
        if (content[index] !== ',') {
          throw new Error(`Missing JSON separator in ${sourcePath}.`);
        }
        index += 1;
      }
      throw new Error(`Unterminated JSON object in ${sourcePath}.`);
    }
    if (character === '[') {
      index += 1;
      skipWhitespace();
      let item = 0;
      if (content[index] === ']') {
        index += 1;
        return;
      }
      while (index < content.length) {
        readValue([...path, String(item++)]);
        skipWhitespace();
        if (content[index] === ']') {
          index += 1;
          return;
        }
        if (content[index] !== ',') {
          throw new Error(`Missing JSON array separator in ${sourcePath}.`);
        }
        index += 1;
      }
      throw new Error(`Unterminated JSON array in ${sourcePath}.`);
    }
    const start = index;
    while (index < content.length && !/[\s,\]}]/u.test(content[index])) {
      index += 1;
    }
    if (index === start) {
      throw new Error(`Missing JSON value in ${sourcePath}.`);
    }
  };

  readValue([]);
  skipWhitespace();
  if (index !== content.length) {
    throw new Error(`Trailing JSON content in ${sourcePath}.`);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function loadReleaseIntent(root = workspaceRoot): ReleaseIntent {
  const content = readFileSync(resolve(root, 'release/version.json'), 'utf8');
  rejectDuplicateJsonKeys(content, 'release/version.json');
  const intent = JSON.parse(content) as Record<string, unknown>;
  const releaseVersion = stringValue(intent.releaseVersion);
  const runtimeApiVersion = stringValue(intent.runtimeApiVersion);
  const documentSchemaVersion = stringValue(intent.documentSchemaVersion);
  if (!releaseVersion || !RELEASE_VERSION_PATTERN.test(releaseVersion)) {
    throw new Error('release/version.json has an invalid releaseVersion.');
  }
  if (!runtimeApiVersion || !API_VERSION_PATTERN.test(runtimeApiVersion)) {
    throw new Error('release/version.json has an invalid runtimeApiVersion.');
  }
  if (
    !documentSchemaVersion ||
    !SCHEMA_VERSION_PATTERN.test(documentSchemaVersion)
  ) {
    throw new Error(
      'release/version.json has an invalid documentSchemaVersion.',
    );
  }
  return { releaseVersion, runtimeApiVersion, documentSchemaVersion };
}

/** Repository tooling only. Published packages carry their own generated/native metadata. */
export const RELEASE_VERSION = loadReleaseIntent().releaseVersion;
