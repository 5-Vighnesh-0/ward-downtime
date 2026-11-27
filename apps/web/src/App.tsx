// App shell (design.md §10.2): device setup → sign-in → board, with idle lock, banners and update prompt.
import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { ALLOWED_ROLES, type Branding } from '@wdb/shared';
import { registerSW } from 'virtual:pwa-register';
import { copy } from './copy.en.ts';
import { AdminScreen, AuditScreen } from './screens/Admin.tsx';
import { EnrollScreen, LockScreen, SignInScreen } from './screens/Access.tsx';
import { BoardScreen } from './screens/Board.tsx';
import { ConflictsScreen, UnplacedScreen } from './screens/Conflicts.tsx';
import { RecoveryScreen } from './screens/Recovery.tsx';
import { MyChangesScreen } from './screens/MyChanges.tsx';
import { openDb } from './sync/db.ts';
import { browserNet, request } from './sync/device.ts';
import { SyncEngine } from './sync/engine.ts';
import { applyAccent, loadBranding, NO_BRANDING, refreshBranding } from './ui/branding.ts';
import { sortNotices, type NoticeKey } from './ui/notices.ts';
import { Button, LiveRegion, NoticeLine, useEngine } from './ui/kit.tsx';

const db = openDb();
const net = browserNet();
const WARN_MS = 30_000;
const STALE_PUSH_MS = 10 * 60_000;

// One engine per page, even when React runs effects twice in development.
let engineOnce: Promise<SyncEngine> | null = null;
const openEngine = () =>
  (engineOnce ??= SyncEngine.open(db, net).then((e) => {
    void e.connect();
    return e;
  }));

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="flex flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold">Something went wrong. Your saved changes are safe.</h1>
        <Button variant="primary" onClick={() => location.reload()}>
          Reload
        </Button>
      </main>
    );
  }
}

export function App() {
  const [engine, setEngine] = useState<SyncEngine | null>(null);
  const [phase, setPhase] = useState<'loading' | 'enroll' | 'ready'>('loading');
  const start = async () => {
    setEngine(await openEngine());
    setPhase('ready');
  };
  useEffect(() => {
    void db.meta.get('device').then((m) => (m?.tempPrefix ? start() : setPhase('enroll')));
  }, []);
  return (
    <ErrorBoundary>
      {phase === 'enroll' && <EnrollScreen db={db} net={net} onApproved={() => void start()} />}
      {phase === 'ready' && engine && <Ready engine={engine} />}
    </ErrorBoundary>
  );
}

type Tab = 'board' | 'conflicts' | 'unplaced' | 'changes' | 'recovery' | 'audit' | 'admin';

