/** Commit messages follow Conventional Commits (https://www.conventionalcommits.org). */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Suggested scopes. Unknown scopes warn rather than fail so automated commits still pass.
    'scope-enum': [
      1,
      'always',
      [
        'core',
        'engine',
        'scout',
        'trader',
        'risk',
        'signer',
        'dashboard',
        'db',
        'backtest',
        'deps',
        'deps-dev',
        'ci',
        'docs',
        'release',
        'main',
      ],
    ],
    // Dependency update bodies carry long links and release notes.
    'body-max-line-length': [1, 'always', 100],
    'footer-max-line-length': [1, 'always', 100],
  },
};
