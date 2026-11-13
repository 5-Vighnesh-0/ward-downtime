# ASVS Level 2 and OWASP Top 10 review (M5c, 2026-11-12)

SEC-21. Checklist: [OWASP ASVS 5.0.0](https://github.com/OWASP/ASVS/tree/master/5.0/en), chapters V1 to V17, at Level 2.
Top 10: [OWASP Top 10:2025](https://top10.owasp.org/2025).

**Scope and honesty.** This is a chapter-level self-review by the developer: each chapter's intent is checked against
the built system and the tests that prove it. It is not a requirement-by-requirement audit, and not an independent
assessment. Before any real deployment, walk the numbered L2 requirements one by one. This project claims no
certification and no compliance; it is designed toward ASVS L2.

Status: **Met** (built and tested), **Partly** (gaps listed), **N/A** (feature not present).

## 1. ASVS 5.0.0 chapters

| Chapter | Status | What is built, and the evidence | Gaps |
|---|---|---|---|
| V1 Encoding and Sanitization | Met | React escapes all output; no `innerHTML` or `dangerouslySetInnerHTML` anywhere in `apps/web/src`. SQL goes through Drizzle or `pg` parameters; Semgrep `wdb-no-sql-raw` and `wdb-no-interpolated-query` block raw SQL (two reviewed exceptions in `backup.ts`, names from a fixed list). CSV cells starting `= + - @` tab or CR get a `'` prefix (`csvCell`, export tests). | — |
| V2 Validation and Business Logic | Met | Every event is a Zod `strictObject` (unknown fields refused), 4 KiB per event, 100 per batch, 256 KiB per body (SEC-T-SIZE). Business rules live in the shared reducer and run in server order: one patient per bed, conflicts held for a person (FR-5 to FR-8). Idempotency by `eventId`, monotonic `deviceSeq` (SEC-T-REPLAY). Rate limits and backpressure (FI-04). | — |
| V3 Web Frontend Security | Met | Strict CSP with no `unsafe-*`, `frame-ancestors 'none'`, `object-src 'none'`; HSTS; `nosniff`; `no-referrer`; COOP; Permissions-Policy; no third-party scripts (`deploy/check-tls.sh`, CI). Session cookie `HttpOnly; Secure; SameSite=Strict; Path=/api`. | The cookie cannot use the `__Host-` prefix because it is scoped to `Path=/api`. Accepted: the origin serves only this app. |
| V4 API and Web Service | Met | CSRF: required `X-WDB-Request` header and Origin check on every state change (SEC-T-CSRF). JSON only; schema-checked queries (422). Errors are codes, never internals. Every API response is `Cache-Control: no-store`. | — |
| V5 File Handling | Met | No server-side uploads of arbitrary files. Saved-tablet `.wdbx` files are decrypted on the admin tablet and sent as JSON batches that the server re-validates and signature-checks. The decrypt CLI refuses odd file names inside the container and never overwrites. | — |
| V6 Authentication | Partly | Per-staff PIN (6 to 8 digits) hashed with scrypt; the same answer for unknown staff and wrong PIN; 5 failures lock the account for 15 min; 20 failures on one device pause sign-in (SEC-T-AUTH). Sign-in also needs a signature from an admin-approved device key (possession). Offline sign-in uses a PBKDF2 (600,000 iterations) verifier that expires after 12 h. | A 6-digit PIN is a weak knowledge factor; the device key is the second factor only while the tablet itself is controlled (MDM). The offline verifier can be brute-forced from a stolen, unlocked tablet (security.md §5). Passkeys are not built. |
| V7 Session Management | Met | 32-byte random token, stored hashed server-side; 12 h absolute and 30 min idle expiry on the server; sign-out and staff disable end sessions (session tests). On the tablet: idle lock 1 to 15 min per ward (E2E-08, E2E-08b), and a reload starts locked. | — |
| V8 Authorization | Met | Roles come from the staff table, never the client. Per route and per event type, deny by default (`roles.ts`); a clerk or nurse `RESOLVE_CONFLICT` and a charge `WARD_CONFIGURED` are refused (SEC-T-ROLE). A device can only push its own events. | — |
| V9 Self-contained Tokens | N/A | No JWTs. The tablet's offline credential record is unsigned on purpose: editing it changes only what the UI offers, since the server re-checks every pushed event (design.md §9.4.3). | — |
| V10 OAuth and OIDC | N/A | Not used. | — |
| V11 Cryptography | Met | Platform crypto only (Node `crypto`, WebCrypto): Ed25519 event signatures with a non-extractable key, SHA-256 hash chain, AES-256-GCM with random IVs for exports and backups, PBKDF2-SHA256 600,000 iterations for passphrases, scrypt for PINs. No home-made primitives. | Key rotation for the backup key is manual (RB-BACKUP). |
| V12 Secure Communication | Partly | TLS 1.3 only at Caddy, certificate from the ward's own step-ca; TLS 1.2 refused (`deploy/check-tls.sh`, CI). | Caddy to server and server to Postgres are plain TCP on internal Docker networks that publish no ports. Accepted for one host; use TLS if they ever span hosts. |
| V13 Configuration | Partly | Secrets as files (never in images or git; gitleaks). Server container: non-root, read-only file system, `cap_drop: ALL`, `no-new-privileges`. Images pinned by digest, Trivy-scanned in CI; `Server` header removed; Caddy admin API off. | Caddy runs as root inside its container (capabilities dropped except `NET_BIND_SERVICE`). One x/net finding is excepted until 2026-12-12 (`.trivyignore.yaml`). |
| V14 Data Protection | Partly | Minimum patient fields, synthetic data only (CI check). API responses `no-store`. Exports and backups encrypted. Revoked tablets delete their database (SEC-T-WIPE). | IndexedDB is not encrypted by the app (design.md §9.9); relies on MDM device encryption and the idle lock. |
| V15 Secure Coding and Architecture | Met | Threat model (design.md §9.1, reviewed below). Dependencies: exact versions, 14-day minimum release age, `trustPolicy: no-downgrade`, `blockExoticSubdeps`, approval for new ones; CycloneDX SBOM; `pnpm audit`. The shared reducer is pure (Semgrep `wdb-pure-shared`). | — |
| V16 Security Logging and Error Handling | Met | JSON logs with request IDs and redaction; no PIN, cookie, signature or patient label in logs (SEC-T-LOGS, Semgrep `wdb-no-label-in-log`). Append-only audit log. Alerts for sign-in failures, bad signatures, floods, chain breaks, stale backups, lagging devices (SEC-T-ALERT). Generic 500 responses. | — |
| V17 WebRTC | N/A | Not used. | — |

## 2. OWASP Top 10:2025

| Category | Main controls here |
|---|---|
| A01 Broken Access Control | Server-side roles per route and event type, deny by default, device-bound sessions (V8) |
| A02 Security Misconfiguration | Hardened containers, strict headers checked in CI, secrets as files, admin API off (V3, V13) |
| A03 Software Supply Chain Failures | Exact pins, release-age delay, trust policy, approvals, SBOM, Trivy, digest-pinned images and actions (V15) |
| A04 Cryptographic Failures | Platform primitives only, TLS 1.3 only, encrypted exports and backups (V11, V12) |
| A05 Injection | Parameterized SQL with Semgrep guards, React escaping, CSV formula prefix (V1) |
| A06 Insecure Design | Event log with server order and human conflict resolution; STRIDE model; fault and property tests |
| A07 Authentication Failures | Lockout, sign-in pause, device key plus PIN, short sessions (V6, V7); weak-PIN residual stated |
| A08 Software or Data Integrity Failures | Signed events, hash chain checked at boot, hourly and on every tablet; restore refuses a log that does not verify |
| A09 Security Logging and Alerting Failures | Audit log, alerts, redaction (V16) |
| A10 Mishandling of Exceptional Conditions | Refused events never block later ones; all-or-nothing replay; tablets fail safe on `SERVER_BEHIND` and `CHAIN_FORK`; Toxiproxy faults FI-01 to FI-05 |

## 3. Threat model review (design.md §9.1)

Every control in the STRIDE tables was checked against the code. Found and fixed in M5c:

- The project Semgrep rules the tables relied on did not exist. Added `.semgrep/rules.yml` (`wdb-no-label-in-log`,
  `wdb-no-sql-raw`, `wdb-no-interpolated-query`, `wdb-pure-shared`), run in the CI `sast` job. Each rule was shown to
  fire on a planted violation.
- API responses had no `Cache-Control`; now `no-store` (test in `session.test.ts`).
- The HTTP to HTTPS redirect dropped a non-default port; fixed (`deploy/check-tls.sh`).

Corrected in the tables, not built:

- **Disk-full alert at 80%:** not built. The server container cannot see the Postgres volume; check host disk with
  the host's own monitoring.
- **"Devices pin the local CA root and hostname":** the app does not pin. Trust comes from the root installed by MDM
  in the OS trust store. A rogue server is still caught by the device's head-hash check.
- **Nightly random-seed property runs (PB-01 at 20,000):** not built; CI runs a fixed seed at 1,000 runs.

## 4. Not covered

- A manual screen-reader pass (A11Y-03 manual part) and the real-iPad checks need devices.
- No external penetration test.
