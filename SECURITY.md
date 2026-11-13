# Security policy

This is a portfolio project. It holds synthetic data only, is not deployed in any hospital, and makes no compliance
or certification claim. Security still matters here: the design, controls and tests are the point of the project.

## Reporting a vulnerability

Please report privately through GitHub: open the repository's **Security** tab and choose **Report a
vulnerability**. Do not open a public issue, pull request or discussion for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with it. Use synthetic data in any
example; never send real patient information.

This is maintained by one person on a best-effort basis, so there is no response-time promise. Reports are
acknowledged, fixed on `main`, and credited if you want credit.

## Supported versions

Only the latest `main` is supported. There are no releases or backports.

## Scope

In scope: the ward server (`apps/server`), the tablet app (`apps/web`), the shared event and reducer code
(`packages/shared`), and the deployment files (`compose.yaml`, `deploy/`).

Out of scope: denial of service by flooding the ward LAN, attacks that need a stolen and unlocked tablet or root on
the ward server (these are stated residual risks), and findings in third-party dependencies with no effect on this
project.

## How the project is secured

- [security.md](security.md): requirements (SEC-1 to SEC-31), threat actors and residual risks
- [design.md §9](design.md): STRIDE threat model, keys, sessions, roles, hash chain, audit
- [docs/security/asvs-l2.md](docs/security/asvs-l2.md): a self-review against OWASP ASVS 5.0.0 Level 2 and the
  OWASP Top 10:2025 (not an independent assessment)
