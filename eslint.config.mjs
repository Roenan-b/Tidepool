// @ts-check
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import prettierConfig from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    name: 'tidepool/ignores',
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      'data/**',
      'CHANGELOG.md',
    ],
  },
  {
    name: 'tidepool/linter-options',
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    name: 'tidepool/typescript',
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // Money and risk code must never drop a promise on the floor.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true, requireDefaultForNonUnion: true },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: false },
      ],
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      // The engine, signer and Risk Officer re-validate their inputs at runtime even where
      // the static type says the check cannot fail, because those values cross a trust
      // boundary (HTTP bodies, signed tickets, database rows, RPC payloads). This rule would
      // push toward deleting exactly those checks, so it stays off.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // Same reasoning: \`String(reason)\` and \`!x || x.y !== z\` are deliberate defensive
      // forms at trust boundaries. The optional-chain rewrite is not equivalent when both
      // sides can be undefined, so these stay off.
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
      '@typescript-eslint/prefer-optional-chain': 'off',
      // \`||\` on strings and numbers intentionally treats '' and 0 as "not set" for
      // environment variables and form fields.
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        { ignorePrimitives: { string: true, number: true, boolean: true, bigint: true } },
      ],
      // Async functions that do not await are intentional: they implement Promise-returning
      // interfaces and turn synchronous throws into rejections. Dropping \`async\` would
      // change how errors surface, so this rule stays off.
      '@typescript-eslint/require-await': 'off',
      // Spreading a string iterates by code point, which is what the sanitizers and the
      // ASCII codecs (base32, base58) rely on.
      '@typescript-eslint/no-misused-spread': ['error', { allow: [{ from: 'lib', name: 'string' }] }],
      // noUncheckedIndexedAccess is on, so a non-null assertion marks an invariant the code
      // has already established (an aggregate query that always returns one row, a bounds-
      // checked index). Each one is reviewed rather than banned outright.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Safety checks compare against literal booleans on purpose (`x !== true`), so that a
      // missing or null field fails closed. Rewriting them as truthiness checks would let
      // `undefined` or `null` through, so this rule stays off.
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // Engine and signer log through structured loggers. Server-side dashboard routes may
      // report failures with console.warn and console.error.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'object-shorthand': 'error',
    },
  },
  {
    name: 'tidepool/javascript',
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    name: 'tidepool/dashboard',
    files: ['apps/dashboard/**/*.{ts,tsx}'],
    plugins: {
      '@next/next': nextPlugin,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    settings: {
      next: { rootDir: 'apps/dashboard' },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      // The project does not use the React Compiler, so only the classic hook rules apply.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    name: 'tidepool/tests',
    files: ['**/*.test.ts', '**/test/**/*.ts', '**/testing.ts', '**/testkit.ts'],
    rules: {
      // Test doubles implement async interfaces without awaiting, and tests inspect
      // untyped JSON responses directly.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-deprecated': 'off',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
      'no-control-regex': 'off',
    },
  },
  {
    name: 'tidepool/cli-scripts',
    files: ['**/*Cli.ts', '**/cli.ts', '**/scripts/**/*.ts', '**/migrate.ts', '**/main.ts', '**/prompt.ts'],
    rules: {
      // Command-line entry points write to the terminal on purpose.
      'no-console': 'off',
    },
  },
  prettierConfig,
);
