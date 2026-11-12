// Online-only screens (design.md §10.1): Admin (devices, staff, ward beds) and Audit (FR-14, SEC-6, SEC-18).
import { useCallback, useEffect, useId, useState } from 'react';
import type { Role } from '@wdb/shared';
import { copy } from '../copy.en.ts';
import { ApiError, request, type Net } from '../sync/device.ts';
import type { SyncEngine } from '../sync/engine.ts';
import { Banner, Button, Field, useEngine } from '../ui/kit.tsx';
import { AuditExport } from './Recovery.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? `The ward server refused this (${e.code}).` : copy.needsServer);

/** Loads JSON from the ward server; `reload` runs it again. */
function useOnline<T>(net: Net, path: string): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    request(net, 'GET', path)
      .then((r) => r.json() as Promise<T>)
      .then((d) => live && (setData(d), setError(null)))
      .catch((e) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [net, path, n]);
  return { data, error, reload: useCallback(() => setN((x) => x + 1), []) };
}

function Section(p: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border-2 border-border p-4">
      <h2 className="text-xl font-semibold">{p.title}</h2>
      {p.children}
    </section>
  );
}

interface Device {
  deviceId: string;
  label: string;
  status: 'pending' | 'active' | 'revoked';
  fingerprint: string;
  tempPrefix: string | null;
}
interface Staff {
  staffId: string;
  displayName: string;
  role: Role;
  status: 'active' | 'disabled';
  lockedUntil: string | null;
}

function Devices({ net }: { net: Net }) {
  const { data, error, reload } = useOnline<{ devices: Device[] }>(net, '/api/v1/admin/devices');
  const [msg, setMsg] = useState<string>();
  const [confirm, setConfirm] = useState<string | null>(null);
  const post = async (path: string) => {
    try {
      await request(net, 'POST', path);
      setMsg(undefined);
    } catch (e) {
      setMsg(errText(e));
    }
    setConfirm(null);
    reload();
  };
  if (error) return <Banner tone="warn">{error}</Banner>;
  return (
    <ul className="flex flex-col gap-2">
      {msg && <Banner tone="error">{msg}</Banner>}
      {data?.devices.map((d) => (
        <li key={d.deviceId} className="flex flex-wrap items-center gap-3 rounded-lg border-2 border-border p-3">
          <div className="flex-1">
            <p className="font-semibold">{d.label}</p>
            <p className="text-text-muted">
              {d.status} · code <span className="font-mono tracking-wider">{d.fingerprint}</span>
              {d.tempPrefix && ` · prefix ${d.tempPrefix}`}
            </p>
          </div>
          {d.status === 'pending' && (
            <Button variant="primary" onClick={() => post(`/api/v1/admin/devices/${d.deviceId}/approve`)} label={`Approve ${d.label}, code ${d.fingerprint}`}>
              Approve
            </Button>
          )}
          {d.status !== 'revoked' &&
            (confirm === d.deviceId ? (
              <>
                <Button variant="destructive" onClick={() => post(`/api/v1/admin/devices/${d.deviceId}/revoke`)}>
                  Remove {d.label}
                </Button>
                <Button onClick={() => setConfirm(null)}>Go back</Button>
              </>
            ) : (
              <Button onClick={() => setConfirm(d.deviceId)}>Remove…</Button>
            ))}
        </li>
      ))}
    </ul>
  );
}

function RoleSelect({ value, onChange }: { value: Role; onChange: (r: Role) => void }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-semibold">
        Role
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as Role)} className="min-h-12 rounded-lg border-2 border-border px-3">
        {(['clerk', 'nurse', 'charge', 'admin'] as const).map((r) => (
          <option key={r}>{r}</option>
        ))}
      </select>
    </div>
  );
}

