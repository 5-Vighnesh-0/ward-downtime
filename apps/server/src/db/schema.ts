// Postgres schema, design.md §4.4 (approved 2026-11-11). Grants, triggers and the genesis
// log_head row live in the custom migration next to the generated one.
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  customType,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// shortcut: drizzle-orm 0.45 has no native bytea column; switch to it when upgrading.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const staffRole = pgEnum('staff_role', ['clerk', 'nurse', 'charge', 'admin']);
export const deviceStatus = pgEnum('device_status', ['pending', 'active', 'revoked']);

export const staff = pgTable(
  'staff',
  {
    staffId: text('staff_id').primaryKey(),
    displayName: text('display_name').notNull(),
    role: staffRole('role').notNull(),
    pinHash: bytea('pin_hash').notNull(),
    pinSalt: bytea('pin_salt').notNull(),
    status: text('status').notNull(),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: tstz('locked_until'),
  },
  (t) => [
    check('staff_id_format', sql`${t.staffId} ~ '^S-[0-9]{4}$'`),
    check('staff_status', sql`${t.status} IN ('active', 'disabled')`),
  ],
);

export const devices = pgTable(
  'devices',
  {
    deviceId: uuid('device_id').primaryKey(),
    publicKey: bytea('public_key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    tempPrefix: text('temp_prefix').unique(),
    label: text('label').notNull(),
    status: deviceStatus('status').notNull().default('pending'),
    lastDeviceSeq: integer('last_device_seq').notNull().default(0),
    lastClockOffsetMs: integer('last_clock_offset_ms'),
    enrolledAt: tstz('enrolled_at').notNull().defaultNow(),
    approvedBy: text('approved_by').references(() => staff.staffId),
    approvedAt: tstz('approved_at'),
    revokedAt: tstz('revoked_at'),
    lastSeenAt: tstz('last_seen_at'),
  },
  (t) => [check('public_key_length', sql`octet_length(${t.publicKey}) = 32`)],
);

export const events = pgTable(
  'events',
  {
    serverSeq: bigint('server_seq', { mode: 'number' }).primaryKey(),
    eventId: uuid('event_id').notNull().unique(),
    deviceId: uuid('device_id').notNull().references(() => devices.deviceId),
    deviceSeq: integer('device_seq').notNull(),
    staffId: text('staff_id').notNull().references(() => staff.staffId),
    type: text('type').notNull(),
    body: jsonb('body').notNull(),
    bodySha256: bytea('body_sha256').notNull(),
    clientTime: tstz('client_time').notNull(), // display/audit only (SEC-12)
    serverTime: tstz('server_time').notNull().defaultNow(),
    prevHash: bytea('prev_hash').notNull(),
    hash: bytea('hash').notNull().unique(),
  },
  (t) => [unique('events_device_seq').on(t.deviceId, t.deviceSeq), check('body_size', sql`octet_length(${t.body}::text) <= 4096`)],
);

export const logHead = pgTable(
  'log_head',
  {
    id: smallint('id').primaryKey(),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull(),
    lastHash: bytea('last_hash').notNull(),
  },
  (t) => [check('log_head_singleton', sql`${t.id} = 1`)],
);

export const sessions = pgTable('sessions', {
  tokenHash: bytea('token_hash').primaryKey(),
  staffId: text('staff_id').notNull().references(() => staff.staffId),
  deviceId: uuid('device_id').notNull().references(() => devices.deviceId),
  createdAt: tstz('created_at').notNull().defaultNow(),
  lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
  expiresAt: tstz('expires_at').notNull(),
  revokedAt: tstz('revoked_at'),
});

export const auditLog = pgTable('audit_log', {
  auditId: bigserial('audit_id', { mode: 'number' }).primaryKey(),
  serverTime: tstz('server_time').notNull().defaultNow(),
  staffId: text('staff_id'),
  deviceId: uuid('device_id'),
  action: text('action').notNull(),
  eventId: uuid('event_id'),
  outcome: text('outcome').notNull(),
  code: text('code'),
  requestId: text('request_id').notNull(),
});
