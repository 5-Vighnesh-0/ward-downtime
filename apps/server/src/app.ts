// HTTP API, design.md §5.2. Errors always use {"error": {"code", "message", "details?"}}.
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { appendBatch } from './append.ts';
import { logHead } from './db/schema.ts';
import type { Db } from './db.ts';
import { readEntries } from './entries.ts';

const Batch = z.strictObject({ deviceId: z.uuid(), events: z.array(z.unknown()).min(1).max(100) });
const PullQuery = z.strictObject({
  after: z.coerce.number().pipe(z.int().min(0)).default(0),
  limit: z.coerce.number().pipe(z.int().min(1).max(1000)).default(500),
});

const error = (code: string, message: string, details?: unknown) => ({ error: { code, message, ...(details ? { details } : {}) } });

export function buildApp(db: Db): FastifyInstance {
  const app = Fastify({ bodyLimit: 262_144, logger: false }); // SEC-23: 256 KiB per push

  app.setErrorHandler((err: { statusCode?: number }, _req, reply) => {
    if (err.statusCode === 413) return reply.code(413).send(error('PAYLOAD_TOO_LARGE', 'Request body over 256 KiB'));
    if (err.statusCode === 400 || err.statusCode === 415) return reply.code(err.statusCode).send(error('BAD_REQUEST', 'Malformed request'));
    app.log.error(err);
    return reply.code(500).send(error('INTERNAL', 'Internal error')); // never leak internals
  });

  // shortcut: no session or device-signature auth yet (M2a); M2b adds both before this runs on a real LAN.
  app.post('/api/v1/events', async (req, reply) => {
    const body = Batch.safeParse(req.body);
    if (!body.success) return reply.code(422).send(error('VALIDATION_FAILED', 'Invalid batch', z.flattenError(body.error)));
    const out = await appendBatch(db, body.data.deviceId, body.data.events);
    if (!out.ok) return reply.code(out.status).send(error(out.code, out.code === 'DEVICE_REVOKED' ? 'Device revoked' : 'Device not active'));
    return { headSeq: out.headSeq, headHash: out.headHash, results: out.results };
  });

  app.get('/api/v1/events', async (req, reply) => {
    const q = PullQuery.safeParse(req.query);
    if (!q.success) return reply.code(422).send(error('VALIDATION_FAILED', 'Invalid query', z.flattenError(q.error)));
    const [head] = await db.select({ lastSeq: logHead.lastSeq }).from(logHead).where(eq(logHead.id, 1));
    return { headSeq: head?.lastSeq ?? 0, entries: await readEntries(db, q.data.after, q.data.limit) };
  });

  return app;
}
