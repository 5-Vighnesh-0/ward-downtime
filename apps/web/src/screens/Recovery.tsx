// Recovery (charge, admin): recovery export and device-file import (design.md §7.2–§7.3, §8.4; FR-11, FR-12, SEC-15).
import { useId, useState } from 'react';
import { copy } from '../copy.en.ts';
import { downloadText, openWdbx } from '../sync/crypto.ts';
import { ApiError, request, type Net } from '../sync/device.ts';
import type { SyncEngine } from '../sync/engine.ts';
import { Banner, Button, Field, useEngine } from '../ui/kit.tsx';

const filenameOf = (res: Response, fallback: string) => /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallback;

/** POST that returns a file; saves it and returns its name. */
async function fetchFile(net: Net, path: string, body: object, fallback: string): Promise<string> {
  const res = await request(net, 'POST', path, body);
  const name = filenameOf(res, fallback);
  downloadText(name, await res.text());
  return name;
}

function ExportForm({ engine, net, isAdmin }: { engine: SyncEngine; net: Net; isAdmin: boolean }) {
  const s = useEngine(engine);
  const [pass, setPass] = useState('');
  const [plain, setPlain] = useState(false);
  const [warned, setWarned] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn' | 'error'; text: string }>();
  const checkboxId = useId();
  const open = Object.values(s.view.conflicts).filter((c) => c.status === 'open').length;

  const run = async () => {
    try {
      const name = await fetchFile(net, '/api/v1/exports', plain ? { plaintext: true } : { passphrase: pass }, 'recovery.wdbx');
      setMsg({ tone: 'info', text: `Saved ${name}. Give the passphrase to the EHR team separately.` });
    } catch (e) {
      if (e instanceof ApiError && !e.code.startsWith('HTTP_')) return setMsg({ tone: 'error', text: `The ward server refused this (${e.code}).` });
      if (plain) return setMsg({ tone: 'error', text: copy.needsServer });
      // §7.3: the ward server is down, so build the same export from this tablet's copy of the log.
      const f = await engine.localExport(pass);
      downloadText(f.filename, f.body);
      setMsg({ tone: 'warn', text: `${copy.deviceExport} Saved ${f.filename}.` });
    }
    setPass('');
    setWarned(false);
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (open > 0 && !warned) return setWarned(true);
        void run();
      }}
    >
      <p>Applied changes only, with the tablets' original times and temporary patient IDs, for the EHR team to enter after the outage.</p>
      {!plain && <Field label="Passphrase (at least 12 characters)" type="password" value={pass} onChange={setPass} hint="Needed to open the file. It is not stored." />}
      {isAdmin && (
        <div className="flex min-h-12 items-center gap-3">
          <input id={checkboxId} type="checkbox" checked={plain} onChange={(e) => setPlain(e.target.checked)} className="h-12 w-12" />
          <label htmlFor={checkboxId}>Create unencrypted files (recorded in the audit log)</label>
        </div>
      )}
      {warned ? (
        <Banner tone="warn">
          <span role="alert">{copy.openConflictsExport(open)}</span>
          <Button type="submit" variant="primary">
            Export anyway
          </Button>
          <Button onClick={() => setWarned(false)}>Resolve first</Button>
        </Banner>
      ) : (
        <Button type="submit" variant="primary" wide disabled={!plain && pass.length < 12}>
          Create recovery export
        </Button>
      )}
      {msg && (
        <Banner tone={msg.tone}>
          <span role="status">{msg.text}</span>
        </Banner>
      )}
    </form>
  );
}

/** Admin: import a tablet's "Save unsynced changes" file (§8.4). Decrypted here; the server verifies every signature. */
function ImportForm({ net }: { net: Net }) {
  const [file, setFile] = useState<File | null>(null);
  const [pass, setPass] = useState('');
  const [msg, setMsg] = useState<{ tone: 'info' | 'error'; text: string }>();
  const fileId = useId();
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!file) return;
        try {
          const files = await openWdbx(await file.text(), pass);
          const { deviceId, events } = JSON.parse(files['unsynced.json'] ?? 'null') as { deviceId: string; events: unknown[] };
          const counts: Record<string, number> = {};
          for (let i = 0; i < events.length; i += 100) {
            const res = await request(net, 'POST', '/api/v1/recovery/queue-import', { deviceId, events: events.slice(i, i + 100) });
            for (const r of ((await res.json()) as { results: { status: string; code?: string }[] }).results) counts[r.code ?? r.status] = (counts[r.code ?? r.status] ?? 0) + 1;
          }
          setMsg({ tone: 'info', text: `Imported. ${Object.entries(counts).map(([k, n]) => `${k}: ${n}`).join(', ') || 'Nothing in the file.'}` });
          setPass('');
        } catch (err) {
          setMsg({ tone: 'error', text: err instanceof ApiError ? `The ward server refused this (${err.code}).` : err instanceof Error ? err.message : String(err) });
        }
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={fileId} className="font-semibold">
          Saved tablet file (.wdbx)
        </label>
        <input id={fileId} type="file" accept=".wdbx,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="min-h-12" />
      </div>
      <Field label="Passphrase used when the file was saved" type="password" value={pass} onChange={setPass} />
      <Button type="submit" variant="primary" wide disabled={!file || pass.length < 12}>
        Import changes
      </Button>
      {msg && (
        <Banner tone={msg.tone}>
          <span role="status">{msg.text}</span>
        </Banner>
      )}
    </form>
  );
}

export function RecoveryScreen({ engine, net, isAdmin }: { engine: SyncEngine; net: Net; isAdmin: boolean }) {
  return (
    <main className="flex flex-col gap-4 p-4">
      <h1 className="text-2xl font-semibold">Recovery</h1>
      <section className="flex flex-col gap-3 rounded-lg border-2 border-border p-4">
        <h2 className="text-xl font-semibold">Recovery export</h2>
        <ExportForm engine={engine} net={net} isAdmin={isAdmin} />
      </section>
      {isAdmin && (
        <section className="flex flex-col gap-3 rounded-lg border-2 border-border p-4">
          <h2 className="text-xl font-semibold">Import a saved tablet file</h2>
          <ImportForm net={net} />
        </section>
      )}
    </main>
  );
}

/** Audit log export (FR-14), always encrypted. */
export function AuditExport({ net }: { net: Net }) {
  const [pass, setPass] = useState('');
  const [msg, setMsg] = useState<string>();
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          setMsg(`Saved ${await fetchFile(net, '/api/v1/audit/export', { passphrase: pass }, 'audit.wdbx')}.`);
          setPass('');
        } catch (err) {
          setMsg(err instanceof ApiError && !err.code.startsWith('HTTP_') ? `The ward server refused this (${err.code}).` : copy.needsServer);
        }
      }}
    >
      <Field label="Passphrase for the audit export (at least 12 characters)" type="password" value={pass} onChange={setPass} />
      <Button type="submit" disabled={pass.length < 12}>
        Export audit log
      </Button>
      {msg && <p role="status">{msg}</p>}
    </form>
  );
}
