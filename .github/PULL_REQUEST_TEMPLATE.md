<!-- This repository does not accept outside pull requests. Open an issue instead. -->

## Summary

<!-- What changes and why. Link the issue it closes. -->

## Before and after

<!-- What a user or operator sees before and after this change. -->

## Risk

- [ ] Touches funds, limits, the reservation ledger or the signer
- [ ] Changes the database schema or a migration
- [ ] Changes the engine control API or the dashboard auth

<!-- If any box is ticked, describe the failure mode and how it fails closed. -->

## Checklist

- [ ] The title follows Conventional Commits
- [ ] `npm run check` passes locally
- [ ] Tests cover the change
- [ ] No keys, tokens, keystores or `.env` files are included
- [ ] README or docs updated where behavior changed
