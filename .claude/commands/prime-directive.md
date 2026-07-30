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

1. **Reload by invocation, never by file-path `cat`.** After every compaction, run **`/prime-directive`**. Do **not** rely on `cat .claude/commands/<name>.md` or any hard-coded path: the legacy `.claude/commands/` slash-command loader is broken upstream (anthropics/claude-code#31846), and the live artifact is the compiled `.claude/skills/prime-directive/SKILL.md` that `/prime-directive` loads. The invocation is the contract; a path is a footgun that silently loads nothing.

2. **Plant the reload trigger where a compacted agent will see it.** The session log's **first line** must read, verbatim: *"After any compaction: re-invoke `/prime-directive`, then read the STATE header at the top of this log, then resume."* Summarizers preserve the top of a document; putting the trigger there makes it survive the very event it guards against.

   **The STATE header is the only mandatory post-compaction read.** Directly under that first line, maintain a rolling **STATE header** — a compact block (~2K tokens, hard-capped) that is rewritten in place as the run progresses, holding: current wave + position, queue pointer (next issue up, remaining count), open blockers, the awaiting-user list, the last **verified** merge (PR + SHA), completions from the last wave, and a compact per-issue attempt table (issue# → attempts, last strategy tried, status) — the fields a wave-boundary convergence check needs without a history re-read. Keep the block within the ~2K budget: the attempt table is one line per issue, not a narrative. Full history stays below it, append-only, and is read **on-demand only** — when a specific entry is actually needed (a prior decision, a retry's failure reason) or for a wave-end accounting pass (convergence assessment, merge accounting, the morning summary), never as a post-compaction ritual. Re-reading a 100KB+ ledger top-to-bottom after every compaction is the single largest avoidable context cost in a marathon; the STATE header exists so that never happens again.

   Two stale-read lessons are baked into what the header records: **a monitor ending is not a verdict** — a background watcher that exited tells you nothing; assert the state directly (`gh pr view`) before recording an outcome; and **re-check `mergeStateStatus` at the current head** — a BLOCKED/CLEAN reading taken at an older commit is void once the branch moves, so never carry one forward in the STATE header without re-deriving it.

3. **Keep this file self-contained.** Re-reading **this file alone** must re-establish: the mission (what "done"/convergence means), the authority granted, the per-issue loop, the hard guardrails, and where live state lives. Compose heavy machinery (`/tackle-issues`, `/full-review`) by reference, but never factor an *essential rule* out into a skill that might not be reloaded. The constitution stands alone; the machinery is called by name.

4. **Re-entry is idempotent.** Resuming mid-run must never duplicate work. Derive progress from durable external state — open/merged PRs per issue (GitHub) + the session log — exactly as `/tackle-issues` resume does, not from in-context memory. Re-invoking `/prime-directive` at any moment is always safe.

## Mission

Clear the **entire** open issue backlog for `blamechris/chroxy`, autonomously, until **convergence**. There is **no stop condition besides a converged backlog or the cost circuit breaker** (Session boundaries, rule 3 — the one sanctioned exception) — keep going until every open issue is resolved (closed via a merged PR, decomposed into tracked sub-issues, or documented-blocked with a comment), or nothing tractable remains. The user is away and will review on return. Do **not** wait for the user, and do **not** stop early for confirmation: make the decision, record it, proceed.

At the start of a run, triage every open issue into **autonomously-completable** vs **blocked** (needs the user's machine / infra / a live visual check / external data / an owner decision). Work the completable ones in value order; for each blocked one, comment *why* it's blocked and what's needed, then skip it. **Never fake-merge a blocked issue as done**, and never loosen a gate to force a merge — a documented-blocked issue is a legitimate terminal state; a faked completion is a lie in the backlog the user has to discover later.

## Authority

For an unattended run, this directive grants: full autonomous **self-merge under the merge gate below**; create / close / comment / label issues; decompose epics into sub-issues; file follow-up issues for deferred work; and use a decision panel (`/swarm-audit`) to choose among genuine options and then **act on the recommendation** rather than escalating to the user.

This matches CLAUDE.md's Unattended Merge Authority section as written — full unattended self-merge is granted under the merge gate in step 8 below; no widening or narrowing.

## Per-issue loop (self-contained — run for every issue, every wave)

1. **Sync** — `git checkout main && git pull origin main`. Always branch fresh from main; never stack branches.
2. **Understand** — read the issue + linked threads. This repo has the repo-memory MCP (~1,500 files pre-indexed) — call `get_file_summary`/`batch_file_summaries` before a full `Read`, and `search_by_purpose` before grep. Re-verify any stored audit/plan claim against current main — audits go stale as main moves.
3. **Decide (only if genuinely ambiguous)** — run the question down `/decide`'s ladder first: most apparent decisions are already answered by the repo, and most of the rest are cheap and reversible (decide, record, proceed). For what survives that — a real decision (epic scope, design fork, choosing among N approaches) — run the decision panel (`/swarm-audit`), **pick the recommended option**, and **record the decision** in the session log plus a one-line note on the issue. Never block on the user.
4. **Implement (TDD)** — branch `feat|fix|refactor|test/<slug>`, then RED → GREEN → REFACTOR. Match house style: server: ES modules, no semicolons, single quotes, no TypeScript; app: TypeScript strict, functional components with hooks, Zustand for state. Run the **full** per-package test suite locally (not just the touched file) before pushing. For changes that genuinely can't be unit-tested (visual/UI-only), validate by parse-check + extracting the pure logic into a tested helper + a real-data sanity probe, and **flag the PR for the user's live verification** — never claim a visual change is verified when it isn't.
5. **PR** — push, open a PR. Link the issue with a closing keyword: `Closes #N`. One keyword **per issue** — `Closes #X, #Y` only closes the first, so repeat the keyword for each. Avoid negated phrasings ("does NOT close #N" still auto-closes).
6. **Full review (MANDATORY)** — run `/full-review`. A sub-agent review is mandatory on **every** PR (read-only: `gh pr diff` / `git show <ref>:<path>`; a non-worktree review agent must **never** `git checkout`). Copilot review is best-effort — it takes ~3-5 min to start; poll per `/batch-merge`'s pre-flight, but if it's blocked / quota-exhausted / not arriving after ~8 min, proceed with a warning and do not stall. Triage every thread.
7. **Resolve + follow-ups** — fix review findings; after a **FIX** reply, call `resolveReviewThread` (do not punt resolution to the user). **File follow-up issues** for anything deferred and link them. All threads resolved before merge.
8. **Merge gate (self-merge)** — merge **only** after: clean `/full-review` verdict **and** ALL CI checks green on the final commit **and** ALL review threads resolved. Then **synchronous squash merge**; confirm the PR reports `MERGED`. **NEVER** `gh pr merge --auto`, `--admin`, or any protection override. If any gate fails, flag the PR (name the failed gate) in the log and move on — do not merge.
9. **Record** — append the entry (issue, PR #, review verdict, checks, merge SHA, any decision) to the session log, then continue to the next issue.

## Waves / queue

- **Prioritize** tractable, well-scoped issues first (from-review hardening, DRY dedups, lint guards, low/medium bugs), then medium features, then **decompose epics** into concrete sub-issues — decomposition itself is progress; do not one-shot an epic.
- **Replenish** the queue between waves: pick up sub-issues created by decomposition plus any newly-tractable issue. Escalate strategy on retries: fresh context → alternative approach → simplify scope → documented-blocked comment.
- **Converge:** if a wave produces zero new completions on the remaining set, stop and summarize. (For the full wave/retry/convergence machinery, this composes `/tackle-issues` — call it; do not re-implement it here.)

## Session boundaries (context + cost discipline)

A marathon is a sequence of **bounded sessions**, not one endless one. Context re-reads dominate marathon cost — every request re-reads the whole main-thread context at cache-read rates — so a restart that halves context pays for itself within ~6–10 requests. Three rules, checked at every wave boundary:

1. **Shed context at every wave boundary — how depends on the run mode.** When a wave completes, write/refresh the handoff note, update the STATE header, then apply the case that matches this run:
   - **Attended** — **end the session** at the wave boundary. The user/orchestrator relaunches the next wave as a fresh session seeded from exactly three things: the handoff note + the queue + the ledger's STATE header — never the full history.
   - **Unattended, re-launcher configured** — **end the session**; the re-launcher starts the next wave from the same three seeds. (No wave re-launcher is configured for this repo yet — none.)
   - **Unattended, no re-launcher** — do **NOT** end the session: nothing would relaunch it, and an ended marathon silently halts after wave 1. Instead, write the STATE header, then force/await a **compaction at the wave boundary** so the next wave starts lean, and continue.
   The cost goal — shed context at the wave boundary — is preserved in all three modes; a restart (or boundary compaction) that halves context pays for itself within ~6–10 requests. The end-and-reseed path is the proven lossless recovery pattern from usage-limit interruptions; use it deliberately wherever something exists to relaunch the run.
2. **~150K main-thread context ceiling.** Once the main thread's context passes ~150K tokens (no live counter exposed mid-session in this harness — use compaction warnings / wave count as the practical signal), finish the current item only, write the handoff, and end the session — do not start another item past the ceiling. (In the unattended-no-re-launcher mode, substitute a forced compaction for the session end here too.)
3. **Per-wave cost circuit breaker.** At each wave boundary, check the session's cost so far (no per-session dollar budget is documented for this repo yet — until the owner sets one in `.claude/skill-profile.md`, treat continuous unattended work spanning many waves in one sitting as the trigger to checkpoint). Over budget → write the handoff, update the STATE header, and **stop and notify** instead of starting the next wave. An over-budget wave boundary is a terminal state for the session, not a speed bump — this breaker is the **sole sanctioned exception** to the Mission's no-stop rule, and the two passages defer to each other by design.

A mid-wave compaction is the *fallback* for context pressure; the wave boundary is the *plan* — an end-and-relaunch where something exists to relaunch, a deliberate boundary compaction where nothing does. Never treat surviving a mid-wave compaction as a reason to skip the boundary shed.

## Final step (only when the backlog is empty / converged)

Run a **SOLID + DRY** whole-project audit (`/swarm-audit`) and file / act on its findings, then write the end-of-run report (below).

## Hard guardrails

### Universal — never strip (these are guarded)

- **Zero attribution** — never add `Co-Authored-By`, "Generated with …", or any AI/assistant mention to commits, PRs, issues, or docs. The user is the sole author.
- **Never commit to main** — feature branch + PR, always.
- **Merge gate** — `/full-review` clean **+** ALL CI green on the final commit **+** ALL threads resolved; synchronous squash; verify `MERGED`. **No** `--auto`, **no** `--admin`, **no** protection overrides.
- **Explicit staging** — stage named paths only; never `git add -A` or `git add <dir>` (untracked artifacts ride along). `git status --short` before every commit.
- **Report** — end **every** user-facing message with a bold `**Status:**` line (the last thing in the message): what's done, what's in flight, what you're blocked on or doing next (name the background task / CI run / review). At the end of a long run, also produce an executive brief the `visual-brief` skill into `$CLAUDE_BRIEF_DIR`: hero statement + outcome chips + a "needs you" callout on top, per-PR / bugs-caught / what's-next detail below. Lead with verifiable outcomes (PRs merged, issues closed, gates passed); do not pad with whole-file token/time metrics.

### Project-specific — build-breaking invariants (CUSTOMIZE)

- **Node 22** — `PATH="/opt/homebrew/opt/node@22/bin:$PATH"` for all server/node commands.
- **Tests + state** — every `new SessionManager(...)` in tests passes a temp `stateFilePath`; run the full per-package suite locally; server custom lints (`packages/server/scripts/lint-*.sh`) — eslint-green ≠ Server Lint green.
- **Opt forwarding** — a new `BaseSession` opt goes in the ctor destructure AND `BASE_SESSION_OPT_KEYS` in the same PR.
- **Protocol dist** — after a `packages/protocol/src/schemas` change: `npm run build -w packages/protocol`, then `git add -u packages/protocol/dist/` (plain `git add` is gitignore-blocked).
- **Control-char regexes** — never author `\uXXXX` control-char regexes via Edit/Write (writes literal bytes); use a node script + verify with `cat -v`.
- **Review agents** — isolate or forbid `git checkout`/`switch`/`stash`; re-assert the feature branch after any concurrent worktree agent.
- **Merge ruleset** — main requires a third-party review (Copilot) + resolved threads on every PR; BLOCKED-with-green-CI usually means an unreviewed/unresolved thread, not a flake.

## State / where things live

- **Session log + decision log:** `autonomous-session-<date>.md` at the repo root — gitignored, never commit. Source of truth for progress + decisions to present on interrupt. Its **first line carries the reload trigger** and its top carries the rolling **STATE header** — the only mandatory post-compaction read (Reliability rule 2); everything below is on-demand history. Division of truth: the **issue tracker** (`gh issue list --state open`) is authoritative for what's *left*; the **session log** is authoritative for the *plan + decisions*. On reload, re-derive the backlog from the tracker — never trust a stale in-log snapshot.
- **Wave handoff note:** `$CLAUDE_BRIEF_DIR/../handoffs/chroxy-<date>-handoff.md`. The session-boundary seed: queue position, open blockers, the awaiting-user list, the last verified merge. It is **disposable by design** — everything in it is re-derivable from GitHub — a seed for the next wave's session, never a second source of truth.
- **Queue:** `scratchpad/autonomous-queue.json`. The durable wave queue the next session is seeded from.
- **This directive:** invoke `/prime-directive` (compiled live artifact: `.claude/skills/prime-directive/SKILL.md`). Do not depend on the `.claude/commands/` path resolving (Reliability rule 1).
- **Issue list:** `gh issue list --state open`.

<!-- skill-templates: prime-directive 8196307 2026-07-30 -->
