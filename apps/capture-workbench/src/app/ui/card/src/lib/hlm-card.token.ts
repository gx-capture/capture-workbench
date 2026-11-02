import { inject, InjectionToken } from '@angular/core';

export type HlmCardConfig = {
  size: 'sm' | 'default';
};

const defaultConfig: HlmCardConfig = {
  size: 'default',
};

const HlmCardConfigToken = new InjectionToken<HlmCardConfig>('HlmCardConfig');

// The CLI also generates a provide…Config() helper; it is left out until a
// caller needs a non-default config (dead-code gate).
export function injectHlmCardConfig(): HlmCardConfig {
  return inject(HlmCardConfigToken, { optional: true }) ?? defaultConfig;
}
