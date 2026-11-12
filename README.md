# Ward Downtime Board

An offline-first bed board for hospital wards. When the EHR or network goes down, tablets keep working, record changes independently, and merge safely afterward. Conflicts (two patients in one bed) are never silently overwritten; a charge nurse resolves them.

> **Synthetic data only.** This is a portfolio project. It handles no real patient information and makes no HIPAA or medical-device compliance claim.

## The problem
Vendor downtime views are mostly read-only (to be verified). During an outage, wards fall back to whiteboards and spreadsheets, then spend hours reconciling afterward.

## How it works
- Every change is an immutable event with a unique ID, queued locally if offline.
- The ward server assigns a global order; every device replays the same log to the same board.
- Retries are safe (idempotent). Pending changes are visibly marked until confirmed.
- One patient per bed: a clash opens a conflict, both admits are held, a charge nurse picks one.
- A recovery export gives back-dated events with temporary IDs for later EHR reconciliation.

## Stack
TypeScript, React 19 PWA (IndexedDB), Fastify, PostgreSQL, Caddy with a local CA, Docker Compose. Tests: Vitest, fast-check, Playwright, Toxiproxy.

## Docs
- [prd.md](prd.md): what and why
- [security.md](security.md): threat model and controls
- [design.md](design.md): architecture and build plan
- [CLAUDE.md](CLAUDE.md): rules for AI agents

## Run it
```
pnpm install
docker compose up
pnpm dev
```
(Placeholder until the build exists.)

## Status
Design phase. A single-page simulation of two tablets and a ward server demonstrates the conflict flow.

## License
TBD
