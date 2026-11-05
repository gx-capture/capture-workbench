import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function normalizeRoute(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.split('?')[0].replace(/\{[^}]*\}|:[A-Za-z_]\w*/gu, '{}').replace(/\/$/u, '')}`;
}

// Mask comments and strings for brace matching, keeping source offsets intact.
// Preserve strings separately in the source used for route patterns.
function mask(source: string, strings: boolean): string {
  return source.replace(
    /r(#+)?"[\s\S]*?"\1|"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu,
    (value) => (!strings && !value.startsWith('//') && !value.startsWith('/*'))
      ? value : value.replace(/[^\n]/gu, ' '),
  );
}

function blockEnd(masked: string, start: number): number {
  let depth = 0;
  for (let index = start; index < masked.length; index += 1) {
    if (masked[index] === '{') depth += 1;
    if (masked[index] === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error('Unclosed Rust route block.');
}

function productionSource(source: string): string {
  let result = mask(source, false);
  // Unit tests can mention routes that production no longer serves.
  for (;;) {
    const test = /#\[cfg\(test\)\]/u.exec(result);
    if (!test) return result;
    const externalModule = /^#\[cfg\(test\)\]\s*mod\s+\w+\s*;/u.exec(result.slice(test.index));
    if (externalModule) {
      result = result.slice(0, test.index) + result.slice(test.index + externalModule[0].length);
      continue;
    }
    const masked = mask(result, true);
    const start = masked.indexOf('{', test.index);
    if (start < 0) throw new Error('Cannot parse Rust test module.');
    result = result.slice(0, test.index) + result.slice(blockEnd(masked, start));
  }
}

function functions(source: string): Map<string, string> {
  const result = new Map<string, string>();
  const masked = mask(source, true);
  for (const match of masked.matchAll(/\bfn\s+(\w+)(?:<[^{};]*>)?\s*\(/gu)) {
    const start = masked.indexOf('{', match.index);
    if (start < 0) throw new Error(`Cannot parse Rust function ${match[1]}.`);
    result.set(match[1], source.slice(match.index, blockEnd(masked, start)));
  }
  return result;
}

export function hostRoutes(sources: readonly string[]): Set<string> {
  const source = sources.map(productionSource).join('\n');
  const bodies = functions(source);
  const routes = new Set<string>();
  // The native transport takes method then path; accept literal and format! paths.
  for (const body of bodies.values()) {
    for (const call of body.matchAll(/\brequest(?:_json|_with_headers)?\s*\(\s*[^,]+,\s*"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)"\s*,\s*/gu)) {
      let expression = body.slice(call.index + call[0].length);
      const variable = /^&?(\w+)\s*,/u.exec(expression)?.[1];
      if (variable) {
        const binding = new RegExp(`\\blet\\s+(?:mut\\s+)?${variable}\\s*=\\s*`, 'u').exec(body.slice(0, call.index));
        if (binding) expression = body.slice(binding.index + binding[0].length);
      }
      const path = /^(?:&?format!\s*\(\s*)?"(\/[^"\n]+)"/u.exec(expression)?.[1];
      if (!path) throw new Error(`Cannot derive desktop ${call[1]} request path; extend the route extractor for this call pattern.`);
      routes.add(normalizeRoute(call[1], path));
    }
  }
  // Expand host wrappers whose method/id/suffix arguments build a route.
  // The prefix comes from their code, never from a second route inventory.
  for (const [name, body] of bodies) {
    if (!/method:\s*&str/u.test(body) || !/suffix:\s*&str/u.test(body)) continue;
    let template = body.match(/format!\s*\(\s*"(\/[^"\n]*\{suffix\}[^"\n]*)"/u)?.[1];
    if (!template) {
      const helper = body.match(/&?(\w+_path)\s*\(/u)?.[1];
      template = helper ? bodies.get(helper)?.match(/format!\s*\(\s*"(\/[^"\n]*\{suffix\}[^"\n]*)"/u)?.[1] : undefined;
    }
    if (!template) throw new Error(`Cannot derive host route template for ${name}.`);
    const calls = new RegExp(`\\b${name}\\s*\\(\\s*[^,]+,\\s*"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)"\\s*,\\s*[^,]+,\\s*"([^"\\n]*)"`, 'gu');
    for (const call of source.matchAll(calls)) {
      routes.add(normalizeRoute(call[1], template.replace('{suffix}', call[2])));
    }
  }
  // Direct SSE calls have an implicit GET method.
  for (const match of source.matchAll(/\brequest_sse\s*\(\s*[^,]+,\s*(?:&?format!\s*\(\s*)?"(\/[^"\n]+)"/gu)) {
    routes.add(normalizeRoute('GET', match[1]));
  }
  if (routes.size === 0) throw new Error('No desktop host runtime routes were derived.');
  return routes;
}

