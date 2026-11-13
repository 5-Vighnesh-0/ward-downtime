# Security: Ward Downtime Board

Status: Draft v1 · Applies to the prototype and the design. **Synthetic data only.**

## 1. Position (read this first)

- This project uses fake patient data. It does **not** claim HIPAA compliance, FDA clearance or any certification.
- The design aims to align with HIPAA Security Rule safeguards. The Dec 2024 proposed update to the Security Rule had not been finalized as far as the research showed; **verify current status before citing it**. Design to the stricter proposal where cheap.
- If this ever handled real patient data, it would need a risk analysis, a BAA where applicable, an independent security review and hospital approval first.

## 2. Assets

| Asset | Why it matters |
|---|---|
| Event log (who is in which bed) | Patient location is sensitive health data in a real deployment |
| Staff and device identities | Access control and audit |
| Signing keys, session tokens | Impersonation |
| Recovery exports | Contain the whole log in one file |
| Device local storage | Full copy of the board sits on every tablet |

## 3. Threats and actors

| Actor | Example threat |
|---|---|
| Curious passer-by / lost tablet | Reads the board from an unlocked or stolen device |
| Malicious or careless insider | Edits or deletes history; acts as someone else |
| Network attacker on the ward LAN | Sniffs traffic, replays or forges events, rogue server |
| Compromised device | Floods the log, forges events |
| Ransomware on hospital systems | The very outage this product is built for; must not spread into the board |
| Supply chain | Malicious dependency or image |

Use STRIDE per component (client, sync API, server, database, export, deploy) and record the result in the design doc.

## 4. Requirements

### 4.1 Transport
- SEC-1: TLS 1.3 only, between devices and ward server, even on the LAN.
- SEC-2: Local CA (e.g. step-ca or mkcert for the prototype; hospital internal CA in production) with one permanent hostname, installed **before** any outage.
- SEC-3: HSTS, no mixed content, strict CSP, no third-party scripts at runtime.

### 4.2 Identity and access
- SEC-4: Device enrollment: each device generates a keypair (WebCrypto, non-extractable where supported); an admin approves it.
- SEC-5: Staff sign-in with a short-lived session; PIN or passkey, never shared logins. Server-side lockout and rate limiting.
- SEC-6: Roles enforced on the **server**: clerk, nurse, charge, admin. Only charge/admin resolve conflicts.
- SEC-7: Offline sign-in uses a locally cached, expiring credential; session lifetime and idle lock configurable (default 5 min idle lock).
- SEC-8: Revoking a device or user takes effect at next sync and blocks further pushes.

### 4.3 Event integrity
- SEC-9: Every event is signed by the device key; server verifies signature, device status and role before appending.
- SEC-10: The server log is append-only and hash-chained (each entry includes the hash of the previous one) so tampering is detectable.
- SEC-11: Validate every event with a strict schema (reject unknown fields, size limits). Idempotency by event ID.
- SEC-12: Server never trusts client timestamps for ordering; client times are display and audit data only.

### 4.4 Data at rest
- SEC-13: Server database on an encrypted volume; backups encrypted.
- SEC-14: Client local storage holds the minimum fields needed. Accept that browser storage is not strongly encrypted; mitigate with device lock, MDM-managed tablets, idle lock and remote wipe by revoking the device. Optionally encrypt the local DB with a key derived from the staff PIN (document the trade-off).
- SEC-15: Recovery exports are encrypted with a passphrase or key by default and labelled with a classification banner.

### 4.5 Data minimization and synthetic data
- SEC-16: The board stores a name label and a temporary ID only. No diagnosis, MRN, DOB or notes in v1. v2 (FR-15) adds short free text for task titles (60 characters) and handoff notes (140), for ward work only: the form warns against clinical and personal details, and the tablet and server refuse text that looks like an identifier (MRN, SSN, DOB, dates, email addresses, long numbers).
- SEC-17: Seed data comes from generators (e.g. Synthea, faker). A CI check blocks files that look like real identifiers (SSN, MRN patterns, real-looking emails).

### 4.6 Audit and logging
- SEC-18: Audit log records who, device, action, event ID, outcome, server time. Audit entries are append-only.
- SEC-19: Application logs never contain patient labels or tokens; use IDs and redaction.
- SEC-20: Alert on repeated auth failures, signature failures, event floods and hash-chain breaks.

### 4.7 Application hardening
- SEC-21: OWASP ASVS Level 2 as the checklist; OWASP Top 10 reviewed.
- SEC-22: CSRF protection, secure cookies (HttpOnly, Secure, SameSite=Strict) or token auth with rotation.
- SEC-23: Rate limits and payload size limits on sync endpoints; backpressure, not crashes.
- SEC-24: Dependency pinning with lockfile, minimal dependencies, subresource-free build.

### 4.8 Deployment and operations
- SEC-25: Containers run as non-root, read-only filesystem where possible, no secrets in images, secrets via environment or secret store.
- SEC-26: Ward server is network-segmented; no inbound internet; outbound blocked by default.
- SEC-27: Backups tested by restore; documented recovery steps for ransomware on the ward server itself (rebuild from encrypted backup, devices re-sync their copies).
- SEC-28: Time sync (NTP) on the server; clock skew detected and shown.

### 4.9 Secure SDLC
- SEC-29: CI runs: lint, type-check, tests, secret scan (gitleaks), SAST (Semgrep), dependency audit, container scan (Trivy), SBOM (CycloneDX).
- SEC-30: Threat model and this document updated with each architecture change.
- SEC-31: Security tests: auth bypass, role escalation, replayed event, forged signature, oversized payload, tampered log.

## 5. Residual risks (state them honestly)

- Browser storage on a stolen, unlocked, unmanaged tablet can be read.
- Offline credentials weaken revocation until the device next syncs.
- A compromised device with a valid key can still submit valid-looking events until revoked; the audit trail and charge-nurse review are the control.
- Local CA setup mistakes can break the secure context and disable offline features.
- v2 free text: the identifier check cannot stop someone typing clinical details or names in plain words. The warning on the form and staff training are the control.

## 6. Verification checklist

- [x] Threat model (STRIDE) written and reviewed (design.md §9.1; developer self-review 2026-11-12 in docs/security/asvs-l2.md §3)
- [x] All SEC items mapped to a test or a documented decision (design.md §2 table; SEC-25 compose hardening and the Caddy root exception are documented decisions; SEC-26 in RB-NET)
- [x] Penetration-style tests for SEC-31 pass (automated SEC-T suite, map in design.md §12.7; not an external pentest)
- [x] Hash chain verification tool run on a sample log (100,300-event restore drill, docs/runbooks/RB-BACKUP.md)
- [x] No real-looking identifiers in repo (CI check green: `pnpm check:synthetic` in the `quality` job)
- [x] Restore-from-backup drill done (2026-11-12, docs/runbooks/RB-BACKUP.md)
- [x] README states: synthetic data only, no compliance claim (README.md)

## 7. Sources to verify before citing

- HIPAA Security Rule (45 CFR Part 164 Subpart C) and the Dec 2024 NPRM status
- NIST SP 800-66 Rev. 2 (HIPAA Security Rule implementation guide)
- OWASP ASVS 4.0.3 / 5.0
- NIST SP 800-63B (authentication)
