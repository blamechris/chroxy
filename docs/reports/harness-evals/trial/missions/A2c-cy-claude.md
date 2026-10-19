# Trial mission — A2c-cy-claude

This file is the mission override for a controlled harness trial. Read it in
full before any other step, and re-read it after every compaction together with
`/prime-directive`. Where it conflicts with the directive's defaults, **this file
wins**; where it is silent, the directive applies as written.

## Run fields

| Field | Value |
|---|---|
| Run id | `A2c-cy-claude` |
| Harness | CY — Chroxy session, claude-sdk provider |
| Coordinator model / effort | `claude-opus-5-5` / high |
| Base branch (the ONLY merge target) | `trial/a2c-cy-claude` |
| Base SHA (T0) | `git merge-base origin/trial/a2c-cy-claude origin/main` — the commit the base was cut from; identified in `README.md` on `main` |
| Permission mode | unattended — the harness's no-prompt mode, selected before the first message (see Invocation); a human approval during the run is an incident, count it |
| Harness versions | record in the report: Chroxy daemon version and codex binary version for Chroxy runs, app version for desktop runs |
| Run report path | `docs/reports/harness-evals/trial/runs/A2c-cy-claude/REPORT.md` |
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

1. **Base branch.** Branch from `trial/a2c-cy-claude`, open every PR against
   `trial/a2c-cy-claude`, squash-merge into `trial/a2c-cy-claude`. Never push to, merge
   into, or rebase onto `main`. Treat `trial/a2c-cy-claude` wherever the directive
   says "main" for sync, diff scope (`git diff --name-only origin/trial/a2c-cy-claude...HEAD`)
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
   than `trial/a2c-cy-claude`, nor any PR whose base is one. In the owner's vault,
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
   land it on `trial/a2c-cy-claude` by PR (a direct push is blocked once the
   `trial/**` ruleset is on), and end the session with the directive's usual
   closing status.
7. **Cost.** Record the session cost where the harness exposes it (Chroxy's
   cost badge or `/cost` for Claude sessions) and label it `SDK-reported
   total_cost_usd`: it is an API-rate equivalent computed from tokens, not a
   charge on a subscription. Write `n/a` rather than an estimate.

## Run report contents

Write `docs/reports/harness-evals/trial/runs/A2c-cy-claude/REPORT.md` with:

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

In the Chroxy dashboard: New Session → provider Claude (SDK) → worktree isolation off (the clone is already isolated) → working directory = the run's clone. A new dashboard session starts on the dashboard's default model, Sonnet 5.5, so set the model first: in the header pick the Opus 5.5 entry labelled `(provider alias)`, then confirm the daemon recorded it for this session before sending: `grep -n "Model change" ~/.chroxy/logs/chroxy.log | tail -2` must show the new session's id and end with `opus` on both lines. Effort is not set from the dashboard: the header's thinking level sets a `maxThinkingTokens` budget, not Claude Code's effort level, and at Auto it sets none, so leave it at Auto. The level comes from the user settings, which the SDK session inherits: `~/.claude/settings.json` → `modelSettings` → `claude-opus-5-5` → `effortLevel: "high"`; confirm it with `grep -A3 modelSettings ~/.claude/settings.json` before the session is created. First message:

```
/prime-directive "Trial run A2c-cy-claude: follow docs/reports/harness-evals/trial/missions/A2c-cy-claude.md exactly"
```

Press Enter once, then keep your hands off that session: Escape in the composer, Cmd+. and the Stop button that takes Send's place all interrupt the turn, and the slash palette's "No commands found" while typing is cosmetic and closes on send.

If the slash command is not recognised, send: `Invoke the prime-directive skill with the argument: Trial run A2c-cy-claude: follow docs/reports/harness-evals/trial/missions/A2c-cy-claude.md exactly` and note "invocation: natural-language skill call" in the run report.

Permission mode: Auto (the dashboard header dropdown; needs `allowAutoPermissionMode: true` in the daemon config), set before the first message and not changed afterwards. The daemon's auto-deploy agent must be unloaded for the whole run (`MAC-BOOTSTRAP.md`, step 9).
