# Tasks

Order matters. Tick items when tests pass. IDs refer to `prd.md` and `security.md`.

## M0: Setup
- [x] Monorepo (pnpm, Turborepo), TypeScript strict, lint, CI skeleton
- [ ] Secret scan, SAST, dependency audit in CI (SEC-29). Passed locally with the CI versions; tick after the first GitHub run
- [x] Synthetic data script + real-identifier CI check (SEC-17)

## M1: Shared core (`packages/shared`)
- [x] Event types + Zod schemas (FR-3)
- [x] Reducer: admit, discharge, transfer, rename, resolve (FR-5 to FR-9)
- [x] Conflict rules and edge cases (FR-6, FR-8)
- [x] Property tests: convergence and idempotent replay (FR-4)

## M2: Ward server (`apps/server`)
- [x] Postgres schema, append-only event table, hash chain (SEC-10)
- [x] Push/pull endpoints, idempotency by event ID (FR-4)
- [x] Server-assigned order (FR-5, SEC-12)
- [x] Signature, device and role checks (SEC-4 to SEC-9)
- [x] SSE live updates
- [ ] Audit log (FR-14, SEC-18). Audit rows written (SEC-18); view/export endpoints come with the M3 audit screen

## M3: Offline PWA (`apps/web`)
- [ ] IndexedDB store and unsynced queue (FR-2)
- [ ] Sync loop with backoff, pending/confirmed/conflict states (FR-10)
- [ ] Board UI, admit/discharge/transfer/rename (FR-1, FR-2)
- [ ] Persistent storage request, unsynced counter, file export fallback (FR-12)
- [ ] Service worker, install flow

## M4: Conflicts and export
- [ ] Charge nurse conflict queue (FR-7)
- [ ] Recovery export JSON + CSV (FR-11)

## M5: Hardening
- [ ] Auth, roles, idle lock (SEC-5 to SEC-8). Server side done in M2b; client idle lock and offline sign-in in M3
- [ ] Caddy + local CA, TLS 1.3, CSP (SEC-1 to SEC-3)
- [ ] Playwright offline scenarios, Toxiproxy faults, security tests (SEC-31)
- [ ] Backup/restore drill, runbooks (SEC-27)
- [ ] Accessibility pass

## M6: v2
- [ ] Tasks tied to beds (FR-15)
- [ ] Shift handoff notes (FR-15)

## Before going public
- [ ] LICENSE, SECURITY.md, CONTRIBUTING.md
- [ ] README states synthetic data only, no compliance claim
