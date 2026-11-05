import { SheriffConfig } from '@softarc/sheriff-core';

/**
 * Architecture rules for the Angular package and the desktop shell (DDD refactor
 * step W7, .agents/PLANS/ddd-refactor/). They organize the UI package and the
 * desktop shell into feature modules aligned with ubiquitous language and
 * enforce unidirectional dependencies:
 * element → capture → installation → client / i18n → contracts / constants.
 */
export const config: SheriffConfig = {
  enableBarrelLess: true,
  entryPoints: {
    'capture-workbench-ui': 'packages/capture-workbench-ui/src/index.ts',
    'capture-workbench': 'apps/capture-workbench/src/main.ts',
  },
  modules: {
    'packages/capture-workbench-ui/src': ['ui:public-api'],
    'packages/capture-workbench-ui/src/lib': ['ui:client'],
    'packages/capture-workbench-ui/src/lib/element': ['ui:element'],
    'packages/capture-workbench-ui/src/lib/capture-workflow': ['ui:capture'],
    'packages/capture-workbench-ui/src/lib/installation': ['ui:installation'],
    'packages/capture-workbench-ui/src/lib/i18n': ['ui:i18n'],
    'packages/capture-workbench-ui/src/lib/contracts': ['ui:contract'],
    'packages/capture-workbench-ui/src/lib/constants': ['ui:constant'],
    'apps/capture-workbench/src/app/asr': ['shell:feature'],
    'apps/capture-workbench/src/app/ocr': ['shell:feature'],
    'apps/capture-workbench/src/app/history': ['shell:feature'],
    'apps/capture-workbench/src/app/settings': ['shell:feature'],
    'apps/capture-workbench/src/app/engine-card': ['shell:feature'],
    'apps/capture-workbench/src/app/placeholder': ['shell:feature'],
    'apps/capture-workbench/src/app/services': ['shell:service'],
    'apps/capture-workbench/src/app/contracts': ['shell:contract'],
    'apps/capture-workbench/src/app/i18n': ['shell:i18n'],
    'apps/capture-workbench/src/app/ui/<primitive>/src': ['shell:ui'],
    'packages/capture-runtime-client/src': ['sdk'],
  },
  depRules: {
    root: ['shell:*', 'ui:public-api', 'sdk', 'root'],
    'ui:public-api': ['ui:*', 'sdk'],
    'ui:element': [
      'ui:element',
      'ui:capture',
      'ui:installation',
      'ui:client',
      'ui:contract',
      'ui:constant',
      'sdk',
    ],
    'ui:capture': [
      'ui:capture',
      'ui:installation',
      'ui:client',
      'ui:i18n',
      'ui:contract',
      'ui:constant',
      'sdk',
    ],
    'ui:installation': [
      'ui:installation',
      'ui:client',
      'ui:i18n',
      'ui:contract',
      'ui:constant',
      'sdk',
    ],
    'ui:client': ['ui:client', 'ui:contract', 'ui:constant', 'sdk'],
    'ui:i18n': ['ui:i18n', 'ui:contract', 'ui:constant'],
    'ui:contract': ['ui:contract', 'sdk'],
    'ui:constant': ['ui:constant', 'ui:contract', 'sdk'],
    'shell:feature': [
      'shell:feature',
      'shell:service',
      'shell:contract',
      'shell:i18n',
      'shell:ui',
      'ui:public-api',
      'sdk',
    ],
    'shell:service': [
      'shell:service',
      'shell:contract',
      'shell:i18n',
      'ui:public-api',
      'sdk',
    ],
    'shell:contract': ['shell:contract', 'ui:public-api', 'sdk'],
    'shell:i18n': ['shell:i18n', 'shell:contract'],
    // Spartan helm primitives (Tailwind + Spartan brain) depend only on each other.
    'shell:ui': ['shell:ui'],
    sdk: ['sdk', 'noTag'],
    noTag: ['noTag', 'root', 'sdk', 'ui:*', 'shell:*'],
  },
};
