# Board redesign, hospital branding and easy setup

Date: 2026-11-18. Status: draft for review. Agreed in a brainstorm with mockups (`.superpowers/brainstorm/`).

## Why

- The board is crowded. On an admin tablet the screen can show up to 7 tabs and about 10 stacked warning boxes above the beds. The bed pop-up shows every form at once.
- Getting in is too technical. Today it takes Docker, a terminal, a certificate on every device and command-line approvals.
- Two people must manage on their own: a **nurse** adding a tablet to a ward whose server IT already set up, and a **recruiter** trying the project.
- Out of scope: a non-technical person installing the ward server itself. IT does that once (RB-TLS).

## Locked decisions this does not touch

Event log, server ordering, one patient per bed, human conflict resolution, no CRDT, no last-write-wins, ordering never from client clocks. The redesign changes screens, not sync.

## Delivery: three parts, one plan each, in this order

1. **Board redesign and hospital branding** (the part nurses see every shift).
2. **Guided tablet setup and charge-nurse approval.**
3. **Hosted demo for recruiters.**

Each part ships on its own with tests passing. Part 3 reuses parts 1 and 2.

---

## Part 1: Board redesign and hospital branding

### 1.1 Look: "Clinical calm"

- Warm off-white page (`#f6f5f1`), white bed tiles, dark ink text, one accent colour (the hospital's).
- Fixed safety colours, never brandable: conflict red, "not sent" amber, empty-bed grey outline. Every status shows a word plus a shape (red outline, dashed outline), never colour alone.
- No coloured side stripes on cards.
- Body text at least 16px (the app's root size stays 18px), touch targets at least 44px, contrast at least 4.5:1. Existing tokens in `apps/web/src/styles/tokens.css` are reused and renamed only where needed.

### 1.2 Layout: ward map by bay

- **Top bar** (one line): hospital logo and name, ward name, one **status pill** that merges online/offline and unsynced count ("Offline · 1 waiting"), and a staff menu (staff ID, Lock, Sign out).
- **Side rail** (left): Board, Unplaced, My changes; Conflicts for charge and admin, with a count badge; **More** holds Recovery, Audit and Admin. Nurses and clerks see only what their role allows, as today.
- **One notice line** under the top bar: the most urgent notice, plus "+N more" that opens the rest in a list. Order: chain fork / storage lost > server alerts > recovering > offline > clock skew > storage not persisted > update ready. Notices that today carry a button (Open Recovery, Save to file, Install update) keep it.
- **Counts row** replaces the filter buttons: "8 occupied · 3 empty · 1 conflict · 1 not sent". Tapping a count filters the map; tapping again clears it.
- **Ward map**: beds grouped by bay with a bay heading, as many columns as fit. Each tile shows the bed number (large), the patient label and at most one meta line (late tasks, notes count, "Not sent", "Conflict: 2 patients").
- **Bays**: the ward configuration has no bays today (beds are only `B01`, `B02`…). Bays become a display-only setting the admin edits in Admin → Hospital: a bay name and the beds in it. Beds in no bay show under "Other beds"; with no bays set, all beds show as one group. Bays live in `ward_settings`, not in the event log, so they never affect replay or the hash chain.

### 1.3 Bed panel

- Tapping a bed opens a **side panel** on the right while the map stays visible; tapping another bed switches the panel. When the screen is narrower than 900px, the same panel opens as a **bottom sheet**.
- Order inside: bed number, label, temp ID; actions (Move bed, Rename, Discharge); then **Tasks** and **Notes** as two tabs with counts.
- "Add a task" and "Add a note" forms stay closed until tapped.
- Close with ✕ or Escape; focus returns to the bed tile (keeps today's dialog behaviour, WCAG 2.4.3).

### 1.4 Hospital branding

- **Admin → Hospital** (admin only): hospital name (max 60 characters), logo upload, accent colour, bays.
- **Logo**: PNG or JPEG only, at most 200 KB and 1024×1024 px. The server checks the file's first bytes (magic number), not its name. No SVG (it can carry scripts). Served from the ward server with its own content type and `nosniff`, so the CSP (`img-src 'self'`) is unchanged.
- **Colour from the logo**: on upload the admin's browser draws the logo on a canvas and picks the most common strong colour (ignoring near-white, near-black and grey pixels). It then darkens it in small steps until it reaches 4.5:1 against white. The admin sees the result and can override it with a colour picker. The server checks the hex value and the 4.5:1 contrast again and refuses anything below it.
- **No internet**: nothing is looked up online. The admin uploads the file their hospital's communications team provides.
- **Tablets**: fetch branding from `GET /api/v1/branding` (no session needed, so the sign-in screen can show it), keep a copy for offline use, and refresh on each sync. Default when nothing is set: no logo, the current teal, the ward name only.
- Every change is written to the audit log (`BRANDING_CHANGED`, by staff ID).

**Database change (needs your OK before building):** a new single-row table `ward_settings`:

| column | type | note |
|---|---|---|
| id | smallint primary key, check id = 1 | one row only |
| hospital_name | text, null | max 60 characters |
| accent | text, null | `#rrggbb`, contrast checked |
| logo | bytea, null | at most 200 KB |
| logo_type | text, null | `image/png` or `image/jpeg` |
| bays | jsonb, null | `[{ "name": "Bay A", "beds": ["B01", …] }]`, max 20 bays, each bed in at most one bay; checked with Zod |
| updated_at | timestamptz | |
| updated_by | text, references staff | |

Kept out of the event log on purpose: branding is not ward state and must not affect replay or the hash chain. It is included in backups because it lives in the same database.

### 1.5 What stays the same

Sync engine, reducer, outbox, all API behaviour apart from the new branding routes, copy wording (except the shorter notice texts), keyboard and screen-reader support, and the role rules.

---

## Part 2: Guided tablet setup and charge-nurse approval

### 2.1 Flow

1. A charge nurse or admin opens **Devices → Add a tablet**. This opens a **setup window** for 1 hour and shows a QR code, the setup address and a 4-character **certificate check code**.
2. The nurse scans the QR code. It opens `http://<ward host>/setup`, a plain page that detects iPad or Android. It shows the certificate download and the steps one picture at a time, with the same check code to compare.
3. Once the certificate is trusted, the page links to the HTTPS app. On iPad it shows where Share → Add to Home Screen is; on Android it shows an **Install app** button (the browser's install prompt).
4. The nurse names the tablet and gets the 12-character code, as today. The Devices item on charge and admin tablets shows a badge ("1 waiting"). The approver compares the code and taps **Approve**.

If IT already pushes the certificate by MDM (RB-TLS), the nurse opens the HTTPS address directly and skips step 2.

### 2.2 Setup window (security)

- Off by default. A charge nurse or admin opens it, it closes by itself after 1 hour or when closed by hand, and opening and closing are audited.
- While closed, `/setup` and the certificate download answer 404.
- Caddy serves `/setup` and the certificate over plain HTTP only for these two paths; everything else still redirects to HTTPS.
- **Risk, stated honestly:** while the window is open, someone on the same Wi-Fi could swap the downloaded certificate for their own and then read that tablet's traffic. The check code lowers this risk but does not remove it. It is acceptable only for small setups; real wards should use MDM.
- The window state lives in server memory, so a server restart closes it.

### 2.3 Charge nurses approve tablets

- `POST /api/v1/admin/devices/:id/approve` accepts charge and admin. Revoking stays admin only.
- Approvals record the approver's staff ID in the audit log, as today.
- **security.md change (agreed in the brainstorm):** SEC-4 becomes "an admin or charge nurse approves it; only an admin revokes it".

---

## Part 3: Hosted demo for recruiters

### 3.1 What a recruiter sees

- A public address with a normal certificate (Let's Encrypt through Caddy), so there is nothing to install.
- A front page with **Try as nurse**, **Try as charge nurse** and **Try as admin**: one tap signs in a demo staff member, with no PIN to type.
- A made-up hospital ("Demo General Hospital", a generic name chosen so it cannot pass for a real one, with a colour and plain logo drawn for this project), a ward with two bays, and synthetic patients (faker / Synthea labels).
- A line that is always visible: "Demo · synthetic data · resets every night".
- A **Go offline** switch (demo only): the tablet stops talking to the server until switched back, so a recruiter can see offline work, the waiting count and then the sync, without turning on airplane mode.
- Everyone shares one demo ward, so two recruiters see each other's changes live.

### 3.2 Demo mode on the server

- Turned on with `WDB_DEMO=1`. When it is on:
  - `POST /api/v1/demo/signin {role}` exists (404 otherwise) and signs the calling tablet in as that role's demo staff member;
  - new tablets are approved on enrollment;
  - the hospital name and logo are fixed to the demo ones;
  - `GET /api/v1/branding` reports `demo: true`, which shows the demo line and the Go offline switch.
- Safeguards: the server logs a warning at start-up, and refuses to start with `WDB_DEMO=1` unless the ward name starts with "Demo".
- Nightly reset: a scheduled job in the demo compose file wipes the database and runs `pnpm seed`.
- Rate limits stay on; demo sign-in shares the enrolment limit.

### 3.3 Hosting

- A `compose.demo.yaml` override: Caddy uses its default public ACME issuer instead of step-ca; backups and the restore service are left out.
- You pick the provider, create the account and pay for it; Claude cannot sign up or pay. The runbook `docs/runbooks/RB-DEMO.md` gives the steps for the provider you choose. Cost NOT VERIFIED until a provider is picked.
- The README gets the demo link at the top.

---

## Testing

- **Part 1:**
  - unit tests: notice ordering, counts and filter, bay grouping (beds in no bay, no bays set, unknown bed IDs ignored);
  - property test: the colour-darkening step always ends at 4.5:1 or more for any input colour;
  - server tests: logo checks (wrong magic bytes, too big, SVG refused), contrast refusal, branding audited, non-admin refused;
  - E2E: the existing suites updated for the new layout, keeping accessible names where possible; axe (A11Y-01) and keyboard (A11Y-02) still pass; README screenshots retaken.
- **Part 2:** server tests for the setup window (404 when closed, closes after 1 hour, audited), charge approves, charge cannot revoke; E2E for add-a-tablet through to approval.
- **Part 3:** server tests for demo routes returning 404 without `WDB_DEMO`, the start-up refusal, auto-approval only in demo mode; one E2E run in demo mode covering one-tap sign-in and Go offline then sync.
- Done means, as always: tests pass, types check, lint clean, synthetic-data check clean, requirement IDs in commits, docs updated.

## Docs to update

- design.md §10 (screens, component tree, states, visual system), §5 (new routes), §9 (setup window, demo mode).
- security.md SEC-4 (agreed); new SEC items for the setup window, logo upload checks and demo-mode safeguards.
- prd.md: new FR items for branding, guided setup and the demo. **Needs your OK** (CLAUDE.md: ask before editing prd.md).
- RB-TLS (setup window as the small-site option next to MDM), new RB-DEMO, README.

## Open items

- Hosting provider for the demo (your choice; needed before part 3).
- Approval of the `ward_settings` table and the prd.md edits (before part 1 starts).
