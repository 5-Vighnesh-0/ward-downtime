# Board Redesign and Hospital Branding (Part 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ward board calm and easy to read (ward map by bay, one status pill, one notice line, side rail, bed side panel) and let the admin brand it with the hospital's name, logo and colour.

**Architecture:** Branding lives in one new Postgres row (`ward_settings`), outside the event log, served by `GET /api/v1/branding` and changed by two admin routes. Shared pure helpers (contrast, darkening, bay schema) sit in `packages/shared` so the server and tablet check the same rules. The tablet keeps the last branding in Dexie `meta` for offline use and sets the accent through CSSOM. The UI changes are confined to `apps/web/src` screens and `ui/` helpers; sync, reducer and outbox are untouched.

**Tech Stack:** TypeScript strict, Zod 4, Drizzle + Postgres 16, Fastify 5, React 19, Tailwind 4, Dexie, Vitest + fast-check, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-18-board-redesign-and-easy-setup-design.md` (Part 1). Approved 2026-11-18, including the `ward_settings` table and the prd.md edits.

## Global Constraints

- SYNTHETIC DATA ONLY. Never add real names, MRNs, DOBs, SSNs or anything that looks real. Demo hospital name: "Demo General Hospital".
- Never claim HIPAA compliance or any certification.
- No secrets in code, docs or examples.
- Locked decisions untouched: event log, server ordering, one patient per bed, human conflict resolution, no CRDT, no last-write-wins. Ordering never depends on client clocks.
- No new dependencies (canvas, `createImageBitmap`, `OffscreenCanvas` and `<input type="color">` are platform features).
- Accent contrast on white at least 4.5:1, enforced on server and tablet. Conflict red, pending amber and the empty outline are never brandable.
- Logo: PNG or JPEG only, at most 200 KB (204,800 bytes) and 1024 × 1024 px, type read from the file's bytes. No SVG.
- Touch targets stay at least 48 px (`min-h-12`); root font size stays 18px; status is never colour alone.
- CSP stays as it is (`img-src 'self' data:`, `style-src 'self'`): logo as a `data:` URL, accent set with `style.setProperty`.
- Commits happen only when the user says so in this session; every commit message names requirement IDs (FR-16, SEC-32, plus any touched).
- Before running server or web tests: `docker compose up -d db-test`.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `packages/shared/src/branding.ts` | create | contrast maths, `darkenToContrast`, `Bays`, `BrandingUpdate`, `Branding` type |
| `packages/shared/src/index.ts` | modify | export branding |
| `packages/shared/test/branding.test.ts` | create | unit + property tests |
| `apps/server/src/db/schema.ts` | modify | `wardSettings` table |
| `apps/server/drizzle/0004_*.sql`, `0005_*.sql` | generate | table + grants |
| `apps/server/src/backup.ts` | modify | back up `ward_settings` |
| `apps/server/src/branding.ts` | create | image checks, read/save the row |
| `apps/server/src/app.ts` | modify | three branding routes, image body parser |
| `apps/server/test/branding.test.ts` | create | route tests |
| `apps/server/test/backup.test.ts` | modify | branding survives backup/restore |
| `apps/web/src/sync/device.ts` | modify | `request()` accepts a Blob body |
| `apps/web/src/sync/db.ts` | modify | `Meta.branding` |
| `apps/web/src/ui/branding.ts` | create | load/refresh/apply branding on the tablet |
| `apps/web/src/ui/notices.ts` | create | notice ranking |
| `apps/web/src/ui/logoColor.ts` | create | colour from a logo |
| `apps/web/src/ui/bedState.ts` | modify | `groupByBay`, `countLabel` |
| `apps/web/src/styles/tokens.css` | modify | Clinical calm tokens |
| `apps/web/src/ui/kit.tsx` | modify | Button `expanded`, calm Banner, `Panel`, `NoticeLine` |
| `apps/web/src/App.tsx` | modify | top bar, staff menu, side rail, notices, branding |
| `apps/web/src/screens/Board.tsx` | modify | counts row, bays, tiles, side panel, tabs, closed forms |
| `apps/web/src/screens/Admin.tsx` | modify | Hospital section |
| `apps/web/test/*.test.ts` | create/modify | branding, notices, bays, logo colour |
| `apps/web/e2e/support.ts`, `a11y.spec.ts`, `tasks.spec.ts`, `offline.spec.ts`, `smoke.spec.ts`, `budgets.spec.ts` | modify | new selectors |
| `prd.md`, `security.md`, `design.md`, `TASKS.md`, `README.md`, `docs/screenshots/*` | modify | docs |

---

### Task 1: Shared branding rules

**Files:**
- Create: `packages/shared/src/branding.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/branding.test.ts`

**Interfaces:**
- Produces: `luminance(hex: string): number`, `contrastOnWhite(hex: string): number`, `MIN_CONTRAST = 4.5`, `darkenToContrast(hex: string): string`, `Accent` (Zod), `Bays` (Zod + type `{ name: string; beds: string[] }[]`), `BrandingUpdate` (Zod: `{ hospitalName: string | null; accent: string | null; bays: Bays | null }`), `interface Branding { hospitalName: string | null; accent: string | null; logo: string | null; bays: Bays | null; ward: string | null }`.

- [ ] **Step 1: Write the failing test** — `packages/shared/test/branding.test.ts`

```ts
// Spec 2026-11-18 §1.4 (FR-16): the accent is always readable on white; bays never share a bed.
import { describe, expect, it } from 'vitest';
import { Bays, BrandingUpdate, contrastOnWhite, darkenToContrast, MIN_CONTRAST } from '../src/index.ts';
import { fc } from './prop/fc.ts';

describe('accent colour', () => {
  it('measures contrast like WCAG 2', () => {
    expect(contrastOnWhite('#000000')).toBeCloseTo(21, 1);
    expect(contrastOnWhite('#ffffff')).toBeCloseTo(1, 5);
    expect(contrastOnWhite('#0e7490')).toBeGreaterThan(MIN_CONTRAST); // today's teal
  });

  it('keeps a colour that is already dark enough, in lower case', () => {
    expect(darkenToContrast('#0E7490')).toBe('#0e7490');
  });

  it('always ends readable on white, whatever colour goes in', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffff }), (n) => {
        const out = darkenToContrast(`#${n.toString(16).padStart(6, '0')}`);
        expect(out).toMatch(/^#[0-9a-f]{6}$/);
        expect(contrastOnWhite(out)).toBeGreaterThanOrEqual(MIN_CONTRAST);
      }),
    );
  });

  it('refuses a light accent and accepts a dark one', () => {
    expect(BrandingUpdate.safeParse({ hospitalName: null, accent: '#ffff00', bays: null }).success).toBe(false);
    expect(BrandingUpdate.safeParse({ hospitalName: 'Demo General Hospital', accent: '#0e7490', bays: null }).success).toBe(true);
    expect(BrandingUpdate.safeParse({ hospitalName: 'x', accent: 'teal', bays: null }).success).toBe(false);
  });
});

describe('bays', () => {
  it('accepts bays and refuses a bed in two bays, bad bed IDs and empty bays', () => {
    expect(Bays.safeParse([{ name: 'Bay A', beds: ['B01', 'B02'] }, { name: 'Bay B', beds: ['B03'] }]).success).toBe(true);
    expect(Bays.safeParse([{ name: 'Bay A', beds: ['B01'] }, { name: 'Bay B', beds: ['B01'] }]).success).toBe(false);
    expect(Bays.safeParse([{ name: 'Bay A', beds: ['bed 1'] }]).success).toBe(false);
    expect(Bays.safeParse([{ name: 'Bay A', beds: [] }]).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @wdb/shared exec vitest run test/branding.test.ts`
Expected: FAIL, `contrastOnWhite` (and the others) not exported.

- [ ] **Step 3: Implement** — `packages/shared/src/branding.ts`

```ts
// Hospital branding (spec 2026-11-18 §1.4, FR-16): accent contrast and display-only bays. Never part of the event log.
import { z } from 'zod';

const HEX = /^#[0-9a-fA-F]{6}$/;
const printable = /^[^\u0000-\u001f\u007f]+$/;
const bedId = z.string().regex(/^B[0-9]{2}$/); // same format as schema.ts

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const rgbOf = (hex: string): number[] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const hexOf = (rgb: number[]) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;

/** WCAG 2 relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = rgbOf(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of `#rrggbb` against white. */
export const contrastOnWhite = (hex: string): number => 1.05 / (luminance(hex) + 0.05);
export const MIN_CONTRAST = 4.5;

/** Darkens in 5% steps until the colour reads at 4.5:1 on white. Ends at black (21:1) at worst, so it always stops. */
export function darkenToContrast(hex: string): string {
  let rgb = rgbOf(hex);
  let out = hexOf(rgb);
  while (contrastOnWhite(out) < MIN_CONTRAST) {
    rgb = rgb.map((c) => Math.floor(c * 0.95));
    out = hexOf(rgb);
  }
  return out;
}

export const Accent = z
  .string()
  .regex(HEX)
  .transform((h) => h.toLowerCase())
  .refine((h) => contrastOnWhite(h) >= MIN_CONTRAST, 'Colour too light to read on white');

export const Bays = z
  .array(z.strictObject({ name: z.string().min(1).max(30).regex(printable), beds: z.array(bedId).min(1).max(60) }))
  .max(20)
  .refine((bays) => {
    const all = bays.flatMap((b) => b.beds);
    return new Set(all).size === all.length;
  }, 'A bed can be in one bay only');
export type Bays = z.infer<typeof Bays>;

export const BrandingUpdate = z.strictObject({
  hospitalName: z.string().trim().min(1).max(60).regex(printable).nullable(),
  accent: Accent.nullable(),
  bays: Bays.nullable(),
});
export type BrandingUpdate = z.infer<typeof BrandingUpdate>;