function StaffList({ net }: { net: Net }) {
  const { data, error, reload } = useOnline<{ staff: Staff[] }>(net, '/api/v1/admin/staff');
  const [form, setForm] = useState({ staffId: '', displayName: '', role: 'nurse' as Role, pin: '' });
  const [msg, setMsg] = useState<string>();
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [newPin, setNewPin] = useState('');
  const send = async (method: string, path: string, body: object, done?: string) => {
    try {
      await request(net, method, path, body);
      setMsg(done);
      reload();
      return true;
    } catch (e) {
      setMsg(errText(e));
      return false;
    }
  };
  if (error) return <Banner tone="warn">{error}</Banner>;
  return (
    <div className="flex flex-col gap-4">
      {msg && <p role="status">{msg}</p>}
      <ul className="flex flex-col gap-2">
        {data?.staff.map((s) => (
          <li key={s.staffId} className="flex flex-wrap items-center gap-3 rounded-lg border-2 border-border p-3">
            <div className="flex-1">
              <p className="font-semibold">
                {s.displayName} <span className="font-mono">{s.staffId}</span>
              </p>
              <p className="text-text-muted">
                {s.role} · {s.status}
                {s.lockedUntil && new Date(s.lockedUntil) > new Date() && ' · locked'}
              </p>
            </div>
            <Button onClick={() => send('PATCH', `/api/v1/admin/staff/${s.staffId}`, { status: s.status === 'active' ? 'disabled' : 'active' })}>
              {s.status === 'active' ? 'Disable' : 'Enable'}
            </Button>
            <Button onClick={() => (setResetFor(s.staffId), setNewPin(''))}>Reset PIN</Button>
            {resetFor === s.staffId && (
              <form
                className="flex w-full flex-wrap items-end gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await send('PATCH', `/api/v1/admin/staff/${s.staffId}`, { pin: newPin }, `PIN reset for ${s.staffId}.`)) setResetFor(null);
                }}
              >
                <Field label={`New PIN for ${s.staffId}`} type="password" inputMode="numeric" maxLength={8} value={newPin} onChange={(v) => setNewPin(v.replace(/\D/g, ''))} />
                <Button type="submit" variant="primary" disabled={newPin.length < 6}>
                  Save PIN
                </Button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await send('POST', '/api/v1/admin/staff', form, `Added ${form.staffId}.`)) setForm({ staffId: '', displayName: '', role: 'nurse', pin: '' });
        }}
      >
        <h3 className="font-semibold">Add staff member</h3>
        <Field label="Staff ID" hint="S- and four digits" value={form.staffId} onChange={(v) => setForm({ ...form, staffId: v.toUpperCase().trim() })} maxLength={6} />
        <Field label="Display name" value={form.displayName} onChange={(v) => setForm({ ...form, displayName: v })} maxLength={40} />
        <RoleSelect value={form.role} onChange={(role) => setForm({ ...form, role })} />
        <Field label="First PIN (6 to 8 digits)" type="password" inputMode="numeric" maxLength={8} value={form.pin} onChange={(v) => setForm({ ...form, pin: v.replace(/\D/g, '') })} />
        <Button type="submit" variant="primary" disabled={!/^S-[0-9]{4}$/.test(form.staffId) || !form.displayName.trim() || form.pin.length < 6}>
          Add staff member
        </Button>
      </form>
    </div>
  );
}

/** WARD_CONFIGURED event: goes through the outbox like any change, so it also works offline. */
function WardBeds({ engine }: { engine: SyncEngine }) {
  const s = useEngine(engine);
  const [count, setCount] = useState(String(Object.keys(s.view.beds).length || 12));
  const [msg, setMsg] = useState<string>();
  const n = Number(count);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const beds = Array.from({ length: n }, (_, i) => ({ bedId: `B${String(i + 1).padStart(2, '0')}`, label: `Bed ${i + 1}` }));
        try {
          await engine.record('WARD_CONFIGURED', { beds });
          setMsg(`Saved ${n} beds. They show as soon as the change is applied.`);
        } catch (err) {
          setMsg(err instanceof Error ? err.message : String(err));
        }
      }}
    >
      <Field label="Number of beds (1 to 60)" inputMode="numeric" value={count} onChange={(v) => setCount(v.replace(/\D/g, '').slice(0, 2))} />
      <Button type="submit" variant="primary" disabled={!(n >= 1 && n <= 60)}>
        Save beds
      </Button>
      {msg && <p role="status">{msg}</p>}
    </form>
  );
}

interface Health {
  headSeq: number;
  headHash: string;
  sseClients: number;
  devices: { label: string; status: string; lastSeenAt: string | null; clockOffsetMs: number | null; lastDeviceSeq: number }[];
  last24h: Record<string, number>;
  pushMs: { count: number; p50: number | null; p95: number | null };
  alerts: { code: string; detail: string }[];
}

