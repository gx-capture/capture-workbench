import { dirname, relative, resolve } from 'node:path';
import {
  productionFile,
  type ComplexityConfig,
  type Finding,
} from './code-complexity-findings.ts';

const NESTING = 'excessive_nesting';
const CLIPPY_RULES = new Set([NESTING, 'too_many_lines', 'too_many_arguments']);

interface Span {
  is_primary: boolean;
  file_name: string;
  byte_start: number;
  byte_end: number;
}

interface CargoMessage {
  reason: string;
  manifest_path?: string;
  message?: {
    code: { code: string } | null;
    message: string;
    spans: Span[];
  };
}

interface ClippyFinding {
  file: string;
  rule: string;
  start: number;
  end: number;
  value: number;
}

// Paths whose change can alter Clippy's findings: Rust sources, manifests and
// lockfiles, Cargo, Clippy or toolchain configuration (Cargo's config sets the
// rustflags and wrapper of the Clippy run), the gate itself, and the CI
// workflow that decides when Clippy runs.
const RUST_FINDING_INPUT =
  /\.rs$|(^|\/)(Cargo\.toml|Cargo\.lock|\.cargo\/config(\.toml)?|\.?clippy\.toml|rust-toolchain[^/]*)$|^tools\/code-complexity-[^/]*\.ts$|^tools\/quality\/code-complexity[^/]*\.json$|^\.github\/workflows\/ci\.yml$/iu;

/** Whether a change to these repository paths can alter the Clippy findings. */
export function changesRustFindings(paths: string[]): boolean {
  return paths.some((path) => RUST_FINDING_INPUT.test(path));
}

/** The compiler errors in Cargo's JSON stdout, for the message of a failed run. */
export function cargoErrors(stdout: string): string {
  return stdout.split(/\r?\n/u).flatMap((line) => {
    if (!line.startsWith('{')) return [];
    // Build scripts may print anything; a line that only looks like JSON
    // must not replace the real error with a parse failure.
    let row: { reason?: string; message?: { level?: string; rendered?: string; message?: string } };
    try {
      row = JSON.parse(line);
    } catch {
      return [];
    }
    return row.reason === 'compiler-message' && row.message?.level === 'error'
      ? [row.message.rendered ?? row.message.message ?? '']
      : [];
  }).join('\n');
}

export function readClippyFindings(
  output: string,
  root: string,
  manifest: string,
  config: ComplexityConfig,
  nestingThreshold: number,
): ClippyFinding[] {
  const findings = new Map<string, ClippyFinding>();
  for (const line of output.split(/\r?\n/u).filter(Boolean)) {
    const row = JSON.parse(line) as CargoMessage;
    if (row.reason !== 'compiler-message' || resolve(row.manifest_path ?? '') !== manifest) continue;
    const diagnostic = row.message;
    const rule = diagnostic?.code?.code.replace(/^clippy::/u, '');
    if (!diagnostic || !rule || !CLIPPY_RULES.has(rule)) continue;
    const span = diagnostic.spans.find((item) => item.is_primary);
    if (!span) throw new Error('Clippy diagnostic has no primary span: ' + diagnostic.message);
    const file = relative(root, resolve(dirname(manifest), span.file_name)).replaceAll('\\', '/');
    if (!productionFile(file, config)) continue;
    const value = rule === NESTING
      ? nestingThreshold + 1
      : Number(/\((\d+)\/\d+\)/u.exec(diagnostic.message)?.[1]);
    if (!Number.isSafeInteger(value)) throw new Error('Unrecognized Clippy diagnostic: ' + diagnostic.message);
    const { byte_start: start, byte_end: end } = span;
    findings.set(JSON.stringify([rule, file, start, end]), { file, rule, start, end, value });
  }
  return [...findings.values()];
}

// Clippy emits the first over-limit blocks without a depth value. Higher
// limits expose deeper descendants. Using the original block's span for
// attribution keeps its identity when a deeper descendant is introduced.
export function applyNestingProbe(base: ClippyFinding[], probe: ClippyFinding[]): void {
  for (const block of probe) {
    if (block.rule !== NESTING) continue;
    const ancestor = base.find((entry) =>
      entry.rule === NESTING && entry.file === block.file &&
      entry.start <= block.start && entry.end >= block.end,
    );
    if (!ancestor) throw new Error('Clippy nesting probe found no enclosing block in ' + block.file);
    ancestor.value = Math.max(ancestor.value, block.value);
  }
}

interface Scope {
  name: string;
  localName: string;
  start: number;
  end: number;
}

// In a header's angle brackets, a `{` after one of these opens a const-generic
// argument (`Foo<{ N }>`, `Foo<A, { N }>`, `Trait<C = { N }>`); any other `{` is the body.
const GENERIC_ARGUMENT_START = new Set(['<', ',', '=']);