/** What `GET /api/v1/branding` returns. `logo` is a `data:` URL, so the CSP's `img-src 'self' data:` covers it. */
export interface Branding {
  hospitalName: string | null;
  accent: string | null;
  logo: string | null;
  bays: Bays | null;
  ward: string | null;
}
```

Add to `packages/shared/src/index.ts`:

```ts
export * from './branding.ts';
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @wdb/shared exec vitest run test/branding.test.ts`
Expected: PASS (5 tests).
Then: `pnpm typecheck` — expected: no errors.

- [ ] **Step 5: Commit (when the user has asked for commits)**

```bash
git add packages/shared/src/branding.ts packages/shared/src/index.ts packages/shared/test/branding.test.ts
git commit -m "feat(shared): accent contrast and bay rules for hospital branding (FR-16)"
```

---

### Task 2: `ward_settings` table, grants and backup

**Files:**
- Modify: `apps/server/src/db/schema.ts` (append after `exports`)
- Generate: `apps/server/drizzle/0004_ward_settings.sql`, `apps/server/drizzle/0005_ward_settings_grants.sql` (+ `meta/`)
- Modify: `apps/server/src/backup.ts:19-25`
- Test: `apps/server/test/backup.test.ts:45-60`

**Interfaces:**
- Produces: `wardSettings` Drizzle table with columns `id, hospitalName, accent, logo (Buffer), logoType, bays (jsonb), updatedAt, updatedBy`.

Note: test resets already run `TRUNCATE … staff … CASCADE`; `ward_settings.updated_by` references `staff`, so the row is cleared too. No reset change needed.

- [ ] **Step 1: Write the failing test** — in `apps/server/test/backup.test.ts`, inside the first test, insert before `const { bytes, headSeq } = await takeBackup(pool(), key);`:

```ts
    await owner.query(
      `INSERT INTO ward_settings (id, hospital_name, accent, logo, logo_type, bays, updated_by)
       VALUES (1, 'Demo General Hospital', '#0e7490', '\\x89504e47'::bytea, 'image/png', '[{"name":"Bay A","beds":["B01"]}]', 'S-0004')`,
    );
```

and change the table list on line 60 to include it, then assert the content after the loop:

```ts
      for (const t of ['staff', 'devices', 'events', 'audit_log', 'exports', 'ward_settings']) expect(await count(target.pool, t)).toBe(await count(pool(), t));
      const ws = (await target.pool.query('SELECT hospital_name, logo, bays FROM ward_settings')).rows[0];
      expect(ws).toEqual({ hospital_name: 'Demo General Hospital', logo: Buffer.from('89504e47', 'hex'), bays: [{ name: 'Bay A', beds: ['B01'] }] });
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @wdb/server exec vitest run test/backup.test.ts`
Expected: FAIL, `relation "ward_settings" does not exist`.

- [ ] **Step 3: Add the table** — append to `apps/server/src/db/schema.ts`:

```ts
// Hospital branding and display-only bays (spec 2026-11-18 §1.4, FR-16; approved 2026-11-18). One row; never in the
// event log, so it cannot change replay or the hash chain.
export const wardSettings = pgTable(
  'ward_settings',
  {
    id: smallint('id').primaryKey(),
    hospitalName: text('hospital_name'),
    accent: text('accent'),
    logo: bytea('logo'),
    logoType: text('logo_type'),
    bays: jsonb('bays'),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    updatedBy: text('updated_by').references(() => staff.staffId),
  },
  (t) => [
    check('ward_settings_singleton', sql`${t.id} = 1`),
    check('ward_settings_logo_size', sql`octet_length(${t.logo}) <= 204800`),
    check('ward_settings_logo_type', sql`${t.logoType} IN ('image/png', 'image/jpeg')`),
  ],
);
```

- [ ] **Step 4: Generate the migration and the grants**

Run: `pnpm --filter @wdb/server db:generate --name ward_settings`
Expected: `apps/server/drizzle/0004_ward_settings.sql` with `CREATE TABLE "ward_settings"`, the three checks and the foreign key.

Run: `pnpm --filter @wdb/server exec drizzle-kit generate --custom --name ward_settings_grants`
Then put this in the new `apps/server/drizzle/0005_ward_settings_grants.sql`:

```sql
-- The app reads and writes the one branding row; it never deletes it (spec 2026-11-18 §1.4).
GRANT SELECT, INSERT, UPDATE ON ward_settings TO wdb_app;
```

- [ ] **Step 5: Back it up** — in `apps/server/src/backup.ts`, add the table to `TABLES` (after `staff`'s rows exist, so the foreign key holds on restore):

```ts
const TABLES = [
  ['staff', 'staff_id'],
  ['devices', 'device_id'],
  ['events', 'server_seq'],
  ['audit_log', 'audit_id'],
  ['exports', 'created_at, export_id'],
  ['ward_settings', 'id'],
] as const;
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @wdb/server exec vitest run test/backup.test.ts`
Expected: PASS. If `bays` comes back as a string, the restore inserts jsonb from text: check `restoreDatabase`'s column handling and pass objects through `JSON.stringify` for `jsonb` columns, like it already does for `events.body`.
Then: `pnpm --filter @wdb/server test` — expected: all pass.

- [ ] **Step 7: Commit (when asked)**

```bash
git add apps/server/src/db/schema.ts apps/server/drizzle apps/server/src/backup.ts apps/server/test/backup.test.ts
git commit -m "feat(server): ward_settings table for branding and bays, included in backups (FR-16, SEC-19)"
```

---

### Task 3: Branding routes on the server

**Files:**
- Create: `apps/server/src/branding.ts`
- Modify: `apps/server/src/app.ts` (imports; content-type parser after `app.setErrorHandler`; routes after the `/api/v1/admin/staff/:id` route)
- Test: `apps/server/test/branding.test.ts`

**Interfaces:**
- Consumes: `BrandingUpdate`, `Branding`, `Bays` (Task 1); `wardSettings` (Task 2).
- Produces: `GET /api/v1/branding` → `Branding` (no session); `PUT /api/v1/admin/branding` (admin, JSON `BrandingUpdate`) → `Branding`; `PUT /api/v1/admin/branding/logo` (admin, raw `image/png` or `image/jpeg` body) → `Branding`. Errors: 403 `ROLE_FORBIDDEN`, 422 `VALIDATION_FAILED`, 422 `LOGO_REFUSED`, 413 `PAYLOAD_TOO_LARGE`, 415 `BAD_REQUEST`. Audit action `BRANDING_CHANGED` (`code` = `'settings'` or `'logo'`).
- Server functions: `inspectImage(b: Buffer)`, `logoProblem(b: Buffer): string | null`, `readBranding(db: Db, ward: string | null): Promise<Branding>`, `saveBranding(db: Db, staffId: string, set: Partial<typeof wardSettings.$inferInsert>): Promise<void>`, `MAX_LOGO_BYTES = 204_800`.

- [ ] **Step 1: Write the failing test** — `apps/server/test/branding.test.ts`

```ts
// FR-16, SEC-32: hospital branding. Read without a session; only admins change it; logos are checked by their bytes.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { inspectImage } from '../src/branding.ts';
import { createDb } from '../src/db.ts';
import { addDevice, addStaff, APP_URL, CSRF, ORIGIN, OWNER_URL, reset, sessionCookie } from './support.ts';

const owner = new pg.Pool({ connectionString: OWNER_URL });
const { db, pool } = createDb(APP_URL);
let app: FastifyInstance;
const cookie: Record<string, string> = {};

/** The first 33 bytes of a PNG: signature and IHDR with this size. Enough for the checks, not a full image. */
const png = (w: number, h: number) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
/** SOI, an APP0 segment, then SOF0 with height 64 and width 128. */
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

beforeAll(async () => {
  app = buildApp(db, { origin: ORIGIN, ward: 'Demo Ward' });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await owner.end();
});
beforeEach(async () => {
  await reset(owner);
  const d = await addDevice(pool);
  for (const [id, role] of [['S-0003', 'charge'], ['S-0004', 'admin']] as const) {
    await addStaff(pool, id, role);
    cookie[role] = await sessionCookie(pool, id, d.deviceId);
  }
});

const put = (role: string, url: string, payload: object | Buffer, type = 'application/json') =>
  app.inject({ method: 'PUT', url, headers: { ...CSRF, cookie: cookie[role] ?? '', 'content-type': type }, payload });
const SETTINGS = { hospitalName: 'Demo General Hospital', accent: '#1D4ED8', bays: [{ name: 'Bay A', beds: ['B01', 'B02'] }] };

