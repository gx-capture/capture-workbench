import { posix, relative } from 'node:path';
import ts from 'typescript';
import {
  compareWithBaseline,
  numbered,
  type RatchetResult,
} from './dead-code-gate.ts';

const RULES = {
  eslint: ['max-lines-per-function', 'complexity', 'max-params', 'max-depth', 'max-lines'],
  ruff: ['C901', 'PLR0915', 'PLR0913', 'PLR1702'],
  clippy: ['too_many_lines', 'too_many_arguments', 'excessive_nesting'],
} as const;

type Tool = keyof typeof RULES;
type Thresholds = { [T in Tool]: Record<(typeof RULES)[T][number], number> };

export interface ComplexityConfig {
  thresholds: Thresholds;
  exclude: string[];
  fastApiRoutes: string[];
}

export function parseComplexityConfig(json: string): ComplexityConfig {
  const config = JSON.parse(json) as Partial<ComplexityConfig> | null;
  for (const [tool, rules] of Object.entries(RULES)) {
    const thresholds = config?.thresholds?.[tool as Tool] as Record<string, number> | undefined;
    for (const rule of rules) {
      const value = thresholds?.[rule] ?? 0;
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`Invalid code-complexity threshold for ${tool}/${rule}`);
      }
    }
    if (Object.keys(thresholds ?? {}).length !== rules.length) {
      throw new Error(`Unexpected code-complexity threshold for ${tool}`);
    }
  }
  for (const field of ['exclude', 'fastApiRoutes'] as const) {
    const globs = config?.[field];
    if (!Array.isArray(globs) || globs.some((glob) => typeof glob !== 'string' || !glob)) {
      throw new Error(`Invalid code-complexity glob list: ${field}`);
    }
  }
  return config as ComplexityConfig;
}

export function productionFile(file: string, config: ComplexityConfig): boolean {
  return !config.exclude.some((glob) => posix.matchesGlob(file, glob));
}

function repoPath(root: string, file: string): string {
  return relative(root, file).replaceAll('\\', '/');
}

export interface Finding {
  tool: Tool;
  rule: string;
  file: string;
  symbol: string;
  value: number;
}

function identity({ tool, rule, file, symbol }: Finding): string {
  return JSON.stringify([tool, rule, file, symbol]);
}

// Order repeated findings for the same symbol by severity, so neither
// diagnostic order nor moving code within the symbol changes the comparison.
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((left, right) => {
    const a = identity(left);
    const b = identity(right);
    return a < b ? -1 : a > b ? 1 : right.value - left.value;
  });
}

export function compareFindings(current: Finding[], baseline: Finding[]): RatchetResult<Finding> {
  function index(findings: Finding[]): Map<string, Finding> {
    const ordered = sortFindings(findings);
    return new Map(numbered(ordered.map(identity)).map((key, i) => [key, ordered[i]]));
  }
  const currentByKey = index(current);
  const baselineByKey = index(baseline);
  const { added, stale } = compareWithBaseline([...currentByKey.keys()], [...baselineByKey.keys()]);
  const worsened = [];
  for (const [key, finding] of currentByKey) {
    const previous = baselineByKey.get(key);
    if (previous && finding.value > previous.value) {
      worsened.push({ current: finding, previous });
    }
  }
  return {
    // Every key came from these maps, so each lookup yields exactly one finding.
    added: added.flatMap((key) => currentByKey.get(key) ?? []),
    stale: stale.flatMap((key) => baselineByKey.get(key) ?? []),
    worsened,
  };
}

function measuredValue(message: string, pattern: RegExp): number {
  const value = pattern.exec(message)?.[1];
  if (value === undefined) throw new Error(`Unrecognized lint diagnostic: ${message}`);
  return Number(value);
}

function tsSymbol(source: ts.SourceFile, line: number, column: number): string {
  const position = source.getPositionOfLineAndCharacter(line - 1, column - 1);
  const names: string[] = [];
  function visit(node: ts.Node): void {
    if (position < node.getStart(source) || position >= node.end) return;
    if (ts.isFunctionLike(node)) {
      const parent = node.parent;
      const name = node.name ?? (ts.isVariableDeclaration(parent) ? parent.name : undefined);
      if (name) names.push(name.getText(source));
      else if (ts.isConstructorDeclaration(node)) names.push('constructor');
      // A property or type alias already contributed the name of the function type it holds.
      else if (
        !ts.isPropertyAssignment(parent) && !ts.isPropertyDeclaration(parent) &&
        !ts.isPropertySignature(parent) && !ts.isTypeAliasDeclaration(parent)
      ) names.push('<anonymous>');
    } else if (ts.isClassStaticBlockDeclaration(node)) {
      names.push('<static block>');
    } else if (
      ts.isClassLike(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
      ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertySignature(node)
    ) {
      if (node.name) names.push(node.name.getText(source));
    }
    node.forEachChild(visit);
  }
  visit(source);
  return names.join('.') || '<module>';
}

interface EslintReport {
  filePath: string;
  messages: readonly { ruleId: string | null; message: string; line: number; column: number; fatal?: boolean }[];
}

export function parseEslintFindings(
  reports: readonly EslintReport[],
  root: string,
  readSource: (file: string) => string,
): Finding[] {
  return reports.flatMap(({ filePath, messages }) => {
    const file = repoPath(root, filePath);
    let source: ts.SourceFile | undefined;
    return messages.flatMap(({ ruleId, message, line, column, fatal }): Finding[] => {
      if (fatal) throw new Error(`ESLint could not parse ${file}:${line}: ${message}`);
      // ESLint can also report that an inline directive was ignored.
      if (!ruleId) return [];
      const value = measuredValue(
        message,
        ruleId === 'complexity' ? / has a complexity of (\d+)\./u : /\((\d+)\)\. Maximum allowed/u,
      );
      const symbol = ruleId === 'max-lines' ? '<file>' : tsSymbol(
        source ??= ts.createSourceFile(file, readSource(file), ts.ScriptTarget.Latest, true),
        line,
        column,
      );
      return [{ tool: 'eslint', rule: ruleId, file, symbol, value }];
    });
  });
}

interface RuffDiagnostic {
  filename: string;
  code: string | null;
  location: { row: number };
  message: string;
}

export function readRuffDiagnostics(output: string, root: string, config: ComplexityConfig) {
  const diagnostics = JSON.parse(output) as RuffDiagnostic[];
  if (!Array.isArray(diagnostics)) throw new Error('Expected a Ruff diagnostic list');
  return diagnostics.flatMap(({ filename, code, location, message }) => {
    const file = repoPath(root, filename);
    if (!productionFile(file, config)) return [];
    if (code === 'PLR0913' && config.fastApiRoutes.some((glob) => posix.matchesGlob(file, glob))) return [];
    if (!code || !(RULES.ruff as readonly string[]).includes(code)) {
      throw new Error(`Unexpected Ruff diagnostic in ${file}:${location.row}: ${message}`);
    }
    return [{ file, rule: code, line: location.row, message }];
  });
}

export function parseRuffFindings(
  diagnostics: ReturnType<typeof readRuffDiagnostics>,
  symbolAt: (file: string, line: number) => string,
): Finding[] {
  return diagnostics.map(({ file, rule, line, message }) => ({
    tool: 'ruff',
    rule,
    file,
    symbol: symbolAt(file, line),
    value: measuredValue(message, /\((\d+) > \d+\)/u),
  }));
}
