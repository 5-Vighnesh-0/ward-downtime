// Enroll, sign-in and idle lock screens (design.md §9.2, §9.4, §10.1).
import { useEffect, useState } from 'react';
import { copy } from '../copy.en.ts';
import { checkOffline, saveCred } from '../sync/creds.ts';
import type { Cred, WdbDb } from '../sync/db.ts';
import { ApiError, enroll, enrollmentStatus, signIn, type Net } from '../sync/device.ts';
import { Banner, Button, Field, PinPad } from '../ui/kit.tsx';

const isIos = () => /iPad|iPhone/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

function Screen(p: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex max-w-md flex-col gap-5 p-6">
      <h1 className="text-2xl font-semibold">{p.title}</h1>
      {p.children}
    </main>
  );
}

/** First run: make the device key, enroll, show the fingerprint, wait for an admin to approve. */
export function EnrollScreen(p: { db: WdbDb; net: Net; onApproved: () => void }) {
  const [label, setLabel] = useState('');
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [status, setStatus] = useState<'new' | 'pending' | 'revoked'>('new');
  const [error, setError] = useState<string>();

  useEffect(() => {
    void p.db.meta.get('device').then((m) => {
      if (m?.fingerprint) {
        setFingerprint(m.fingerprint);
        setStatus('pending');
      }
    });
  }, [p.db]);

  useEffect(() => {
    if (status !== 'pending') return;
    const poll = async () => {
      const s = await enrollmentStatus(p.db, p.net).catch(() => null);
      if (s === 'active') p.onApproved();
      if (s === 'revoked') setStatus('revoked');
    };
    void poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, [status, p]);

  if (isIos() && !standalone()) return <Screen title="Set up this tablet">{copy.installHome}</Screen>;
  if (status === 'revoked') return <Screen title="Removed">{copy.revoked}</Screen>;
  if (fingerprint)
    return (
      <Screen title="Waiting for approval">
        <p>Read this code to the ward admin. They approve the tablet in Admin → Devices.</p>
        <p className="rounded-lg border-2 border-border p-4 text-center font-mono text-4xl tracking-widest tabular-nums" aria-label={`Code ${fingerprint.split('').join(' ')}`}>
          {fingerprint.slice(0, 4)} {fingerprint.slice(4, 8)} {fingerprint.slice(8)}
        </p>
        <p className="text-text-muted">This screen moves on by itself once approved.</p>
      </Screen>
    );
  return (
    <Screen title="Set up this tablet">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setFingerprint(await enroll(p.db, p.net, label.trim()));
            setStatus('pending');
          } catch (err) {
            setError(err instanceof ApiError ? `The ward server refused this (${err.code}).` : copy.needsServer);
          }
        }}
      >
        <Field label="Tablet name" hint="For example: Bay A tablet 2" value={label} onChange={setLabel} maxLength={40} error={error} autoFocus />
        <Button type="submit" variant="primary" wide disabled={!label.trim()}>
          Ask to join the ward board
        </Button>
      </form>
    </Screen>
  );
}

/** Online sign-in when the ward server answers; otherwise the offline PIN verifier (SEC-7). */
async function signInAnywhere(db: WdbDb, net: Net, staffId: string, pin: string): Promise<string | null> {
  try {
    const s = await signIn(db, net, staffId, pin);
    await saveCred(db, s, pin);
    return null;
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.code === 'ACCOUNT_LOCKED') return copy.locked;
      if (e.code === 'SIGNIN_PAUSED') return copy.paused;
      if (e.code === 'DEVICE_REVOKED') return copy.revoked;
      return copy.wrongPinOnline;
    }
  }
  const r = await checkOffline(db, staffId, pin, Date.now());
  if (r.ok) {
    const c = await db.creds.get(staffId);
    await db.session.put({ id: 'current', staffId, role: r.role, expiresAt: c?.exp ?? new Date().toISOString() });
    return null;
  }
  if (r.reason === 'WRONG_PIN') return copy.wrongPin(r.triesLeft);
  if (r.reason === 'WIPED') return copy.offlineWiped;
  return copy.noOfflineCred;
}

export function SignInScreen(p: { db: WdbDb; net: Net; message?: string | undefined; onSignedIn: () => void }) {
  const [known, setKnown] = useState<Cred[]>([]);
  const [staffId, setStaffId] = useState('');
  const [error, setError] = useState<string>();
  useEffect(() => {
    void p.db.creds.toArray().then(setKnown);
  }, [p.db]);
  const valid = /^S-[0-9]{4}$/.test(staffId);
  return (
    <Screen title="Sign in">
      {p.message && <Banner tone="warn">{p.message}</Banner>}
      {known.length > 0 && (
        <fieldset className="flex flex-wrap gap-2">
          <legend className="mb-2 font-semibold">Signed in on this tablet recently</legend>
          {known.map((c) => (
            <Button key={c.staffId} variant={staffId === c.staffId ? 'primary' : 'secondary'} onClick={() => setStaffId(c.staffId)}>
              {c.staffId}
            </Button>
          ))}
        </fieldset>
      )}
      <Field label="Staff ID" hint="For example: S-0003" value={staffId} onChange={(v) => setStaffId(v.toUpperCase().trim())} maxLength={6} />
      <PinPad
        submitLabel="Sign in"
        error={error}
        onSubmit={async (pin) => {
          if (!valid) return setError('Enter a staff ID like S-0003.');
          const err = await signInAnywhere(p.db, p.net, staffId, pin);
          setError(err ?? undefined);
          if (!err) p.onSignedIn();
        }}
      />
    </Screen>
  );
}

/** Idle lock (§9.4.3): the signed-in staff member's PIN unlocks, checked on the device. */
export function LockScreen(p: { db: WdbDb; staffId: string; onUnlock: () => void; onSwitchUser: () => void }) {
  const [error, setError] = useState<string>();
  return (
    <Screen title="Locked">
      <p>
        Signed in as <strong>{p.staffId}</strong>. Enter your PIN to continue.
      </p>
      <PinPad
        submitLabel="Unlock"
        error={error}
        onSubmit={async (pin) => {
          const r = await checkOffline(p.db, p.staffId, pin, Date.now());
          if (r.ok) return p.onUnlock();
          if (r.reason === 'WRONG_PIN') return setError(copy.wrongPin(r.triesLeft));
          p.onSwitchUser(); // expired or wiped: a full sign-in is needed
        }}
      />
      <Button onClick={p.onSwitchUser}>Switch user</Button>
    </Screen>
  );
}
