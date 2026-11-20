// Bed grid and bed sheet (design.md §10.3, §10.4; FR-1, FR-2, FR-10). No drag and drop anywhere (WCAG 2.5.7).
import { useEffect, useState, type ReactNode } from 'react';
import { looksLikeIdentifier, type Bays, type Board } from '@wdb/shared';
import { copy } from '../copy.en.ts';
import type { SyncEngine } from '../sync/engine.ts';
import { cardName, cardState, countLabel, FILTERS, groupByBay, matches, noteWords, notesFor, taskSummary, taskWords, type CardState, type Filter, type TaskSummary } from '../ui/bedState.ts';
import { Button, Field, Sheet, useEngine } from '../ui/kit.tsx';

const cardStyle: Record<CardState['kind'] | 'occupiedPending', string> = {
  empty: 'border-2 border-dashed border-border bg-transparent',
  occupied: 'border border-border bg-surface',
  conflict: 'border-2 border-status-conflict bg-status-conflict-bg',
  occupiedPending: 'border-2 border-dashed border-status-pending bg-surface',
  pendingOut: 'border-2 border-dashed border-status-pending bg-surface',
};

/** Re-renders every 30 s, so tasks turn overdue without a tap. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function BedCard({ id, selected, label, state, tasks, notes, onOpen }: { id: string; selected: boolean; label: string; state: CardState; tasks: TaskSummary; notes: number; onOpen: () => void }) {
  const pending = (state.kind === 'occupied' && state.pending) || state.kind === 'pendingOut';
  const words = taskWords(tasks);
  const [noteWord] = noteWords(notes);
  // One wrapping meta line (spec: at most one per tile). The spaces keep visible words in the accessible name (WCAG 2.5.3).
  const metaParts: { cls: string; node: ReactNode }[] = [
    ...words.map((w) => ({ cls: tasks.overdue ? 'font-semibold text-status-error' : 'text-text-muted', node: w })),
    ...(noteWord ? [{ cls: 'text-text-muted', node: noteWord }] : []),
    ...(pending ? [{ cls: 'font-semibold text-status-pending', node: <><span aria-hidden="true">🕓 </span>Not sent</> }] : []),
  ];
  return (
    <button
      type="button"
      id={`bed-${id}`}
      aria-current={selected ? 'true' : undefined}
      onClick={onOpen}
      aria-label={cardName(label, state, tasks, notes)}
      className={`flex min-h-24 flex-col items-start gap-1 rounded-xl p-3 text-left ${cardStyle[state.kind === 'occupied' && pending ? 'occupiedPending' : state.kind]} ${selected ? 'ring-2 ring-accent ring-offset-2' : ''}`}
    >
      {/* The spaces keep the visible words apart in the text, so they read as part of the aria-label (WCAG 2.5.3). */}
      <span className="text-xl font-bold text-accent tabular-nums">{label}</span>{' '}
      {state.kind === 'empty' && <span className="text-text-muted">Empty</span>}
      {(state.kind === 'occupied' || state.kind === 'pendingOut') && (
        <span className={`text-lg font-semibold ${state.kind === 'pendingOut' ? 'line-through' : ''}`}>{state.label}</span>
      )}
      {state.kind === 'conflict' && (
        <span className="font-semibold text-status-conflict">
          <span aria-hidden="true">⚠ </span>
          {copy.conflictTitle(state.count)}
        </span>
      )}
      {metaParts.length > 0 && ' '}
      {metaParts.length > 0 && (
        <span className="flex flex-wrap gap-x-1">
          {metaParts.map((m, i) => (
            <span key={i} className={m.cls}>
              {i > 0 && <span aria-hidden="true">· </span>}
              {m.node}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

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
      {groupByBay(shown, bays).map((g, i) => (
        <section key={i} aria-labelledby={`bay-${i}`} className="flex flex-col gap-2">
          <h2 id={`bay-${i}`} className="text-sm font-bold tracking-wider text-text-muted uppercase">{g.name}</h2>
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

function BedSheet(p: { engine: SyncEngine; board: Board; confirmed: Board; bedId: string; canNote: boolean; onClose: () => void; onResolve?: (() => void) | undefined }) {
  const bedLabel = p.board.beds[p.bedId]?.label ?? p.bedId;
  const state = cardState(p.bedId, p.board, p.confirmed);
  const [mode, setMode] = useState<'main' | 'move' | 'rename' | 'discharge'>('main');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string>();
  const extras = (
    <>
      <BedTasks engine={p.engine} board={p.board} confirmed={p.confirmed} bedId={p.bedId} />
      <BedNotes engine={p.engine} board={p.board} confirmed={p.confirmed} bedId={p.bedId} canNote={p.canNote} />
    </>
  );
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
        {extras}
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
        {extras}
      </Sheet>
    );
  if (state.kind === 'pendingOut')
    return (
      <Sheet title={bedLabel} open onClose={p.onClose}>
        <p>{state.label} has a pending move or discharge. It shows as confirmed once the ward server has it.</p>
        {extras}
      </Sheet>
    );

  const { patientId, label: name } = state;
  return (
    <Sheet title={`${bedLabel}: ${name}`} open onClose={p.onClose}>
      <p className="text-text-muted">
        ID: <span className="font-mono">{patientId}</span>
        {state.pending && ' · Not sent'}
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
      {extras}
    </Sheet>
  );
}

/** Next time of day `hh:mm` on this tablet's clock; one up to an hour ago still counts as today (already late). */
function dueAtFrom(hhmm: string, now = new Date()): string {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  if (d.getTime() < now.getTime() - 3_600_000) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** FR-15 tasks on this bed. Free text follows the SEC-16 policy: short, no clinical or personal details. */
function BedTasks(p: { engine: SyncEngine; board: Board; confirmed: Board; bedId: string }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [assignee, setAssignee] = useState('');
  const [error, setError] = useState<string>();
  const now = useNow();
  const open = Object.entries(p.board.tasks ?? {}).filter(([, t]) => t.bedId === p.bedId && t.status === 'open');
  const t = title.trim();
  const titleError = t && looksLikeIdentifier(t) ? copy.noIdentifiers : undefined;
  const assigneeOk = assignee === '' || /^S-[0-9]{4}$/.test(assignee);
  const run = async (f: () => Promise<unknown>) => {
    try {
      setError(undefined);
      await f();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };
  return (
    <section aria-labelledby={`tasks-${p.bedId}`} className="flex flex-col gap-3 border-t-2 border-border pt-4">
      <h3 id={`tasks-${p.bedId}`} className="text-lg font-semibold">
        Tasks
      </h3>
      {open.length === 0 && <p className="text-text-muted">No open tasks for this bed.</p>}
      <ul className="flex flex-col gap-2">
        {open.map(([id, task]) => {
          const overdue = task.dueAt !== null && Date.parse(task.dueAt) < now;
          const pending = p.confirmed.tasks?.[id]?.status !== 'open';
          return (
            <li key={id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <span className="font-semibold">{task.title}</span>
                {task.assignee && ` · for ${task.assignee}`}
                {task.dueAt && <span className={overdue ? 'font-semibold text-status-error' : ''}>{` · ${overdue ? 'overdue since' : 'due'} ${timeOf(task.dueAt)}`}</span>}
                {pending && <span className="text-status-pending"> · Not sent</span>}
              </span>
              <Button label={`Mark ${task.title} done`} onClick={() => run(() => p.engine.record('TASK_COMPLETED', { taskId: id }))}>
                Done
              </Button>
            </li>
          );
        })}
      </ul>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const payload = { bedId: p.bedId, title: t, ...(assignee ? { assignee } : {}), ...(due ? { dueAt: dueAtFrom(due) } : {}) };
          if (await run(() => p.engine.record('TASK_CREATED', payload))) {
            setTitle('');
            setDue('');
            setAssignee('');
          }
        }}
      >
        <Field label="New task" value={title} onChange={setTitle} maxLength={60} hint={copy.noClinical} error={titleError ?? error} />
        <div className="flex flex-wrap gap-3">
          <Field label="Due at (optional)" type="time" value={due} onChange={setDue} />
          <Field label="For staff ID (optional)" value={assignee} onChange={(v) => setAssignee(v.toUpperCase().slice(0, 6))} error={assigneeOk ? undefined : 'Use a staff ID like S-0002'} />
        </div>
        <Button type="submit" disabled={!t || !!titleError || !assigneeOk}>
          Add task
        </Button>
      </form>
    </section>
  );
}

/** FR-15 handoff notes for whoever is in the bed now. Same SEC-16 free-text policy as tasks. */
function BedNotes(p: { engine: SyncEngine; board: Board; confirmed: Board; bedId: string; canNote: boolean }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const notes = notesFor(p.board, p.bedId);
  const confirmed = new Set(notesFor(p.confirmed, p.bedId).map((n) => n.eventId));
  const t = text.trim();
  const textError = t && looksLikeIdentifier(t) ? copy.noIdentifiers : undefined;
  return (
    <section aria-labelledby={`notes-${p.bedId}`} className="flex flex-col gap-3 border-t-2 border-border pt-4">
      <h3 id={`notes-${p.bedId}`} className="text-lg font-semibold">
        Handoff notes
      </h3>
      {notes.length === 0 ? (
        <p className="text-text-muted">No handoff notes for this bed.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {notes.map((n) => (
            <li key={n.eventId}>
              <p>{n.text}</p>
              <p className="text-text-muted">
                {n.by}, {timeOf(n.at)}
                {!confirmed.has(n.eventId) && <span className="text-status-pending"> · Not sent</span>}
              </p>
            </li>
          ))}
        </ul>
      )}
      {p.canNote && (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              setError(undefined);
              await p.engine.record('HANDOFF_NOTE_ADDED', { bedId: p.bedId, text: t });
              setText('');
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          <Field label="New handoff note" value={text} onChange={setText} maxLength={140} hint={copy.noClinical} error={textError ?? error} />
          <Button type="submit" disabled={!t || !!textError}>
            Add note
          </Button>
        </form>
      )}
    </section>
  );
}
