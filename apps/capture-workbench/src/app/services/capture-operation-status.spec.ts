import type { DesktopLibrarySummary } from '../contracts';
import {
  canStartAgain,
  committedTerminalStatus,
  isInterrupted,
  isWaiting,
} from './capture-operation-status';

function stored(overrides: Partial<DesktopLibrarySummary>): DesktopLibrarySummary {
  return {
    documentId: 'a'.repeat(32),
    fileName: 'file.pdf',
    mediaType: 'application/pdf',
    byteLength: 8,
    createdAtMs: 1,
    updatedAtMs: 1,
    status: 'queued',
    ...overrides,
  };
}

const recording = { fileName: 'meeting.m4a', mediaType: 'audio/mp4' } as const;

describe('isInterrupted', () => {
  it.each<[string, Partial<DesktopLibrarySummary>]>([
    ['processing with a link', { status: 'processing', captureId: 'capture-1' }],
    ['processing before the link was written', { status: 'processing' }],
    ['an earlier version’s persisting row', { status: 'persisting', captureId: 'capture-1' }],
    ['queued with a link', { status: 'queued', captureId: 'capture-1' }],
    // An earlier version's Start again stored `queued` and kept the raw result.
    ['queued with a raw result', { status: 'queued', hasRaw: true }],
    ['an earlier version’s recovery row', { status: 'recovery_required', recoveryCode: 'capture_recovery_required' }],
    ['an earlier version’s unconfirmed cancel', {
      status: 'recovery_required', recoveryCode: 'cancel_failed', captureId: 'capture-1',
    }],
    ['an earlier version’s failed cleanup that names no end', {
      status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage: 'extracting',
    }],
    ['a checkpoint without raw text', { status: 'awaiting_confirmation' }],
    ['a checkpoint on a recording', { ...recording, status: 'awaiting_confirmation', hasRaw: true }],
    ['an earlier version’s failure that needed recovery', { status: 'failed', recoveryCode: 'capture_recovery_required' }],
  ])('is true for %s that this run does not own', (_case, row) => {
    expect(isInterrupted(stored(row), false)).toBe(true);
    expect(isInterrupted(stored(row), true)).toBe(false);
  });

  it.each<[string, Partial<DesktopLibrarySummary>]>([
    ['waiting', { status: 'queued' }],
    ['completed with a link', { status: 'completed', captureId: 'capture-1', hasRaw: true }],
    ['failed with a link', { status: 'failed', captureId: 'capture-1', errorCode: 'ocr_failed' }],
    ['cancelled', { status: 'canceled', stage: 'cancelled' }],
    ['an OCR checkpoint with raw text and a link', { status: 'awaiting_confirmation', hasRaw: true, captureId: 'capture-1' }],
    ['an earlier version’s failed cleanup of a result', {
      status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage: 'awaiting_structuring', hasRaw: true,
    }],
    ['an earlier version’s failed cleanup of a recording’s result', {
      ...recording, status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage: 'extracting', hasRaw: true,
    }],
  ])('is false for %s: its stored status is shown as it is', (_case, row) => {
    expect(isInterrupted(stored(row), false)).toBe(false);
  });
});

describe('committedTerminalStatus', () => {
  it.each([
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'canceled'],
    ['awaiting_structuring', 'awaiting_confirmation'],
  ] as const)('reads an earlier version’s failed cleanup with the stage %s as %s', (stage, status) => {
    expect(committedTerminalStatus(stored({
      status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage, captureId: 'capture-1',
    }))).toBe(status);
  });

  // Earlier versions stored a refused unlink of a recording with the last
  // event's stage. The document's own data then says how the capture ended.
  it.each([
    ['a kept result', { hasRaw: true }, 'completed'],
    ['a terminal error', { errorCode: 'speech_failed' }, 'failed'],
    ['a terminal error beside older data', { errorCode: 'speech_failed', hasRaw: true }, 'failed'],
    ['neither', {}, undefined],
  ] as const)('reads %s when the stage of a recording’s cleanup row is not terminal', (_case, data, status) => {
    expect(committedTerminalStatus(stored({
      ...recording, status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage: 'awaiting_structuring', ...data,
    }))).toBe(status);
  });

  it.each(['queued', 'processing', 'completed', 'failed', 'canceled', 'awaiting_confirmation'] as const)(
    'says nothing about a row stored as %s',
    (status) => {
      expect(committedTerminalStatus(stored({ status, stage: 'completed', hasRaw: true }))).toBeUndefined();
    },
  );
});

describe('isWaiting', () => {
  it('holds for a queued row without a link or a raw result only', () => {
    expect(isWaiting(stored({ status: 'queued' }))).toBe(true);
    expect(isWaiting(stored({ status: 'queued', captureId: 'capture-1' }))).toBe(false);
    expect(isWaiting(stored({ status: 'queued', hasRaw: true }))).toBe(false);
    expect(isWaiting(stored({ status: 'canceled' }))).toBe(false);
  });
});

describe('canStartAgain', () => {
  it.each<[string, Partial<DesktopLibrarySummary>, boolean]>([
    ['failed', { status: 'failed' }, true],
    ['cancelled', { status: 'canceled' }, true],
    ['interrupted', { status: 'processing', captureId: 'capture-1' }, true],
    ['an earlier version’s failed cleanup of a cancel', {
      status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage: 'cancelled',
    }, true],
    ['failed with raw text', { status: 'failed', hasRaw: true }, false],
    ['interrupted with raw text', { status: 'processing', hasRaw: true }, false],
    ['waiting', { status: 'queued' }, false],
    ['queued with a raw result', { status: 'queued', hasRaw: true }, false],
    ['completed', { status: 'completed', hasRaw: true }, false],
    ['an earlier version’s failed cleanup of a completed recording', {
      ...recording, status: 'recovery_required', recoveryCode: 'runtime_cleanup_failed', stage: 'completed',
    }, false],
  ])('%s: %s', (_case, row, expected) => {
    expect(canStartAgain(stored(row))).toBe(expected);
  });
});
