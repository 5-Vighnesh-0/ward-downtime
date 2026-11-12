// Bootstrap commands (DATABASE_URL). The first admin and their first device cannot be approved through the API.
//   read -rs PIN && echo "$PIN" | pnpm --filter @wdb/server admin add-staff --id S-0001 --role admin --name "First Admin"
//   pnpm --filter @wdb/server admin approve-device --id <deviceId>
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Role } from '@wdb/shared';
import { addStaffMember, approveDevice } from './admin.ts';
import { createDb } from './db.ts';

async function readStdin(): Promise<string> {
  let s = '';
  for await (const chunk of process.stdin) s += String(chunk);
  return s.trim();
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({ args: rest, options: { id: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' } } });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  if (!values.id) throw new Error('--id is required');
  const { db, pool } = createDb(url);
  try {
    if (command === 'add-staff') {
      if (!values.role || !values.name) throw new Error('--role and --name are required');
      await addStaffMember(db, { staffId: values.id, role: values.role as Role, displayName: values.name, pin: await readStdin() });
      console.log(`added ${values.id} (${values.role})`);
    } else if (command === 'approve-device') {
      console.log(`approved ${values.id}, temp-ID prefix ${await approveDevice(db, values.id)}`);
    } else throw new Error('usage: admin add-staff|approve-device --id ...');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
