// Recovery export (design.md §7.2, FR-11). Pure, so the server and an offline charge tablet build identical files.
import { replay } from './reducer.ts';
import type { AnyEvent } from './schema.ts';

export interface LedgerLike {
  serverSeq: number;
  serverTime: string;
  hash: string;
  event: AnyEvent;
}

export interface ExportOptions {
  generatedAt: string;
  ward: string | null;
  source: 'server' | 'device';
  deviceLabels: Record<string, string>;
}

const CLASSIFICATION = 'SYNTHETIC DATA - CONFIDENTIAL - WARD DOWNTIME RECOVERY EXPORT';
const COLUMNS = ['serverSeq', 'eventId', 'type', 'patientId', 'label', 'bedId', 'fromBedId', 'toBedId', 'clientTime', 'serverTime', 'deviceLabel', 'staffId'] as const;

/** One RFC 4180 cell. A leading = + - @ tab or CR gets a `'` so spreadsheets never run it as a formula. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: (string | number | null | undefined)[]) => `${cells.map(csvCell).join(',')}\r\n`;

/** Applied patient events at the end of `entries`, in serverSeq order, plus open conflicts. */
export function buildRecoveryExport(entries: readonly LedgerLike[], o: ExportOptions): { json: string; csv: string; upToSeq: number } {
  const board = replay(entries);
  const labels = new Map<string, string>(); // label at the time of each event
  const rows = [];
  for (const { serverSeq, serverTime, event: e } of entries) {
    if (e.type === 'WARD_CONFIGURED' || e.type === 'RESOLVE_CONFLICT') continue; // their effect shows in the kept placements
    const outcome = board.outcomes[e.eventId]?.kind;
    if (e.type === 'ADMIT' && (outcome === 'applied' || outcome === 'held' || outcome === 'rejected')) labels.set(e.payload.patientId, e.payload.label);
    if (e.type === 'RENAME' && outcome === 'applied') labels.set(e.payload.patientId, e.payload.label);
    if (outcome !== 'applied') continue;
    const p = e.payload;
    rows.push({
      serverSeq,
      eventId: e.eventId,
      type: e.type,
      patientId: p.patientId,
      label: labels.get(p.patientId) ?? null,
      bedId: 'bedId' in p ? p.bedId : null,
      fromBedId: 'fromBedId' in p ? p.fromBedId : null,
      toBedId: 'toBedId' in p ? p.toBedId : null,
      clientTime: e.clientTime, // original tablet time, for EHR back-dating only (never ordering)
      serverTime,
      deviceId: e.deviceId,
      deviceLabel: o.deviceLabels[e.deviceId] ?? null,
      staffId: e.staffId,
    });
  }
  const last = entries.at(-1);
  const upToSeq = last?.serverSeq ?? 0;
  const openConflicts = Object.entries(board.conflicts)
    .filter(([, c]) => c.status === 'open')
    .map(([conflictId, c]) => ({
      conflictId,
      bedId: c.bedId,
      candidates: c.candidates.map((x) => ({ eventId: x.eventId, patientId: x.patientId, label: board.patients[x.patientId]?.label ?? null })),
    }));
  const json = JSON.stringify(
    { format: 'wdb-recovery-export/1', classification: CLASSIFICATION, ward: o.ward, source: o.source, generatedAt: o.generatedAt, upToSeq, headHash: last?.hash ?? '0'.repeat(64), events: rows, openConflicts },
    null,
    2,
  );
  const csv = `# ${CLASSIFICATION} - upToSeq=${upToSeq}\r\n${csvRow([...COLUMNS])}${rows.map((r) => csvRow(COLUMNS.map((c) => r[c]))).join('')}`;
  return { json, csv, upToSeq };
}
