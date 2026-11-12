// SEC-17 / DATA_POLICY.md: fail the build on anything that looks like a real identifier.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Finding {
  file: string;
  line: number;
  rule: string;
  match: string;
}

interface Rule {
  id: string;
  re: RegExp;
  allow?: (m: RegExpMatchArray) => boolean;
}

const ALLOWED_EMAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i;

const RULES: Rule[] = [
  { id: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { id: 'mrn', re: /\bMRN\s*[:#]?\s*\d{6,}\b/gi },
  {
    id: 'email',
    re: /\b[\w.+-]+@((?:[\w-]+\.)+[a-z]{2,})\b/gi,
    allow: (m) => ALLOWED_EMAIL_DOMAIN.test(m[1] ?? ''),
  },
  { id: 'dob-field', re: /["']?\b(dob|date_?of_?birth|birth_?date)\b["']?\s*[:=]/gi },
];

export function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((lineText, i) => {
    for (const rule of RULES) {
      for (const m of lineText.matchAll(rule.re)) {
        if (rule.allow?.(m)) continue;
        findings.push({ file, line: i + 1, rule: rule.id, match: m[0] });
      }
    }
  });
  return findings;
}

function repoFiles(): string[] {
  // Tracked + untracked-but-not-ignored, so generated fixtures are checked before commit.
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
  });
  // pnpm-lock.yaml holds only third-party package metadata (it quotes maintainers' emails), never our data.
  return out.split('\0').filter((f) => f && f !== 'pnpm-lock.yaml');
}

function main(): void {
  const findings: Finding[] = [];
  for (const file of repoFiles()) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // deleted in the working tree
    }
    if (text.includes('\0')) continue; // binary
    findings.push(...scanText(file, text));
  }
  for (const f of findings) console.error(`${f.file}:${f.line} [${f.rule}] ${f.match}`);
  if (findings.length > 0) {
    console.error(`synthetic-check: ${findings.length} real-looking identifier(s) found`);
    process.exit(1);
  }
  console.log('synthetic-check: ok');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
