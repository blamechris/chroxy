---
description: "A reload-resilient north star for an unattended, multi-wave backlog-clearing marathon — a compact, self-contained constitution you re-invoke after every..."
---

# /prime-directive

A reload-resilient north star for an unattended, multi-wave backlog-clearing marathon — a compact, self-contained constitution you re-invoke after every context compaction to re-establish the mission, the authority you were granted, the per-issue loop, and the never-strip guardrails before resuming. Where `/tackle-issues` and `/autonomous-dev-flow` are the machinery, this is the constitution that keeps a long autonomous run from drifting as its context is summarized and rebuilt.

Invoke it at the **start** of an unattended run to set the mission, and again **after every compaction** to reload it. It does not start work by itself — it re-grounds the agent, then hands off to the marathon machinery (`/tackle-issues`) for the actual wave loop. Treat this file as load-bearing: everything an interrupted, freshly-compacted agent needs to safely resume is here, in one read. Natural-language cues like *"work autonomously / use the prime directive / keep going until the backlog is clean or you're genuinely blocked"* should route here.

## Arguments

- `$ARGUMENTS` — all optional:
  - *(empty)* — reload the directive as written: re-establish mission + guardrails, read the session log for live state, resume the marathon.
  - A path — override the session-log location for this run (default below).
  - A short mission override in quotes — narrow the scope for this run (e.g. `"only label:ready-to-build"`), without editing the file.

## Reliability — the reload contract (read this first)

This skill exists because a long autonomous run is **compacted repeatedly**, and each compaction summarizes (and can quietly distort) the agent's memory of *what it is doing and what the rules are*. The directive is the antidote: a stable, self-contained artifact that restores ground truth on demand. Four rules make that reliable — do not weaken them:

