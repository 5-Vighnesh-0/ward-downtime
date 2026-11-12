// This tablet's changes and their sync state (design.md §5.5, §8.3, §8.4; FR-10, FR-12).
import { useEffect, useState } from 'react';
import type { AnyEvent, Outcome } from '@wdb/shared';
import { copy } from '../copy.en.ts';
import { downloadText, sealWdbx } from '../sync/crypto.ts';
import type { OutboxItem } from '../sync/db.ts';
import type { SyncEngine } from '../sync/engine.ts';
import { Button, Field, useEngine } from '../ui/kit.tsx';

function describe(e: AnyEvent): string {
  switch (e.type) {
    case 'ADMIT':
      return `Admit ${e.payload.label} (${e.payload.patientId}) to ${e.payload.bedId}`;
    case 'DISCHARGE':
      return `Discharge ${e.payload.patientId} from ${e.payload.bedId}`;
    case 'TRANSFER':
      return `Move ${e.payload.patientId} from ${e.payload.fromBedId} to ${e.payload.toBedId}`;
    case 'RENAME':
      return `Rename ${e.payload.patientId} to ${e.payload.label}`;
    case 'RESOLVE_CONFLICT':
      return `Resolve ${e.payload.conflictId}`;
    case 'WARD_CONFIGURED':
      return `Set up ${e.payload.beds.length} beds`;
  }
}

function pendingStatus(i: OutboxItem, blocked: boolean): { text: string; tone: string } {
  if (i.state === 'refused') return { text: copy.failed(i.code ?? 'UNKNOWN'), tone: 'text-status-error' };
  if (blocked) return { text: `Pending. ${copy.blocked}`, tone: 'text-status-pending' };
  return { text: i.state === 'acked' ? 'Pending: accepted, waiting for confirmation' : 'Pending: not yet sent', tone: 'text-status-pending' };
}

function confirmedStatus(o: Outcome | undefined): { text: string; tone: string } {
  if (o?.kind === 'noop' && copy.reasons[o.reason]) return { text: `✓ Confirmed, no change. ${copy.reasons[o.reason]}`, tone: 'text-text-muted' };
  if (!o || o.kind === 'applied' || o.kind === 'noop') return { text: '✓ Confirmed', tone: 'text-text-muted' };
  if (o.kind === 'held') return { text: '⚠ Conflict: a charge nurse must choose', tone: 'text-status-conflict' };
  if (o.kind === 'rejected') return { text: copy.notKept, tone: 'text-status-conflict' };
  return { text: copy.reasons[o.reason] ? `Not applied. ${copy.reasons[o.reason]}` : copy.notApplied(o.reason), tone: 'text-status-error' };
}

/** Save unsent changes to an encrypted file (§8.4). The download is a Blob URL: no network. */
async function saveToFile(engine: SyncEngine, passphrase: string): Promise<void> {
  const events = engine.state.outbox.filter((i) => i.state !== 'acked').map((i) => i.event);
  const { deviceId, label } = engine.device;
  const box = await sealWdbx({ 'unsynced.json': JSON.stringify({ deviceId, events }) }, passphrase);
  const range = events.length ? `${events[0]?.deviceSeq}-${events.at(-1)?.deviceSeq}` : 'empty';
  downloadText(`unsynced-${label.replace(/[^A-Za-z0-9]+/g, '-')}-${range}.wdbx`, box);
}

export function SaveToFile({ engine }: { engine: SyncEngine }) {
  const [pass, setPass] = useState('');
  const [msg, setMsg] = useState<string>();
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border-2 border-border p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await saveToFile(engine, pass);
          setPass('');
          setMsg('Saved. Give the file to the charge nurse or IT, and tell them the passphrase separately.');
        } catch (err) {
          setMsg(err instanceof Error ? err.message : String(err));
        }
      }}
    >
      <h2 className="text-xl font-semibold">Save unsynced changes to file</h2>
      <Field label="Passphrase (at least 12 characters)" type="password" value={pass} onChange={setPass} hint="Needed to open the file. It is not stored." />
      <Button type="submit" variant="primary" wide disabled={pass.length < 12}>
        Save to file
      </Button>
      {msg && <p role="status">{msg}</p>}
    </form>
  );
}

export function MyChangesScreen({ engine }: { engine: SyncEngine }) {
  const s = useEngine(engine);
  const me = engine.device.deviceId;
  const blocked = new Set(s.blocked);
  const [events, setEvents] = useState<AnyEvent[]>([]);
  useEffect(() => {
    void engine.myConfirmed(50).then(setEvents);
  }, [engine, s.confirmed.atSeq]);
  return (
    <main className="flex flex-col gap-4 p-4">
      <h1 className="text-2xl font-semibold">My changes</h1>
      <p>
        Unsynced: <strong>{s.unsynced}</strong>. Device <span className="font-mono">{me.slice(0, 8)}</span>, “{engine.device.label}”.
      </p>
      <SaveToFile engine={engine} />
      <h2 className="text-xl font-semibold">Not confirmed yet</h2>
      {s.outbox.length === 0 ? (
        <p className="text-text-muted">Nothing waiting. All changes from this tablet are confirmed.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {s.outbox.map((i) => {
            const st = pendingStatus(i, blocked.has(i.eventId));
            return (
              <li key={i.eventId} className="rounded-lg border-2 border-dashed border-border p-3">
                <p className="font-semibold">{describe(i.event)}</p>
                <p className={st.tone}>{st.text}</p>
              </li>
            );
          })}
        </ul>
      )}
      <h2 className="text-xl font-semibold">Confirmed</h2>
      <ul className="flex flex-col gap-2">
        {events.map((event) => {
          const st = confirmedStatus(s.confirmed.outcomes[event.eventId]);
          return (
            <li key={event.eventId} className="rounded-lg border-2 border-border p-3">
              <p className="font-semibold">{describe(event)}</p>
              <p className={st.tone}>{st.text}</p>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
