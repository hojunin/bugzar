# Contributing to Bugzar

Thanks for your interest! This project is a pnpm + TypeScript monorepo
(`packages/sdk`, `packages/capture-core`, `packages/viewer`,
`packages/shared`).

## Getting started

```bash
pnpm install
pnpm build        # build all packages
pnpm test         # vitest across all packages
pnpm check        # Biome lint + format check
```

## Before opening a PR

- `pnpm check` and `pnpm test` must pass. Run `pnpm check:fix` to auto-format.
- Keep changes focused; match the surrounding code style.
- Never commit secrets. `.env` files are git-ignored — put real credentials
  only in your local `.env`, and add new config keys to the tracked
  `.env.example` with placeholder values.
- Add or update tests for behavior changes. The SDK (`packages/sdk`) carries
  the bulk of the vitest suites.

## Reporting bugs

Open a GitHub Issue with reproduction steps. For **security** issues, do **not**
open a public issue — see [`SECURITY.md`](./SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](./LICENSE).
