// Runs Synthea (dev/CI only, needs Java 17+) and keeps ONLY "First Last" name labels (SEC-16).
// Every other Synthea field (dates, SSN-like IDs, addresses) is dropped; the raw output
// lives in a temp folder that is always deleted.
// Usage: pnpm synthea:labels --jar <path/to/synthea-with-dependencies.jar> [--count 50] [--seed 1] [--out fixtures/synthea-labels.json]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// RFC 4180 fields for one line (Synthea quotes fields that contain commas).
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      fields.push(cur);
      cur = '';
    } else cur += c;
  }
  fields.push(cur);
  return fields;
}

export function labelsFromPatientsCsv(csv: string): string[] {
  const [header = '', ...rows] = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  const cols = parseCsvLine(header);
  const first = cols.indexOf('FIRST');
  const last = cols.indexOf('LAST');
  if (first < 0 || last < 0) throw new Error('patients.csv has no FIRST/LAST columns');
  return rows.map((row) => {
    const f = parseCsvLine(row);
    return `${f[first] ?? ''} ${f[last] ?? ''}`.trim().slice(0, 40);
  }).filter((l) => l !== '');
}

function main(): void {
  const { values } = parseArgs({
    options: {
      jar: { type: 'string' },
      count: { type: 'string', default: '50' },
      seed: { type: 'string', default: '1' },
      out: { type: 'string', default: 'fixtures/synthea-labels.json' },
    },
  });
  if (!values.jar) throw new Error('--jar <path to synthea-with-dependencies.jar> is required');
  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('--count must be 1..10000');

  const tmp = mkdtempSync(join(tmpdir(), 'wdb-synthea-'));
  try {
    execFileSync(
      'java',
      [
        '-jar', values.jar,
        '-p', String(count),
        '-s', values.seed,
        '--exporter.baseDirectory', `${tmp}/`,
        '--exporter.csv.export', 'true',
        '--exporter.fhir.export', 'false',
        '--exporter.hospital.fhir.export', 'false',
        '--exporter.practitioner.fhir.export', 'false',
        '--exporter.metadata.export', 'false',
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    const labels = labelsFromPatientsCsv(readFileSync(join(tmp, 'csv', 'patients.csv'), 'utf8'));
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, `${JSON.stringify(labels, null, 2)}\n`);
    console.log(`synthea-labels: wrote ${labels.length} labels to ${values.out}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
