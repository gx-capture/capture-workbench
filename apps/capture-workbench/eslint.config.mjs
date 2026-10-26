import nx from '@nx/eslint-plugin';
import baseConfig from '../../eslint.config.mjs';
import sheriff from '@softarc/eslint-plugin-sheriff';

export default [
  ...nx.configs['flat/angular'],
  ...nx.configs['flat/angular-template'],
  ...baseConfig,
  {
    // Architecture rules (sheriff.config.ts); tests may import any layer.
    ...sheriff.configs.all,
    files: ['**/*.ts'],
    ignores: ['**/*.spec.ts'],
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        {
          type: 'attribute',
          prefix: 'app',
          style: 'camelCase',
        },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: 'element',
          prefix: 'app',
          style: 'kebab-case',
        },
      ],
    },
  },
  {
    files: ['**/*.html'],
    // Override or add rules here
    rules: {},
  },
];
