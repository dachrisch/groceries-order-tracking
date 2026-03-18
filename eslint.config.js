import js from '@eslint/js';
import ts from 'typescript-eslint';
import solid from 'eslint-plugin-solid';
import globals from 'globals';

export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    // Apply type-checked rules ONLY to src directory where tsconfig.json applies
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      solid,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        project: true,
      },
    },
    rules: {
      ...solid.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-namespace': 'off',
    },
  },
  {
    // Files outside src (like config files) should not be type-checked
    files: ['**/*.js', '**/*.cjs', 'vite.config.ts', 'eslint.config.js'],
    ...ts.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    ignores: ['dist/**', 'dist-server/**', 'node_modules/**'],
  }
);