export function fakeRoutes(sources: readonly string[]): Set<string> {
  const bodies = functions(sources.map(productionSource).join('\n'));
  const root = bodies.get('route');
  if (!root) throw new Error('Missing deterministic fake runtime route table.');
  const routes = new Set<string>();
  for (const match of root.matchAll(/\("(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)"\s*,\s*"(\/[^"\n]+)"\)/gu)) {
    routes.add(normalizeRoute(match[1], match[2]));
  }
  // Only traverse handlers actually dispatched by the top-level route table.
  for (const dispatch of root.matchAll(/request\.path\.starts_with\("([^"\n]+)"\)\s*=>\s*\{?\s*self\.(\w+)\(&request\)/gu)) {
    const body = bodies.get(dispatch[2]);
    if (!body) throw new Error(`Missing deterministic route handler ${dispatch[2]}.`);
    const prefix = `${dispatch[1]}{}`;
    for (const match of body.matchAll(/\("(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)"\s*,\s*"([^"\n]*)"\)/gu)) {
      routes.add(normalizeRoute(match[1], prefix + (match[2] ? `/${match[2]}` : '')));
    }
    for (const match of body.matchAll(/\("(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)"\s*,\s*(\w+)\)\s*if\s*\2\.starts_with\("([^"\n]+)"\)/gu)) {
      routes.add(normalizeRoute(match[1], `${prefix}/${match[3]}{}`));
    }
    // Installation handlers express their suffix routes with if/strip_suffix.
    const masked = mask(body, true);
    const suffixBlocks: [number, number][] = [];
    for (const match of body.matchAll(/if\s+let\s+Some\([^)]*\)\s*=\s*\w+\.strip_suffix\("([^"\n]+)"\)\s*\{/gu)) {
      const start = masked.indexOf('{', match.index);
      const end = blockEnd(masked, start);
      suffixBlocks.push([match.index, end]);
      for (const method of body.slice(start, end).matchAll(/request\.method\s*==\s*"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)"/gu)) {
        routes.add(normalizeRoute(method[1], prefix + match[1]));
      }
    }
    for (const match of body.matchAll(/request\.method\s*==\s*"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)"/gu)) {
      if (!suffixBlocks.some(([start, end]) => match.index >= start && match.index < end)) {
        routes.add(normalizeRoute(match[1], prefix));
      }
    }
  }
  return routes;
}

export function missingFakeRoutes(host: ReadonlySet<string>, fake: ReadonlySet<string>): string[] {
  return [...host].filter((route) => !fake.has(route)).sort();
}

function rustSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return rustSources(join(root, entry.name));
    return entry.name.endsWith('.rs') && !/(?:^|[._])tests?\.rs$/u.test(entry.name)
      ? [readFileSync(join(root, entry.name), 'utf8')] : [];
  });
}

export function checkFakeRuntimeRoutes(desktopRoot: string): number {
  const nativeRoot = join(desktopRoot, 'src-tauri', 'src');
  const host = hostRoutes([
    ...readdirSync(nativeRoot).filter((name) => /^runtime_client.*\.rs$/u.test(name))
      .map((name) => readFileSync(join(nativeRoot, name), 'utf8')),
    ...rustSources(join(nativeRoot, 'runtime_client')),
  ]);
  const fake = fakeRoutes(rustSources(join(desktopRoot, 'scripts', 'fixtures', 'deterministic-runtime', 'src')));
  const missing = missingFakeRoutes(host, fake);
  if (missing.length > 0) throw new Error(`Deterministic fake runtime is missing desktop host routes:\n${missing.map((route) => `  ${route}`).join('\n')}`);
  return host.size;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const desktopRoot = resolve(import.meta.dirname, '../apps/capture-workbench-desktop');
    const count = checkFakeRuntimeRoutes(desktopRoot);
    console.log(`Deterministic fake runtime routes verified: ${count} desktop host routes served.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
