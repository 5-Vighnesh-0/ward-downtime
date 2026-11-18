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
  const lastBed = new Map<string, string>(); // the last bed the exported rows put each patient in
  const rows = [];
  for (const { serverSeq, serverTime, event: e } of entries) {
    if (e.type === 'WARD_CONFIGURED' || e.type === 'RESOLVE_CONFLICT') continue; // their effect shows in the kept placements
    if (e.type === 'TASK_CREATED' || e.type === 'TASK_COMPLETED' || e.type === 'HANDOFF_NOTE_ADDED') continue; // ward work, not patient movements for the EHR
    const outcome = board.outcomes[e.eventId]?.kind;
    if (e.type === 'ADMIT' && (outcome === 'applied' || outcome === 'held' || outcome === 'rejected')) labels.set(e.payload.patientId, e.payload.label);
    if (e.type === 'RENAME' && outcome === 'applied') labels.set(e.payload.patientId, e.payload.label);
    if (outcome !== 'applied') continue;
    const p = e.payload;
    if (e.type === 'ADMIT') lastBed.set(p.patientId, e.payload.bedId);
    if (e.type === 'TRANSFER') lastBed.set(p.patientId, e.payload.toBedId);
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
  // Patients with no bed now. The rows alone would leave one in their last bed: a transfer that lost a conflict has
  // already emptied it, and a first occupant who lost a conflict has no applied row at all.
  const unplaced = Object.entries(board.patients)
    .filter(([, p]) => p.where.kind === 'unplaced')
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([patientId, p]) => ({ patientId, label: p.label, lastBedId: lastBed.get(patientId) ?? null }));
  const json = JSON.stringify(
    { format: 'wdb-recovery-export/1', classification: CLASSIFICATION, ward: o.ward, source: o.source, generatedAt: o.generatedAt, upToSeq, headHash: last?.hash ?? '0'.repeat(64), events: rows, openConflicts, unplaced },
    null,
    2,
  );
  // The same two lists close the CSV as comment lines, so a CSV-only reader sees them too.
  // Through csvRow like the rows: labels are free text, so the same quoting and formula guard apply.
  const notes = [
    ...openConflicts.map((c) => csvRow(['# open conflict', c.conflictId, c.bedId, ...c.candidates.flatMap((x) => [x.patientId, x.label])])),
    ...unplaced.map((u) => csvRow(['# unplaced', u.patientId, u.label, u.lastBedId ? `no longer in ${u.lastBedId}` : 'not kept in any bed'])),
  ];
  const csv = `# ${CLASSIFICATION} - upToSeq=${upToSeq}\r\n${csvRow([...COLUMNS])}${rows.map((r) => csvRow(COLUMNS.map((c) => r[c]))).join('')}${notes.join('')}`;
  return { json, csv, upToSeq };
}
