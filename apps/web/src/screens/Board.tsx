// Bed grid and bed sheet (design.md §10.3, §10.4; FR-1, FR-2, FR-10). No drag and drop anywhere (WCAG 2.5.7).
import { useState } from 'react';
import type { Board } from '@wdb/shared';
import { copy } from '../copy.en.ts';
import type { SyncEngine } from '../sync/engine.ts';
import { cardName, cardState, type CardState } from '../ui/bedState.ts';
import { Button, Field, Sheet, useEngine } from '../ui/kit.tsx';

const cardStyle: Record<CardState['kind'], string> = {
  empty: 'border-2 border-border bg-surface-raised',
  occupied: 'border-2 border-status-occupied',
  conflict: 'border-4 border-status-conflict',
  pendingOut: 'border-2 border-dashed border-status-pending',
};

function BedCard({ label, state, onOpen }: { label: string; state: CardState; onOpen: () => void }) {
  const pending = (state.kind === 'occupied' && state.pending) || state.kind === 'pendingOut';
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={cardName(label, state)}
      className={`flex min-h-28 flex-col items-start gap-1 rounded-lg p-3 text-left ${cardStyle[state.kind]} ${pending && state.kind === 'occupied' ? 'border-dashed' : ''}`}
    >
      <span className="text-text-muted tabular-nums">{label}</span>
      {state.kind === 'empty' && <span className="text-text-muted">Empty</span>}
      {(state.kind === 'occupied' || state.kind === 'pendingOut') && (
        <span className={`text-[22px] font-semibold ${state.kind === 'pendingOut' ? 'line-through' : ''}`}>{state.label}</span>
      )}
      {state.kind === 'conflict' && (
        <span className="font-semibold text-status-conflict">
          <span aria-hidden="true">⚠ </span>
          {copy.conflictTitle(state.count)}
        </span>
      )}
      {pending && (
        <span className="font-semibold text-status-pending">
          <span aria-hidden="true">🕓 </span>Pending
        </span>
      )}
    </button>
  );
}

export function BoardScreen({ engine, isAdmin, onResolve }: { engine: SyncEngine; isAdmin: boolean; onResolve?: (() => void) | undefined }) {
  const s = useEngine(engine);
  const [open, setOpen] = useState<string | null>(null);
  const beds = Object.entries(s.view.beds).sort(([a], [b]) => a.localeCompare(b));
  return (
    <main className="flex flex-col gap-4 p-4">
      <h1 className="text-2xl font-semibold">Beds</h1>
      {beds.length === 0 && <p>{copy.noBeds + (isAdmin ? ' Use Admin → Ward beds.' : '')}</p>}
      <ul className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
        {beds.map(([id, bed]) => (
          <li key={id} className="grid">
            <BedCard label={bed.label} state={cardState(id, s.view, s.confirmed)} onOpen={() => setOpen(id)} />
          </li>
        ))}
      </ul>
      {open && <BedSheet engine={engine} board={s.view} confirmed={s.confirmed} bedId={open} onClose={() => setOpen(null)} onResolve={onResolve} />}
    </main>
  );
}

function BedSheet(p: { engine: SyncEngine; board: Board; confirmed: Board; bedId: string; onClose: () => void; onResolve?: (() => void) | undefined }) {
  const bedLabel = p.board.beds[p.bedId]?.label ?? p.bedId;
  const state = cardState(p.bedId, p.board, p.confirmed);
  const [mode, setMode] = useState<'main' | 'move' | 'rename' | 'discharge'>('main');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string>();
  const act = async (f: () => Promise<unknown>) => {
    try {
      await f();
      p.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (state.kind === 'empty')
    return (
      <Sheet title={`${bedLabel}: admit`} open onClose={p.onClose}>
        <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), void act(() => p.engine.admit({ label: label.trim(), bedId: p.bedId })))}>
          <Field label="Patient name label" value={label} onChange={setLabel} maxLength={40} autoFocus error={error} />
          <p className="text-text-muted">
            ID: <span className="font-mono">{p.engine.device.nextPatientId}</span>
          </p>
          <Button type="submit" variant="primary" wide disabled={!label.trim()}>
            Admit to {bedLabel.toLowerCase()}
          </Button>
        </form>
      </Sheet>
    );
  if (state.kind === 'conflict')
    return (
      <Sheet title={`${bedLabel}: ${copy.conflictTitle(state.count)}`} open onClose={p.onClose}>
        <p>{copy.conflictHelp}</p>
        {p.onResolve && (
          <Button variant="primary" wide onClick={p.onResolve}>
            Choose who stays
          </Button>
        )}
      </Sheet>
    );
  if (state.kind === 'pendingOut')
    return (
      <Sheet title={bedLabel} open onClose={p.onClose}>
        <p>{state.label} has a pending move or discharge. It shows as confirmed once the ward server has it.</p>
      </Sheet>
    );

  const { patientId, label: name } = state;
  return (
    <Sheet title={`${bedLabel}: ${name}`} open onClose={p.onClose}>
      <p className="text-text-muted">
        ID: <span className="font-mono">{patientId}</span>
        {state.pending && ' · Pending'}
      </p>
      {error && (
        <p role="alert" className="font-semibold text-status-error">
          {error}
        </p>
      )}
      {mode === 'main' && (
        <div className="flex flex-col gap-2">
          <Button wide onClick={() => setMode('move')}>
            Move to another bed
          </Button>
          <Button wide onClick={() => (setLabel(name), setMode('rename'))}>
            Change name label
          </Button>
          <Button wide variant="destructive" onClick={() => setMode('discharge')}>
            Discharge
          </Button>
        </div>
      )}
      {mode === 'move' && (
        <ul className="grid grid-cols-2 gap-2">
          {Object.entries(p.board.beds)
            .filter(([id]) => id !== p.bedId)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, bed]) => (
              <li key={id} className="grid">
                <Button
                  disabled={bed.status !== 'empty'}
                  onClick={() => act(() => p.engine.record('TRANSFER', { patientId, fromBedId: p.bedId, toBedId: id }))}
                  label={bed.status === 'empty' ? `Move ${name} to ${bed.label}` : `${bed.label}, ${bed.status === 'conflict' ? 'conflict' : 'occupied'}`}
                >
                  {bed.label}
                  {bed.status !== 'empty' && <span className="block text-sm font-normal">{bed.status === 'conflict' ? 'Conflict' : 'Occupied'}</span>}
                </Button>
              </li>
            ))}
        </ul>
      )}
      {mode === 'rename' && (
        <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), void act(() => p.engine.record('RENAME', { patientId, label: label.trim() })))}>
          <Field label="Patient name label" value={label} onChange={setLabel} maxLength={40} autoFocus />
          <Button type="submit" variant="primary" wide disabled={!label.trim() || label.trim() === name}>
            Save name label
          </Button>
        </form>
      )}
      {mode === 'discharge' && (
        <div className="flex flex-col gap-2">
          <p className="font-semibold">
            Discharge {name} from {bedLabel.toLowerCase()}?
          </p>
          <Button wide variant="destructive" onClick={() => act(() => p.engine.record('DISCHARGE', { patientId, bedId: p.bedId }))}>
            Discharge
          </Button>
          <Button wide onClick={() => setMode('main')}>
            Keep in bed
          </Button>
        </div>
      )}
    </Sheet>
  );
}
