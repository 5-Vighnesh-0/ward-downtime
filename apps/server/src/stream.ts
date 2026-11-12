// SSE live push (design.md §5.6). Entries are read back from the DB, so only committed data is sent, in order.
import type { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.ts';
import { readEntries } from './entries.ts';

export interface StreamOptions {
  backlog: number; // more missed entries than this → `event: resync`, the device pulls instead
  pingMs: number;
}

export function createStreams(db: Db, bus: EventEmitter, opts: StreamOptions) {
  const open = new Map<string, () => void>(); // one stream per device

  function handle(req: FastifyRequest, reply: FastifyReply, deviceId: string): void {
    const lastId = String(req.headers['last-event-id'] ?? '');
    let last = /^[0-9]{1,15}$/.test(lastId) ? Number(lastId) : 0;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-request-id': req.id,
    });
    // A first comment, so the client (and any proxy that waits for body bytes) sees the stream open at once.
    res.write(': open\n\n');

    let closed = false;
    let queue = Promise.resolve();
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      bus.off('appended', onAppend);
      if (open.get(deviceId) === close) open.delete(deviceId);
      req.log.info({ event: 'sse_close', deviceId });
      res.end();
    };
    const flush = async () => {
      if (closed) return;
      const entries = await readEntries(db, last, opts.backlog + 1);
      if (entries.length > opts.backlog) {
        res.write('event: resync\ndata: {}\n\n');
        close();
        return;
      }
      for (const e of entries) {
        res.write(`id: ${e.serverSeq}\nevent: appended\ndata: ${JSON.stringify(e)}\n\n`);
        last = e.serverSeq;
      }
    };
    // Serialized, and subscribed before the first flush, so nothing appended in between is missed.
    function onAppend() {
      queue = queue.then(flush).catch(close);
    }

    open.get(deviceId)?.();
    open.set(deviceId, close);
    req.log.info({ event: 'sse_open', deviceId, lastEventId: last });
    bus.on('appended', onAppend);
    const ping = setInterval(() => res.write(': ping\n\n'), opts.pingMs);
    req.raw.on('close', close);
    onAppend();
  }

  return {
    handle,
    close: (deviceId: string) => open.get(deviceId)?.(),
    closeAll: () => [...open.values()].forEach((c) => c()),
    count: () => open.size,
  };
}
