import fc from 'fast-check';

// CI runs a fixed seed so results are reproducible (design.md §12.1). The nightly job picks a new WDB_PROP_SEED once
// for the whole run (each test file loads this module on its own, so a seed drawn here would differ per file) and
// sets WDB_PROP_RUNS=20000. A failure prints its seed; run again with that seed to replay it exactly, then add the
// case as a regression test. The coverage checks in the tests (conflicts seen, tasks completed twice) assume at
// least 1,000 runs.
// The shared package has no Node types (it stays platform-free), so read the environment through globalThis.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const seed = Number(env.WDB_PROP_SEED ?? 42);
const numRuns = Number(env.WDB_PROP_RUNS ?? 1000);
if (!Number.isInteger(seed) || !Number.isInteger(numRuns) || numRuns < 1) throw new Error('WDB_PROP_SEED and WDB_PROP_RUNS must be whole numbers');
fc.configureGlobal({ seed, numRuns });

export { fc };
