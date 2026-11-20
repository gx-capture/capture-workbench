// The localhost journey invokes these checks through stdin. Transcript text
// stays in process memory and only the validated oracle and budget go to stdout.
import { readFileSync } from 'node:fs';
import {
  parseProgressiveAudioOracle,
  progressiveAudioBudgetMs,
  verifyProgressiveFinal,
  verifyProgressivePartial,
} from './progressive-audio-evidence.ts';

type EvidenceRequest =
  | { readonly action: 'read'; readonly oraclePath: string }
  | { readonly action: 'partial'; readonly oracle: unknown; readonly snapshot: unknown; readonly displayed: readonly string[] }
  | {
    readonly action: 'final';
    readonly oracle: unknown;
    readonly raw: unknown;
    readonly rendered: readonly { readonly segmentId: string | null; readonly text: string }[];
  };

export function runProgressiveEvidenceCommand(): void {
  try {
    const request = JSON.parse(readFileSync(0, 'utf8')) as EvidenceRequest;
    switch (request.action) {
      case 'read': {
        const oracle = parseProgressiveAudioOracle(JSON.parse(readFileSync(request.oraclePath, 'utf8')));
        process.stdout.write(JSON.stringify({
          oracle,
          partialBudgetMs: progressiveAudioBudgetMs(oracle.durationMs, oracle.extraction.device),
        }));
        break;
      }
      case 'partial':
        verifyProgressivePartial(parseProgressiveAudioOracle(request.oracle), request.snapshot, request.displayed);
        break;
      case 'final':
        verifyProgressiveFinal(parseProgressiveAudioOracle(request.oracle), request.raw, request.rendered);
        break;
      default:
        throw new Error('Unknown progressive audio evidence action.');
    }
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : 'Progressive audio evidence check failed.');
    process.exitCode = 1;
  }
}
