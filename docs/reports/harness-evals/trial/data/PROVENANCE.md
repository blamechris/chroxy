# Trial report inputs — provenance

| File | Source | Notes |
|---|---|---|
| `G-codex-EVIDENCE-A.json`, `G-codex-EVIDENCE-B.json` | byte-identical copies of `docs/reports/harness-evals/trial/eval/G-codex/EVIDENCE-{A,B}.json` at commit `ca51d4fe` on `trial/eval-codex` (G-codex's grading evidence, collected 2026-10-22T18:04Z through the GitHub API) | per-PR opened/merged times, cycle minutes, `ci.yml` run counts in the run window, review and comment body counts, diff sizes, strict-key verdicts; per-run anchors and the issue-timeline cross-reference events |
| `runs.json` | the README status table (`../README.md`) and the run reports on each `trial/*` base | per-run harness, model, effort, anchors, cost and incidents, written by the supervisor |
| `tiebreaks.json` | `docs/reports/harness-evals/trial/eval/TIEBREAKS.md` at `6a955c27` on `trial/eval` | the owner's four count-moving rulings, as verdict overrides applied on top of G-codex's strict verdicts; the five convention rulings are applied in the script's column choices |

`../scripts/measures.py` reads these files only and prints the tables in `../REPORT.md`; run
`python3 docs/reports/harness-evals/trial/scripts/measures.py` from the repository root. The
other grader's tables are in `docs/reports/harness-evals/trial/eval/G-claude/GRADING.md` on
`trial/eval-claude` (`4f663eee`); where its conventions differ (own-commit CI counts, all
owner comments) the report says so beside the figure.