function Ready({ engine }: { engine: SyncEngine }) {
  const s = useEngine(engine);
  const session = engine.session;
  const [tab, setTab] = useState<Tab>('board');
  // A reload or restart with someone still signed in starts locked, so it never skips the idle lock (SEC-7).
  const [locked, setLocked] = useState(() => engine.session !== null);
  const [warn, setWarn] = useState(false);
  const [persisted, setPersisted] = useState(true);
  const [update, setUpdate] = useState<(() => Promise<void>) | null>(null);
  const [announce, setAnnounce] = useState('');
  const [alerts, setAlerts] = useState<{ code: string; detail: string }[]>([]);
  const [branding, setBranding] = useState<Branding>(NO_BRANDING);
  const [more, setMore] = useState(false);
  const [menu, setMenu] = useState(false);
  const [bedOpen, setBedOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const showBranding = (b: Branding) => (setBranding(b), applyAccent(b.accent));
  const watchesAlerts = session?.role === 'charge' || session?.role === 'admin';

  // SEC-20: charge and admin tablets show server alerts; checked every minute while online.
  useEffect(() => {
    if (!watchesAlerts || !s.online || locked) return;
    const check = () =>
      request(net, 'GET', '/api/v1/alerts')
        .then((r) => r.json() as Promise<{ alerts: { code: string; detail: string }[] }>)
        .then((r) => setAlerts(r.alerts))
        .catch(() => undefined);
    void check();
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, [watchesAlerts, s.online, locked]);
  // FR-16: the stored copy at once, then the ward server's whenever the tablet is online.
  useEffect(() => void loadBranding(db).then(showBranding), []);
  // Also every minute while online and when the app comes back to the front, so a tablet that stays online sees admin changes.
  useEffect(() => {
    if (!s.online) return;
    const refresh = () => void refreshBranding(db, net).then(showBranding);
    const visible = () => document.visibilityState === 'visible' && refresh();
    refresh();
    const t = setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', visible);
    return () => (clearInterval(t), document.removeEventListener('visibilitychange', visible));
  }, [s.online]);
  const lastUnsynced = useRef(s.unsynced);

  // §8.1: ask the browser not to evict our data; on Safari `false` is normal, so only warn.
  useEffect(() => {
    void navigator.storage?.persisted?.().then(async (p) => {
      const granted = p || (await navigator.storage.persist().catch(() => false));
      setPersisted(granted);
      await db.meta.update('device', { persistGranted: granted });
    });
  }, []);

  // §8.6: a new service worker waits until the user installs it, which is allowed once nothing is unsent.
  useEffect(() => {
    const updateSW = registerSW({ onNeedRefresh: () => setUpdate(() => () => updateSW(true)) });
  }, []);

  // §5.6: push at once when the network or the app comes back, instead of waiting for backoff or polling.
  useEffect(() => {
    const kick = () => {
      if (document.visibilityState === 'hidden') return;
      void engine.pull();
      void engine.push();
    };
    const back = () => (engine.retryStream(), kick());
    addEventListener('online', back);
    document.addEventListener('visibilitychange', kick);
    return () => {
      removeEventListener('online', back);
      document.removeEventListener('visibilitychange', kick);
    };
  }, [engine]);

  // SEC-14: a revoked tablet also drops its cached app shell.
  useEffect(() => {
    if (s.alert !== 'DEVICE_REVOKED') return;
    void caches?.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
    void navigator.serviceWorker?.getRegistrations().then((rs) => rs.forEach((r) => void r.unregister()));
  }, [s.alert]);

  useEffect(() => {
    if (lastUnsynced.current > 0 && s.unsynced === 0 && s.online) setAnnounce(copy.allSent);
    lastUnsynced.current = s.unsynced;
  }, [s.unsynced, s.online]);

  // Idle lock with a 30 s warning (WCAG 2.2.1). The ward's setting counts once the server has accepted it (SEC-7, §9.4.3).
  const lockMs = (s.confirmed.idleLockMinutes ?? 5) * 60_000;
  useEffect(() => {
    if (!session || locked) return;
    let warnT: ReturnType<typeof setTimeout>;
    let lockT: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(warnT);
      clearTimeout(lockT);
      setWarn(false);
      warnT = setTimeout(() => setWarn(true), lockMs - WARN_MS);
      lockT = setTimeout(() => setLocked(true), lockMs);
    };
    const kinds = ['pointerdown', 'keydown'] as const;
    kinds.forEach((k) => addEventListener(k, reset));
    reset();
    return () => {
      clearTimeout(warnT);
      clearTimeout(lockT);
      kinds.forEach((k) => removeEventListener(k, reset));
    };
  }, [session, locked, lockMs]);

  if (s.alert === 'DEVICE_REVOKED') return <main className="p-6 text-xl font-semibold">{copy.revoked}</main>;
  if (!session || s.alert === 'SIGNED_OUT')
    return <SignInScreen db={db} net={net} message={s.alert === 'SIGNED_OUT' ? copy.signedOut : undefined} onSignedIn={() => void engine.resume()} />;
  if (locked)
    return (
      <LockScreen
        db={db}
        staffId={session.staffId}
        onUnlock={() => setLocked(false)}
        onSwitchUser={() => {
          setLocked(false);
          void engine.signOut();
        }}
      />
    );

  const staleMin = Math.floor((Date.now() - s.lastPushAt) / 60_000);
  // Refused changes never send, so they must not keep the stale-push warning up or block an update (§6.4).
  const sending = s.outbox.some((i) => i.state === 'queued' || i.state === 'sending');
  const stale = sending && Date.now() - s.lastPushAt > STALE_PUSH_MS;
  const canResolve = session.role === 'charge' || session.role === 'admin';
  const openConflicts = Object.values(s.view.conflicts).filter((c) => c.status === 'open').length;
  type Item = [Tab, string, string]; // id, label, icon (decorative)
  const main: Item[] = [
    ['board', 'Board', '▦'],
    ['unplaced', 'Unplaced', '⇄'],
    ['changes', 'My changes', '↻'],
    ...(canResolve ? ([['conflicts', `Conflicts (${openConflicts})`, '⚠']] as Item[]) : []),
  ];
  const extra: Item[] = [
    ...(canResolve ? ([['recovery', 'Recovery', '⟲'], ['audit', 'Audit', '☰']] as Item[]) : []),
    ...(session.role === 'admin' ? ([['admin', 'Admin', '⚙']] as Item[]) : []),
  ];
  const showMore = more || extra.some(([id]) => id === tab);
  const railButton = ([id, label, icon]: Item) => (
    <Button key={id} variant={tab === id ? 'primary' : 'secondary'} onClick={() => setTab(id)}>
      <span aria-hidden="true">{icon} </span>
      <span aria-current={tab === id ? 'page' : undefined}>{label}</span>
    </Button>
  );

  const notices: { id: string; key: NoticeKey; tone: 'info' | 'warn' | 'error'; content: ReactNode }[] = [];
  if (warn)
    notices.push({ id: 'idle', key: 'idle', tone: 'warn', content: (<><span role="alert">{copy.idleWarning}</span><Button variant="primary" onClick={() => setWarn(false)}>Stay signed in</Button></>) });
  if (s.alert === 'CHAIN_FORK') notices.push({ id: 'chainFork', key: 'chainFork', tone: 'error', content: copy.chainFork });
  if (s.alert === 'STORAGE_LOST') notices.push({ id: 'storageLost', key: 'storageLost', tone: 'error', content: copy.storageLost });
  if (s.online)
    for (const a of alerts)
      notices.push({ id: `${a.code} ${a.detail}`, key: 'alert', tone: 'error', content: (<span><strong>{copy.alerts[a.code] ?? a.code}.</strong> {a.detail}</span>) });
  if (s.alert === 'SERVER_BEHIND')
    notices.push({ id: 'serverBehind', key: 'serverBehind', tone: 'warn', content: (<>{copy.serverBehind}{session.role === 'admin' && <Button onClick={() => setTab('recovery')}>Open Recovery</Button>}</>) });
  if (!s.online) notices.push({ id: 'offline', key: 'offline', tone: 'warn', content: copy.offline });
  if ((stale || s.unsynced >= 20) && tab !== 'changes')
    notices.push({ id: 'unsynced', key: 'unsynced', tone: 'warn', content: (<>{copy.unsyncedWarning(s.unsynced, Math.max(staleMin, 0))}<Button onClick={() => setTab('changes')}>Save to file</Button></>) });
  if (s.clockOffsetMs !== null && Math.abs(s.clockOffsetMs) > 120_000) notices.push({ id: 'clockSkew', key: 'clockSkew', tone: 'warn', content: copy.clockSkew(s.clockOffsetMs) });
  if (!persisted) notices.push({ id: 'persist', key: 'persist', tone: 'warn', content: copy.persist });
  if (update)
    notices.push({ id: 'update', key: 'update', tone: 'info', content: (<>{copy.updateReady}<Button variant="primary" disabled={sending} onClick={update}>Install update</Button></>) });

  const status = `${s.online ? 'Online' : 'Offline'} · ${s.unsynced === 0 ? 'all sent' : `${s.unsynced} not sent`}`;
  return (
    <>
      <header className="sticky top-0 z-30 flex min-h-14 items-center gap-3 border-b border-border bg-surface px-4 py-1">
        {branding.logo && <img src={branding.logo} alt="" className="h-9 w-auto" />}
        <span className="font-semibold">{branding.hospitalName ?? 'Ward board'}</span>
        {branding.ward && <span className="hidden text-text-muted sm:inline">{branding.ward}</span>}
        <Button onClick={() => setTab('changes')}>
          <span className={s.online && !stale ? '' : 'text-status-pending'}>
            {stale && <span aria-hidden="true">⚠ </span>}
            <span aria-hidden="true">{s.online ? '● ' : '○ '}</span>
            <span>{status}</span>
            <span className="sr-only">, open My changes</span>
          </span>
        </Button>
        <div className="relative ml-auto" ref={menuRef} onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), setMenu(false), menuRef.current?.querySelector('button')?.focus())}>
          <Button expanded={menu} onClick={() => setMenu(!menu)}>
            <span className="font-mono">{session.staffId}</span>
          </Button>
          {menu && (
            <div className="absolute top-full right-0 z-20 mt-1 flex w-44 flex-col gap-2 rounded-xl border border-border bg-surface p-2 shadow-lg">
              <Button wide onClick={() => (setMenu(false), setLocked(true))}>Lock</Button>
              <Button wide onClick={() => (setMenu(false), engine.signOut())}>Sign out</Button>
            </div>
          )}
        </div>
      </header>
      <div className="min-[900px]:flex">
        <nav aria-label="Screens" className="flex gap-1 overflow-x-auto border-b border-border bg-surface p-2 min-[900px]:sticky min-[900px]:top-14 min-[900px]:h-[calc(100vh-3.5rem)] min-[900px]:w-44 min-[900px]:shrink-0 min-[900px]:flex-col min-[900px]:overflow-visible min-[900px]:border-r min-[900px]:border-b-0">
          {main.map(railButton)}
          {extra.length > 0 && (
            <Button expanded={showMore} disabled={extra.some(([id]) => id === tab)} onClick={() => setMore(!showMore)}>
              <span aria-hidden="true">⋯ </span>More
            </Button>
          )}
          {showMore && extra.map(railButton)}
        </nav>
        <div className={`min-w-0 flex-1 ${bedOpen ? 'pb-[60vh] min-[900px]:pr-[27rem] min-[900px]:pb-0' : ''}`}>
          <NoticeLine notices={sortNotices(notices)} />
          {tab === 'board' && <BoardScreen onPanel={setBedOpen} engine={engine} bays={branding.bays} isAdmin={session.role === 'admin'} canNote={ALLOWED_ROLES.HANDOFF_NOTE_ADDED.includes(session.role)} onResolve={canResolve ? () => setTab('conflicts') : undefined} />}
          {tab === 'conflicts' && <ConflictsScreen engine={engine} />}
          {tab === 'unplaced' && <UnplacedScreen engine={engine} />}
          {tab === 'changes' && <MyChangesScreen engine={engine} isAdmin={session.role === 'admin'} />}
          {tab === 'recovery' && <RecoveryScreen engine={engine} net={net} isAdmin={session.role === 'admin'} recovering={alerts.some((a) => a.code === 'RECOVERING')} />}
          {tab === 'audit' && <AuditScreen net={net} />}
          {tab === 'admin' && <AdminScreen engine={engine} net={net} onBranding={() => void refreshBranding(db, net).then(showBranding)} />}
        </div>
      </div>
      <LiveRegion message={announce} />
    </>
  );
}
