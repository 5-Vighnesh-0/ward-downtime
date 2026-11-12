# CLAUDE.md: Ward Downtime Board

Rules for any AI agent working in this repo. Read this, `prd.md` and `security.md` before doing anything.

## What this is
Offline-first hospital ward bed board. Event-sourced log, server-assigned order, one patient per bed, conflicts resolved by a charge nurse. Portfolio project.

## Hard rules
- SYNTHETIC DATA ONLY. Never add real names, MRNs, DOBs, SSNs or anything that looks real. Use Synthea or faker.
- Never claim HIPAA compliance or any certification. Say "aligned with" or "designed toward".
- Never invent sources, stats or competitor facts. Search, link, or mark NOT VERIFIED.
- No secrets in code, docs or examples. Use placeholders like `<DEVICE_PUBLIC_KEY>`.
- Do not reopen locked decisions (see prd.md and design.md ADRs): event log, server ordering, one patient per bed, human conflict resolution, no CRDT, no last-write-wins.
- Ordering never depends on client clocks. Client times are for display and audit only.

## Stack
TypeScript strict, pnpm + Turborepo. Shared reducer package used by client and server. React 19 + Vite PWA, Dexie/IndexedDB. Fastify + Postgres 16 + Drizzle. Caddy + internal CA. Docker Compose. Vitest, fast-check, Playwright, Toxiproxy. Also approved: Zod, Workbox via vite-plugin-pwa, TanStack Query (online admin reads only), Zustand, Tailwind, Radix UI, Pino, step-ca, pg, @fastify/cookie, @fastify/rate-limit, @vitejs/plugin-react, @tailwindcss/vite (see design.md §3.3, §16). Dev only: eslint, typescript-eslint, @types/node, @types/pg, @types/react, @types/react-dom, drizzle-kit, fake-indexeddb, @faker-js/faker; Synthea runs from its release jar (Java 17+). OpenTelemetry is deferred out of v1. Do not add a dependency outside this list without asking.

## Layout
```
packages/shared   event types, Zod schemas, reducer (pure, no I/O)
apps/server       Fastify API, Postgres, sync endpoints
apps/web          React PWA, service worker, local queue
design.md         architecture, ADRs, build plan
docs/             adr/, runbooks/
```

## Commands
`pnpm install` · `docker compose up -d db-test` (needed by `pnpm test`) · `pnpm test` · `pnpm lint` · `pnpm typecheck` · `pnpm check:synthetic` · `pnpm seed` · `pnpm synthea:labels --jar <path>` · `pnpm --filter @wdb/server migrate` · `pnpm --filter @wdb/server verify-chain` · `pnpm --filter @wdb/server admin add-staff|approve-device` · `pnpm --filter @wdb/server start` · `pnpm --filter @wdb/web dev|build` · `pnpm e2e` · `docker compose up`

## Working style
- Tests first for the reducer and sync logic. Convergence must be proven with property-based tests.
- Make the smallest change that fully solves the task. No extra files, abstractions or features.
- Stop and ask before: deleting files, adding dependencies, changing the DB schema, or editing prd.md / security.md.
- Update docs when behavior changes. Keep prose short and plain.

## Done means
Tests pass, types check, no lint errors, requirement IDs (FR-x / SEC-x) referenced in the PR or commit, docs updated.
