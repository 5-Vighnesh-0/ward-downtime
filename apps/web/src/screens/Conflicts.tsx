// Conflicts (charge, admin) and Unplaced (everyone): design.md §10.1, §10.3 Resolve; FR-7, FR-8, E13.
import { useEffect, useState } from 'react';
import type { AnyEvent, Conflict } from '@wdb/shared';
import { copy } from '../copy.en.ts';
import type { SyncEngine } from '../sync/engine.ts';
import { Button, Sheet, useEngine } from '../ui/kit.tsx';

interface Choice {
  conflictId: string;
  conflict: Conflict;
  keep: string; // candidate eventId or 'NONE'
}

const bedName = (engine: SyncEngine, bedId: string) => engine.state.view.beds[bedId]?.label ?? bedId;

export function ConflictsScreen({ engine }: { engine: SyncEngine }) {
  const s = useEngine(engine);
  const open = Object.entries(s.view.conflicts).filter(([, c]) => c.status === 'open');
  const [events, setEvents] = useState<Map<string, AnyEvent>>(new Map());
  const [choice, setChoice] = useState<Choice | null>(null);
  const [error, setError] = useState<string>();
  const ids = open.flatMap(([, c]) => c.candidates.map((x) => x.eventId)).join(',');
  useEffect(() => {
    void engine.eventsById(ids ? ids.split(',') : []).then(setEvents);
  }, [engine, ids]);

  const label = (patientId: string) => s.view.patients[patientId]?.label ?? patientId;
  return (
    <main className="flex flex-col gap-4 p-4">
      <h1 className="text-2xl font-semibold">Conflicts</h1>
      {open.length === 0 && <p>{copy.noConflicts}</p>}
      {error && (
        <p role="alert" className="font-semibold text-status-error">
          {error}
        </p>
      )}
      {open.map(([conflictId, c]) => (
        <section key={conflictId} aria-labelledby={`${conflictId}-h`} className="flex flex-col gap-3 rounded-lg border-4 border-status-conflict p-4">
          <h2 id={`${conflictId}-h`} className="text-xl font-semibold">
            <span aria-hidden="true">⚠ </span>
            {bedName(engine, c.bedId)}: {c.candidates.length} patients placed
          </h2>
          <ul className="grid gap-3 md:grid-cols-2">
            {c.candidates.map((x) => {
              const e = events.get(x.eventId);
              return (
                <li key={x.eventId} className="flex flex-col gap-2 rounded-lg border-2 border-border p-3">
                  <p className="text-[22px] font-semibold">{label(x.patientId)}</p>
                  <p className="text-text-muted">
                    ID <span className="font-mono">{x.patientId}</span>
                    {e && (
                      <>
                        {' · '}
                        {e.type === 'TRANSFER' ? 'moved' : 'admitted'} by <span className="font-mono">{e.staffId}</span> on tablet{' '}
                        <span className="font-mono">{e.deviceId === engine.device.deviceId ? `“${engine.device.label}”` : e.deviceId.slice(0, 8)}</span>
                        {' · tablet time '}
                        <time dateTime={e.clientTime} className="tabular-nums">
                          {new Date(e.clientTime).toLocaleString()}
                        </time>
                      </>
                    )}
                  </p>
                  <Button variant="primary" onClick={() => setChoice({ conflictId, conflict: c, keep: x.eventId })}>
                    Keep {label(x.patientId)}
                  </Button>
                </li>
              );
            })}
          </ul>
          <Button onClick={() => setChoice({ conflictId, conflict: c, keep: 'NONE' })}>Keep neither</Button>
        </section>
      ))}
      {choice && (
        <ResolveDialog
          engine={engine}
          choice={choice}
          label={label}
          onClose={() => setChoice(null)}
          onError={(m) => (setError(m), setChoice(null))}
        />
      )}
    </main>
  );
}

function ResolveDialog(p: { engine: SyncEngine; choice: Choice; label: (patientId: string) => string; onClose: () => void; onError: (m: string) => void }) {
  const { conflictId, conflict: c, keep } = p.choice;
  const kept = c.candidates.find((x) => x.eventId === keep);
  const others = c.candidates.filter((x) => x !== kept).map((x) => p.label(x.patientId));
  const bed = bedName(p.engine, c.bedId).toLowerCase();
  const title = kept ? `Keep ${p.label(kept.patientId)} in ${bed}?` : `Keep neither patient in ${bed}?`;
  return (
    <Sheet title={title} open onClose={p.onClose}>
      <p>
        {others.join(' and ')} will move to Unplaced. This is recorded under your name.
      </p>
      <Button
        variant="primary"
        wide
        onClick={async () => {
          try {
            // candidatesSeen: if anyone joined the conflict meanwhile, the resolution is not applied (E7).
            await p.engine.record('RESOLVE_CONFLICT', { conflictId, keep, candidatesSeen: c.candidates.map((x) => x.eventId) });
            p.onClose();
          } catch (e) {
            p.onError(e instanceof Error ? e.message : String(e));
          }
        }}
      >
        {kept ? `Keep ${p.label(kept.patientId)}` : 'Keep neither'}
      </Button>
      <Button wide onClick={p.onClose}>
        Go back
      </Button>
    </Sheet>
  );
}

export function UnplacedScreen({ engine }: { engine: SyncEngine }) {
  const s = useEngine(engine);
  const unplaced = Object.entries(s.view.patients).filter(([, p]) => p.where.kind === 'unplaced');
  const [patientId, setPatientId] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const empty = Object.entries(s.view.beds)
    .filter(([, b]) => b.status === 'empty')
    .sort(([a], [b]) => a.localeCompare(b));
  const chosen = patientId ? s.view.patients[patientId] : undefined;
  return (
    <main className="flex flex-col gap-4 p-4">
      <h1 className="text-2xl font-semibold">Unplaced</h1>
      {unplaced.length === 0 && <p>{copy.noUnplaced}</p>}
      <ul className="flex flex-col gap-2">
        {unplaced.map(([id, p]) => (
          <li key={id} className="flex flex-wrap items-center gap-3 rounded-lg border-2 border-dashed border-border p-3">
            <div className="flex-1">
              <p className="text-[22px] font-semibold">{p.label}</p>
              <p className="text-text-muted">
                ID <span className="font-mono">{id}</span> · not in a bed
              </p>
            </div>
            <Button variant="primary" onClick={() => setPatientId(id)}>
              Admit {p.label} to a bed
            </Button>
          </li>
        ))}
      </ul>
      {patientId && chosen && (
        <Sheet title={`Admit ${chosen.label}`} open onClose={() => setPatientId(null)}>
          {error && (
            <p role="alert" className="font-semibold text-status-error">
              {error}
            </p>
          )}
          {empty.length === 0 ? (
            <p>No empty beds right now.</p>
          ) : (
            <ul className="grid grid-cols-2 gap-2">
              {empty.map(([bedId, bed]) => (
                <li key={bedId} className="grid">
                  <Button
                    label={`Admit ${chosen.label} to ${bed.label}`}
                    onClick={async () => {
                      try {
                        await engine.admit({ patientId, label: chosen.label, bedId });
                        setPatientId(null);
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e));
                      }
                    }}
                  >
                    {bed.label}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Sheet>
      )}
    </main>
  );
}
