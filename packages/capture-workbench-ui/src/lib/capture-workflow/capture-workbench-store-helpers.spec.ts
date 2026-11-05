import { firstValueFrom, of, throwError } from 'rxjs';
import { retryUncertainResponse } from '../capture-client-errors';
import { CAPTURE_WORKBENCH_MESSAGES } from '../i18n/messages';
import { streamingStage } from './capture-workbench-store-helpers';

describe('speaker identification stages', () => {
  it.each(['loading-model', 'transcribing', 'identifying-speakers'] as const)(
    'keeps the runtime stage %s and labels it in every language',
    (stage) => {
      expect(streamingStage(stage)).toBe(stage);
      for (const messages of Object.values(CAPTURE_WORKBENCH_MESSAGES)) {
        expect(messages.taskStage[stage]).toBeTruthy();
      }
    },
  );

  it('shows an unknown runtime stage as preprocessing', () => {
    expect(streamingStage('some-future-stage')).toBe('preprocessing');
  });
});

describe('capture request retry policy', () => {
  it.each([
    { code: 'stream_validation_error', status: 400 },
    { code: 'stream_validation_error' },
    { status: 403 },
  ])('does not replay a definite host failure: %j', async (failure) => {
    const operation = vi.fn(() => throwError(() => failure));

    await expect(
      firstValueFrom(
        retryUncertainResponse(operation, new AbortController().signal),
      ),
    ).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it.each([{ code: 'invalid_response' }, { status: 0 }, { status: 503 }])(
    'retries an uncertain response once: %j',
    async (failure) => {
      const operation = vi
        .fn()
        .mockImplementationOnce(() => throwError(() => failure))
        .mockImplementationOnce(() => of('accepted'));

      await expect(
        firstValueFrom(
          retryUncertainResponse(operation, new AbortController().signal),
        ),
      ).resolves.toBe('accepted');
      expect(operation).toHaveBeenCalledTimes(2);
    },
  );
});
