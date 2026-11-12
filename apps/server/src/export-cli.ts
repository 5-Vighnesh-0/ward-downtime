// `pnpm --filter @wdb/server export:decrypt <file.wdbx>` (design.md §7.3). The passphrase is read from stdin:
//   read -rs PASS && echo "$PASS" | pnpm --filter @wdb/server export:decrypt recovery-412.wdbx
// Writes each file next to the input as <name>-<file> and never overwrites an existing file.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWdbx } from './wdbx.ts';

export function decryptToFiles(path: string, passphrase: string): string[] {
  const files = openWdbx(readFileSync(path, 'utf8'), passphrase);
  const stem = basename(path).replace(/\.wdbx$/, '');
  return Object.entries(files).map(([name, content]) => {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || name.startsWith('.')) throw new Error(`refusing odd file name in container: ${JSON.stringify(name)}`);
    const out = join(dirname(path), `${stem}-${name}`);
    writeFileSync(out, content, { flag: 'wx', mode: 0o600 }); // wx: fail rather than overwrite
    return out;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw new Error('usage: export:decrypt <file.wdbx>  (passphrase on stdin)');
  let pass = '';
  for await (const chunk of process.stdin) pass += String(chunk);
  for (const out of decryptToFiles(file, pass.replace(/\r?\n$/, ''))) console.log(`wrote ${out}`);
}
