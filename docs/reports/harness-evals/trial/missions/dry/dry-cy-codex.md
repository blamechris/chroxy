# Dry-run mission — dry-cy-codex

Purpose: prove, before the real trial, that this harness can load
`/prime-directive`, open a PR against a non-`main` base, pass the merge gate and
write a run report. Nothing here touches the issue backlog.

| Field | Value |
|---|---|
| Run id | `dry-cy-codex` |
| Harness | CY — Chroxy session, Codex app-server provider (ChatGPT connection) |
| Model / effort | `gpt-6-astra` / xhigh |
| Base branch (the ONLY merge target) | `trial/dry-cy-codex` |
| Wall-clock cap | 45 minutes |

## The single queue item (synthetic)

Create `docs/reports/harness-evals/trial/runs/dry-cy-codex/PING.md` containing the UTC
timestamp of your first command and the harness name, on a feature branch cut
from `trial/dry-cy-codex`; open a PR against `trial/dry-cy-codex`; run the full merge gate as the
directive specifies (a docs-only change records `smoke: not applicable`); squash
merge into `trial/dry-cy-codex`.

## Rules

Rules 1 to 7 of the real missions apply verbatim (base branch replaces `main`
everywhere; `Trial-Closes:` is moot here since no issue is involved; no issue
comments, labels or new issues; do not read any other `trial/*` branch). Stop at
the 45-minute cap even if unfinished, and write
`docs/reports/harness-evals/trial/runs/dry-cy-codex/REPORT.md` with the run-report
fields from the real mission template, including the invocation method that
actually worked.

## Invocation

Chroxy dashboard: New Session → provider Codex → ChatGPT subscription → model gpt-6-astra → effort xhigh → working directory = a fresh clone of `trial/dry-cy-codex`. Confirm the header shows gpt-6-astra. First message:

```
/prompts:prime-directive Dry run dry-cy-codex: follow docs/reports/harness-evals/trial/missions/dry/dry-cy-codex.md exactly
```

If `/prompts:` is not expanded, paste the contents of `~/.codex/prompts/prime-directive.md` followed by the line `Dry run dry-cy-codex: follow docs/reports/harness-evals/trial/missions/dry/dry-cy-codex.md exactly`.
