# Testing

## Layers
| Layer | Tool | What it proves |
|---|---|---|
| Unit | Vitest | Reducer rules, schemas, ID generation |
| Property-based | fast-check | Any interleaving of events across N devices converges to the same board |
| Deterministic simulation | seeded harness | Random offline/online/crash schedules replay exactly from a seed |
| Integration | Vitest + Postgres container | Idempotent push, ordering, hash chain, role checks |
| End-to-end | Playwright (multiple browser contexts) | Offline admit, reconnect, conflict, resolve, export |
| Fault injection | Toxiproxy | Latency, drops, resets, server restarts mid-sync |
| Security | Vitest + scripts | Forged signature, replayed event, role escalation, oversized payload, tampered log |
| Accessibility | axe + manual | WCAG 2.2 AA, touch targets, keyboard use |

## Must-pass scenarios
These match the acceptance scenarios in `prd.md` (1 to 7). Each has a named test.

## Rules
- Reducer and sync logic: write the test first.
- Every bug gets a regression test, ideally a saved seed.
- Convergence tests run in CI on every push (fixed seed 42, 1,000 runs) and nightly (one random seed, 20,000 runs; a failing log is kept). Replay a seed with `WDB_PROP_SEED=<seed> WDB_PROP_RUNS=20000 pnpm --filter @wdb/shared exec vitest run test/prop --testTimeout=1200000`.
- Never use real data in tests (see `DATA_POLICY.md`).

## Commands
`pnpm test` · `pnpm test:prop` · `pnpm test:sim --seed <n>` · `pnpm e2e`
