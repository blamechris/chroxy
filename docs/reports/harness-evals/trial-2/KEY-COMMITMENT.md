# Sealed key commitment — harness trial 2

The owner's answer key for the trial-2 queue is sealed outside the repository
(vault path `~/Obsidian/no-it-all/reviews/harness-trial-2/KEY.md`, encrypted at
rest until the last run has ended). This file commits to its contents before T0,
so any later edit is detectable; `trialctl verify-key` checks an unsealed copy
against the table below.

| Field | Value |
|---|---|
| Sealed at (UTC) | not sealed yet |
| SHA-256 of `KEY.md` | not sealed yet |
| Size | not sealed yet |
| Dry grading | not done yet (PLAN.md §5 step 2) |
| Verify | `python3 docs/reports/harness-evals/runner/trialctl.py --trial docs/reports/harness-evals/trial-2 verify-key <path to KEY.md>` |

The digest is of the plaintext `KEY.md`. A changed key before T0 means a
replacement table here (the old digest stays in git history); after T0 the key
is frozen, and a mismatch at unseal is reported as an incident.
