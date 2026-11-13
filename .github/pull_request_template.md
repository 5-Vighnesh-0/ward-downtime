## What and why

<!-- One or two sentences. Name the requirement IDs this serves, e.g. FR-7, SEC-22. -->

## Checklist

- [ ] Requirement IDs (FR-x, SEC-x) are in the title or description
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm check:synthetic` pass; `pnpm e2e` if the app changed
- [ ] Reducer or sync changes have tests first; convergence changes have property tests
- [ ] Synthetic data only: no real names, MRNs, dates of birth, phone numbers or emails (DATA_POLICY.md)
- [ ] No new dependency, or it was agreed first and is on the approved list in CLAUDE.md
- [ ] No compliance or certification claims ("aligned with" / "designed toward" only)
- [ ] Docs updated where behaviour changed (design.md, runbooks, README)
- [ ] **SEC-30:** if this changes the architecture, a trust boundary, data stored or a new input, the STRIDE tables in
      design.md §9.1 and security.md are updated in this pull request (or: no architecture change)
