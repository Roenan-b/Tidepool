# Contributing to Tidepool

Thanks for your interest in Tidepool. This is a private project with a single maintainer, so please read this page before you open anything.

## What is welcome

- **Bug reports.** Open an issue with the bug report template. Include what you ran, what you expected and what happened instead.
- **Feature ideas.** Open an issue with the feature request template and describe the problem you want solved.
- **Security problems.** Do not open a public issue. Follow [SECURITY.md](SECURITY.md) and use private vulnerability reporting.

## What is not accepted

The repository does not accept outside code changes. Pull requests from people other than the maintainer will be closed without review. This keeps the custody, risk and signing code under one owner's review. If you have a fix in mind, describe it in an issue instead.

## Development setup

Requirements: Node.js 22.13 or newer (see `.nvmrc`), npm 10, and Docker for the local Postgres.

```bash
npm ci
docker compose up -d
npm run build -w @tidepool/core
npm run check
```

`npm ci` installs Git hooks through husky:

- **pre-commit** runs ESLint and Prettier on staged files through lint-staged.
- **commit-msg** checks the message with commitlint.

## Scripts

| Command                 | Purpose                                               |
| ----------------------- | ----------------------------------------------------- |
| `npm run lint`          | ESLint, type-aware, zero warnings allowed             |
| `npm run lint:fix`      | ESLint with autofix                                   |
| `npm run format`        | Prettier, write                                       |
| `npm run format:check`  | Prettier, check only                                  |
| `npm run typecheck`     | TypeScript in every workspace                         |
| `npm test`              | Vitest in every workspace (needs `TEST_DATABASE_URL`) |
| `npm run test:coverage` | Tests with coverage thresholds                        |
| `npm run build`         | Compile `core`, `engine` and `signer`                 |
| `npm run check`         | Format check, lint, typecheck and tests               |

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org):

```
<type>(<optional scope>): <summary>
```

Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`. Suggested scopes: `core`, `engine`, `scout`, `trader`, `risk`, `signer`, `dashboard`, `db`, `backtest`, `deps`, `ci`, `docs`. A breaking change adds `!` after the type or a `BREAKING CHANGE:` footer.

Release Please reads these messages to open release pull requests, bump the version and update [CHANGELOG.md](CHANGELOG.md).

## Code standards

- TypeScript is strict, with `noUncheckedIndexedAccess`.
- Money is held in integer lamports (`bigint`), never floating point.
- Safety checks fail closed. Compare against literal booleans (`x !== true`) where a missing field must be treated as unsafe, and keep runtime validation at trust boundaries even when the static type says it cannot fail.
- Never commit keys, keystores, `.env` files or API tokens.
- Every change keeps CI green: formatting, lint, typecheck, tests with coverage floors, and the build.

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
