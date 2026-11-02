// The TypeScript reading of a worker artifact's source in the release engine
// catalog. It mirrors `EngineArtifactDescriptor`/`EngineArtifactPart` in
// packages/capture-runtime/src/capture_runtime/engine_catalog.py: a worker
// archive above one GitHub release asset (2 GB) is published as ordered parts
// `<fileName>.001`, `.002`, ... instead of one `url`, and the catalog keeps the
// whole archive's `bytes` and `sha256` alongside each part's own.

export interface EngineCatalogWorkerPart {
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly url: string;
}

/** A worker artifact's published source: one archive at `url`, or its parts. */
export type EngineCatalogWorkerSource =
  | { readonly url: string; readonly parts: readonly [] }
  | { readonly url: null; readonly parts: readonly EngineCatalogWorkerPart[] };

// GitHub release assets must stay under 2 GB; larger archives ship as parts.
const MAX_WORKER_PART_BYTES = 2_000_000_000;
const SHA256 = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Name of the one-based `index`th part of `fileName` (`artifact_parts.part_file_name`). */
export function workerPartFileName(fileName: string, index: number): string {
  return `${fileName}.${String(index).padStart(3, '0')}`;
}

/**
 * Reads the `url` or `parts` source of a worker artifact whose `fileName` and
 * whole-archive `bytes` the caller has already validated. Exactly one of the
 * two keys is present; parts are at least two, named in order, each within
 * one release asset, and add up to the archive.
 */
export function engineCatalogWorkerSource(
  artifact: Record<string, unknown>,
  fileName: string,
  bytes: number,
): EngineCatalogWorkerSource {
  if (!('parts' in artifact)) {
    if (
      typeof artifact.url !== 'string' ||
      !artifact.url.startsWith('https://')
    ) {
      throw new Error('Engine catalog worker artifact is invalid.');
    }
    return { url: artifact.url, parts: [] };
  }
  if ('url' in artifact)
    throw new Error('Engine catalog worker artifact is invalid.');
  const raw = artifact.parts;
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error('Engine catalog worker parts are invalid.');
  }
  const parts = raw.map((item: unknown, index): EngineCatalogWorkerPart => {
    if (!isRecord(item))
      throw new Error('Engine catalog worker part is invalid.');
    const keys = Object.keys(item).sort();
    if (keys.join(',') !== 'bytes,fileName,sha256,url') {
      throw new Error('Engine catalog worker part fields are not canonical.');
    }
    const expectedName = workerPartFileName(fileName, index + 1);
    if (
      item.fileName !== expectedName ||
      typeof item.bytes !== 'number' ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 1 ||
      item.bytes > MAX_WORKER_PART_BYTES ||
      typeof item.url !== 'string' ||
      !item.url.startsWith('https://')
    ) {
      throw new Error('Engine catalog worker part is invalid.');
    }
    if (typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) {
      throw new Error(
        'Engine catalog worker part digest must be a lowercase SHA-256 digest.',
      );
    }
    return {
      fileName: expectedName,
      bytes: item.bytes,
      sha256: item.sha256,
      url: item.url,
    };
  });
  if (parts.reduce((total, part) => total + part.bytes, 0) !== bytes) {
    throw new Error(
      'Engine catalog worker parts do not add up to the archive.',
    );
  }
  return { url: null, parts };
}

/** The release files published for a worker archive: itself, or its parts. */
export function workerPublishedFiles(worker: {
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly parts: readonly EngineCatalogWorkerPart[];
}): readonly {
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
}[] {
  return worker.parts.length
    ? worker.parts
    : [
        {
          fileName: worker.fileName,
          bytes: worker.bytes,
          sha256: worker.sha256,
        },
      ];
}
