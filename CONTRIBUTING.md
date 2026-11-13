# Contributing

Thanks for looking. This is a small portfolio project, so please open an issue to discuss a change before writing
a large pull request. Security problems go through [SECURITY.md](SECURITY.md), never a public issue.

## Rules that are not negotiable

- **Synthetic data only** ([DATA_POLICY.md](DATA_POLICY.md)). No real names, MRNs, dates of birth, SSNs, phone
  numbers or emails anywhere: code, tests, screenshots, issues. `pnpm check:synthetic` runs in CI.
- **No compliance claims.** Say "aligned with" or "designed toward", never "compliant" or "certified".
- **No secrets** in code, docs or examples. Use placeholders like `<DEVICE_PUBLIC_KEY>`.
- **Locked decisions stay locked** (prd.md and the ADRs in design.md): an event log, server-assigned order, one
  patient per bed, conflicts resolved by a person, no CRDT and no last-write-wins. Ordering never depends on
  client clocks.
- **New dependencies need agreement first.** The approved list is in [CLAUDE.md](CLAUDE.md).

## Setup

Node (version in `.nvmrc`), pnpm and Docker.

```bash
pnpm install
docker compose up -d db-test
pnpm --filter @wdb/web exec playwright install
```

## Before you open a pull request

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm check:synthetic
pnpm e2e
```

- Reducer and sync changes come with tests first, and convergence changes with property tests (fast-check).
- Keep the change small, and update the docs it touches (design.md, runbooks).
- Name the requirement IDs it serves (FR-x, SEC-x) in the commit message or pull request.
- If it changes the architecture, update the threat model in design.md §9.1 in the same pull request.

CI runs the same checks plus E2E on three browsers, the Toxiproxy fault suite, Semgrep, gitleaks, Trivy and
`pnpm audit`.

By contributing you agree that your work is released under the [MIT License](LICENSE).
