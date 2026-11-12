// Small shared UI pieces (design.md §10.5): 48 px targets, visible labels, status as icon + text.
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { EngineState, SyncEngine } from '../sync/engine.ts';

export const useEngine = (engine: SyncEngine): EngineState =>
  useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.state,
  );

const variants = {
  primary: 'bg-status-occupied text-white border-status-occupied',
  secondary: 'bg-surface text-text border-border',
  destructive: 'bg-status-error text-white border-status-error',
};

/** Disabled for 600 ms after a tap, to absorb double taps from gloves. */
export function Button(p: {
  children: ReactNode;
  onClick?: () => unknown;
  variant?: keyof typeof variants;
  disabled?: boolean;
  type?: 'button' | 'submit';
  wide?: boolean;
  label?: string;
}) {
  // A ref, not disabled state: disabling during the click would cancel a submit button's form submission.
  const last = useRef(-Infinity); // event timestamps count from page load, so 0 would swallow the first 600 ms
  return (
    <button
      type={p.type ?? 'button'}
      aria-label={p.label}
      disabled={p.disabled}
      onClick={(e) => {
        if (e.timeStamp - last.current < 600) return e.preventDefault();
        last.current = e.timeStamp;
        void p.onClick?.();
      }}
      className={`min-h-12 min-w-12 rounded-lg border-2 px-4 font-semibold disabled:opacity-50 ${variants[p.variant ?? 'secondary']} ${p.wide ? 'min-h-14 w-full' : ''}`}
    >
      {p.children}
    </button>
  );
}

/** Native modal dialog: traps focus, restores it on close, and closes on Esc. */
export function Sheet(p: { title: string; open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (p.open && d && !d.open) {
      d.showModal(); // moves focus to the first button, so put it back on the field meant to start with it
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!p.open && d?.open) d.close();
  }, [p.open]);
  return (
    <dialog ref={ref} aria-labelledby={titleId} onClose={p.onClose} className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border-2 border-border bg-surface p-0 text-text shadow-xl">
      {p.open && (
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-start justify-between gap-4">
            <h2 id={titleId} className="text-xl font-semibold">
              {p.title}
            </h2>
            <Button onClick={p.onClose} label="Close">
              ✕
            </Button>
          </div>
          {p.children}
        </div>
      )}
    </dialog>
  );
}

export function Field(p: { label: string; value: string; onChange: (v: string) => void; type?: string; error?: string | undefined; hint?: string; autoFocus?: boolean; inputMode?: 'numeric' | 'text'; maxLength?: number }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-semibold">
        {p.label}
      </label>
      {p.hint && <p className="text-text-muted">{p.hint}</p>}
      <input
        id={id}
        type={p.type ?? 'text'}
        value={p.value}
        autoFocus={p.autoFocus}
        data-autofocus={p.autoFocus || undefined}
        inputMode={p.inputMode}
        maxLength={p.maxLength}
        aria-invalid={p.error ? true : undefined}
        aria-describedby={p.error ? `${id}-err` : undefined}
        onChange={(e) => p.onChange(e.target.value)}
        className="min-h-12 rounded-lg border-2 border-border px-3 text-lg"
      />
      {p.error && (
        <p id={`${id}-err`} role="alert" className="font-semibold text-status-error">
          {p.error}
        </p>
      )}
    </div>
  );
}

export function Banner(p: { tone?: 'info' | 'warn' | 'error'; children: ReactNode }) {
  const tone = { info: 'border-status-occupied', warn: 'border-status-pending', error: 'border-status-error' }[p.tone ?? 'info'];
  const icon = { info: 'ℹ', warn: '⚠', error: '⛔' }[p.tone ?? 'info'];
  return (
    <div className={`flex items-start gap-3 rounded-lg border-2 bg-surface-raised p-3 ${tone}`}>
      <span aria-hidden="true">{icon}</span>
      <div className="flex flex-1 flex-wrap items-center gap-3">{p.children}</div>
    </div>
  );
}

/** 72 px keys; the PIN can also be typed or pasted into the field (WCAG 3.3.8). */
export function PinPad(p: { onSubmit: (pin: string) => unknown; submitLabel: string; error?: string | undefined }) {
  const [pin, setPin] = useState('');
  const add = (d: string) => setPin((x) => (x.length < 8 ? x + d : x));
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void p.onSubmit(pin);
        setPin('');
      }}
    >
      <Field label="PIN (6 to 8 digits)" type="password" inputMode="numeric" maxLength={8} value={pin} onChange={(v) => setPin(v.replace(/\D/g, '').slice(0, 8))} error={p.error} />
      <div className="grid grid-cols-3 gap-2 self-center">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} type="button" onClick={() => add(d)} className="h-18 w-18 rounded-lg border-2 border-border text-2xl font-semibold">
            {d}
          </button>
        ))}
        <button type="button" onClick={() => setPin((x) => x.slice(0, -1))} aria-label="Delete last digit" className="h-18 w-18 rounded-lg border-2 border-border text-xl">
          ⌫
        </button>
        <button type="button" onClick={() => add('0')} className="h-18 w-18 rounded-lg border-2 border-border text-2xl font-semibold">
          0
        </button>
        <span />
      </div>
      <Button type="submit" variant="primary" wide disabled={pin.length < 6}>
        {p.submitLabel}
      </Button>
    </form>
  );
}

/** Polite announcements for screen readers ("All changes sent."). */
export function LiveRegion({ message }: { message: string }) {
  return (
    <div aria-live="polite" className="sr-only">
      {message}
    </div>
  );
}
