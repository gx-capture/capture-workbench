import { InjectionToken, inject } from '@angular/core';
import type { ButtonVariants } from './hlm-button';

export interface BrnButtonConfig {
  variant: ButtonVariants['variant'];
  size: ButtonVariants['size'];
}

const defaultConfig: BrnButtonConfig = {
  variant: 'default',
  size: 'default',
};

const BrnButtonConfigToken = new InjectionToken<BrnButtonConfig>(
  'BrnButtonConfig',
);

// The CLI also generates a provide…Config() helper; it is left out until a
// caller needs a non-default config (dead-code gate).
export function injectBrnButtonConfig(): BrnButtonConfig {
  return inject(BrnButtonConfigToken, { optional: true }) ?? defaultConfig;
}
