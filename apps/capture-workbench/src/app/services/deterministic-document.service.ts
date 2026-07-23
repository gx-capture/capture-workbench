import { Injectable } from '@angular/core';
import {
  Observable,
  from,
  map,
  switchMap,
} from 'rxjs';
import type {
  CaptureBlockType,
  CaptureDocumentV1,
  CreateCaptureRequest,
  RawCaptureV1,
  RuntimeRequirementV1,
} from '@gx/capture-workbench';
import {
  DETERMINISTIC_CAPTURE_WARNING,
  DETERMINISTIC_COMPLETED_AT,
} from '../constants';

@Injectable({ providedIn: 'root' })
export class DeterministicDocumentService {
  createCandidate(raw: RawCaptureV1, model: string): CaptureDocumentV1 {
    return {
      schemaVersion: '1',
      source: raw.source,
      rawSegments: raw.segments,
      blocks: raw.segments.map((segment) => ({
        blockId: `block-${segment.order + 1}`,
        order: segment.order,
        sourceSegmentId: segment.segmentId,
        type: this.blockType(raw.source.mediaType),
        locator: segment.locator,
        sourceText: segment.text,
        targetText: segment.text,
      })),
      sourceText: raw.sourceText,
      targetText: raw.sourceText,
      extractionEngine: raw.extractionEngine,
      structuringEngine: {
        engine: 'deterministic-ollama',
        model,
        digest: `sha256:${(model === 'host-provider-fake' ? 'd' : 'c').repeat(64)}`,
      },
      warnings: raw.warnings,
      createdAt: raw.createdAt,
      completedAt: DETERMINISTIC_COMPLETED_AT,
    };
  }

  readyRequirement(
    requirementId: RuntimeRequirementV1['requirementId'],
    displayName: string,
    requiredFor: readonly string[],
  ): RuntimeRequirementV1 {
    return {
      requirementId,
      kind: requirementId,
      displayName,
      status: 'ready',
      requiredFor,
      installStrategy: 'deterministic-fake',
      detail: 'Available in the validation fixture',
    };
  }

  sha256(file: File): Observable<string> {
    return from(file.arrayBuffer()).pipe(
      switchMap((contents) => from(crypto.subtle.digest('SHA-256', contents))),
      map((digest) =>
        Array.from(
          new Uint8Array(digest),
          (byte) => byte.toString(16).padStart(2, '0'),
        ).join(''),
      ),
    );
  }

  fallbackMediaType(kind: CreateCaptureRequest['sourceKind']): string {
    if (kind === 'pdf') return 'application/pdf';
    if (kind === 'image') return 'image/png';
    return 'audio/wav';
  }

  warning(): string {
    return DETERMINISTIC_CAPTURE_WARNING;
  }

  private blockType(mediaType: string): CaptureBlockType {
    return mediaType.startsWith('audio/') ? 'transcript' : 'paragraph';
  }
}
