import fc from 'fast-check';

// Fixed seed so CI is reproducible (design.md §12.1). Random-seed nightly runs arrive with the nightly CI job.
fc.configureGlobal({ seed: 42, numRuns: 1000 });

export { fc };
