# Dry-run mission — dry-cy-claude

Purpose: prove, before the real trial, that this harness can load
`/prime-directive`, open a PR against a non-`main` base, pass the merge gate and
write a run report. Nothing here touches the issue backlog.

| Field | Value |
|---|---|
| Run id | `dry-cy-claude` |
| Harness | CY — Chroxy session, claude-sdk provider |
| Model / effort | `claude-opus-5-5` / high |
| Base branch (the ONLY merge target) | `trial/dry-cy-claude` |
| Wall-clock cap | 45 minutes |

## The single queue item (synthetic)

Create `docs/reports/harness-evals/trial/runs/dry-cy-claude/PING.md` containing the UTC
timestamp of your first command and the harness name, on a feature branch cut
from `trial/dry-cy-claude`; open a PR against `trial/dry-cy-claude`; run the full merge gate as the
directive specifies (a docs-only change records `smoke: not applicable`); squash
merge into `trial/dry-cy-claude`.

## Rules

Rules 1 to 7 of the real missions apply verbatim (base branch replaces `main`
everywhere; `Trial-Closes:` is moot here since no issue is involved; no issue
comments, labels or new issues; do not read any other `trial/*` branch). Stop at
the 45-minute cap even if unfinished, and write
`docs/reports/harness-evals/trial/runs/dry-cy-claude/REPORT.md` with the run-report
fields from the real mission template, including the invocation method that
actually worked.

## Invocation

Chroxy dashboard: New Session → provider Claude (SDK) → model claude-opus-5-5 → effort high → working directory = a fresh clone of `trial/dry-cy-claude`. First message:

```
/prime-directive "Dry run dry-cy-claude: follow docs/reports/harness-evals/trial/missions/dry/dry-cy-claude.md exactly"
```

If the slash command is not recognised, send: `Invoke the prime-directive skill with the argument: Dry run dry-cy-claude: follow docs/reports/harness-evals/trial/missions/dry/dry-cy-claude.md exactly`.
