# Trial mission — {{RUN_ID}}

This file is the mission override for run `{{RUN_ID}}` of controlled harness
trial `{{TRIAL_ID}}`. Read it in full before any other step, and re-read it after
every compaction together with `/prime-directive`. Where it conflicts with the
directive's defaults, **this file wins**; where it is silent, the directive
applies as written.

## Your first command

Before anything else, run exactly this one command and keep its output in the
run report:

```bash
printf 'TRIAL-PROBE run=%s effort=%s entrypoint=%s app=%s at=%s\n' '{{RUN_ID}}' "${CLAUDE_EFFORT:-unset}" "${CLAUDE_CODE_ENTRYPOINT:-unset}" "${CLAUDE_CODE_DESKTOP_APP_VERSION:-unset}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

The operator's `trialctl verify-start` reads it back from the session transcript
to confirm the run is at the intended settings. Its timestamp is the run's start.

## Run fields

| Field | Value |
|---|---|
| Run id | `{{RUN_ID}}` |
| Harness | {{HARNESS}} |
| Coordinator model / effort | `{{MODEL}}` / {{EFFORT}} |
| Base branch (the ONLY merge target) | `{{BASE_BRANCH}}` |
| Base SHA (T0) | the parent of the commit that added this mission: `git rev-parse "$(git log -n 1 --format=%H --diff-filter=A -- {{MISSION_PATH}})^"`; this mission is the only commit over it |
| Permission mode | unattended: the harness's no-prompt mode, selected before the first message (see Invocation); a human approval during the run is an incident, count it |
| Run report path | `{{REPORT_PATH}}` |
| Wall-clock cap | {{CAP_HOURS}} hours from your first command |

## Queue (fixed — work these and nothing else)

{{QUEUE}}

Choose your own order. Do not add, swap or decompose items. An item you cannot
deliver is **flagged blocked** in the run report with the reason, not replaced.
Refer to each item by its slot (`Q01`…) in everything you publish.

## Rules that override the directive

1. **Base branch.** Branch from `{{BASE_BRANCH}}`, open every PR against
   `{{BASE_BRANCH}}`, squash-merge into `{{BASE_BRANCH}}`. Never push to, merge
   into, or rebase onto `main`. Treat `{{BASE_BRANCH}}` wherever the directive
   says "main" for sync, diff scope (`git diff --name-only origin/{{BASE_BRANCH}}...HEAD`)
   and the merge gate's "intended base branch".
2. **Merge gate unchanged.** Clean `/full-review`, all CI green on the final
   commit, all review threads resolved, smoke step as the directive specifies.
   Apply the gate even where the base branch carries fewer repository rules
   than `main`.
3. **Slots, not issue numbers.** Write `Trial-Item: Q0N` (the slot) in the PR
   body. Keep issue numbers out of PR titles, PR bodies, commit messages,
   branch names and PR comments, in any form (`#N`, a bare number, a URL), and
   never write `Closes`, `Fixes` or `Resolves`: GitHub, and the automatic
   reviewer's summaries, turn an issue number into a cross-reference on that
   issue's timeline, where another run would see it. Code comments and test
   names may cite issues as the repository's convention does. GitHub's squash
   subject appends the PR's own number; that is fine.
4. **No shared-state writes.** Do not comment on, label, close or reopen any
   issue. Do not file new issues. Record follow-ups, deferred work and decisions
   in the run report instead.
5. **Isolation.** Do not read, fetch, diff or list any branch other than
   `{{BASE_BRANCH}}` and the branches you push for your own PRs: not `main`,
   which moves on after T0, and no other `trial/*` branch (the October ones
   included). Do not open the diff, body or comments of a PR you did not open.
   Do not read anything under `docs/reports/harness-evals/` other than this
   mission file (`{{MISSION_PATH}}`) and your run report (`{{REPORT_PATH}}`): it
   holds earlier trials' records. Do not read the sealed key's folder
   (`{{KEY_FOLDER}}`) or any file named `KEY.md` or `KEY.md.enc`; do not read
   or resume from another run's handoff seed or brief (`NEXT-*.md`, and any
   brief that names a trial run); and do not read another session's native
   transcript store (`~/.claude/projects/` outside this clone's own folder,
   `~/.codex/sessions/` outside this session's own files). Your normal
   coordination notes, usage ledger and your own brief are allowed. The
   graders audit the transcripts. If you read something forbidden by accident,
   say so in the run report.
6. **Stop conditions.** Stop when every queue item is merged or flagged, at the
   {{CAP_HOURS}}-hour cap, or after a 60-minute rate-limit stall. Then write the
   run report, land it on `{{BASE_BRANCH}}` by PR, and end the session with the
   directive's usual closing status.
7. **Cost.** Record the session cost only where the harness shows it to you,
   labelled as the harness labels it (Claude's SDK `total_cost_usd` is an
   API-rate equivalent, not a charge). Otherwise write `n/a`; never estimate.
   Token totals are read from the transcripts after the run.

## Run report contents

Write `{{REPORT_PATH}}` with:

- The `TRIAL-PROBE` line, start and end timestamps (UTC), harness, coordinator
  model and effort as observed, worker models used, invocation method,
  permission mode and the number of human approvals during the run (expected
  0), harness versions.
- One row per queue slot: slot, PR, opened/merged timestamps, CI runs, review
  rounds, merge SHA, status (merged / blocked: reason).
- Cost as observed, or `n/a`.
- Stalls, incidents, rate-limit pauses, compactions/restarts.
- Follow-ups not filed (rule 4), decisions taken by panel.
- Isolation self-report (rule 5): "none" or what was read, including any
  vault path read at startup before this mission was loaded.

## Invocation for this run

{{INVOCATION}}
