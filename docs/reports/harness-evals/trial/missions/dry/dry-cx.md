# Dry-run mission — dry-cx

Purpose: prove, before the real trial, that this harness can load
`/prime-directive`, open a PR against a non-`main` base, pass the merge gate and
write a run report. Nothing here touches the issue backlog.

| Field | Value |
|---|---|
| Run id | `dry-cx` |
| Harness | CX — Codex desktop app |
| Model / effort | `gpt-6-astra` / xhigh |
| Base branch (the ONLY merge target) | `trial/dry-cx` |
| Wall-clock cap | 45 minutes |

## The single queue item (synthetic)

Create `docs/reports/harness-evals/trial/runs/dry-cx/PING.md` containing the UTC
timestamp of your first command and the harness name, on a feature branch cut
from `trial/dry-cx`; open a PR against `trial/dry-cx`; run the full merge gate as the
directive specifies (a docs-only change records `smoke: not applicable`); squash
merge into `trial/dry-cx`.

## Rules

Rules 1 to 7 of the real missions apply verbatim (base branch replaces `main`
everywhere; `Trial-Closes:` is moot here since no issue is involved; no issue
comments, labels or new issues; do not read any other `trial/*` branch,
the owner's vault (`~/Obsidian`) or any `KEY.md` / `KEY.md.enc`). Stop at
the 45-minute cap even if unfinished, and write
`docs/reports/harness-evals/trial/runs/dry-cx/REPORT.md` with the run-report
fields from the real mission template, including the invocation method that
actually worked.

## Invocation

Codex desktop app in a fresh clone of `trial/dry-cx`, model gpt-6-astra, reasoning extra-high:

```
/prompts:prime-directive Dry run dry-cx: follow docs/reports/harness-evals/trial/missions/dry/dry-cx.md exactly
```