describe('inspectImage', () => {
  it('reads PNG and JPEG sizes from the bytes and refuses anything else', () => {
    expect(inspectImage(png(64, 32))).toEqual({ type: 'image/png', width: 64, height: 32 });
    expect(inspectImage(jpeg)).toEqual({ type: 'image/jpeg', width: 128, height: 64 });
    expect(inspectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(inspectImage(Buffer.alloc(0))).toBeNull();
  });
});

describe('branding routes', () => {
  it('starts empty and is readable without signing in', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/branding' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ hospitalName: null, accent: null, logo: null, bays: null, ward: 'Demo Ward' });
  });

  it('an admin saves name, colour and bays; the change is audited', async () => {
    const r = await put('admin', '/api/v1/admin/branding', SETTINGS);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ hospitalName: 'Demo General Hospital', accent: '#1d4ed8', bays: SETTINGS.bays });
    expect((await app.inject({ method: 'GET', url: '/api/v1/branding' })).json().accent).toBe('#1d4ed8');
    const { rows } = await owner.query("SELECT staff_id, code FROM audit_log WHERE action = 'BRANDING_CHANGED'");
    expect(rows).toEqual([{ staff_id: 'S-0004', code: 'settings' }]);
  });

  it('refuses charge nurses, light colours and a bed in two bays', async () => {
    const r = await put('charge', '/api/v1/admin/branding', SETTINGS);
    expect([r.statusCode, r.json().error.code]).toEqual([403, 'ROLE_FORBIDDEN']);
    expect((await put('admin', '/api/v1/admin/branding', { ...SETTINGS, accent: '#ffff00' })).statusCode).toBe(422);
    expect((await put('admin', '/api/v1/admin/branding', { ...SETTINGS, bays: [{ name: 'A', beds: ['B01'] }, { name: 'B', beds: ['B01'] }] })).statusCode).toBe(422);
  });

  it('stores a PNG or JPEG logo as typed by its bytes, whatever the header says', async () => {
    const r = await put('admin', '/api/v1/admin/branding/logo', png(64, 64), 'image/jpeg');
    expect(r.statusCode).toBe(200);
    expect(r.json().logo).toMatch(/^data:image\/png;base64,/);
    expect((await put('admin', '/api/v1/admin/branding/logo', jpeg, 'image/jpeg')).json().logo).toMatch(/^data:image\/jpeg;base64,/);
    const { rows } = await owner.query("SELECT code FROM audit_log WHERE action = 'BRANDING_CHANGED' ORDER BY audit_id");
    expect(rows.map((x) => x.code)).toEqual(['logo', 'logo']);
  });

  it('refuses SVG, oversized images, big files and non-admins', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const code = async (role: string, b: Buffer, type = 'image/png') => {
      const r = await put(role, '/api/v1/admin/branding/logo', b, type);
      return [r.statusCode, r.json().error.code];
    };
    expect(await code('admin', svg)).toEqual([422, 'LOGO_REFUSED']);
    expect(await code('admin', svg, 'image/svg+xml')).toEqual([415, 'BAD_REQUEST']);
    expect(await code('admin', png(2000, 10))).toEqual([422, 'LOGO_REFUSED']);
    expect(await code('admin', Buffer.concat([png(64, 64), Buffer.alloc(204_800)]))).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    expect(await code('charge', png(64, 64))).toEqual([403, 'ROLE_FORBIDDEN']);
    expect((await owner.query('SELECT count(*)::int AS n FROM ward_settings')).rows[0].n).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @wdb/server exec vitest run test/branding.test.ts`
Expected: FAIL, `Cannot find module '../src/branding.ts'`.

- [ ] **Step 3: Implement the module** — `apps/server/src/branding.ts`

```ts
// Hospital branding (spec 2026-11-18 §1.4; FR-16, SEC-32): logo checks and the one ward_settings row.
import { eq } from 'drizzle-orm';
import type { Bays, Branding } from '@wdb/shared';
import { wardSettings } from './db/schema.ts';
import type { Db } from './db.ts';

export const MAX_LOGO_BYTES = 204_800;
const MAX_SIDE = 1024;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// JPEG start-of-frame markers carry the size; C4, C8 and CC share the range but are not frames.
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/** Type and size from the file's own bytes, never its name or the request header. Null for anything but PNG or JPEG. */
export function inspectImage(b: Buffer): { type: 'image/png' | 'image/jpeg'; width: number; height: number } | null {
  if (b.length >= 24 && b.subarray(0, 8).equals(PNG_SIG) && b.toString('latin1', 12, 16) === 'IHDR')
    return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] ?? 0;
    if (isSof(marker)) return { type: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

/** Why a logo is refused, or null when it is fine. */
export function logoProblem(b: Buffer): string | null {
  if (b.length > MAX_LOGO_BYTES) return 'Logo over 200 KB';
  const img = inspectImage(b);
  if (!img) return 'Logo must be a PNG or JPEG file';
  if (img.width < 1 || img.height < 1 || img.width > MAX_SIDE || img.height > MAX_SIDE) return 'Logo must be at most 1024 × 1024 pixels';
  return null;
}

export async function readBranding(db: Db, ward: string | null): Promise<Branding> {
  const [r] = await db.select().from(wardSettings).where(eq(wardSettings.id, 1));
  return {
    hospitalName: r?.hospitalName ?? null,
    accent: r?.accent ?? null,
    logo: r?.logo && r.logoType ? `data:${r.logoType};base64,${r.logo.toString('base64')}` : null,
    bays: (r?.bays as Bays | null | undefined) ?? null,
    ward,
  };
}

/** Creates or updates the single row; only the given columns change. */
export async function saveBranding(db: Db, staffId: string, set: Partial<typeof wardSettings.$inferInsert>): Promise<void> {
  const row = { ...set, updatedAt: new Date(), updatedBy: staffId };
  await db
    .insert(wardSettings)
    .values({ id: 1, ...row })
    .onConflictDoUpdate({ target: wardSettings.id, set: row });
}
```

- [ ] **Step 4: Wire the routes** — in `apps/server/src/app.ts`:

Imports (add to the existing lines):

```ts
import { BrandingUpdate, type Role } from '@wdb/shared';
import { inspectImage, logoProblem, MAX_LOGO_BYTES, readBranding, saveBranding } from './branding.ts';
```

(remove the old `import type { Role } from '@wdb/shared';` line, since `Role` now comes from the combined import).

After `app.setErrorHandler(...)`:

```ts
  // Logo uploads arrive as raw bytes (SEC-32); everything else stays JSON. Other types keep getting 415.
  app.addContentTypeParser(['image/png', 'image/jpeg'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
```

After the `api.patch('/api/v1/admin/staff/:id', …)` route:

```ts
    // --- Hospital branding (spec 2026-11-18 §1.4, FR-16). Read without a session: the sign-in screen shows it. ---
    const ward = opts.ward ?? null;
    api.get('/api/v1/branding', async () => readBranding(db, ward));

    api.put('/api/v1/admin/branding', { onRequest: admin }, async (req, reply) => {
      const b = BrandingUpdate.safeParse(req.body);
      if (!b.success) return reply.code(422).send(error('VALIDATION_FAILED', 'Invalid branding', z.flattenError(b.error)));
      const by = (req.auth as Auth).staffId;
      await saveBranding(db, by, b.data);
      await audit(req, { staffId: by, deviceId: req.auth?.deviceId ?? null, action: 'BRANDING_CHANGED', outcome: 'ok', code: 'settings' });
      return readBranding(db, ward);
    });

    api.put('/api/v1/admin/branding/logo', { onRequest: admin, bodyLimit: MAX_LOGO_BYTES }, async (req, reply) => {
      const body = req.body as Buffer;
      const problem = logoProblem(body);
      if (problem) return deny(reply, 422, 'LOGO_REFUSED', problem);
      const by = (req.auth as Auth).staffId;
      await saveBranding(db, by, { logo: body, logoType: inspectImage(body)?.type ?? null });
      await audit(req, { staffId: by, deviceId: req.auth?.deviceId ?? null, action: 'BRANDING_CHANGED', outcome: 'ok', code: 'logo' });
      return readBranding(db, ward);
    });
```

If the 413 test answers 422 instead, Fastify applied the route `bodyLimit` after parsing: keep `bodyLimit: MAX_LOGO_BYTES` on the route (Fastify enforces it while reading the body) and check the parser is registered on `app`, not inside the `api` scope.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @wdb/server exec vitest run test/branding.test.ts`
Expected: PASS (6 tests).
Then: `pnpm --filter @wdb/server test && pnpm typecheck && pnpm lint` — expected: all pass.

- [ ] **Step 6: Commit (when asked)**

```bash
git add apps/server/src/branding.ts apps/server/src/app.ts apps/server/test/branding.test.ts
git commit -m "feat(server): branding routes, logo checked by its bytes (FR-16, SEC-32)"
```

---

### Task 4: Branding on the tablet

**Files:**
- Modify: `apps/web/src/sync/device.ts` (`request()` body handling)
- Modify: `apps/web/src/sync/db.ts` (`interface Meta`)
- Create: `apps/web/src/ui/branding.ts`
- Test: `apps/web/test/branding.test.ts`

**Interfaces:**
- Consumes: `Branding` (Task 1); `GET /api/v1/branding` (Task 3).
- Produces: `NO_BRANDING: Branding`, `loadBranding(db: WdbDb): Promise<Branding>`, `refreshBranding(db: WdbDb, net: Net): Promise<Branding>`, `applyAccent(accent: string | null): void`; `request(net, method, path, body?: unknown | Blob, headers?)` sends a Blob as-is.

- [ ] **Step 1: Write the failing test** — `apps/web/test/branding.test.ts`

```ts
// FR-16: the tablet keeps the ward's branding, so the board still looks right with the server down.
import { afterEach, describe, expect, it } from 'vitest';
import { refreshBranding, loadBranding, NO_BRANDING } from '../src/ui/branding.ts';
import { startWard, tablet, type Tablet, type Ward } from './support.ts';

let ward: Ward;
let t: Tablet;
afterEach(async () => {
  t?.engine.stop();
  await ward?.close();
});

describe('branding on the tablet', () => {
  it('stores what the ward server sends and keeps it offline', async () => {
    ward = await startWard();
    t = await tablet(ward, 'nurse');
    expect(await loadBranding(t.db)).toEqual(NO_BRANDING);
    await ward.owner.pool.query("INSERT INTO ward_settings (id, hospital_name, accent) VALUES (1, 'Demo General Hospital', '#1d4ed8')");
    expect(await refreshBranding(t.db, t.net)).toMatchObject({ hospitalName: 'Demo General Hospital', accent: '#1d4ed8' });
    t.net.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    expect((await refreshBranding(t.db, t.net)).hospitalName).toBe('Demo General Hospital');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @wdb/web exec vitest run test/branding.test.ts`
Expected: FAIL, `Cannot find module '../src/ui/branding.ts'`.

- [ ] **Step 3: Implement**

In `apps/web/src/sync/db.ts`, add to `interface Meta` (and `import type { Branding } from '@wdb/shared';` at the top):

```ts
  branding?: Branding; // last copy from the ward server (FR-16); not indexed, so no Dexie version change
```

In `apps/web/src/sync/device.ts` `request()`, replace the content-type and body lines:

```ts
      ...(body === undefined || body instanceof Blob ? {} : { 'content-type': 'application/json' }),
```

```ts
    body: body === undefined ? null : body instanceof Blob ? body : JSON.stringify(body), // a Blob carries its own type
```

Create `apps/web/src/ui/branding.ts`:

```ts
// Hospital branding on the tablet (spec 2026-11-18 §1.4, FR-16): fetched from the ward server, kept for offline use.
import type { Branding } from '@wdb/shared';
import type { WdbDb } from '../sync/db.ts';
import { request, type Net } from '../sync/device.ts';

export const NO_BRANDING: Branding = { hospitalName: null, accent: null, logo: null, bays: null, ward: null };

export async function loadBranding(db: WdbDb): Promise<Branding> {
  return (await db.meta.get('device'))?.branding ?? NO_BRANDING;
}

/** Fetches and stores the branding; with the server unreachable it returns the stored copy. */
export async function refreshBranding(db: WdbDb, net: Net): Promise<Branding> {
  try {
    const b = (await (await request(net, 'GET', '/api/v1/branding')).json()) as Branding;
    await db.meta.update('device', { branding: b });
    return b;
  } catch {
    return loadBranding(db);
  }
}

/** Sets the accent for the whole app through CSSOM, which the CSP's style-src 'self' allows. */
export function applyAccent(accent: string | null): void {
  const root = document.documentElement.style;
  if (accent) root.setProperty('--color-accent', accent);
  else root.removeProperty('--color-accent');
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @wdb/web exec vitest run test/branding.test.ts`
Expected: PASS.
Then: `pnpm --filter @wdb/web test && pnpm typecheck` — expected: all pass.

- [ ] **Step 5: Commit (when asked)**

```bash
git add apps/web/src/sync/device.ts apps/web/src/sync/db.ts apps/web/src/ui/branding.ts apps/web/test/branding.test.ts
git commit -m "feat(web): keep the ward's branding on the tablet for offline use (FR-16)"
```

---

### Task 5: Clinical calm tokens, kit pieces and notice ranking

**Files:**
- Modify: `apps/web/src/styles/tokens.css`
- Modify: `apps/web/src/ui/kit.tsx`
- Create: `apps/web/src/ui/notices.ts`
- Test: `apps/web/test/notices.test.ts`

**Interfaces:**
- Produces: `type NoticeKey = 'idle' | 'chainFork' | 'storageLost' | 'alert' | 'serverBehind' | 'offline' | 'unsynced' | 'clockSkew' | 'persist' | 'update'`; `sortNotices<T extends { key: NoticeKey }>(list: T[]): T[]`; kit: `Button` gains `expanded?: boolean`; `NoticeLine({ notices }: { notices: { id: string; key: NoticeKey; tone: 'info' | 'warn' | 'error'; content: ReactNode }[] })`; `Panel({ title, onClose, children })`.

- [ ] **Step 1: Write the failing test** — `apps/web/test/notices.test.ts`

```ts
// Spec 2026-11-18 §1.2: one notice line shows the most urgent notice first.
import { describe, expect, it } from 'vitest';
import { sortNotices, type NoticeKey } from '../src/ui/notices.ts';

describe('sortNotices', () => {
  it('puts the idle warning and data problems first and the update last, keeping order within a rank', () => {
    const keys: NoticeKey[] = ['update', 'offline', 'alert', 'persist', 'chainFork', 'idle', 'clockSkew', 'alert', 'unsynced', 'serverBehind', 'storageLost'];
    const list = keys.map((key, i) => ({ key, i }));
    expect(sortNotices(list).map((n) => `${n.key}${n.key === 'alert' ? n.i : ''}`)).toEqual([
      'idle', 'chainFork', 'storageLost', 'alert2', 'alert7', 'serverBehind', 'offline', 'unsynced', 'clockSkew', 'persist', 'update',
    ]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @wdb/web exec vitest run test/notices.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the ranking** — `apps/web/src/ui/notices.ts`

```ts
// Which notice the one notice line shows first (spec 2026-11-18 §1.2). Lower rank = more urgent.
export type NoticeKey = 'idle' | 'chainFork' | 'storageLost' | 'alert' | 'serverBehind' | 'offline' | 'unsynced' | 'clockSkew' | 'persist' | 'update';

const RANK: Record<NoticeKey, number> = {
  idle: 0, // WCAG 2.2.1: the sign-out warning must be seen at once
  chainFork: 1,
  storageLost: 1,
  alert: 2,
  serverBehind: 3,
  offline: 4,
  unsynced: 5,
  clockSkew: 6,
  persist: 7,
  update: 8,
};

/** Most urgent first; notices of the same rank keep their order (Array.prototype.sort is stable). */
export const sortNotices = <T extends { key: NoticeKey }>(list: T[]): T[] => [...list].sort((a, b) => RANK[a.key] - RANK[b.key]);
```

- [ ] **Step 4: Run it**

Run: `pnpm --filter @wdb/web exec vitest run test/notices.test.ts`
Expected: PASS.

- [ ] **Step 5: Calm tokens** — replace the `@theme` block and `html` rule in `apps/web/src/styles/tokens.css`:

```css
/* Clinical calm (spec 2026-11-18 §1.1). Contrast: text on page 15.2:1, muted on page 6.4:1, border on page 3.2:1
   (WCAG 1.4.11), pending on white 7.4:1, conflict on white 6.6:1. The accent is the hospital's colour, set at run time
   by applyAccent() and always at least 4.5:1 on white. Status also has an icon and text, never colour alone. */
@import 'tailwindcss';

@theme {
  --color-page: #f6f5f1;
  --color-surface: #ffffff;
  --color-surface-raised: #efede7;
  --color-text: #1c2430;
  --color-text-muted: #4f5764;
  --color-border: #858a93;
  --color-accent: #0e7490;
  --color-focus: #0e7490;
  --color-status-occupied: #0e7490;
  --color-status-pending: #8a3b0c;
  --color-status-pending-bg: #fbecd9;
  --color-status-conflict: #b42318;
  --color-status-conflict-bg: #fdeceb;
  --color-status-error: #b42318;
  --font-sans: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}

html {
  font-size: 18px;
  line-height: 1.4;
  color: var(--color-text);
  background: var(--color-page);
}
```

Keep the rest of the file (body padding, focus, scroll-margin, dialog rules) as it is.

- [ ] **Step 6: Kit changes** — in `apps/web/src/ui/kit.tsx`:

Button: add `expanded?: boolean;` to the props, `aria-expanded={p.expanded}` on the `<button>`, and replace `variants` and the class string:

```ts
const variants = {
  primary: 'bg-accent text-white border-accent',
  secondary: 'bg-surface text-text border-border',
  destructive: 'bg-status-error text-white border-status-error',
};
```

```tsx
      className={`min-h-12 min-w-12 rounded-xl border px-4 font-semibold disabled:opacity-50 ${variants[p.variant ?? 'secondary']} ${p.wide ? 'min-h-14 w-full' : ''}`}
```

Banner: replace with calm tints:

```tsx
export function Banner(p: { tone?: 'info' | 'warn' | 'error'; children: ReactNode }) {
  const tone = { info: 'bg-surface-raised', warn: 'bg-status-pending-bg', error: 'bg-status-conflict-bg' }[p.tone ?? 'info'];
  const icon = { info: 'ℹ', warn: '⚠', error: '⛔' }[p.tone ?? 'info'];
  return (
    <div className={`flex items-start gap-3 rounded-xl p-3 ${tone}`}>
      <span aria-hidden="true">{icon}</span>
      <div className="flex flex-1 flex-wrap items-center gap-3">{p.children}</div>
    </div>
  );
}
```

Add `NoticeLine` (and `import type { NoticeKey } from './notices.ts';`):

```tsx
/** One notice at a time, most urgent first; "+N more" opens the rest (spec 2026-11-18 §1.2). */
export function NoticeLine({ notices }: { notices: { id: string; key: NoticeKey; tone: 'info' | 'warn' | 'error'; content: ReactNode }[] }) {
  const [all, setAll] = useState(false);
  const [first, ...rest] = notices;
  if (!first) return null;
  return (
    <div className="flex flex-col gap-2 px-4 pt-3">
      <Banner tone={first.tone}>
        {first.content}
        {rest.length > 0 && (
          <Button expanded={all} onClick={() => setAll(!all)}>
            {all ? 'Hide other notices' : `+${rest.length} more ${rest.length === 1 ? 'notice' : 'notices'}`}
          </Button>
        )}
      </Banner>
      {all &&
        rest.map((n) => (
          <Banner key={n.id} tone={n.tone}>
            {n.content}
          </Banner>
        ))}
    </div>
  );
}
```

Add `Panel` (non-modal, so the next bed is one tap away):

```tsx
/** The open bed (spec 2026-11-18 §1.3): beside the map from 900 px, a bottom sheet below. Non-modal; Esc or ✕ closes. */
export function Panel(p: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.show();
    (d?.querySelector<HTMLElement>('[data-autofocus]') ?? d?.querySelector<HTMLElement>('h2'))?.focus();
  }, [p.title]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onKeyDown={(e) => e.key === 'Escape' && p.onClose()}
      className="fixed inset-x-0 top-auto bottom-0 z-20 m-0 max-h-[85vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-surface p-0 text-text shadow-xl min-[900px]:top-14 min-[900px]:right-0 min-[900px]:left-auto min-[900px]:h-[calc(100vh-3.5rem)] min-[900px]:max-h-none min-[900px]:w-[26rem] min-[900px]:rounded-none"
    >
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} tabIndex={-1} className="text-xl font-semibold">
            {p.title}
          </h2>
          <Button onClick={p.onClose} label="Close">
            ✕
          </Button>
        </div>
        {p.children}
      </div>
    </dialog>
  );
}
```

- [ ] **Step 7: Check**

Run: `pnpm --filter @wdb/web test && pnpm typecheck && pnpm lint`
Expected: all pass (nothing uses `NoticeLine` or `Panel` yet; the app now shows the calm colours).

- [ ] **Step 8: Commit (when asked)**

```bash
git add apps/web/src/styles/tokens.css apps/web/src/ui/kit.tsx apps/web/src/ui/notices.ts apps/web/test/notices.test.ts
git commit -m "feat(web): Clinical calm tokens, notice line and bed panel pieces (FR-16)"
```

---

### Task 6: App shell — top bar, staff menu, side rail, one notice line

**Files:**
- Modify: `apps/web/src/App.tsx` (imports; branding state; the whole `return (…)` of `Ready`)
- Modify: `apps/web/e2e/support.ts:114,133-139` (the `Beds` heading on lines 72-78 stays: it becomes `sr-only`, which Playwright still counts as visible), `apps/web/e2e/offline.spec.ts:19`, `apps/web/e2e/smoke.spec.ts:16`, `apps/web/e2e/budgets.spec.ts:37`, `apps/web/e2e/a11y.spec.ts:59-61`

**Interfaces:**
- Consumes: `loadBranding`, `refreshBranding`, `applyAccent`, `NO_BRANDING` (Task 4); `NoticeLine`, `Button.expanded` (Task 5); `sortNotices`, `NoticeKey` (Task 5).
- Produces: `BoardScreen` gets a `bays` prop (Task 7) and `AdminScreen` an `onBranding` prop (Task 9); until those tasks land, pass them and let TypeScript flag the gap, or land Tasks 6, 7 and 9's prop changes together.
- Visible status text the e2e tests use: `Online · all sent` when nothing is waiting, otherwise `Online · N not sent` / `Offline · N not sent` (plus `Offline · all sent`).

- [ ] **Step 1: Update the e2e helpers first (they define the new contract)**

`apps/web/e2e/support.ts` — replace `tab`:

```ts
export async function tab(page: Page, name: string): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Screens' });
  const button = nav.getByRole('button', { name: new RegExp(`^${name}`) });
  await expect(async () => {
    if (!(await button.isVisible())) await nav.getByRole('button', { name: 'More', exact: true }).click(); // Recovery, Audit, Admin
    await button.click();
    await expect(button.locator('[aria-current="page"]')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
}

/** Opens the staff menu in the top bar and taps Lock or Sign out. */
export async function staffMenu(page: Page, item: 'Lock' | 'Sign out'): Promise<void> {
  await page.getByRole('button', { name: /^S-\d{4}$/ }).click();
  await page.getByRole('button', { name: item, exact: true }).click();
}
```

Line 114: `await expect(page.getByText(/· all sent$/)).toBeVisible({ timeout: 20_000 });`

`apps/web/e2e/offline.spec.ts:19`:

```ts
const unsynced = (page: Page, n: number) => expect(page.getByText(n === 0 ? /· all sent$/ : new RegExp(`· ${n} not sent$`))).toBeVisible();
```

`apps/web/e2e/smoke.spec.ts:16`: `await expect(page.getByText(/· all sent$/)).toBeVisible();`

`apps/web/e2e/budgets.spec.ts:37`: `await staffMenu(page, 'Lock');` (import `staffMenu` from `./support.ts`).

`apps/web/e2e/a11y.spec.ts:59` and `:61`: `await staffMenu(a, 'Lock');` and `await staffMenu(b, 'Sign out');` (import it).

- [ ] **Step 2: Run one e2e to see it fail**

Run: `pnpm --filter @wdb/web exec playwright test e2e/smoke.spec.ts --project=chromium`
Expected: FAIL, no text matching `· all sent`.

- [ ] **Step 3: Branding and notices in `Ready`** — `apps/web/src/App.tsx`

Imports to add:

```ts
import type { Branding } from '@wdb/shared';
import { applyAccent, loadBranding, NO_BRANDING, refreshBranding } from './ui/branding.ts';
import { sortNotices, type NoticeKey } from './ui/notices.ts';
import { Banner, Button, LiveRegion, NoticeLine, useEngine } from './ui/kit.tsx';
```

(replace the old kit import line.) Inside `Ready`, after the `alerts` state:

```ts
  const [branding, setBranding] = useState<Branding>(NO_BRANDING);
  const [more, setMore] = useState(false);
  const [menu, setMenu] = useState(false);
  const showBranding = (b: Branding) => (setBranding(b), applyAccent(b.accent));
  // FR-16: the stored copy at once, then the ward server's whenever the tablet is online.
  useEffect(() => void loadBranding(db).then(showBranding), []);
  useEffect(() => {
    if (s.online) void refreshBranding(db, net).then(showBranding);
  }, [s.online]);
```

`Banner` stays imported only if another part of `App.tsx` still uses it; otherwise drop it from the import (lint will say).

- [ ] **Step 4: Replace the `return (…)` of `Ready`** (everything from `return (` after `const tabs` to the end of the component) with:

```tsx
  type Item = [Tab, string, string]; // id, label, icon (decorative)
  const main: Item[] = [
    ['board', 'Board', '▦'],
    ['unplaced', 'Unplaced', '⇄'],
    ['changes', 'My changes', '↻'],
    ...(canResolve ? ([['conflicts', `Conflicts (${openConflicts})`, '⚠']] as Item[]) : []),
  ];
  const extra: Item[] = [
    ...(canResolve ? ([['recovery', 'Recovery', '⟲'], ['audit', 'Audit', '☰']] as Item[]) : []),
    ...(session.role === 'admin' ? ([['admin', 'Admin', '⚙']] as Item[]) : []),
  ];
  const showMore = more || extra.some(([id]) => id === tab);
  const railButton = ([id, label, icon]: Item) => (
    <Button key={id} variant={tab === id ? 'primary' : 'secondary'} onClick={() => setTab(id)}>
      <span aria-hidden="true">{icon} </span>
      <span aria-current={tab === id ? 'page' : undefined}>{label}</span>
    </Button>
  );

  const notices: { id: string; key: NoticeKey; tone: 'info' | 'warn' | 'error'; content: ReactNode }[] = [];
  if (warn)
    notices.push({ id: 'idle', key: 'idle', tone: 'warn', content: (<><span role="alert">{copy.idleWarning}</span><Button variant="primary" onClick={() => setWarn(false)}>Stay signed in</Button></>) });
  if (s.alert === 'CHAIN_FORK') notices.push({ id: 'chainFork', key: 'chainFork', tone: 'error', content: copy.chainFork });
  if (s.alert === 'STORAGE_LOST') notices.push({ id: 'storageLost', key: 'storageLost', tone: 'error', content: copy.storageLost });
  if (s.online)
    for (const a of alerts)
      notices.push({ id: `${a.code} ${a.detail}`, key: 'alert', tone: 'error', content: (<span><strong>{copy.alerts[a.code] ?? a.code}.</strong> {a.detail}</span>) });
  if (s.alert === 'SERVER_BEHIND')
    notices.push({ id: 'serverBehind', key: 'serverBehind', tone: 'warn', content: (<>{copy.serverBehind}{session.role === 'admin' && <Button onClick={() => setTab('recovery')}>Open Recovery</Button>}</>) });
  if (!s.online) notices.push({ id: 'offline', key: 'offline', tone: 'warn', content: copy.offline });
  if ((stale || s.unsynced >= 20) && tab !== 'changes')
    notices.push({ id: 'unsynced', key: 'unsynced', tone: 'warn', content: (<>{copy.unsyncedWarning(s.unsynced, Math.max(staleMin, 0))}<Button onClick={() => setTab('changes')}>Save to file</Button></>) });
  if (s.clockOffsetMs !== null && Math.abs(s.clockOffsetMs) > 120_000) notices.push({ id: 'clockSkew', key: 'clockSkew', tone: 'warn', content: copy.clockSkew(s.clockOffsetMs) });
  if (!persisted) notices.push({ id: 'persist', key: 'persist', tone: 'warn', content: copy.persist });
  if (update)
    notices.push({ id: 'update', key: 'update', tone: 'info', content: (<>{copy.updateReady}<Button variant="primary" disabled={sending} onClick={update}>Install update</Button></>) });

  const status = `${s.online ? 'Online' : 'Offline'} · ${s.unsynced === 0 ? 'all sent' : `${s.unsynced} not sent`}`;
  return (
    <>
      <header className="sticky top-0 z-10 flex min-h-14 items-center gap-3 border-b border-border bg-surface px-4 py-1">
        {branding.logo && <img src={branding.logo} alt="" className="h-9 w-auto" />}
        <span className="font-semibold">{branding.hospitalName ?? 'Ward board'}</span>
        {branding.ward && <span className="hidden text-text-muted sm:inline">{branding.ward}</span>}
        <Button onClick={() => setTab('changes')}>
          <span className={s.online && !stale ? '' : 'text-status-pending'}>
            <span aria-hidden="true">{s.online ? '● ' : '○ '}</span>
            {status}
          </span>
        </Button>
        <div className="relative ml-auto" onKeyDown={(e) => e.key === 'Escape' && setMenu(false)}>
          <Button expanded={menu} onClick={() => setMenu(!menu)}>
            <span className="font-mono">{session.staffId}</span>
          </Button>
          {menu && (
            <div className="absolute top-full right-0 z-20 mt-1 flex w-44 flex-col gap-2 rounded-xl border border-border bg-surface p-2 shadow-lg">
              <Button wide onClick={() => (setMenu(false), setLocked(true))}>Lock</Button>
              <Button wide onClick={() => (setMenu(false), engine.signOut())}>Sign out</Button>
            </div>
          )}
        </div>
      </header>
      <div className="min-[900px]:flex">
        <nav aria-label="Screens" className="flex gap-1 overflow-x-auto border-b border-border bg-surface p-2 min-[900px]:sticky min-[900px]:top-14 min-[900px]:h-[calc(100vh-3.5rem)] min-[900px]:w-44 min-[900px]:shrink-0 min-[900px]:flex-col min-[900px]:overflow-visible min-[900px]:border-r min-[900px]:border-b-0">
          {main.map(railButton)}
          {extra.length > 0 && (
            <Button expanded={showMore} onClick={() => setMore(!showMore)}>
              <span aria-hidden="true">⋯ </span>More
            </Button>
          )}
          {showMore && extra.map(railButton)}
        </nav>
        <div className="min-w-0 flex-1">
          <NoticeLine notices={sortNotices(notices)} />
          {tab === 'board' && <BoardScreen engine={engine} bays={branding.bays} isAdmin={session.role === 'admin'} canNote={ALLOWED_ROLES.HANDOFF_NOTE_ADDED.includes(session.role)} onResolve={canResolve ? () => setTab('conflicts') : undefined} />}
          {tab === 'conflicts' && <ConflictsScreen engine={engine} />}
          {tab === 'unplaced' && <UnplacedScreen engine={engine} />}
          {tab === 'changes' && <MyChangesScreen engine={engine} isAdmin={session.role === 'admin'} />}
          {tab === 'recovery' && <RecoveryScreen engine={engine} net={net} isAdmin={session.role === 'admin'} recovering={alerts.some((a) => a.code === 'RECOVERING')} />}
          {tab === 'audit' && <AuditScreen net={net} />}
          {tab === 'admin' && <AdminScreen engine={engine} net={net} onBranding={showBranding} />}
        </div>
      </div>
      <LiveRegion message={announce} />
    </>
  );
```

Delete the now-unused `const tabs: [Tab, string][] = […]` block.

- [ ] **Step 5: Check**

Run: `pnpm typecheck` — expected: errors only for `BoardScreen`'s `bays` prop and `AdminScreen`'s `onBranding` prop (fixed in Tasks 7 and 9). Do Task 7 Step 3's prop change and Task 9 Step 4's prop change now if you want a green typecheck between tasks.

- [ ] **Step 6: Commit with Tasks 7 and 9 (when asked)** — the shell, board and admin prop changes land together so every commit type-checks.

---

### Task 7: Board — counts row, bays and calm tiles

**Files:**
- Modify: `apps/web/src/ui/bedState.ts` (append)
- Modify: `apps/web/src/screens/Board.tsx` (`cardStyle`, `BedCard`, `BoardScreen`)
- Test: `apps/web/test/bed-state.test.ts` (append)
- Modify: `apps/web/e2e/a11y.spec.ts:136-146`

**Interfaces:**
- Consumes: `Bays` type (Task 1).
- Produces: `groupByBay<T extends { id: string }>(beds: T[], bays: Bays | null): { name: string; beds: T[] }[]`; `countLabel(f: Exclude<Filter, 'All'>, n: number): string`; `BoardScreen` props gain `bays: Bays | null`; bed tiles get `id="bed-<bedId>"`.

- [ ] **Step 1: Write the failing tests** — append to `apps/web/test/bed-state.test.ts` (add `countLabel, groupByBay` to its import from `../src/ui/bedState.ts`):

```ts
describe('groupByBay (spec 2026-11-18 §1.2)', () => {
  const beds = ['B01', 'B02', 'B03', 'B04'].map((id) => ({ id }));
  it('shows one group when no bays are set', () => {
    expect(groupByBay(beds, null)).toEqual([{ name: 'All beds', beds }]);
    expect(groupByBay(beds, [])).toEqual([{ name: 'All beds', beds }]);
  });
  it('groups by bay in bay order, ignores unknown beds, and puts the rest under Other beds', () => {
    const bays = [{ name: 'Bay B', beds: ['B03', 'B99'] }, { name: 'Bay A', beds: ['B02', 'B01'] }];
    expect(groupByBay(beds, bays)).toEqual([
      { name: 'Bay B', beds: [{ id: 'B03' }] },
      { name: 'Bay A', beds: [{ id: 'B02' }, { id: 'B01' }] },
      { name: 'Other beds', beds: [{ id: 'B04' }] },
    ]);
  });
  it('drops bays with no beds left after a filter', () => {
    expect(groupByBay([{ id: 'B03' }], [{ name: 'Bay A', beds: ['B01'] }, { name: 'Bay B', beds: ['B03'] }])).toEqual([{ name: 'Bay B', beds: [{ id: 'B03' }] }]);
  });
});

describe('countLabel', () => {
  it('reads like the counts row', () => {
    expect(countLabel('Occupied', 8)).toBe('8 occupied');
    expect(countLabel('Empty', 3)).toBe('3 empty');
    expect(countLabel('Conflict', 1)).toBe('1 conflict');
    expect(countLabel('Conflict', 0)).toBe('0 conflicts');
    expect(countLabel('Pending', 2)).toBe('2 pending');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @wdb/web exec vitest run test/bed-state.test.ts`
Expected: FAIL, `groupByBay` is not exported.

- [ ] **Step 3: Implement** — append to `apps/web/src/ui/bedState.ts` (add `import type { Bays } from '@wdb/shared';` next to the existing import):

```ts
/** Display-only bays (spec 2026-11-18 §1.2): bay order first, beds in no bay last under "Other beds". */
export function groupByBay<T extends { id: string }>(beds: T[], bays: Bays | null): { name: string; beds: T[] }[] {
  if (!bays?.length) return [{ name: 'All beds', beds }];
  const byId = new Map(beds.map((b) => [b.id, b]));
  const placed = new Set<string>();
  const groups = bays.map((bay) => ({
    name: bay.name,
    beds: bay.beds.flatMap((id) => {
      const b = byId.get(id);
      if (!b) return [];
      placed.add(id);
      return [b];
    }),
  }));
  const other = beds.filter((b) => !placed.has(b.id));
  return [...groups.filter((g) => g.beds.length > 0), ...(other.length ? [{ name: 'Other beds', beds: other }] : [])];
}

/** "8 occupied", "1 conflict": the counts row that replaces the filter buttons. */
export const countLabel = (f: Exclude<Filter, 'All'>, n: number): string =>
  f === 'Conflict' ? `${n} ${n === 1 ? 'conflict' : 'conflicts'}` : `${n} ${f.toLowerCase()}`;
```

- [ ] **Step 4: Run them**

Run: `pnpm --filter @wdb/web exec vitest run test/bed-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Board screen** — in `apps/web/src/screens/Board.tsx`:

Imports: `import { looksLikeIdentifier, type Bays, type Board } from '@wdb/shared';` and add `countLabel, groupByBay` to the `bedState` import.

Replace `cardStyle`:

```ts
const cardStyle: Record<CardState['kind'], string> = {
  empty: 'border-2 border-dashed border-border bg-transparent',
  occupied: 'border border-border bg-surface',
  conflict: 'border-2 border-status-conflict bg-status-conflict-bg',
  pendingOut: 'border-2 border-dashed border-status-pending bg-surface',
};
```

In `BedCard`: add `id: string` and `selected: boolean` to the props; on the `<button>` add `id={`bed-${id}`}` and `aria-current={selected ? 'true' : undefined}`; replace its `className` with

```tsx
      className={`flex min-h-24 flex-col items-start gap-1 rounded-xl p-3 text-left ${cardStyle[state.kind]} ${pending && state.kind === 'occupied' ? 'border-2 border-dashed border-status-pending' : ''} ${selected ? 'ring-2 ring-accent ring-offset-2' : ''}`}
```

and the bed label span with `<span className="font-bold text-accent tabular-nums">{label}</span>{' '}`; the patient name span becomes `text-lg font-semibold`.

Replace `BoardScreen`:

```tsx
export function BoardScreen({ engine, bays, isAdmin, canNote, onResolve }: { engine: SyncEngine; bays: Bays | null; isAdmin: boolean; canNote: boolean; onResolve?: (() => void) | undefined }) {
  const s = useEngine(engine);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('All');
  const now = useNow();
  const beds = Object.entries(s.view.beds)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, bed]) => ({ id, label: bed.label, state: cardState(id, s.view, s.confirmed), tasks: taskSummary(s.view, id, now), notes: notesFor(s.view, id).length }));
  const shown = beds.filter((b) => matches(filter, b.state));
  const close = () => {
    const was = open;
    setOpen(null);
    if (was) requestAnimationFrame(() => document.getElementById(`bed-${was}`)?.focus()); // WCAG 2.4.3: back to the tile
  };
  return (
    <main className={`flex flex-col gap-4 p-4 ${open ? 'min-[900px]:pr-[27rem]' : ''}`}>
      <h1 className="sr-only">Beds</h1>
      {beds.length === 0 && <p>{copy.noBeds + (isAdmin ? ' Use Admin → Ward beds.' : '')}</p>}
      {beds.length > 0 && (
        <div role="group" aria-label="Show beds" className="flex flex-wrap gap-2">
          {FILTERS.filter((f) => f !== 'All').map((f) => (
            <Button key={f} pressed={filter === f} variant={filter === f ? 'primary' : 'secondary'} onClick={() => setFilter(filter === f ? 'All' : f)}>
              {countLabel(f, beds.filter((b) => matches(f, b.state)).length)}
            </Button>
          ))}
        </div>
      )}
      {beds.length > 0 && shown.length === 0 && <p role="status">No beds match this filter.</p>}
      {groupByBay(shown, bays).map((g) => (
        <section key={g.name} aria-label={g.name} className="flex flex-col gap-2">
          <h2 className="text-sm font-bold tracking-wider text-text-muted uppercase">{g.name}</h2>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2">
            {g.beds.map((b) => (
              <li key={b.id} className="grid">
                <BedCard id={b.id} selected={open === b.id} label={b.label} state={b.state} tasks={b.tasks} notes={b.notes} onOpen={() => setOpen(b.id)} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {open && <BedSheet key={open} engine={engine} board={s.view} confirmed={s.confirmed} bedId={open} canNote={canNote} onClose={close} onResolve={onResolve} />}
    </main>
  );
}
```

`FILTERS` keeps `'All'` for `matches`; the row shows the four counts, and tapping the pressed one again clears the filter.

- [ ] **Step 6: Update the a11y spec** — `apps/web/e2e/a11y.spec.ts:136-146`: the group is still `Show beds`; button names change from `Empty (2)` / `Conflict (0)` / `Occupied (1)` to `2 empty` / `0 conflicts` / `1 occupied`. Where the test went back to all beds with an `All (…)` button, tap the pressed count again instead:

```ts
  const filters = page.getByRole('group', { name: 'Show beds' });
  await filters.getByRole('button', { name: '2 empty' }).click();
  await expect(filters.getByRole('button', { name: '2 empty' })).toHaveAttribute('aria-pressed', 'true');
```

(apply the same renaming to the `Conflict (0)` → `0 conflicts` and `Occupied (1)` → `1 occupied` lines; keep each assertion's meaning.)

- [ ] **Step 7: Check**

Run: `pnpm --filter @wdb/web test && pnpm typecheck && pnpm lint`
Expected: pass (with Task 6 in place).

---

### Task 8: Bed panel — side panel, Tasks/Notes tabs, closed forms

**Files:**
- Modify: `apps/web/src/screens/Board.tsx` (`BedSheet`, `BedTasks`, `BedNotes`; new `BedExtras`)
- Modify: `apps/web/e2e/tasks.spec.ts:27,59`

**Interfaces:**
- Consumes: `Panel` (Task 5).
- Produces: in the panel, a `Show` group with toggle buttons named `Tasks · N` and `Notes · N`; buttons `Add a task` and `Add a note` open the forms (fields `New task`, `New handoff note`, submit buttons `Add task`, `Add note` unchanged).

- [ ] **Step 1: Update the e2e spec first** — `apps/web/e2e/tasks.spec.ts`:

Before line 27 (`const title = a.getByLabel('New task');`):

```ts
  await a.getByRole('button', { name: 'Add a task' }).click();
```

Before line 59 (`await a.getByLabel('New handoff note').fill(…)`):

```ts
  await a.getByRole('group', { name: 'Show' }).getByRole('button', { name: /^Notes/ }).click();
  await a.getByRole('button', { name: 'Add a note' }).click();
```

Line 79 (`expect(c.getByLabel('New handoff note')).toHaveCount(0)`) stays: a clerk gets neither the form nor the `Add a note` button.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @wdb/web exec playwright test e2e/tasks.spec.ts --project=chromium`
Expected: FAIL, no button `Add a task`.

- [ ] **Step 3: Panel and tabs** — in `apps/web/src/screens/Board.tsx`:

Import `Panel` from `../ui/kit.tsx` (drop `Sheet` if nothing else in the file uses it). In `BedSheet`, replace every `<Sheet title={…} open onClose={p.onClose}>` with `<Panel title={…} onClose={p.onClose}>` and every `</Sheet>` with `</Panel>`, and replace the `extras` constant with:

```tsx
  const extras = <BedExtras engine={p.engine} board={p.board} confirmed={p.confirmed} bedId={p.bedId} canNote={p.canNote} />;
```

In the occupied branch, replace the `mode === 'main'` block's three wide buttons with one row:

```tsx
      {mode === 'main' && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setMode('move')}>Move bed</Button>
          <Button onClick={() => (setLabel(name), setMode('rename'))}>Rename</Button>
          <Button variant="destructive" onClick={() => setMode('discharge')}>
            Discharge
          </Button>
        </div>
      )}
```

Add `BedExtras` above `BedTasks`:

```tsx
/** Tasks and notes as two tabs with counts (spec 2026-11-18 §1.3). */
function BedExtras(p: { engine: SyncEngine; board: Board; confirmed: Board; bedId: string; canNote: boolean }) {
  const [show, setShow] = useState<'tasks' | 'notes'>('tasks');
  const tasks = Object.values(p.board.tasks ?? {}).filter((t) => t.bedId === p.bedId && t.status === 'open').length;
  const notes = notesFor(p.board, p.bedId).length;
  return (
    <>
      <div role="group" aria-label="Show" className="flex gap-1 rounded-xl bg-surface-raised p-1">
        <Button pressed={show === 'tasks'} variant={show === 'tasks' ? 'primary' : 'secondary'} onClick={() => setShow('tasks')}>
          {`Tasks · ${tasks}`}
        </Button>
        <Button pressed={show === 'notes'} variant={show === 'notes' ? 'primary' : 'secondary'} onClick={() => setShow('notes')}>
          {`Notes · ${notes}`}
        </Button>
      </div>
      {show === 'tasks' ? <BedTasks engine={p.engine} board={p.board} confirmed={p.confirmed} bedId={p.bedId} /> : <BedNotes engine={p.engine} board={p.board} confirmed={p.confirmed} bedId={p.bedId} canNote={p.canNote} />}
    </>
  );
}
```

- [ ] **Step 4: Closed forms** — in `BedTasks`, add `const [adding, setAdding] = useState(false);`, remove `border-t-2 border-border pt-4` from the `<section>` class, and wrap the `<form>`:

```tsx
      {adding ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const payload = { bedId: p.bedId, title: t, ...(assignee ? { assignee } : {}), ...(due ? { dueAt: dueAtFrom(due) } : {}) };
            if (await run(() => p.engine.record('TASK_CREATED', payload))) {
              setTitle('');
              setDue('');
              setAssignee('');
              setAdding(false);
            }
          }}
        >
          <Field label="New task" value={title} onChange={setTitle} maxLength={60} hint={copy.noClinical} error={titleError ?? error} autoFocus />
          <div className="flex flex-wrap gap-3">
            <Field label="Due at (optional)" type="time" value={due} onChange={setDue} />
            <Field label="For staff ID (optional)" value={assignee} onChange={(v) => setAssignee(v.toUpperCase().slice(0, 6))} error={assigneeOk ? undefined : 'Use a staff ID like S-0002'} />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={!t || !!titleError || !assigneeOk}>
              Add task
            </Button>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <Button onClick={() => setAdding(true)}>
          <span aria-hidden="true">+ </span>Add a task
        </Button>
      )}
```

In `BedNotes`, the same pattern: `const [adding, setAdding] = useState(false);`, remove `border-t-2 border-border pt-4`, and replace `{p.canNote && (<form …>)}` with:

```tsx
      {p.canNote &&
        (adding ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                setError(undefined);
                await p.engine.record('HANDOFF_NOTE_ADDED', { bedId: p.bedId, text: t });
                setText('');
                setAdding(false);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            <Field label="New handoff note" value={text} onChange={setText} maxLength={140} hint={copy.noClinical} error={textError ?? error} autoFocus />
            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={!t || !!textError}>
                Add note
              </Button>
              <Button onClick={() => setAdding(false)}>Cancel</Button>
            </div>
          </form>
        ) : (
          <Button onClick={() => setAdding(true)}>
            <span aria-hidden="true">+ </span>Add a note
          </Button>
        ))}
```

- [ ] **Step 5: Check**

Run: `pnpm --filter @wdb/web exec playwright test e2e/tasks.spec.ts e2e/conflicts.spec.ts e2e/smoke.spec.ts --project=chromium`
Expected: PASS. If a spec looks for the bed with `getByRole('dialog')`, it still works: the panel is a (non-modal) dialog named by the bed title.
Then: `pnpm typecheck && pnpm lint`.

---

### Task 9: Admin → Hospital

**Files:**
- Create: `apps/web/src/ui/logoColor.ts`
- Test: `apps/web/test/logo-color.test.ts`
- Modify: `apps/web/src/screens/Admin.tsx` (new `HospitalSettings`; `AdminScreen` props)

**Interfaces:**
- Consumes: `request()` with a Blob (Task 4); `Branding`, `Bays`, `contrastOnWhite`, `darkenToContrast`, `MIN_CONTRAST` (Task 1); the branding routes (Task 3).
- Produces: `dominantColor(rgba: Uint8ClampedArray): string | null`; `colourFromFile(file: Blob): Promise<string | null>`; `AdminScreen({ engine, net, onBranding }: { engine: SyncEngine; net: Net; onBranding: (b: Branding) => void })`.

- [ ] **Step 1: Write the failing test** — `apps/web/test/logo-color.test.ts`

```ts
// FR-16: the board picks the hospital's colour from its logo, ignoring white, black and grey.
import { describe, expect, it } from 'vitest';
import { dominantColor } from '../src/ui/logoColor.ts';

const pixels = (...runs: [number, [number, number, number, number]][]) =>
  new Uint8ClampedArray(runs.flatMap(([n, px]) => Array.from({ length: n }, () => px).flat()));

describe('dominantColor', () => {
  it('finds the main strong colour and skips white, black, grey and see-through pixels', () => {
    const logo = pixels([500, [255, 255, 255, 255]], [300, [0, 0, 0, 255]], [200, [128, 128, 128, 255]], [400, [255, 0, 0, 0]], [120, [20, 90, 200, 255]], [40, [200, 30, 30, 255]]);
    expect(dominantColor(logo)).toBe('#145ac8');
  });
  it('gives null for a logo with no strong colour', () => {
    expect(dominantColor(pixels([10, [255, 255, 255, 255]], [10, [40, 40, 40, 255]]))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @wdb/web exec vitest run test/logo-color.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** — `apps/web/src/ui/logoColor.ts`

```ts
// Picks the hospital's colour from its logo, on this tablet only (spec 2026-11-18 §1.4, FR-16). No internet.

/** Most common strong colour in RGBA pixels, averaged within its bucket; null when there is none. */
export function dominantColor(rgba: Uint8ClampedArray): string | null {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const r = rgba[i] ?? 0;
    const g = rgba[i + 1] ?? 0;
    const b = rgba[i + 2] ?? 0;
    const a = rgba[i + 3] ?? 0;
    const hi = Math.max(r, g, b);
    const lo = Math.min(r, g, b);
    if (a < 128 || lo > 230 || hi < 25 || hi - lo < 30) continue; // see-through, near white, near black, grey
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const s = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    buckets.set(key, { n: s.n + 1, r: s.r + r, g: s.g + g, b: s.b + b });
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const s of buckets.values()) if (!best || s.n > best.n) best = s;
  if (!best) return null;
  const n = best.n;
  return `#${[best.r, best.g, best.b].map((c) => Math.round(c / n).toString(16).padStart(2, '0')).join('')}`;
}

/** Draws the logo small and reads its pixels. Browser only (createImageBitmap, OffscreenCanvas). */
export async function colourFromFile(file: Blob): Promise<string | null> {
  const bmp = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(64, 64);
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.drawImage(bmp, 0, 0, 64, 64);
  return dominantColor(g.getImageData(0, 0, 64, 64).data);
}
```

- [ ] **Step 4: Run it**

Run: `pnpm --filter @wdb/web exec vitest run test/logo-color.test.ts`
Expected: PASS.

- [ ] **Step 5: Hospital section** — in `apps/web/src/screens/Admin.tsx`:

Imports: `import { contrastOnWhite, darkenToContrast, MIN_CONTRAST, type Bays, type Branding, type Role } from '@wdb/shared';` (replacing the `Role` import) and `import { colourFromFile } from '../ui/logoColor.ts';`.

Add the component above `AdminScreen`:

```tsx
/** FR-16: hospital name, logo, colour (picked from the logo, adjustable) and display-only bays. */
function HospitalSettings({ engine, net, onSaved }: { engine: SyncEngine; net: Net; onSaved: (b: Branding) => void }) {
  const s = useEngine(engine);
  const { data, error } = useOnline<Branding>(net, '/api/v1/branding');
  const [name, setName] = useState('');
  const [accent, setAccent] = useState('#0e7490');
  const [bays, setBays] = useState<Bays>([]);
  const [msg, setMsg] = useState<string>();
  const fileId = useId();
  useEffect(() => {
    if (!data) return;
    setName(data.hospitalName ?? '');
    setAccent(data.accent ?? '#0e7490');
    setBays(data.bays ?? []);
  }, [data]);
  if (error) return <p>{error}</p>;
  const tooLight = contrastOnWhite(accent) < MIN_CONTRAST;
  const beds = Object.entries(s.confirmed.beds).sort(([a], [b]) => a.localeCompare(b));
  const setBay = (i: number, bay: Bays[number]) => setBays(bays.map((b, j) => (j === i ? bay : b)));
  const save = async () => {
    const kept = bays.filter((b) => b.name.trim() && b.beds.length > 0).map((b) => ({ ...b, name: b.name.trim() }));
    try {
      const b = (await (await request(net, 'PUT', '/api/v1/admin/branding', { hospitalName: name.trim() || null, accent, bays: kept.length ? kept : null })).json()) as Branding;
      onSaved(b);
      setMsg('Saved. Every tablet shows it after its next sync.');
    } catch (e) {
      setMsg(errText(e));
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <Field label="Hospital name" value={name} onChange={setName} maxLength={60} />
      <div className="flex flex-col gap-1">
        <label htmlFor={fileId} className="font-semibold">
          Hospital logo
        </label>
        <p className="text-text-muted">A PNG or JPEG file from your hospital, up to 200 KB. The board picks its colour from it.</p>
        <input
          id={fileId}
          type="file"
          accept="image/png,image/jpeg"
          className="min-h-12"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              onSaved((await (await request(net, 'PUT', '/api/v1/admin/branding/logo', f)).json()) as Branding);
              const picked = await colourFromFile(f).catch(() => null);
              if (picked) setAccent(darkenToContrast(picked));
              setMsg('Logo saved. Check the colour below, then save.');
            } catch (err) {
              setMsg(errText(err));
            }
          }}
        />
        {data?.logo && <img src={data.logo} alt="Current hospital logo" className="h-12 w-auto self-start" />}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-3 font-semibold">
          Hospital colour
          <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} className="h-12 w-16" />
        </label>
        {tooLight && (
          <>
            <span role="alert" className="font-semibold text-status-error">
              Too light to read on white.
            </span>
            <Button onClick={() => setAccent(darkenToContrast(accent))}>Make it darker</Button>
          </>
        )}
      </div>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 font-semibold">Bays (for the ward map; does not change any patient record)</legend>
        {bays.map((bay, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-xl border border-border p-3">
            <Field label={`Bay ${i + 1} name`} value={bay.name} maxLength={30} onChange={(v) => setBay(i, { ...bay, name: v })} />
            <div role="group" aria-label={`Beds in bay ${i + 1}`} className="flex flex-wrap gap-2">
              {beds.map(([id, bed]) => (
                <label key={id} className="flex min-h-12 items-center gap-2 rounded-lg border border-border px-3">
                  <input
                    type="checkbox"
                    checked={bay.beds.includes(id)}
                    disabled={bays.some((b, j) => j !== i && b.beds.includes(id))}
                    onChange={(e) => setBay(i, { ...bay, beds: e.target.checked ? [...bay.beds, id] : bay.beds.filter((x) => x !== id) })}
                  />
                  {bed.label}
                </label>
              ))}
            </div>
            <Button onClick={() => setBays(bays.filter((_, j) => j !== i))}>Remove bay {i + 1}</Button>
          </div>
        ))}
        <Button onClick={() => setBays([...bays, { name: `Bay ${String.fromCharCode(65 + bays.length)}`, beds: [] }])}>Add a bay</Button>
      </fieldset>
      <Button variant="primary" disabled={tooLight} onClick={save}>
        Save hospital settings
      </Button>
      {msg && <p role="status">{msg}</p>}
    </div>
  );
}
```

Change `AdminScreen` to take and pass `onBranding`, with the section first:

```tsx
export function AdminScreen({ engine, net, onBranding }: { engine: SyncEngine; net: Net; onBranding: (b: Branding) => void }) {
  return (
    <main className="flex flex-col gap-4 p-4">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <Section title="Hospital">
        <HospitalSettings engine={engine} net={net} onSaved={onBranding} />
      </Section>
```

(the existing sections follow unchanged). Also restyle `Section`'s class to `rounded-xl border border-border bg-surface p-4` to match the calm look.

- [ ] **Step 6: Check**

Run: `pnpm --filter @wdb/web test && pnpm typecheck && pnpm lint && pnpm check:synthetic`
Expected: all pass.

- [ ] **Step 7: Commit Tasks 6–9 together (when asked)**

```bash
git add apps/web/src apps/web/test apps/web/e2e
git commit -m "feat(web): calm ward map by bay, one status pill and notice line, bed side panel, Admin → Hospital (FR-16, FR-15, NFR-A11y)"
```

---

### Task 10: Docs, screenshots and the full check

**Files:**
- Modify: `prd.md` (FR list), `security.md` (§4.7 or §4.2), `design.md` (§5.2 route table, §10.1, §10.4, §10.7), `TASKS.md`, `README.md`, `docs/screenshots/*.png`

- [ ] **Step 1: prd.md** — add after FR-15 (approved by the user 2026-11-18):

```markdown
- FR-16: Hospital branding. An admin sets the hospital name, uploads the hospital's logo (PNG or JPEG) and confirms the accent colour, which the board picks from the logo and keeps readable (4.5:1 on white). An admin can group beds into bays for the ward map. Branding and bays are display only: they never enter the event log. Works with no internet.
```

- [ ] **Step 2: security.md** — add after SEC-31:

```markdown
- SEC-32: Logo uploads are admin only, at most 200 KB and 1024 × 1024 px, and accepted only when the file's own bytes are a PNG or JPEG (never SVG). The logo is served as a `data:` URL, so the CSP is unchanged. Every branding change is audited (`BRANDING_CHANGED`).
```

- [ ] **Step 3: design.md** — add the three routes to the §5.2 table (`GET /api/v1/branding` no session; `PUT /api/v1/admin/branding` admin; `PUT /api/v1/admin/branding/logo` admin, raw image body); in §10.1 replace the tab list with the side rail (Board, Unplaced, My changes, Conflicts for charge/admin, More → Recovery, Audit, Admin), the status pill, the staff menu and the one notice line with its ranking; in §10.4 describe tiles (dashed = empty or pending, red outline + tint = conflict, ring = open bed) and the side panel / bottom sheet below 900 px; in §10.7 replace the colour table with the Clinical calm tokens from `tokens.css` and the accent rule. Add `ward_settings` to the §4.4 table list.

- [ ] **Step 4: TASKS.md** — add a done entry: "Board redesign and hospital branding (FR-16, SEC-32), spec 2026-11-18 Part 1."

- [ ] **Step 5: Full check**

Run, in order:

```bash
docker compose up -d db-test
pnpm test
pnpm lint
pnpm typecheck
pnpm check:synthetic
pnpm e2e
```

Expected: all pass. For any e2e failure, read the failing locator: a renamed control follows the names in Tasks 6–8 (status `· all sent`, `staffMenu()`, `More`, counts like `2 empty`, `Add a task`, `Add a note`, `Notes · N`). A notice the test expects may now sit behind `+N more notices`: click that button first.

- [ ] **Step 6: Screenshots**

Run: `WDB_SCREENSHOTS=1 pnpm e2e --project=chromium e2e/screenshots.spec.ts`
Expected: `docs/screenshots/*.png` updated; look at each one before keeping it. Update `README.md` captions if a screenshot's content changed.

- [ ] **Step 7: Commit (when asked)**

```bash
git add prd.md security.md design.md TASKS.md README.md docs/screenshots
git commit -m "docs: hospital branding and the calm board (FR-16, SEC-32)"
```

---

## Not in this plan (by design)

- Removing a logo once uploaded (replace it with another file instead).
- Showing branding on the sign-in screen (it shows on every screen after sign-in).
- A dark theme (the "Night shift" option was not chosen).
- Parts 2 and 3 of the spec (guided tablet setup, charge-nurse approval, hosted demo): separate plans.
