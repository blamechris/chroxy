# Trial mission — B1-cx

This file is the mission override for a controlled harness trial. Read it in
full before any other step, and re-read it after every compaction together with
`/prime-directive`. Where it conflicts with the directive's defaults, **this file
wins**; where it is silent, the directive applies as written.

## Run fields

| Field | Value |
|---|---|
| Run id | `B1-cx` |
| Harness | CX — Codex desktop app in a fresh clone |
| Coordinator model / effort | `gpt-6-astra` / xhigh |
| Base branch (the ONLY merge target) | `trial/b1-cx` |
| Base SHA (T0) | `TBD — set when trial/* branches are cut` |
| Run report path | `docs/reports/harness-evals/trial/runs/B1-cx/REPORT.md` |
| Wall-clock cap | 12 hours from your first command |

## Queue (fixed — work these and nothing else)

**NOT YET SET — owner picks from the candidate list; see ../queue.md**

Choose your own order. Do not add, swap or decompose items. An item you cannot
deliver is **flagged blocked** in the run report with the reason, not replaced.

## Rules that override the directive

1. **Base branch.** Branch from `trial/b1-cx`, open every PR against
   `trial/b1-cx`, squash-merge into `trial/b1-cx`. Never push to, merge
   into, or rebase onto `main`. Treat `trial/b1-cx` wherever the directive
   says "main" for sync, diff scope (`git diff --name-only origin/trial/b1-cx...HEAD`)
   and the merge gate's "intended base branch".
2. **Merge gate unchanged.** Clean `/full-review`, all CI green on the final
   commit, all review threads resolved, smoke step as the directive specifies.
   The base branch may carry fewer repository rules than `main`; apply the gate
   anyway.
3. **Closing keyword.** Write `Trial-Closes: #N` in the PR body. Never write
   `Closes`, `Fixes` or `Resolves` with an issue number.
4. **No shared-state writes.** Do not comment on, label, close or reopen any
   issue. Do not file new issues. Record follow-ups, deferred work and decisions
   in the run report instead.
5. **Isolation.** Do not read, fetch, diff or list any `trial/*` branch other
   than `trial/b1-cx`, nor any PR whose base is one. If you did by accident,
   say so in the run report.
6. **Stop conditions.** Stop when every queue item is merged or flagged, at the
   12-hour cap, or after a 60-minute rate-limit stall. Then write the run report,
   commit it to `trial/b1-cx` (direct commit or PR, either is fine), and end
   the session with the directive's usual closing status.
7. **Cost.** Record the session cost where the harness exposes it (`/cost`,
   ccusage, dashboard usage); write `n/a` rather than an estimate.

## Run report contents

Write `docs/reports/harness-evals/trial/runs/B1-cx/REPORT.md` with:

- Start and end timestamps (UTC), harness, coordinator model and effort as
  observed, worker models used, invocation method.
- One row per queue item: issue, PR, opened/merged timestamps, CI runs, review
  rounds, merge SHA, status (merged / blocked: reason).
- Cost as observed, or `n/a`.
- Stalls, incidents, rate-limit pauses, compactions/restarts.
- Follow-ups not filed (rule 4), decisions taken by panel.
- Isolation self-report (rule 5): "none" or what was read.

## Invocation for this run

In the Codex desktop app open the run's clone, set model gpt-6-astra and reasoning extra-high, then type:

```
/prompts:prime-directive Trial run B1-cx: follow docs/reports/harness-evals/trial/missions/B1-cx.md exactly
```
