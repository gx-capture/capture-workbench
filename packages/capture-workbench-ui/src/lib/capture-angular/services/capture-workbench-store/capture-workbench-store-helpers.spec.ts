import { CAPTURE_WORKBENCH_MESSAGES } from '../../i18n/messages';
import { streamingStage } from './capture-workbench-store-helpers';

describe('speaker identification stages', () => {
  it.each(['transcribing', 'identifying-speakers'] as const)(
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
