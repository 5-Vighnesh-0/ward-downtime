// HTTP API, design.md §5.2. Errors always use {"error": {"code", "message", "details?"}}.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Role } from '@wdb/shared';
import { addStaffMember, AdminError, approveDevice, revokeDevice, updateStaffMember } from './admin.ts';
import { appendBatch } from './append.ts';
import { checkPin, fingerprint, newToken, parseDeviceSig, tokenHash, verifyDeviceSig } from './auth.ts';
import { auditLog, devices, logHead, sessions, staff } from './db/schema.ts';
import type { Db } from './db.ts';
import { readEntries } from './entries.ts';
import { createAuditExport, createRecoveryExport, type ExportFile } from './recovery.ts';
import { publicKeyFromRaw } from './signature.ts';
import { createMonitor, SKEW_ALERT_MS } from './monitor.ts';
import { createStreams } from './stream.ts';

export interface AppOptions {
  origin: string; // e.g. https://wdb.ward-a.hospital.internal (CSRF Origin check)
  maxInflightPushes?: number;
  streamBacklog?: number;
  streamPingMs?: number;
  ward?: string | null; // shown in recovery exports (WDB_WARD_NAME)
  log?: { level: string; stream?: NodeJS.WritableStream }; // JSON logs (design.md §13.1); off when absent
  proxyHops?: number; // 1 behind Caddy, so rate limits see the tablet's address, not Caddy's
}

// Never logged (design.md §13.1). Bodies are never logged at all; these guard anything passed to the logger.
export const LOG_REDACT = ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-wdb-device-sig"]', 'res.headers["set-cookie"]', '*.pin', '*.label', '*.payload'];

interface Auth {
  staffId: string;
  role: Role;
  deviceId: string;
  tokenHash: Buffer;
}
declare module 'fastify' {
  interface FastifyRequest {
    auth?: Auth;
  }
}

const SESSION_MS = 12 * 60 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_PIN_FAILURES = 5;
const MAX_DEVICE_FAILURES = 20; // per device per 15 minutes

const printable = /^[^\u0000-\u001f\u007f]+$/;
const Batch = z.strictObject({ deviceId: z.uuid(), events: z.array(z.unknown()).min(1).max(100) });
const PullQuery = z.strictObject({
  after: z.coerce.number().pipe(z.int().min(0)).default(0),
  limit: z.coerce.number().pipe(z.int().min(1).max(1000)).default(500),
});
const Enroll = z.strictObject({
  deviceId: z.uuid(),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/), // 32 bytes, base64url
  label: z.string().min(1).max(40).regex(printable),
});
const SignIn = z.strictObject({ staffId: z.string().regex(/^S-[0-9]{4}$/), pin: z.string().regex(/^[0-9]{6,8}$/) });
const IdParam = z.strictObject({ id: z.uuid() });
const staffId = z.string().regex(/^S-[0-9]{4}$/);
const role = z.enum(['clerk', 'nurse', 'charge', 'admin']);
const pin = z.string().regex(/^[0-9]{6,8}$/);
const displayName = z.string().min(1).max(40).regex(printable);
const NewStaff = z.strictObject({ staffId, displayName, role, pin });
const StaffPatch = z.strictObject({ role: role.optional(), status: z.enum(['active', 'disabled']).optional(), displayName: displayName.optional(), pin: pin.optional() });
const passphrase = z.string().min(12).max(256);
const ExportBody = z.union([z.strictObject({ passphrase }), z.strictObject({ plaintext: z.literal(true) })]);
const Import = z.strictObject({ deviceId: z.uuid(), events: z.array(z.unknown()).min(1).max(100) });
const AuditQuery = z.strictObject({
  before: z.coerce.number().pipe(z.int().min(1)).optional(),
  limit: z.coerce.number().pipe(z.int().min(1).max(500)).default(100),
  staffId: staffId.optional(),
  deviceId: z.uuid().optional(),
  action: z.string().regex(/^[A-Z_]{1,32}$/).optional(),
});

const error = (code: string, message: string, details?: unknown) => ({ error: { code, message, ...(details ? { details } : {}) } });

