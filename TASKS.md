# Tasks

Order matters. Tick items when tests pass. IDs refer to `prd.md` and `security.md`.

## M0: Setup
- [x] Monorepo (pnpm, Turborepo), TypeScript strict, lint, CI skeleton
- [x] Secret scan, SAST, dependency audit in CI (SEC-29). First GitHub run green 2026-11-12
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
- [x] Audit log (FR-14, SEC-18). Rows and view (M3b); export comes with the M4 recovery export

## M3: Offline PWA (`apps/web`)
- [x] IndexedDB store and unsynced queue (FR-2)
- [x] Sync loop with backoff, pending/confirmed/conflict states (FR-10)
- [x] Board UI, admit/discharge/transfer/rename (FR-1, FR-2)
- [x] Persistent storage request, unsynced counter, file export fallback (FR-12). Server-side import of the file is M4
- [x] Service worker and update prompt; offline reload from the SW cache tested in E2E-02 on all three browsers
- [x] Playwright E2E on Chromium, Firefox, WebKit (M3c)
- [ ] Real iPad: Home Screen install, storage behaviour (§8.2), PIN check speed, PERF on the reference tablet. Needs a device

## M4: Conflicts and export
- [x] Charge nurse conflict queue (FR-7), resolve and Unplaced (FR-8)
- [x] Recovery export JSON + CSV (FR-11), decrypt CLI, audit export, queue import (M4b)

## M5: Hardening
- [ ] Auth, roles, idle lock (SEC-5 to SEC-8). Done in M2b and M3b except the per-ward idle lock setting
- [x] Caddy + local CA, TLS 1.3, CSP (SEC-1 to SEC-3), Compose stack, logs, clock skew (SEC-28), health and alerts (SEC-20) (M5a)
- [ ] Playwright offline scenarios, Toxiproxy faults, security tests (SEC-31)
- [ ] Backup/restore drill, runbooks (SEC-27), recovery replay from a device (design.md §11.4, moved from M4)
- [ ] Accessibility pass

## M6: v2
- [ ] Tasks tied to beds (FR-15)
- [ ] Shift handoff notes (FR-15)

## Before going public
- [ ] LICENSE, SECURITY.md, CONTRIBUTING.md
- [ ] README states synthetic data only, no compliance claim
