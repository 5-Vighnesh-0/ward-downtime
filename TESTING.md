# Testing

## Layers
| Layer | Tool | What it proves |
|---|---|---|
| Unit | Vitest | Reducer rules, schemas, ID generation |
| Property-based | fast-check | Any interleaving of events across N devices converges to the same board |
| Simulation | Vitest, seeded | SIM-01/02: 20 real tablet engines and the real server under seeded partitions and crashes still converge and never reuse a deviceSeq or temp ID |
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
- Simulations run in `pnpm test` at 1,000 operations (seed 1) and nightly at 10,000 with a random seed. Replay one with `WDB_SIM_SEED=<seed> WDB_SIM_OPS=10000 pnpm --filter @wdb/web test:sim` (needs `docker compose up -d db-test`; about 5 minutes).
- Never use real data in tests (see `DATA_POLICY.md`).

## Commands
`pnpm test` · `pnpm --filter @wdb/shared test:prop` · `pnpm --filter @wdb/web test:sim` · `pnpm e2e`
