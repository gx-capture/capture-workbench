import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { concatMap, defer, from, map, of, throwError, toArray } from 'rxjs';

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
const indexPath = join(bundleRoot, 'index.html');

function collectJavascriptFiles(directory) {
  return defer(() => from(readdir(directory, { withFileTypes: true }))).pipe(
    concatMap((entries) => from(entries)),
    concatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectJavascriptFiles(path).pipe(concatMap((files) => from(files)));
      }
      return entry.isFile() && extname(entry.name) === '.js' ? of(path) : of();
    }),
    toArray(),
    map((files) => files.sort()),
  );
}

function verifyProductionBundle() {
  return collectJavascriptFiles(bundleRoot).pipe(
    concatMap((javascriptFiles) => {
      if (javascriptFiles.length === 0) {
        return throwError(
          () => new Error(`No production JavaScript bundles found under ${bundleRoot}`),
        );
      }
      return defer(() => from(readFile(indexPath, 'utf8'))).pipe(
        map((index) => {
          if (/rel="stylesheet"[^>]*media="print"[^>]*onload=/iu.test(index)) {
            throw new Error(
              'Production stylesheet uses an inline onload handler that strict Tauri CSP blocks; disable Angular critical-CSS inlining for this desktop bundle.',
            );
          }
          if (!/rel="stylesheet"[^>]*href="styles-[^"]+\.css"/iu.test(index)) {
            throw new Error('Production bundle does not link its stylesheet as a normal self-hosted asset.');
          }
          return undefined;
        }),
        concatMap(() => from(javascriptFiles)),
        concatMap((file) =>
          defer(() => from(readFile(file, 'utf8'))).pipe(
            map((contents) => ({ file, normalizedContents: contents.toLowerCase() })),
          ),
        ),
        concatMap(({ file, normalizedContents }) =>
          from(forbiddenMarkers).pipe(
            map((marker) =>
              normalizedContents.includes(marker)
                ? `${relative(workspaceRoot, file)} contains ${JSON.stringify(marker)}`
                : undefined,
            ),
          ),
        ),
        toArray(),
        concatMap((violations) => {
          const actualViolations = violations.filter(Boolean);
          if (actualViolations.length > 0) {
            return throwError(
              () =>
                new Error(
                  `Production Capture Workbench contains deterministic fixture code:\n${actualViolations.join('\n')}`,
                ),
            );
          }
          return of(javascriptFiles.length);
        }),
      );
    }),
  );
}

verifyProductionBundle().subscribe({
  next: (count) =>
    console.log(
      `Verified ${count} production JavaScript bundle(s): deterministic fixtures are absent.`,
    ),
  error: (error) => {
    throw error;
  },
});