// Resolve names only. Clippy remains the source of every measurement.
// Skip literals, comments and parenthesized/bracketed signature contents
// when associating a declaration with its body. Comments, literals, `->` and
// `=>` are single tokens, so only a header's own `<` and `>` count as angles.
function rustScopes(source: string): Scope[] {
  const tokens = /\/\/[^\n]*|\/\*|(?:br|cr|r)(#*)"(?:[\s\S]*?)"\1|"(?:\\[\s\S]|[^"\\])*"|'(?:\\(?:u\{[\da-f_]+\}|x[\da-f]{2}|.)|[^'\\\r\n])'|(?:r#)?[a-zA-Z_]\w*|->|=>|[{}()[\];<>,=]/giu;
  const scopes: Scope[] = [];
  const braces: (Scope | undefined)[] = [];
  const brackets: string[] = [];
  let pending: { kind: string; start: number; header: number; depth: number; angles: number } | undefined;
  // Open braces of the const-generic argument being skipped as a unit.
  let constArgument = 0;
  let previous = '';
  for (let token = tokens.exec(source); token; token = tokens.exec(source)) {
    const text = token[0];
    if (text === '/*') {
      const commentTokens = /\/\*|\*\//gu;
      commentTokens.lastIndex = token.index + 2;
      let depth = 1;
      while (depth > 0) {
        const marker = commentTokens.exec(source);
        if (!marker) break;
        depth += marker[0] === '/*' ? 1 : -1;
      }
      tokens.lastIndex = depth === 0 ? commentTokens.lastIndex : source.length;
      continue;
    }
    if (text.startsWith('//')) continue;
    const before = previous;
    previous = text;
    // A const-generic argument is an expression: its operators, closures and
    // keywords are not part of the header's structure.
    if (constArgument > 0) {
      if (text === '{') constArgument += 1;
      if (text === '}') constArgument -= 1;
      continue;
    }
    if (text === '(' || text === '[') brackets.push(text);
    if (text === ')' || text === ']') brackets.pop();
    if (brackets.length > 0) continue;

    if (text === 'fn' || text === 'impl' || text === 'mod' || text === 'trait') {
      // While a header is pending, these keywords sit in its types (function
      // pointers, `impl Trait` in a return type or a bound) and belong to it.
      pending ??= { kind: text, start: token.index, header: token.index + text.length, depth: braces.length, angles: 0 };
    }
    if (pending?.depth === braces.length) {
      if (text === '<') pending.angles += 1;
      if (text === '>') pending.angles = Math.max(0, pending.angles - 1);
      if (text === '{' && pending.angles > 0 && GENERIC_ARGUMENT_START.has(before)) {
        constArgument = 1;
        continue;
      }
    }
    if (text === '{' || text === ';') {
      let scope: Scope | undefined;
      if (pending?.depth === braces.length) {
        const header = source.slice(pending.header, token.index).trim();
        // An impl is named by its header as written, from the keyword (so `impl<T>`
        // keeps its generics attached) up to any where clause.
        const name = pending.kind === 'impl'
          ? source.slice(pending.start, token.index).replace(/\bwhere\b[\s\S]*$/u, '').replace(/\s+/gu, ' ').trim()
          : /^(?:r#)?[a-zA-Z_]\w*/u.exec(header)?.[0];
        if (name) {
          const prefix = braces.flatMap((entry) => entry ? [entry.localName] : []);
          scope = { name: [...prefix, name].join('::'), localName: name, start: pending.start, end: token.index + 1 };
          scopes.push(scope);
        }
        pending = undefined;
      }
      if (text === '{') braces.push(scope);
    }
    if (text === '}') {
      const scope = braces.pop();
      if (scope) scope.end = token.index + 1;
      // A header still pending when a block closes back to its depth or out of
      // it was a type, such as a function-pointer field, not an item; dropping
      // it lets the next keyword start a new item whatever came before. (A
      // const-generic argument is skipped above, so its `}` never gets here.)
      if (pending && pending.depth >= braces.length) pending = undefined;
    }
  }
  return scopes;
}

export function clippyFindings(
  diagnostics: ClippyFinding[],
  readSource: (file: string) => string,
): Finding[] {
  const sources = new Map<string, { bytes: Buffer; scopes: Scope[] }>();
  return diagnostics.map(({ file, rule, value, start, end }) => {
    let parsed = sources.get(file);
    if (!parsed) {
      const source = readSource(file);
      parsed = { bytes: Buffer.from(source), scopes: rustScopes(source) };
      sources.set(file, parsed);
    }
    const { bytes, scopes } = parsed;
    const from = bytes.subarray(0, start).toString().length;
    const to = bytes.subarray(0, end).toString().length;
    const enclosing = scopes.findLast((scope) => scope.start <= from && from < scope.end);
    const declaration = rule === NESTING
      ? undefined
      : scopes.find((scope) => from <= scope.start && scope.start < to);
    return { tool: 'clippy', rule, file, symbol: declaration?.name ?? enclosing?.name ?? '<module>', value };
  });
}