/** design.md §13.2. The head hash is an external anchor: note it down to compare after a restore. */
function HealthPanel({ net }: { net: Net }) {
  const { data: h, error, reload } = useOnline<Health>(net, '/api/v1/admin/health');
  if (error) return <Banner tone="warn">{error}</Banner>;
  if (!h) return <p>Loading…</p>;
  return (
    <div className="flex flex-col gap-3">
      <p>
        Log head <strong className="tabular-nums">{h.headSeq}</strong>, hash <span className="font-mono">{h.headHash.slice(0, 16)}…</span> · {h.sseClients} tablets connected live
      </p>
      <p>
        Last 24 h: {h.last24h.appended} changes added, {h.last24h.duplicate} repeats, {h.last24h.refused} refused, {h.last24h.signinFailures} failed sign-ins ·
        push time p95 {h.pushMs.p95 === null ? '–' : `${Math.round(h.pushMs.p95)} ms`}
      </p>
      {h.alerts.length === 0 ? <p>No alerts.</p> : h.alerts.map((a) => <Banner key={`${a.code} ${a.detail}`} tone="error">{`${copy.alerts[a.code] ?? a.code}. ${a.detail}`}</Banner>)}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">Tablets</caption>
          <thead>
            <tr className="border-b-2 border-border">
              {['Tablet', 'Status', 'Last seen', 'Clock off by', 'Changes sent'].map((x) => (
                <th key={x} scope="col" className="p-2">
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {h.devices.map((d) => (
              <tr key={d.label + d.lastSeenAt} className="border-b border-border">
                <td className="p-2">{d.label}</td>
                <td className="p-2">{d.status}</td>
                <td className="p-2 tabular-nums">{d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : '–'}</td>
                <td className="p-2 tabular-nums">{d.clockOffsetMs === null ? '–' : `${Math.round(d.clockOffsetMs / 1000)} s`}</td>
                <td className="p-2 tabular-nums">{d.lastDeviceSeq}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button onClick={reload}>Refresh</Button>
    </div>
  );
}

export function AdminScreen({ engine, net }: { engine: SyncEngine; net: Net }) {
  return (
    <main className="flex flex-col gap-4 p-4">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <Section title="Ward server health">
        <HealthPanel net={net} />
      </Section>
      <Section title="Devices">
        <Devices net={net} />
      </Section>
      <Section title="Staff">
        <StaffList net={net} />
      </Section>
      <Section title="Ward beds">
        <WardBeds engine={engine} />
      </Section>
    </main>
  );
}

interface AuditRow {
  auditId: number;
  serverTime: string;
  staffId: string | null;
  deviceId: string | null;
  action: string;
  eventId: string | null;
  outcome: string;
  code: string | null;
}

export function AuditScreen({ net }: { net: Net }) {
  const [filters, setFilters] = useState({ staffId: '', action: '' });
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const load = async (before: number | null) => {
    const q = new URLSearchParams({ limit: '100' });
    if (before) q.set('before', String(before));
    if (filters.staffId) q.set('staffId', filters.staffId);
    if (filters.action) q.set('action', filters.action);
    try {
      const page = (await (await request(net, 'GET', `/api/v1/audit?${q}`)).json()) as { entries: AuditRow[]; next: number | null };
      setRows((r) => (before ? [...r, ...page.entries] : page.entries));
      setNext(page.next);
      setError(undefined);
    } catch (e) {
      setError(errText(e));
    }
  };
  useEffect(() => void load(null), []); // first page on open; filters apply on submit
  return (
    <main className="flex flex-col gap-4 p-4">
      <h1 className="text-2xl font-semibold">Audit log</h1>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => (e.preventDefault(), void load(null))}>
        <Field label="Staff ID" value={filters.staffId} onChange={(v) => setFilters({ ...filters, staffId: v.toUpperCase().trim() })} maxLength={6} />
        <Field label="Action" hint="For example: SIGNIN_FAIL" value={filters.action} onChange={(v) => setFilters({ ...filters, action: v.toUpperCase().trim() })} maxLength={32} />
        <Button type="submit" variant="primary">
          Filter
        </Button>
      </form>
      <AuditExport net={net} />
      {error && <Banner tone="warn">{error}</Banner>}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">Audit entries, newest first</caption>
          <thead>
            <tr className="border-b-2 border-border">
              {['Time', 'Staff', 'Device', 'Action', 'Outcome', 'Code'].map((h) => (
                <th key={h} scope="col" className="p-2">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.auditId} className="border-b border-border">
                <td className="p-2 tabular-nums">{new Date(r.serverTime).toLocaleString()}</td>
                <td className="p-2 font-mono">{r.staffId ?? '–'}</td>
                <td className="p-2 font-mono">{r.deviceId?.slice(0, 8) ?? '–'}</td>
                <td className="p-2">{r.action}</td>
                <td className="p-2">{r.outcome}</td>
                <td className="p-2">{r.code ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {next && <Button onClick={() => load(next)}>Load older entries</Button>}
    </main>
  );
}
