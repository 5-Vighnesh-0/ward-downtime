# PRD: Ward Downtime Board

Status: Draft v1 · Owner: Vighnesh · Data: synthetic only (no real patient information, ever)

## 1. Problem

When a hospital loses its EHR, network or power-to-servers (ransomware, vendor outage, planned downtime), ward staff fall back to paper and whiteboards. Vendor "downtime views" are mostly read-only snapshots. Nobody can safely *write* new bed assignments, admits, transfers or discharges, and when systems return, reconciling what happened on paper is slow and error-prone.

**Claim to validate (not yet verified):** existing downtime tools are mostly read-only; this product adds a write-and-merge layer.

## 2. Goal

A ward-level bed board that keeps working with no network and no EHR, lets several devices record changes independently, and merges them safely afterward without silently losing or overwriting anyone's entry.

**Success looks like:** two or more tablets can be taken offline, make conflicting changes, reconnect, and end up with the same board, with every conflict visible and resolved by a human.

## 3. Users

| User | Job | Key need |
|---|---|---|
| Ward clerk / unit secretary | Updates beds, admits, discharges | Fast, obvious, works offline |
| Nurse | Checks who is where, edits patient label; can also admit, discharge and transfer | Glance-readable board |
| Charge nurse | Resolves conflicts, owns the board | Clear conflict queue |
| IT / downtime coordinator | Installs, monitors, exports | Simple deploy, recovery export |

Buyer/champion (hypothesis): nursing informatics lead or hospital IT/emergency-preparedness team. To be validated by interviews.

## 4. Scope

### v1 (build this first)
- Bed board for one ward (configurable bed count)
- Admit to bed, discharge, transfer between beds, edit patient label
- Offline-first on every device; local queue; sync when reachable
- Ward server as hub; devices keep full local copy
- Conflict detection (one patient per bed) with charge-nurse resolution
- Visible sync state per change (pending / confirmed / conflict)
- Recovery export for later reconciliation with the EHR (back-dated events, temporary patient IDs)
- Audit log (who, which device, when, what)

### v2
- Tasks tied to beds (assign, complete, overdue)
- Shift handoff notes per bed

### Non-goals
- Not an EHR, not a clinical decision tool, no orders, meds or results
- No direct EHR write-back in v1 (export only)
- No real patient data; no claim of HIPAA compliance or medical-device status
- No multi-hospital or cloud-hosted mode

## 5. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-1 | Show every bed with occupant label, status and sync state | Must |
| FR-2 | Admit, discharge, transfer and rename work with no network | Must |
| FR-3 | Every change is an immutable event with a device-generated unique ID | Must |
| FR-4 | Retried pushes never duplicate events (idempotent) | Must |
| FR-5 | Server assigns a global order; all devices replay to the same board | Must |
| FR-6 | Two admits to one bed open a conflict; neither is overwritten | Must |
| FR-7 | Charge nurse resolves a conflict; resolution is itself an event | Must |
| FR-8 | Rejected events stay in the log, marked rejected | Must |
| FR-9 | Rename uses later-in-server-order wins (documented exception) | Must |
| FR-10 | Pending changes visibly differ from confirmed ones | Must |
| FR-11 | Recovery export (JSON + CSV) of applied events with original times and temporary IDs | Must |
| FR-12 | Device can export its unsynced queue to a file as a storage-loss fallback | Should |
| FR-13 | Staff and device sign-in; roles (clerk, nurse, charge, admin) | Must |
| FR-14 | Audit log view and export | Should |
| FR-15 | Tasks and handoff notes (v2) | Later |

## 6. Non-functional requirements

- **Offline:** all FR-1 to FR-12 work with zero connectivity after first install.
- **Convergence:** same log in, same board out, on every device, deterministically.
- **Durability:** no acknowledged change lost; storage eviction risk mitigated (persistent storage request, install to home screen, unsynced counter, file export).
- **Latency:** local action visible under 100 ms; sync of a small batch on LAN under 1 s.
- **Scale target:** 1 ward, up to 60 beds, up to 20 devices, 100k events.
- **Accessibility:** WCAG 2.2 AA; touch targets 44 px+; works glove-friendly on tablets.
- **Browser support:** current Chrome, Edge, Safari (iOS/iPadOS) and Firefox.
- **Deploy:** one command on a ward-local machine; works on an isolated LAN.
- **Security:** see `security.md`.

## 7. Acceptance scenarios

1. Two tablets offline both admit different patients to bed 4; reconnect in either order; bed 4 shows a conflict on both; charge nurse keeps one; the other stays in the log as rejected; both tablets show the same board.
2. Tablet goes offline, makes 5 changes, browser is closed and reopened; all 5 still pending; reconnect; all confirm.
3. The same push is retried 3 times; the log has each event once.
4. Server is down for 30 minutes; devices keep working; server restarts; devices converge.
5. Discharge of an already-empty bed is a harmless no-op.
6. Recovery export contains applied events only, with original timestamps and temporary IDs.
7. Property-based test: random event interleavings across N devices always converge.

## 8. Metrics (for the portfolio / pilot story)

- Convergence test pass rate across randomized runs (target 100%)
- Conflicts detected vs. silently lost (target: 0 silent losses)
- Time from reconnect to converged board
- Interview-based: minutes saved reconciling after downtime (to be measured, not assumed)

## 9. Risks and open questions

- Browser storage eviction (especially iOS) can drop unsynced data. Mitigations above; needs real-device testing.
- HTTPS on a closed LAN needs a local CA or internal hostname set up before an outage.
- Hospital procurement/security review is out of scope for the prototype.
- Competitor depth is not fully verified; do more research before making claims.
- Clock drift across devices affects displayed times; ordering must not depend on wall clocks.
- Whether clinicians accept a human-resolved conflict workflow is untested.

## 10. Milestones

1. Shared event model + reducer with property tests
2. Ward server (log, ordering, idempotent push, conflict rules)
3. Offline PWA (IndexedDB queue, sync, UI states)
4. Conflict queue + recovery export
5. Security hardening + chaos/offline test suite
6. v2: tasks and handoff