1. **Reload by invocation, never by file-path `cat`.** After every compaction, run **`/prime-directive`**. Do **not** rely on `cat .claude/commands/prime-directive.md` or any hard-coded path: the legacy `.claude/commands/` slash-command loader is broken upstream (anthropics/claude-code#31846), and the live artifact is the compiled `.claude/skills/prime-directive/SKILL.md` that `/prime-directive` loads. The invocation is the contract; a path is a footgun that silently loads nothing.

2. **Plant the reload trigger where a compacted agent will see it.** The session log's **first line** must read, verbatim: *"After any compaction: re-invoke `/prime-directive`, then read this log from the top for live state, then resume."* Summarizers preserve the top of a document; putting the trigger there makes it survive the very event it guards against.

3. **Keep this file self-contained.** Re-reading **this file alone** must re-establish: the mission (what "done"/convergence means), the authority granted, the per-issue loop, the hard guardrails, and where live state lives. Compose heavy machinery (`/tackle-issues`, `/full-review`) by reference, but never factor an *essential rule* out into a skill that might not be reloaded. The constitution stands alone; the machinery is called by name.

4. **Re-entry is idempotent.** Resuming mid-run must never duplicate work. Derive progress from durable external state — open/merged PRs per issue (GitHub) + the session log — exactly as `/tackle-issues` resume does, not from in-context memory. Re-invoking `/prime-directive` at any moment is always safe.

## Mission

Clear the **entire** open issue backlog for `blamechris/chroxy`, autonomously, until **convergence**. There is **no stop condition besides a converged backlog** — keep going until every open issue is resolved (closed via a merged PR, decomposed into tracked sub-issues, or documented-blocked with a comment), or nothing tractable remains. The user is away and will review on return. Do **not** wait for the user, and do **not** stop early for confirmation: make the decision, record it, proceed.

At the start of a run, triage every open issue into **autonomously-completable** vs **blocked** (needs the user's machine / infra / a live visual or device check / external data / an owner decision). Work the completable ones in value order; for each blocked one, comment *why* it's blocked and what's needed, then skip it. **Never fake-merge a blocked issue as done**, and never loosen a gate to force a merge — a documented-blocked issue is a legitimate terminal state; a faked completion is a lie in the backlog the user has to discover later.

## Authority

For an unattended run, this directive grants: full autonomous **self-merge under the merge gate below**; create / close / comment / label issues; decompose epics into sub-issues; file follow-up issues for deferred work; and use a decision panel (`/swarm-audit`, or a decision sub-agent panel) to choose among genuine options and then **act on the recommendation** rather than escalating to the user.

Chroxy authorizes this full grant for unattended runs: self-merge is permitted **strictly under the merge gate below** (clean `/full-review` + ALL CI green on the final commit + ALL review threads resolved, verified `MERGED`). If any gate fails, the PR is flagged for the user with the failed gate named — never merged. No `--admin`, no `--auto`, no protection overrides.

## Per-issue loop (self-contained — run for every issue, every wave)

1. **Sync** — `git checkout main && git pull origin main`. Always branch fresh from main; never stack branches.
2. **Understand** — read the issue + linked threads. Use the repo-memory MCP (`get_file_summary` / `batch_file_summaries` / `search_by_purpose`) before Read/grep to save tokens; Read the full file only for exact implementation/control flow. Re-verify any stored audit/plan claim against current main — audits go stale as main moves.
3. **Decide (only if genuinely ambiguous)** — for any real decision (epic scope, design fork, choosing among N approaches), run the decision panel (`/swarm-audit`), **pick the recommended option**, and **record the decision** in the session log plus a one-line note on the issue. Never block on the user.
4. **Implement (TDD)** — branch `feat|fix|refactor|test/<slug>`, then RED → GREEN → REFACTOR. Match house style: server is ES modules, no semicolons, single quotes, no TypeScript; app is TypeScript (strict), functional components + hooks, Zustand. Run the **full** per-package test suite locally (not just the touched file) before pushing — and the Server custom lints (`packages/server/scripts/lint-*.sh`), since eslint-green ≠ Server Lint green. For changes that genuinely can't be unit-tested (visual/UI-only, device-only), validate by parse-check + extracting the pure logic into a tested helper + a real-data sanity probe (or a Maestro flow where one exists), and **flag the PR for the user's live verification** — never claim a visual change is verified when it isn't.
5. **PR** — push, open a PR. Link the issue with a closing keyword: `Closes #N`. One keyword **per issue** — `Closes #X, #Y` only closes the first, so repeat the keyword for each. Avoid negated phrasings ("does NOT close #N" still auto-closes).
6. **Full review (MANDATORY)** — run `/full-review`. A sub-agent review is mandatory on **every** PR (read-only: `gh pr diff` / `git show <ref>:<path>`; a non-worktree review agent must **never** `git checkout`). Copilot review is best-effort: if it is blocked / quota-exhausted / not arriving, skip it and do not stall. Triage every thread.
7. **Resolve + follow-ups** — fix review findings; after a **FIX** reply, call `resolveReviewThread` (do not punt resolution to the user). **File follow-up issues** for anything deferred and link them. All threads resolved before merge.
8. **Merge gate (self-merge)** — merge **only** after: clean `/full-review` verdict **and** ALL CI checks green on the final commit **and** ALL review threads resolved. Then **synchronous squash merge**; confirm the PR reports `MERGED`. **NEVER** `gh pr merge --auto`, `--admin`, or any protection override. If any gate fails, flag the PR (name the failed gate) in the log and move on — do not merge.
9. **Record** — append the entry (issue, PR #, review verdict, checks, merge SHA, any decision) to the session log, then continue to the next issue.

## Waves / queue

- **Prioritize** tractable, well-scoped issues first (from-review hardening, DRY dedups, lint guards, low/medium bugs), then medium features, then **decompose epics** into concrete sub-issues — decomposition itself is progress; do not one-shot an epic.
- **Replenish** the queue between waves: pick up sub-issues created by decomposition plus any newly-tractable issue. Escalate strategy on retries: fresh context → alternative approach → simplify scope → documented-blocked comment.
- **Converge:** if a wave produces zero new completions on the remaining set, stop and summarize. (For the full wave/retry/convergence machinery, this composes `/tackle-issues` — call it; do not re-implement it here.)

## Final step (only when the backlog is empty / converged)

Run a **SOLID + DRY** whole-project audit (`/swarm-audit`, or `/project-audit` for the holistic multi-agent pass) and file / act on its findings, then write the end-of-run report (below).

## Hard guardrails

### Universal — never strip (these are guarded)

- **Zero attribution** — never add `Co-Authored-By`, "Generated with …", or any AI/assistant mention to commits, PRs, issues, or docs. The user is the sole author.
- **Never commit to main** — feature branch + PR, always.
- **Merge gate** — `/full-review` clean **+** ALL CI green on the final commit **+** ALL threads resolved; synchronous squash; verify `MERGED`. **No** `--auto`, **no** `--admin`, **no** protection overrides.
- **Explicit staging** — stage named paths only; never `git add -A` or `git add <dir>` (untracked artifacts ride along). `git status --short` before every commit.
- **Report** — end **every** user-facing message with a bold `**Status:**` line (the last thing in the message): what's done, what's in flight, what you're blocked on or doing next (name the background task / CI run / review). At the end of a long run, also produce an executive brief via the `visual-brief` skill into the Obsidian vault (`$CLAUDE_BRIEF_DIR`): hero statement + outcome chips + a "needs you" callout on top, per-PR / bugs-caught / what's-next detail below. Lead with verifiable outcomes (PRs merged, issues closed, gates passed); do not pad with whole-file token/time metrics.

### Project-specific — Chroxy build-breaking invariants

- **Node 22** — `PATH="/opt/homebrew/opt/node@22/bin:$PATH"` for all server/node commands.
- **Tests + state** — every `new SessionManager(...)` in tests passes a temp `stateFilePath`; run the full per-package suite locally; server custom lints (`packages/server/scripts/lint-*.sh`) — eslint-green ≠ Server Lint green.
- **Opt forwarding** — a new `BaseSession` opt goes in the ctor destructure AND `BASE_SESSION_OPT_KEYS` in the same PR (forward via `buildBaseSessionOpts` in every subclass).
- **Protocol dist** — after a `packages/protocol/src/schemas` change: `npm run build -w packages/protocol`, then `git add -u packages/protocol/dist/` (plain `git add` is gitignore-blocked). Same hazard for `packages/store-core/dist` — use `npm run typecheck`, never bare `tsc`.
- **Coverage guards** — making a dashboard-only or app-only message type both-clients trips THREE guards (protocol handler-coverage + store-core coverage-lint PENDING_CONTRACT_TYPES + protocol-type-coverage DASHBOARD_ONLY); run the FULL store-core (`vitest run`) + protocol (`npm test`) suites.
- **Control-char regexes** — never author `\uXXXX` control-char regexes via Edit/Write (writes literal bytes); use a node script + verify with `cat -v`.
- **Review agents** — isolate or forbid `git checkout`/`switch`/`stash`; re-assert the feature branch after any concurrent worktree agent (a case-insensitive macOS path or a worktree agent can detach the main checkout's HEAD).
- **Merge ruleset** — main requires a Copilot review + resolved threads on every PR; BLOCKED-with-green-CI usually means an unreviewed/unresolved thread, not a flake.

## State / where things live

- **Session log + decision log:** `autonomous-session-<date>.md` at the repo root (e.g. `autonomous-session-2026-06-16.md`) — **gitignored, never commit**. Source of truth for progress + decisions to present on interrupt. Its **first line carries the reload trigger** (Reliability rule 2). Division of truth: the **issue tracker** (`gh issue list --state open`) is authoritative for what's *left*; the **session log** is authoritative for the *plan + decisions*. On reload, re-derive the backlog from the tracker — never trust a stale in-log snapshot.
- **This directive:** invoke `/prime-directive` (compiled live artifact: `.claude/skills/prime-directive/SKILL.md`). Do not depend on the `.claude/commands/` path resolving (Reliability rule 1).
- **Issue list:** `gh issue list --state open`.

## Customization (as applied for this repo)

Filled from `blamechris/chroxy` CLAUDE.md + `.claude/skill-profile.md`. To re-tune, run `/skill update prime-directive`:

- **Target repository** — `blamechris/chroxy` (Mission).
- **Authority** — full self-merge authorized strictly under the gate (Authority + step 8).
- **Decision mechanism** — `/swarm-audit` (step 3, Authority).
- **Code-intelligence shortcut** — repo-memory MCP before Read/grep (step 2).
- **Branch naming** — `feat|fix|refactor|test/<slug>` (step 4).
- **House style** — server ES-modules/no-semicolons/single-quotes/no-TS; app TS-strict + Zustand (step 4).
- **Third-party review** — Copilot best-effort, skip if not arriving (step 6).
- **Final-step audit** — `/swarm-audit` or `/project-audit` (Final step).
- **Executive brief** — `visual-brief` → `$CLAUDE_BRIEF_DIR` (Report guardrail).
- **Build-breaking invariants** — the Chroxy set above (Hard guardrails).
- **Session-log** — `autonomous-session-<date>.md`, gitignored (State).
