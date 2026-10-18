# Trial mission — {{RUN_ID}}

This file is the mission override for a controlled harness trial. Read it in
full before any other step, and re-read it after every compaction together with
`/prime-directive`. Where it conflicts with the directive's defaults, **this file
wins**; where it is silent, the directive applies as written.

## Run fields

| Field | Value |
|---|---|
| Run id | `{{RUN_ID}}` |
| Harness | {{HARNESS}} |
| Coordinator model / effort | `{{MODEL}}` / {{EFFORT}} |
| Base branch (the ONLY merge target) | `{{BASE_BRANCH}}` |
| Base SHA (T0) | `git merge-base origin/{{BASE_BRANCH}} origin/main` — the commit the base was cut from; identified in `README.md` on `main` |
| Permission mode | unattended — the harness's no-prompt mode, selected before the first message (see Invocation); a human approval during the run is an incident, count it |
| Harness versions | record in the report: Chroxy daemon version and codex binary version for Chroxy runs, app version for desktop runs |
| Run report path | `docs/reports/harness-evals/trial/runs/{{RUN_ID}}/REPORT.md` |
| Wall-clock cap | 12 hours from your first command |

## Queue (fixed — work these and nothing else)

{{QUEUE}}

Choose your own order. Do not add, swap or decompose items. An item you cannot
deliver is **flagged blocked** in the run report with the reason, not replaced.

## Rules that override the directive

1. **Base branch.** Branch from `{{BASE_BRANCH}}`, open every PR against
   `{{BASE_BRANCH}}`, squash-merge into `{{BASE_BRANCH}}`. Never push to, merge
   into, or rebase onto `main`. Treat `{{BASE_BRANCH}}` wherever the directive
   says "main" for sync, diff scope (`git diff --name-only origin/{{BASE_BRANCH}}...HEAD`)
   and the merge gate's "intended base branch".
2. **Merge gate unchanged.** Clean `/full-review`, all CI green on the final
   commit, all review threads resolved, smoke step as the directive specifies.
   The base branch may carry fewer repository rules than `main`; apply the gate
   anyway.
3. **Closing keyword.** Write `Trial-Closes: N` (the bare issue number, no `#`)
   in the PR body. Never write `Closes`, `Fixes` or `Resolves` with an issue
   number, and keep issue numbers in `#N` form out of PR titles and commit
   subjects: any issue `#N` in a PR body, title or commit message posts a
   cross-reference on that issue's timeline. GitHub's squash subject appends the
   PR's own number in that form; that is the PR, not an issue, and is fine.
4. **No shared-state writes.** Do not comment on, label, close or reopen any
   issue. Do not file new issues. Record follow-ups, deferred work and decisions
   in the run report instead.
5. **Isolation.** Do not read, fetch, diff or list any `trial/*` branch other
   than `{{BASE_BRANCH}}`, nor any PR whose base is one. In the owner's vault,
   do not read the sealed key's folder
   (`~/Obsidian/no-it-all/reviews/harness-trial-2026-10/`) or any file named
   `KEY.md` or `KEY.md.enc`, and do not read or resume from another run's
   handoff seed or brief (`NEXT-*.md`, and any brief under `briefs/` that names
   a trial run). Your normal
   coordination notes, usage ledger and your own brief are allowed. The graders
   audit transcripts for vault reads. If you read something forbidden by
   accident, say so in the run report.
6. **Stop conditions.** Stop when every queue item is merged or flagged, at the
   12-hour cap, or after a 60-minute rate-limit stall. Then write the run report,
   land it on `{{BASE_BRANCH}}` by PR (a direct push is blocked once the
   `trial/**` ruleset is on), and end the session with the directive's usual
   closing status.
7. **Cost.** Record the session cost where the harness exposes it (Chroxy's
   cost badge or `/cost` for Claude sessions) and label it `SDK-reported
   total_cost_usd`: it is an API-rate equivalent computed from tokens, not a
   charge on a subscription. Write `n/a` rather than an estimate.

## Run report contents

Write `docs/reports/harness-evals/trial/runs/{{RUN_ID}}/REPORT.md` with:

- Start and end timestamps (UTC), harness, coordinator model and effort as
  observed, worker models used, invocation method, permission mode and the
  number of human approvals during the run (expected 0), harness versions.
- One row per queue item: issue, PR, opened/merged timestamps, CI runs, review
  rounds, merge SHA, status (merged / blocked: reason).
- Cost as observed, or `n/a`.
- Stalls, incidents, rate-limit pauses, compactions/restarts.
- Follow-ups not filed (rule 4), decisions taken by panel.
- Isolation self-report (rule 5): "none" or what was read, including any
  vault path read at startup before this mission was loaded.

## Invocation for this run

{{INVOCATION}}
