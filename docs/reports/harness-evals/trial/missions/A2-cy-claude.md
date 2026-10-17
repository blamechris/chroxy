# Trial mission — A2-cy-claude

This file is the mission override for a controlled harness trial. Read it in
full before any other step, and re-read it after every compaction together with
`/prime-directive`. Where it conflicts with the directive's defaults, **this file
wins**; where it is silent, the directive applies as written.

## Run fields

| Field | Value |
|---|---|
| Run id | `A2-cy-claude` |
| Harness | CY — Chroxy session, claude-sdk provider |
| Coordinator model / effort | `claude-opus-5-5` / high |
| Base branch (the ONLY merge target) | `trial/a2-cy-claude` |
| Base SHA (T0) | `git merge-base origin/trial/a2-cy-claude origin/main` — the commit the base was cut from; also recorded in `README.md` on `main` |
| Run report path | `docs/reports/harness-evals/trial/runs/A2-cy-claude/REPORT.md` |
| Wall-clock cap | 12 hours from your first command |

## Queue (fixed — work these and nothing else)

- #8233 — cli: chroxy doctor ignores the configured port and checks 8765 _(type: bug, server)_
- #8215 — isLoopbackHost: the ::ffff:7f prefix match accepts non-loopback mapped addresses _(type: bug, server)_
- #7771 — fix(server): models.js updateContextWindow admits NaN _(type: bug, server)_
- #8595 — bug: custom model collision labels repeat pinned descriptors _(type: bug, store-core)_
- #8364 — app: the lone tool bubble and tool detail modal show no terminated state _(type: bug, app)_
- #8282 — feat(server): record the stream kind on history entries so reasoning text is distinguishable from replies _(type: feature, server + protocol)_
- #8277 — dashboard: Settings hides a saved provider override the connected server does not offer, and never shows the migration notice _(type: feature, dashboard)_
- #8567 — notifications: DEFAULT_BYPASS_CATEGORIES is still hand-copied in both clients _(type: cross-package, protocol + server + app + dashboard)_
- #8303 — server,dashboard: Browse is $HOME-only while Create honours workspaceRoots, and a blank cwd inherits a configured directory that explicit Create would refuse _(type: cross-package, server + dashboard)_
- #7815 — test(server): doctor 'accepts custom port' hardcodes 59123 and asserts pass _(type: test, server tests)_

Choose your own order. Do not add, swap or decompose items. An item you cannot
deliver is **flagged blocked** in the run report with the reason, not replaced.

## Rules that override the directive

1. **Base branch.** Branch from `trial/a2-cy-claude`, open every PR against
   `trial/a2-cy-claude`, squash-merge into `trial/a2-cy-claude`. Never push to, merge
   into, or rebase onto `main`. Treat `trial/a2-cy-claude` wherever the directive
   says "main" for sync, diff scope (`git diff --name-only origin/trial/a2-cy-claude...HEAD`)
   and the merge gate's "intended base branch".
2. **Merge gate unchanged.** Clean `/full-review`, all CI green on the final
   commit, all review threads resolved, smoke step as the directive specifies.
   The base branch may carry fewer repository rules than `main`; apply the gate
   anyway.
3. **Closing keyword.** Write `Trial-Closes: N` (the bare issue number, no `#`)
   in the PR body. Never write `Closes`, `Fixes` or `Resolves` with an issue
   number, and keep `#N` out of PR titles and commit subjects: any `#N` in a PR
   body, title or commit message posts a cross-reference on issue N's timeline.
4. **No shared-state writes.** Do not comment on, label, close or reopen any
   issue. Do not file new issues. Record follow-ups, deferred work and decisions
   in the run report instead.
5. **Isolation.** Do not read, fetch, diff or list any `trial/*` branch other
   than `trial/a2-cy-claude`, nor any PR whose base is one. If you did by accident,
   say so in the run report.
6. **Stop conditions.** Stop when every queue item is merged or flagged, at the
   12-hour cap, or after a 60-minute rate-limit stall. Then write the run report,
   land it on `trial/a2-cy-claude` by PR (a direct push is blocked once the
   `trial/**` ruleset is on), and end the session with the directive's usual
   closing status.
7. **Cost.** Record the session cost where the harness exposes it (`/cost`,
   ccusage, dashboard usage); write `n/a` rather than an estimate.

## Run report contents

Write `docs/reports/harness-evals/trial/runs/A2-cy-claude/REPORT.md` with:

- Start and end timestamps (UTC), harness, coordinator model and effort as
  observed, worker models used, invocation method.
- One row per queue item: issue, PR, opened/merged timestamps, CI runs, review
  rounds, merge SHA, status (merged / blocked: reason).
- Cost as observed, or `n/a`.
- Stalls, incidents, rate-limit pauses, compactions/restarts.
- Follow-ups not filed (rule 4), decisions taken by panel.
- Isolation self-report (rule 5): "none" or what was read.

## Invocation for this run

In the Chroxy dashboard: New Session → provider Claude (SDK) → model claude-opus-5-5 → effort high → worktree isolation off (the clone is already isolated) → working directory = the run's clone. First message:

```
/prime-directive "Trial run A2-cy-claude: follow docs/reports/harness-evals/trial/missions/A2-cy-claude.md exactly"
```

If the slash command is not recognised, send: `Invoke the prime-directive skill with the argument: Trial run A2-cy-claude: follow docs/reports/harness-evals/trial/missions/A2-cy-claude.md exactly` and note "invocation: natural-language skill call" in the run report.