export function buildApp(db: Db, opts: AppOptions): FastifyInstance {
  const app = Fastify({
    bodyLimit: 262_144, // SEC-23
    logger: opts.log ? { level: opts.log.level, redact: { paths: LOG_REDACT, censor: '[REDACTED]' }, ...(opts.log.stream ? { stream: opts.log.stream } : {}) } : false,
    requestIdLogLabel: 'requestId',
    trustProxy: (_address: string, hop: number) => hop < (opts.proxyHops ?? 0),
    genReqId: () => randomUUID(),
    requestIdHeader: false,
  });
  const monitor = createMonitor(db, app.log);
  const bus = new EventEmitter().setMaxListeners(100);
  const streams = createStreams(db, bus, { backlog: opts.streamBacklog ?? 1000, pingMs: opts.streamPingMs ?? 20_000 });
  const maxInflight = opts.maxInflightPushes ?? 500;
  let inflight = 0;

  const deny = (reply: FastifyReply, status: number, code: string, message: string) => reply.code(status).send(error(code, message));
  const audit = (req: FastifyRequest, row: Omit<typeof auditLog.$inferInsert, 'requestId'>) =>
    db.insert(auditLog).values({ ...row, requestId: req.id });

  app.setErrorHandler((err: { statusCode?: number }, _req, reply) => {
    if (err.statusCode === 413) return deny(reply, 413, 'PAYLOAD_TOO_LARGE', 'Request body over 256 KiB');
    if (err.statusCode === 429) return deny(reply, 429, 'RATE_LIMITED', 'Too many requests');
    if (err.statusCode === 400 || err.statusCode === 415) return deny(reply, err.statusCode, 'BAD_REQUEST', 'Malformed request');
    app.log.error(err);
    return deny(reply, 500, 'INTERNAL', 'Internal error'); // never leak internals
  });
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  // SEC-22: SameSite=Strict cookie + required custom header + Origin check on every state change.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const origin = req.headers.origin;
    if (req.headers['x-wdb-request'] !== '1' || (origin !== undefined && origin !== opts.origin)) {
      return deny(reply, 403, 'CSRF_FAILED', 'Missing X-WDB-Request header or foreign Origin');
    }
  });
  app.addHook('preClose', async () => streams.closeAll());

  app.register(cookie);
  app.register(rateLimit, { global: false });

  const requireSession = (roles?: readonly Role[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies.wdb_sid;
    if (!token) return deny(reply, 401, 'NO_SESSION', 'Sign in first');
    const hash = tokenHash(token);
    const [row] = await db
      .select({ s: sessions, role: staff.role, staffStatus: staff.status, deviceStatus: devices.status, offset: devices.lastClockOffsetMs })
      .from(sessions)
      .innerJoin(staff, eq(sessions.staffId, staff.staffId))
      .innerJoin(devices, eq(sessions.deviceId, devices.deviceId))
      .where(eq(sessions.tokenHash, hash));
    if (!row) return deny(reply, 401, 'NO_SESSION', 'Sign in first');
    if (row.deviceStatus === 'revoked') return deny(reply, 403, 'DEVICE_REVOKED', 'Device revoked');
    if (row.deviceStatus !== 'active') return deny(reply, 403, 'DEVICE_NOT_ACTIVE', 'Device not active');
    const now = Date.now();
    if (row.s.revokedAt || row.s.expiresAt.getTime() <= now || row.s.lastSeenAt.getTime() < now - IDLE_MS || row.staffStatus !== 'active') {
      return deny(reply, 401, 'NO_SESSION', 'Session ended');
    }
    if (roles && !roles.includes(row.role)) return deny(reply, 403, 'ROLE_FORBIDDEN', 'Not allowed for this role');
    await db.update(sessions).set({ lastSeenAt: new Date(now) }).where(eq(sessions.tokenHash, hash));
    req.auth = { staffId: row.s.staffId, role: row.role, deviceId: row.s.deviceId, tokenHash: hash };
    // SEC-28: record how far the tablet's clock is off. Display and audit only; ordering never uses it.
    const clientMs = Date.parse(String(req.headers['x-wdb-client-time'] ?? ''));
    const offset = Number.isFinite(clientMs) ? now - clientMs : null;
    if (offset !== null) reply.header('x-wdb-clock-offset-ms', String(offset));
    await db.update(devices).set({ lastSeenAt: new Date(now), ...(offset !== null ? { lastClockOffsetMs: offset } : {}) }).where(eq(devices.deviceId, row.s.deviceId));
    if (offset !== null && Math.abs(offset) > SKEW_ALERT_MS && !(row.offset !== null && Math.abs(row.offset) > SKEW_ALERT_MS)) {
      await audit(req, { staffId: row.s.staffId, deviceId: row.s.deviceId, action: 'CLOCK_SKEW', outcome: 'ok', code: String(offset) });
    }
  };

  /** Device named and signed in X-WDB-Device-Sig, or null. */
  async function signingDevice(req: FastifyRequest) {
    const p = parseDeviceSig(String(req.headers['x-wdb-device-sig'] ?? ''));
    if (!p) return null;
    const [dev] = await db.select().from(devices).where(eq(devices.deviceId, p.deviceId));
    if (!dev) return null;
    const path = req.url.split('?')[0] ?? '';
    return verifyDeviceSig(p, req.method, path, publicKeyFromRaw(dev.publicKey), Math.floor(Date.now() / 1000)) ? dev : null;
  }

  app.register(async (api) => {
    const byDevice = (req: FastifyRequest) => req.auth?.deviceId ?? req.ip;

    // --- Enrollment (SEC-4) ---
    api.post('/api/v1/devices', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
      const b = Enroll.safeParse(req.body);
      if (!b.success) return reply.code(422).send(error('VALIDATION_FAILED', 'Invalid enrollment', z.flattenError(b.error)));
      const publicKey = Buffer.from(b.data.publicKey, 'base64url');
      const fp = fingerprint(publicKey);
      const [row] = await db
        .insert(devices)
        .values({ deviceId: b.data.deviceId, publicKey, fingerprint: fp, label: b.data.label })
        .onConflictDoNothing()
        .returning({ id: devices.deviceId });
      if (!row) return deny(reply, 409, 'DEVICE_EXISTS', 'Device already enrolled');
      await audit(req, { deviceId: b.data.deviceId, action: 'DEVICE_ENROLL', outcome: 'ok' });
      return reply.code(202).send({ status: 'pending', fingerprint: fp });
    });

    api.get('/api/v1/devices/:id/status', async (req, reply) => {
      const p = IdParam.safeParse(req.params);
      const dev = p.success ? await signingDevice(req) : null;
      if (!dev || !p.success || dev.deviceId !== p.data.id) return deny(reply, 401, 'DEVICE_SIG_INVALID', 'Bad device signature');
      return { status: dev.status, tempPrefix: dev.tempPrefix };
    });

    // --- Staff sessions (SEC-5, SEC-7) ---
    api.post('/api/v1/sessions', async (req, reply) => {
      const b = SignIn.safeParse(req.body);
      if (!b.success) return reply.code(422).send(error('VALIDATION_FAILED', 'Invalid sign-in', z.flattenError(b.error)));
      const dev = await signingDevice(req);
      if (!dev) return deny(reply, 401, 'DEVICE_SIG_INVALID', 'Bad device signature');
      if (dev.status === 'revoked') return deny(reply, 403, 'DEVICE_REVOKED', 'Device revoked');
      if (dev.status !== 'active') return deny(reply, 403, 'DEVICE_NOT_ACTIVE', 'Device not active');

      const [{ n } = { n: 0 }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(and(eq(auditLog.deviceId, dev.deviceId), eq(auditLog.action, 'SIGNIN_FAIL'), gt(auditLog.serverTime, new Date(Date.now() - LOCK_MS))));
      if (n >= MAX_DEVICE_FAILURES) return deny(reply, 429, 'SIGNIN_PAUSED', 'Too many failed sign-ins on this device');

      const { staffId, pin } = b.data;
      const fail = async (code: string, status = 401) => {
        req.log.warn({ event: 'signin_fail', staffId, deviceId: dev.deviceId, code });
        await audit(req, { staffId, deviceId: dev.deviceId, action: 'SIGNIN_FAIL', outcome: 'denied', code });
        return deny(reply, status, code, code === 'ACCOUNT_LOCKED' ? 'Account locked for 15 minutes' : 'Staff ID or PIN not recognised');
      };
      const [s] = await db.select().from(staff).where(eq(staff.staffId, staffId));
      if (s?.lockedUntil && s.lockedUntil.getTime() > Date.now()) return fail('ACCOUNT_LOCKED');
      // Hash even for unknown staff, so timing does not reveal which IDs exist.
      const ok = await checkPin(pin, s?.pinHash ?? Buffer.alloc(32), s?.pinSalt ?? Buffer.alloc(16));
      if (!s || s.status !== 'active' || !ok) {
        if (s) {
          const [u] = await db
            .update(staff)
            .set({ failedAttempts: sql`${staff.failedAttempts} + 1` })
            .where(eq(staff.staffId, staffId))
            .returning({ failedAttempts: staff.failedAttempts });
          if ((u?.failedAttempts ?? 0) >= MAX_PIN_FAILURES) {
            await db.update(staff).set({ failedAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_MS) }).where(eq(staff.staffId, staffId));
            await audit(req, { staffId, deviceId: dev.deviceId, action: 'SIGNIN_LOCKED', outcome: 'denied' });
          }
        }
        return fail('SIGNIN_FAILED');
      }

      await db.update(staff).set({ failedAttempts: 0, lockedUntil: null }).where(eq(staff.staffId, staffId));
      const token = newToken();
      const expiresAt = new Date(Date.now() + SESSION_MS);
      await db.insert(sessions).values({ tokenHash: tokenHash(token), staffId, deviceId: dev.deviceId, expiresAt });
      await audit(req, { staffId, deviceId: dev.deviceId, action: 'SIGNIN_OK', outcome: 'ok' });
      reply.setCookie('wdb_sid', token, { httpOnly: true, secure: true, sameSite: 'strict', path: '/api', maxAge: SESSION_MS / 1000 });
      // offlineUntil: how long the device may accept this staff member's PIN offline (SEC-7).
      return reply.code(201).send({ staffId, role: s.role, expiresAt: expiresAt.toISOString(), offlineUntil: expiresAt.toISOString() });
    });

    api.delete('/api/v1/sessions/current', { onRequest: requireSession() }, async (req, reply) => {
      const a = req.auth as Auth;
      await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, a.tokenHash));
      await audit(req, { staffId: a.staffId, deviceId: a.deviceId, action: 'SIGNOUT', outcome: 'ok' });
      return reply.clearCookie('wdb_sid', { path: '/api' }).code(204).send();
    });

    // --- Log (FR-4, FR-5) ---
    api.post(
      '/api/v1/events',
      { onRequest: requireSession(), config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: byDevice, hook: 'preHandler' } } },
      async (req, reply) => {
        if (inflight >= maxInflight) return reply.header('retry-after', '5').code(503).send(error('BACKPRESSURE', 'Server busy, retry shortly'));
        const body = Batch.safeParse(req.body);
        if (!body.success) return reply.code(422).send(error('VALIDATION_FAILED', 'Invalid batch', z.flattenError(body.error)));
        if (body.data.deviceId !== req.auth?.deviceId) return deny(reply, 403, 'DEVICE_MISMATCH', 'Batch is not from the signed-in device');
        inflight++;
        const t0 = performance.now();
        try {
          const out = await appendBatch(db, body.data.deviceId, body.data.events, { requestId: req.id });
          if (!out.ok) return deny(reply, out.status, out.code, out.code === 'DEVICE_REVOKED' ? 'Device revoked' : 'Device not active');
          monitor.recordPush(performance.now() - t0);
          const by = (st: string) => out.results.filter((r) => r.status === st).length;
          req.log.info({ event: 'push_batch', deviceId: body.data.deviceId, staffId: req.auth?.staffId, count: out.results.length, appended: by('appended'), duplicate: by('duplicate'), refused: by('refused') });
          for (const r of out.results) if (r.status === 'refused') req.log.warn({ event: 'event_refused', code: r.code, eventId: r.eventId, deviceId: body.data.deviceId });
          if (out.results.some((r) => r.status === 'appended')) bus.emit('appended');
          return { headSeq: out.headSeq, headHash: out.headHash, results: out.results };
        } finally {
          inflight--;
        }
      },
    );

    api.get(
      '/api/v1/events',
      { onRequest: requireSession(), config: { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: byDevice, hook: 'preHandler' } } },
      async (req, reply) => {
        const q = PullQuery.safeParse(req.query);
        if (!q.success) return reply.code(422).send(error('VALIDATION_FAILED', 'Invalid query', z.flattenError(q.error)));
        const [head] = await db.select({ lastSeq: logHead.lastSeq }).from(logHead).where(eq(logHead.id, 1));
        // disabledStaff: devices drop these staff members' offline sign-in (design.md §9.2.3).
        const disabled = await db.select({ id: staff.staffId }).from(staff).where(eq(staff.status, 'disabled')).orderBy(staff.staffId);
        return { headSeq: head?.lastSeq ?? 0, entries: await readEntries(db, q.data.after, q.data.limit), disabledStaff: disabled.map((r) => r.id) };
      },
    );

    api.get('/api/v1/stream', { onRequest: requireSession() }, async (req, reply) => {
      streams.handle(req, reply, (req.auth as Auth).deviceId);
    });

    // --- Admin (SEC-6, SEC-8) ---
    const admin = requireSession(['admin']);
    api.get('/api/v1/admin/devices', { onRequest: admin }, async () => ({
      devices: await db
        .select({
          deviceId: devices.deviceId,
          label: devices.label,
          status: devices.status,
          fingerprint: devices.fingerprint,
          tempPrefix: devices.tempPrefix,
          enrolledAt: devices.enrolledAt,
          lastSeenAt: devices.lastSeenAt,
        })
        .from(devices)
        .orderBy(desc(devices.enrolledAt)),
    }));

    api.post('/api/v1/admin/devices/:id/approve', { onRequest: admin }, async (req, reply) => {
      const p = IdParam.safeParse(req.params);
      if (!p.success) return deny(reply, 404, 'NOT_FOUND', 'Device not found');
      try {
        const tempPrefix = await approveDevice(db, p.data.id, req.auth?.staffId ?? null);
        await audit(req, { staffId: req.auth?.staffId ?? null, deviceId: p.data.id, action: 'DEVICE_APPROVE', outcome: 'ok' });
        return { status: 'active', tempPrefix };
      } catch (e) {
        if (e instanceof AdminError) return deny(reply, e.code === 'NOT_FOUND' ? 404 : 409, e.code, e.message);
        throw e;
      }
    });

    api.post('/api/v1/admin/devices/:id/revoke', { onRequest: admin }, async (req, reply) => {
      const p = IdParam.safeParse(req.params);
      if (!p.success) return deny(reply, 404, 'NOT_FOUND', 'Device not found');
      try {
        await revokeDevice(db, p.data.id);
      } catch (e) {
        if (e instanceof AdminError) return deny(reply, 404, e.code, e.message);
        throw e;
      }
      streams.close(p.data.id);
      await audit(req, { staffId: req.auth?.staffId ?? null, deviceId: p.data.id, action: 'DEVICE_REVOKE', outcome: 'ok' });
      return { status: 'revoked' };
    });

    api.get('/api/v1/admin/staff', { onRequest: admin }, async () => ({
      staff: await db
        .select({ staffId: staff.staffId, displayName: staff.displayName, role: staff.role, status: staff.status, lockedUntil: staff.lockedUntil })
        .from(staff)
        .orderBy(staff.staffId),
    }));

    api.post('/api/v1/admin/staff', { onRequest: admin }, async (req, reply) => {
      const b = NewStaff.safeParse(req.body);
      if (!b.success) return reply.code(422).send(error('VALIDATION_FAILED', 'Invalid staff member', z.flattenError(b.error)));
      try {
        await addStaffMember(db, b.data);
      } catch (e) {
        if ((e as { cause?: { code?: string } }).cause?.code === '23505') return deny(reply, 409, 'STAFF_EXISTS', 'Staff ID already in use');
        throw e;
      }
      // shortcut: audit_log has no target column, so `code` holds the target staff ID; add one with the next approved schema change.
      await audit(req, { staffId: req.auth?.staffId ?? null, deviceId: req.auth?.deviceId ?? null, action: 'STAFF_CREATE', outcome: 'ok', code: b.data.staffId });
      return reply.code(201).send({ staffId: b.data.staffId, displayName: b.data.displayName, role: b.data.role, status: 'active' });
    });

    api.patch('/api/v1/admin/staff/:id', { onRequest: admin }, async (req, reply) => {
      const id = staffId.safeParse((req.params as { id?: string }).id);
      const b = StaffPatch.safeParse(req.body);
      if (!id.success) return deny(reply, 404, 'NOT_FOUND', 'Staff member not found');
      if (!b.success) return reply.code(422).send(error('VALIDATION_FAILED', 'Invalid update', z.flattenError(b.error)));
      try {
        const row = await updateStaffMember(db, id.data, Object.fromEntries(Object.entries(b.data).filter(([, v]) => v !== undefined)));
        await audit(req, { staffId: req.auth?.staffId ?? null, deviceId: req.auth?.deviceId ?? null, action: 'STAFF_UPDATE', outcome: 'ok', code: id.data });
        return row;
      } catch (e) {
        if (e instanceof AdminError) return deny(reply, 404, e.code, e.message);
        throw e;
      }
    });

    // --- Recovery export (FR-11, SEC-15) and audit export (FR-14). The passphrase is never stored or logged. ---
    const download = (reply: FastifyReply, f: ExportFile) =>
      reply.header('content-type', 'application/octet-stream').header('content-disposition', `attachment; filename="${f.filename}"`).header('cache-control', 'no-store').send(f.body);
    const exportLimit = { rateLimit: { max: 6, timeWindow: '1 minute', keyGenerator: byDevice, hook: 'preHandler' as const } };

    api.post('/api/v1/exports', { onRequest: requireSession(['charge', 'admin']), config: exportLimit }, async (req, reply) => {
      const b = ExportBody.safeParse(req.body);
      if (!b.success) return reply.code(422).send(error('VALIDATION_FAILED', 'A passphrase of at least 12 characters is required', z.flattenError(b.error)));
      const auth = req.auth as Auth;
      const plaintext = 'plaintext' in b.data;
      if (plaintext && auth.role !== 'admin') return deny(reply, 403, 'ROLE_FORBIDDEN', 'Only an admin can create unencrypted files');
      const f = await createRecoveryExport(db, { staffId: auth.staffId, passphrase: 'passphrase' in b.data ? b.data.passphrase : null, ward: opts.ward ?? null });
      await audit(req, { staffId: auth.staffId, deviceId: auth.deviceId, action: plaintext ? 'EXPORT_PLAINTEXT' : 'EXPORT_CREATE', outcome: 'ok', code: f.sha256 });
      return download(reply, f);
    });

    api.post('/api/v1/audit/export', { onRequest: requireSession(['charge', 'admin']), config: exportLimit }, async (req, reply) => {
      const b = z.strictObject({ passphrase }).safeParse(req.body);
      if (!b.success) return reply.code(422).send(error('VALIDATION_FAILED', 'A passphrase of at least 12 characters is required', z.flattenError(b.error)));
      const auth = req.auth as Auth;
      const f = await createAuditExport(db, b.data.passphrase);
      await audit(req, { staffId: auth.staffId, deviceId: auth.deviceId, action: 'AUDIT_EXPORT', outcome: 'ok', code: f.sha256 });
      return download(reply, f);
    });

    // --- Queue import (§8.4): a saved device file, verified with that device's own key, appended by the normal rules ---
    api.post('/api/v1/recovery/queue-import', { onRequest: admin }, async (req, reply) => {
      const b = Import.safeParse(req.body);
      if (!b.success) return reply.code(422).send(error('VALIDATION_FAILED', 'Invalid import', z.flattenError(b.error)));
      const auth = req.auth as Auth;
      const out = await appendBatch(db, b.data.deviceId, b.data.events, { requestId: req.id, importing: true });
      await audit(req, { staffId: auth.staffId, deviceId: b.data.deviceId, action: 'QUEUE_IMPORT', outcome: out.ok ? 'ok' : 'denied', code: out.ok ? null : out.code });
      if (!out.ok) return deny(reply, out.status, out.code, 'Device not found or not yet approved');
      if (out.results.some((r) => r.status === 'appended')) bus.emit('appended');
      return { headSeq: out.headSeq, headHash: out.headHash, results: out.results };
    });

    // --- Health and alerts (SEC-20): alerts for charge and admin tablets, the full panel for admins ---
    api.get('/api/v1/alerts', { onRequest: requireSession(['charge', 'admin']) }, async () => ({ alerts: await monitor.alerts() }));
    api.get('/api/v1/admin/health', { onRequest: admin }, async () => ({ ...(await monitor.health()), sseClients: streams.count() }));

    // --- Audit view (FR-14, SEC-18): newest first, paged with `before` ---
    api.get('/api/v1/audit', { onRequest: requireSession(['charge', 'admin']) }, async (req, reply) => {
      const q = AuditQuery.safeParse(req.query);
      if (!q.success) return reply.code(422).send(error('VALIDATION_FAILED', 'Invalid query', z.flattenError(q.error)));
      const { before, limit, staffId: s, deviceId: dv, action } = q.data;
      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            before ? lt(auditLog.auditId, before) : undefined,
            s ? eq(auditLog.staffId, s) : undefined,
            dv ? eq(auditLog.deviceId, dv) : undefined,
            action ? eq(auditLog.action, action) : undefined,
          ),
        )
        .orderBy(desc(auditLog.auditId))
        .limit(limit + 1);
      const entries = rows.slice(0, limit).map((r) => ({ ...r, serverTime: r.serverTime.toISOString() }));
      return { entries, next: rows.length > limit ? (entries.at(-1)?.auditId ?? null) : null };
    });
  });

  return app;
}

