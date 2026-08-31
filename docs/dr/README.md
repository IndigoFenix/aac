# DR evidence

This folder holds the dated evidence that our disaster-recovery claims have
actually been exercised, rather than merely designed. `drills/` contains one
Markdown file per restore drill, written by `npm run dr:drill -- --execute`
(`scripts/dr-restore-drill.ts`), named `<yyyy-mm-dd>-restore-drill.md` — with a
`-2`, `-3`, … suffix if more than one drill runs on the same day. Each file
records the snapshot restored and when it was taken, the restore start /
available / teardown timestamps, the measured restore duration (the empirical RTO
component), the observed RPO, every smoke check's pass or fail, the operator and
the exact command line. Every drill stays inside `il-central-1`; a copy to any
other region would itself be a cross-border transfer of PHI under AKIM §14. These
files are committed on purpose — they are the §17 contingency-plan evidence, and
an auditor should be able to read the history here without AWS access. The
procedures they exercise, and the RTO/RPO table they feed, live in
[`../DISASTER_RECOVERY.md`](../DISASTER_RECOVERY.md); the verbose per-run
transcript stays in the gitignored `logs/` tree because it echoes AWS resource
identifiers.
