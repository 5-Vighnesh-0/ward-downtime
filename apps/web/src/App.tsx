// App shell (design.md §10.2): device setup → sign-in → board, with idle lock, banners and update prompt.
import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
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
import { Banner, Button, LiveRegion, useEngine } from './ui/kit.tsx';

const db = openDb();
const net = browserNet();
const LOCK_MS = 5 * 60_000; // §9.4.3 default. shortcut: fixed 5 min, make it a ward setting (1–15 min) when the admin screen grows one
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

  // Idle lock with a 30 s warning (WCAG 2.2.1).
  useEffect(() => {
    if (!session || locked) return;
    let warnT: ReturnType<typeof setTimeout>;
    let lockT: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(warnT);
      clearTimeout(lockT);
      setWarn(false);
      warnT = setTimeout(() => setWarn(true), LOCK_MS - WARN_MS);
      lockT = setTimeout(() => setLocked(true), LOCK_MS);
    };
    const kinds = ['pointerdown', 'keydown'] as const;
    kinds.forEach((k) => addEventListener(k, reset));
    reset();
    return () => {
      clearTimeout(warnT);
      clearTimeout(lockT);
      kinds.forEach((k) => removeEventListener(k, reset));
    };
  }, [session, locked]);

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
  const stale = s.unsynced > 0 && Date.now() - s.lastPushAt > STALE_PUSH_MS;
  const canResolve = session.role === 'charge' || session.role === 'admin';
  const openConflicts = Object.values(s.view.conflicts).filter((c) => c.status === 'open').length;
  const tabs: [Tab, string][] = [
    ['board', 'Board'],
    ...(canResolve ? ([['conflicts', `Conflicts (${openConflicts})`]] as [Tab, string][]) : []),
    ['unplaced', 'Unplaced'],
    ['changes', 'My changes'],
    ...(canResolve ? ([['recovery', 'Recovery'], ['audit', 'Audit']] as [Tab, string][]) : []),
    ...(session.role === 'admin' ? ([['admin', 'Admin']] as [Tab, string][]) : []),
  ];
  return (
    <>
      <header className="sticky top-0 z-10 flex min-h-14 flex-wrap items-center gap-3 border-b-2 border-border bg-surface px-4 py-1">
        <span className="font-semibold">Ward board</span>
        <span className={s.online ? 'text-status-occupied' : 'text-status-pending'}>
          <span aria-hidden="true">{s.online ? '● ' : '○ '}</span>
          {s.online ? 'Online' : 'Offline'}
        </span>
        <Button onClick={() => setTab('changes')} label={`Unsynced: ${s.unsynced}. Open My changes`}>
          <span className={stale ? 'text-status-pending' : ''}>
            {stale && <span aria-hidden="true">⚠ </span>}Unsynced: {s.unsynced}
          </span>
        </Button>
        <span className="ml-auto font-mono">{session.staffId}</span>
        <Button onClick={() => setLocked(true)}>Lock</Button>
        <Button onClick={() => engine.signOut()}>Sign out</Button>
      </header>
      <nav aria-label="Screens" className="flex gap-2 overflow-x-auto px-4 pt-3">
        {tabs.map(([id, label]) => (
          <Button key={id} variant={tab === id ? 'primary' : 'secondary'} onClick={() => setTab(id)}>
            <span aria-current={tab === id ? 'page' : undefined}>{label}</span>
          </Button>
        ))}
      </nav>
      <div className="flex flex-col gap-2 px-4 pt-3">
        {!s.online && <Banner tone="warn">{copy.offline}</Banner>}
        {s.alert === 'CHAIN_FORK' && <Banner tone="error">{copy.chainFork}</Banner>}
        {s.alert === 'STORAGE_LOST' && <Banner tone="error">{copy.storageLost}</Banner>}
        {s.alert === 'SERVER_BEHIND' && (
          <Banner tone="warn">
            {copy.serverBehind}
            {session.role === 'admin' && <Button onClick={() => setTab('recovery')}>Open Recovery</Button>}
          </Banner>
        )}
        {s.clockOffsetMs !== null && Math.abs(s.clockOffsetMs) > 120_000 && <Banner tone="warn">{copy.clockSkew(s.clockOffsetMs)}</Banner>}
        {s.online &&
          alerts.map((a) => (
            <Banner key={`${a.code} ${a.detail}`} tone="error">
              <span>
                <strong>{copy.alerts[a.code] ?? a.code}.</strong> {a.detail}
              </span>
            </Banner>
          ))}
        {!persisted && <Banner tone="warn">{copy.persist}</Banner>}
        {warn && (
          <Banner tone="warn">
            <span role="alert">{copy.idleWarning}</span>
            <Button variant="primary" onClick={() => setWarn(false)}>
              Stay signed in
            </Button>
          </Banner>
        )}
        {update && (
          <Banner>
            {copy.updateReady}
            <Button variant="primary" disabled={s.unsynced > 0} onClick={update}>
              Install update
            </Button>
          </Banner>
        )}
        {(stale || s.unsynced >= 20) && tab !== 'changes' && (
          <Banner tone="warn">
            {copy.unsyncedWarning(s.unsynced, Math.max(staleMin, 0))}
            <Button onClick={() => setTab('changes')}>Save to file</Button>
          </Banner>
        )}
      </div>
      {tab === 'board' && <BoardScreen engine={engine} isAdmin={session.role === 'admin'} onResolve={canResolve ? () => setTab('conflicts') : undefined} />}
      {tab === 'conflicts' && <ConflictsScreen engine={engine} />}
      {tab === 'unplaced' && <UnplacedScreen engine={engine} />}
      {tab === 'changes' && <MyChangesScreen engine={engine} />}
      {tab === 'recovery' && <RecoveryScreen engine={engine} net={net} isAdmin={session.role === 'admin'} />}
      {tab === 'audit' && <AuditScreen net={net} />}
      {tab === 'admin' && <AdminScreen engine={engine} net={net} />}
      <LiveRegion message={announce} />
    </>
  );
}

