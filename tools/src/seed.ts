// Synthetic seed data (SEC-17, DATA_POLICY.md). Prints JSON to stdout.
// Usage: pnpm seed [--beds 24] [--staff 8] [--patients 20] [--seed 42]
import { faker } from '@faker-js/faker';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export type Role = 'clerk' | 'nurse' | 'charge' | 'admin';

export interface Seed {
  beds: { bedId: string; label: string }[];
  staff: { staffId: string; displayName: string; role: Role }[];
  patients: { patientId: string; label: string }[];
}

export interface SeedOptions {
  beds: number;
  staff: number;
  patients: number;
  seed: number;
}

// Temp-ID prefix reserved for seed data; real prefixes are assigned at device approval.
const SEED_PREFIX = 'SD0';

function inRange(name: string, n: number, min: number, max: number): void {
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer ${min}..${max}`);
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');
const label = () => `${faker.person.firstName()} ${faker.person.lastName()}`.slice(0, 40);

export function makeSeed(o: SeedOptions): Seed {
  inRange('beds', o.beds, 1, 60);
  inRange('staff', o.staff, 1, 9999);
  inRange('patients', o.patients, 0, 9999);
  faker.seed(o.seed);
  const roleFor = (i: number): Role => (i === 0 ? 'admin' : i === 1 ? 'charge' : i % 2 === 0 ? 'clerk' : 'nurse');
  return {
    beds: Array.from({ length: o.beds }, (_, i) => ({ bedId: `B${pad(i + 1, 2)}`, label: `Bed ${i + 1}` })),
    staff: Array.from({ length: o.staff }, (_, i) => ({
      staffId: `S-${pad(i + 1, 4)}`,
      displayName: label(),
      role: roleFor(i),
    })),
    patients: Array.from({ length: o.patients }, (_, i) => ({
      patientId: `T-${SEED_PREFIX}-${pad(i + 1, 4)}`,
      label: label(),
    })),
  };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      beds: { type: 'string', default: '24' },
      staff: { type: 'string', default: '8' },
      patients: { type: 'string', default: '20' },
      seed: { type: 'string', default: '42' },
    },
  });
  const seed = makeSeed({
    beds: Number(values.beds),
    staff: Number(values.staff),
    patients: Number(values.patients),
    seed: Number(values.seed),
  });
  process.stdout.write(`${JSON.stringify(seed, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
