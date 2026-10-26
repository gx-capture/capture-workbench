import { SheriffConfig } from '@softarc/sheriff-core';

/**
 * Architecture rules for the Angular package and the desktop shell (DDD refactor
 * step W1, .agents/PLANS/ddd-refactor/). They describe today's technical folders
 * so that no new import points back up the chain
 * component → service → client → contract. Step W7 replaces them with one
 * module per bounded context.
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
    'packages/capture-workbench-ui/src/lib/capture-angular/components/<component>':
      ['ui:component'],
    'packages/capture-workbench-ui/src/lib/capture-angular/services/<service>':
      ['ui:service'],
    'packages/capture-workbench-ui/src/lib/capture-angular/i18n': ['ui:i18n'],
    'packages/capture-workbench-ui/src/lib/contracts': ['ui:contract'],
    'packages/capture-workbench-ui/src/lib/constants': ['ui:constant'],
    'apps/capture-workbench/src/app/services': ['shell:service'],
    'apps/capture-workbench/src/app/contracts': ['shell:contract'],
    'apps/capture-workbench/src/app/i18n': ['shell:i18n'],
    'packages/capture-runtime-client/src': ['sdk'],
  },
  depRules: {
    root: ['shell:*', 'ui:public-api', 'sdk', 'root'],
    'ui:public-api': ['ui:*', 'sdk'],
    'ui:component': [
      'ui:component',
      'ui:service',
      'ui:client',
      'ui:i18n',
      'ui:contract',
      'ui:constant',
      'sdk',
    ],
    'ui:service': [
      'ui:service',
      'ui:client',
      'ui:contract',
      'ui:constant',
      'sdk',
    ],
    'ui:client': ['ui:client', 'ui:contract', 'ui:constant', 'sdk'],
    'ui:i18n': ['ui:i18n', 'ui:contract', 'ui:constant'],
    'ui:contract': ['ui:contract', 'sdk'],
    'ui:constant': ['ui:constant', 'ui:contract', 'sdk'],
    'shell:service': [
      'shell:service',
      'shell:contract',
      'shell:i18n',
      'ui:public-api',
      'sdk',
    ],
    'shell:contract': ['shell:contract', 'ui:public-api', 'sdk'],
    'shell:i18n': ['shell:i18n', 'shell:contract'],
    sdk: ['sdk', 'noTag'],
    noTag: ['noTag', 'root', 'sdk', 'ui:*', 'shell:*'],
  },
};
