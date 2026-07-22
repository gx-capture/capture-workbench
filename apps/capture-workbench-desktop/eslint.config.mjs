import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    ignores: ['src-tauri/target/**', 'scripts/fixtures/**/target/**'],
  },
];
