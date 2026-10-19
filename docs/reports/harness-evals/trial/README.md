# Controlled harness trial — runbook

Design: [`PROTOCOL.md`](PROTOCOL.md). Missions: [`missions/`](missions/). Grader
prompts: [`graders/`](graders/). This file is the step list and the live status.

## Status

| Item | Value |
|---|---|
| T0 (base SHA) | the squash-merge commit of the PR that last changed this row (re-cut after the dry-run findings landed, so the clones carry the corrected rules); the four run bases `trial/a1-cd`, `trial/b2-cy-codex`, `trial/a2-cy-claude`, `trial/b1-cx` fast-forward to it, and an existing clone follows with `git pull --ff-only` — verify with `git merge-base origin/trial/a1-cd origin/main`. The three `trial/dry-*` branches keep their evidence and stay on the previous cut |
| Queue | set 2026-10-17, 10 issues — see [`queue.md`](queue.md) |
| Sealed key | sealed 2026-10-17T23:17Z; SHA-256 committed in [`KEY-COMMITMENT.md`](KEY-COMMITMENT.md) |
| Run 1 `A1-cd` | **done** — started 2026-10-18T04:07Z (first command), report PR merged 06:06:54Z; Claude desktop app 2.42304.0 (e7f60e), Claude Code 2.1.296, Opus 5.5 / high, unattended, 0 human approvals; 10 of 10 queue items merged into `trial/a1-cd` (tip `fe7ea87e`); cost `n/a` (not exposed by the desktop app); 1 security finding withheld to the owner privately; report: `runs/A1-cd/REPORT.md` on `trial/a1-cd` |
| Run 2 `B2-cy-codex` | **ended early 2026-10-18T07:52:22Z**, killed by the daemon's auto-deploy (cause at the end of this row) — started 07:29Z in the Chroxy dashboard (daemon v0.11.4 at `59b77bb9` for the whole run), provider Codex app-server, ChatGPT connection, gpt-6-astra / xhigh, permission mode Auto, sandbox default (workspace-write), worktree isolation off; `/prompts:prime-directive` expanded; unattended; no human approvals observed; 2 PRs opened against `trial/b2-cy-codex` (8645 for 7771 at 07:45Z and 8646 for 8595 at 07:51Z, both green, left open as evidence), 0 merged, no report; clone `~/trial/b2-cy-codex` at T0. Cause: #8644 merged to `main` at 07:46Z; the idle-only auto-deploy tick judged the daemon idle while the codex session was still active (codex events every few seconds up to 07:52:16Z), sent SIGTERM six seconds later at 07:52:22Z and restarted onto `91956e79` at 07:52:41Z; the restored session failed with "Codex native restore: this saved session has no native locator", so the session was lost. Counted as a Chroxy harness incident (two daemon defects to file); whether B2 is re-run is recorded here when decided |
| Run 3 `A2-cy-claude` | **done** — started 2026-10-18T16:03Z (owner's send; the report's first command 16:04:16Z), report written 18:01:27Z, report PR merged 18:14:56Z; Chroxy dashboard, daemon v0.11.4 at `91956e79` (deploy agent unloaded at 15:58Z), provider Claude (SDK), coordinator `claude-opus-5-5`, workers Sonnet 5.5 (42 subagents, all foreground), permission mode Auto, unattended, 0 human approvals; `/prime-directive` recognised; 10 of 10 queue items merged into `trial/a2-cy-claude` (tip `bc0b6c9e`); cost $22.18 (Chroxy cost badge, the SDK-reported `total_cost_usd`, an API-rate equivalent and not a charge), the report's transcript-priced lower bound $22.64; Claude meters at start 5-hour 15%, weekly 30%; incidents self-reported: one foreground CI watch moved to the background by the harness at 17:27Z, one flaky server test (PR 8657) and one Repo Relay notify failure (PR 8656) each cleared by a single re-run, two merge attempts blocked by the review-comment merge gate until the comment was posted, and a real Windows path-canonicalisation bug surfaced by CI on PR 8656 (2 of that PR's 5 review rounds); report: `runs/A2-cy-claude/REPORT.md` on `trial/a2-cy-claude`. **Deviation (effort):** the effective effort was Claude Code's Opus 5.5 default, `medium`, not run 1's `high`: Chroxy's thinking-level control sets a thinking-token budget (`maxThinkingTokens`), not Claude Code's effort level, and at Auto it sets none; `~/.claude/settings.json` held no saved level. Found 33 minutes in with nine PRs open; the owner kept the run as an extra data point (CY-claude at medium). The run report states effort `high`, a value the coordinator did not read (Claude Code exposes the active level to Bash as `CLAUDE_EFFORT`); this row is authoritative on that point. The controlled arm-A run (Opus 5.5 / high) is still outstanding after run 5's two attempts (below) |
| Run 4 `B1-cx` | **done** — the report's conservative cap anchor is 2026-10-18T18:32:41Z, set before its first command (owner's message 18:33Z); fixed-queue cutoff 20:55:44Z, report PR 8673 merged 21:10:42Z; Codex desktop app 26.1013.40934 (build 20770, prod channel), Codex CLI 0.163.0, coordinator `gpt-6-astra` / xhigh, workers `gpt-6.1-sol` / high; approvals control "Approve for me", observed as an automatic approval reviewer: 0 human approvals, two scoped sandbox escalations granted without a human; the report observes the sandbox as workspace-write / on-request with network disabled, neither the mission's full access nor its never-ask (setup deviation; the owner reported no change to the setting during the run); invocation: the report says the first message carried the expanded directive and the agent also read the compiled skill and the user-global prompt file, native discovery not verified; 9 of 10 queue items merged into `trial/b1-cx` (tip `3a521964`); item 8282 flagged blocked ("acceptance already fulfilled at T0"), no PR (run 3 answered the same finding with a test-only PR); one earlier attempt on 8303 (PR 8671) closed unmerged after Windows CI failures and retried as PR 8672; 5 compactions, 0 restarts; cost `n/a` (no harness-exposed total), the ChatGPT usage-page figure to be recorded when the owner reads it; incidents self-reported: startup reads batched before the mission load (an allowed coordination note among them), a process listing that exposed another trial's command line (not opened or used), the automatic review rejecting a PR-number squash subject once (GitHub shows every merged subject without a PR number), and the Windows CI failures above; report: `runs/B1-cx/REPORT.md` on `trial/b1-cx` |
| Run 5 `A2b-cy-claude` (A2 re-run at `high`) | **done, attempt 2, with a model deviation** — started about 2026-10-19T00:52Z (owner's send; the report's first command 00:52:53Z), report written 02:35Z, report PR 8687 merged 02:45:22Z, about 1 h 42 min of the 12 h cap; Chroxy dashboard, a new session on the same clone and base after attempt 1 (below); daemon v0.11.4 at `91956e79` (deploy agent absent from `launchctl list` and clone clean at `fef086cd`, both checked minutes before the start); provider Claude (SDK); permission mode Auto (inferred: the report records no human prompts; the header setting was not captured), unattended, 0 human approvals; `/prime-directive` recognised; 9 of 10 queue items merged into `trial/a2b-cy-claude` (tip `f882b5e9`), item 8282 verified already satisfied on the base with no PR (run 3 answered the same finding with a test-only PR, run 4 flagged it blocked); cost $15.55 (Chroxy cost badge, the SDK-reported `total_cost_usd`, an API-rate equivalent and not a charge; the report says `n/a` because the agent cannot see the badge); context 509.8k tokens at the end; no implementation subagents (the coordinator implemented every item itself), reviewers `sonnet` subagents, one Codex read-only review pass (`gpt-6-sol`) on PR 8685; incidents self-reported: two merge attempts blocked by the review-comment merge gate until the comment was posted, one CI watch moved to the background by the harness and stopped at once, and during the PR 8683 smoke the isolated preview daemon's New Session fell back to the `claude-cli` provider, which registered a permission hook in the user-level `~/.claude/settings.json`; the agent stopped that preview daemon and reports the file intact with the `modelSettings` entry and no hook left (a Chroxy defect to file after the trial; the trial daemon was not touched); one PR body (8685) carries a `#8011` reference, outside the queue (supervisor's read, not in the report); vault: smoke evidence written, and after the report a handoff seed (`NEXT-a2b-cy-claude.md`) and a usage-ledger row, writes the mission allows, plus a brief under `~/.claude/briefs/`; the isolation self-report lists no forbidden read; report: `runs/A2b-cy-claude/REPORT.md` on `trial/a2b-cy-claude`. **Deviation (model and effort):** the session ran on the daemon's new-session default, `claude-sonnet-5-5` (header "Default (Sonnet 5.5 (pinned 5.5))"; the report's own model id), not `claude-opus-5-5`: the header model was not changed on the new session before the send, although the mission's invocation says to confirm Opus 5.5 in the header first; the saved `modelSettings.claude-opus-5-5.effortLevel = high` does not apply to Sonnet 5.5, so the effort was that model's default, `medium`, by configuration (the applied level was again not read; Claude Code exposes it to Bash as `CLAUDE_EFFORT`). Attempt 2 is therefore a CY-claude data point at Sonnet 5.5 / medium, and the controlled arm-A run (Opus 5.5 / high) is still outstanding; **Third attempt prepared, and deferred on the supervisor's recommendation (the owner started run 6 instead):** `A2c-cy-claude` on a new base `trial/a2c-cy-claude` (tip `78ad56cd`, the mission as the only commit over T0; `scripts/runs.json` entry and mission on `main`), with the header model set first and verified from the daemon log before the send; deferred past the owner's weekly Claude usage reset (Wednesday 16:00 local, 2026-10-21T23:00Z): before run 6 was started on 2026-10-19 the owner's meters read 5-hour 30%, weekly 66%, Fable (separate weekly limit) 41%, and the weekly meter had moved from 50% at attempt 1's start to 66%, with attempt 2 the only trial run in between, so an Opus 5.5 / high run risked a mid-run rate-limit pause; run 6 runs first. **Attempt 1 (setup incident, not a run result):** sent about 2026-10-18T23:07Z (the send is not logged) on the `opus` alias (header "Opus 5.5 (provider alias)"; daemon log `Model changed to opus` at 23:06:44Z), header thinking level Auto, permission mode Auto, worktree isolation off; the daemon logged `[ws] Interrupt from <client>` at 23:07:08.953Z, within seconds of the send and 2 seconds before Claude Code's init (23:07:11.061Z, `claude-opus-5-5`, the alias resolved by the installed Claude Code: the attempt-1 transcript records `version` 2.1.296 and `claude --version` reads 2.1.296 from a binary dated 2026-10-10, past both the v2.1.251 per-model settings release and the v2.1.280 alias change), then `query: $0.0000 in 38ms` and `Query aborted after user stop`; Claude Code's transcript records no model usage (`modelUsage` empty, `totalCostUSD` 0) and its last conversation entry is a single user message, "[Request interrupted by user]"; the agent produced nothing (no PR, base tip and clone unchanged) and the session sat idle from 23:07:13Z while the dashboard chat showed only the owner's message (owner's screenshot and report); diagnosed between about 00:40Z and 00:50Z from the process list, the daemon log and the transcript. Cause: an interrupt from the owner's dashboard client (the client that had set the model at 23:06:44Z); every interrupt path in the dashboard is user-initiated: Escape in the composer with no picker open, Cmd+. (also the command palette's Interrupt entry), the Stop button that takes Send's place while a turn runs, and the Control Room's Interrupt button; which one was pressed is not confirmed. Counted as a setup incident with a Chroxy UX contributing cause (two dashboard issues to file after the trial); the idle attempt-1 session is left in place as evidence; about 105 minutes passed before the restart. Claude meters at attempt 1's start: 5-hour 28%, weekly 50% (not re-read at attempt 2). Run 3 stays the Opus 5.5 / medium data point |
| Run 6 `B2b-cy-codex` (B2 re-run) | **started about 2026-10-19T04:16Z** (owner's "just sent"; the first command and the cap end, 12 hours after it, will be taken from the run report); daemon v0.11.4 at `91956e79`, no restart observed since 2026-10-18T07:52:41Z (PID last read about 23:00Z on 2026-10-18, not re-read at the start); deploy agent confirmed absent from `launchctl list` just after the clone; set per the step list and not yet observed from outside the session: a Chroxy dashboard session, provider Codex app-server, ChatGPT connection, header gpt-6-astra / xhigh, permission mode Auto, sandbox left on the `Default` option (workspace-write on this daemon), worktree isolation off, `/prompts:prime-directive` as the first message (expansion or the pasted-prompt fallback to be read from the report); the model is to be confirmed from the run report's own model line; clone `~/trial/b2b-cy-codex` at `f905a021`, the mission commit over T0 (`932bd3a4`); decided by the owner on 2026-10-18 after run 2 was killed by the daemon's auto-deploy (see run 2); the daemon must not restart while it is live, since this daemon build cannot restore a Codex app-server session; started ahead of run 5's third attempt, which waits for the owner's weekly Claude usage reset (see run 5) |
| Dry runs | 3 of 3 complete 2026-10-18 — see [`DRY-RUNS.md`](DRY-RUNS.md); vault rule narrowed and permission-mode control added as a result |
| `Trial-Closes:` scratch check | done 2026-10-18T03:55Z — `Trial-Closes: 8630` added to the body of merged dry PR 8621; scratch issue 8630 stayed open with no cross-reference and no closing link, then closed by hand |
| Grading | not started |

## Who can do what

The cloud supervisor session (where this runbook was written) reaches GitHub, the
Claude Code Remote session list and its own cloud sessions. It cannot reach the
Mac: it cannot start the Claude or Codex desktop apps or the Chroxy daemon, and a
message it sends into a running session arrives as peer data, not owner
authority, which a prime-directive run needs to self-merge. So the owner launches
every subject run and types its invocation; the supervisor prepares, observes,
measures and grades. Steps are tagged **[owner]** or **[supervisor]**. The owner-side commands are
collected in [`MAC-BOOTSTRAP.md`](MAC-BOOTSTRAP.md), written to be handed to a
local Claude session in the chroxy checkout.

## Steps

1. **[supervisor → owner] Queue candidates.** The supervisor delivers a candidate
   table (12 primary + 4 alternates, rejected issues listed with the rule that
   excluded them). **[owner]** picks 8–12 and replies with the numbers.
   **[supervisor]** enters them in `scripts/queue.json`, runs
   `python3 scripts/render_missions.py`, commits.
2. **[owner] Sealed key.** For each queue issue write a private note in the vault
   (suggested: `~/Obsidian/no-it-all/reviews/harness-trial-2026-10/KEY.md`):
   expected root cause, acceptance checks, known-fix yes/no. Nothing from it goes
   into the repository until step 11. Then seal it: `shasum -a 256 KEY.md`, hand
   the digest to the supervisor for [`KEY-COMMITMENT.md`](KEY-COMMITMENT.md), and
   encrypt the plaintext so the live copy is unreadable to any process on the Mac:
   `openssl enc -aes-256-cbc -pbkdf2 -salt -in KEY.md -out KEY.md.enc && rm KEY.md`.
   If the digest is already in `KEY-COMMITMENT.md`, confirm `shasum` matches it
   before encrypting; a mismatch (an editor re-save, for instance) means a
   replacement table before run 1. The digest is of the plaintext; keep the
   passphrase out of the repo and the vault. macOS's `/usr/bin/openssl` is
   LibreSSL: confirm once that it accepts `-pbkdf2`, and decrypt with the same
   binary. Sync and backup copies of the plaintext are covered by the digest and
   the grader audit, not by the `rm`.
3. **[owner, Mac] Dry-run clones, then compile the Codex prompts for the dry
   runs** from one of them, so the dry runs exercise the same skill text as this
   package (`MAC-BOOTSTRAP.md` steps 1–2). The prompts are recompiled from a `T0`
   clone in step 7 before run 1; the compile SHA goes in each run report.
   ```bash
   export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
   for r in dry-cy-claude dry-cy-codex dry-cx; do
     git clone --branch "trial/$r" https://github.com/blamechris/chroxy "$HOME/trial/$r"
     (cd "$HOME/trial/$r" && npm install)
   done
   (cd "$HOME/trial/dry-cx" && node scripts/compile-skill-targets.mjs --targets codex)
   ls ~/.codex/prompts/prime-directive.md ~/.codex/prompts/tackle-issues.md ~/.codex/prompts/full-review.md ~/.codex/prompts/swarm-audit.md ~/.codex/prompts/session-lifecycle.md
   ```
4. **[owner, GitHub] Ruleset for `trial/**`.** Settings → Rules → Rulesets → New
   branch ruleset, target `refs/heads/trial/**`, copy `main`'s required status
   checks, required conversation resolution, block-force-push and, if `main`
   gets it from a ruleset rule, "Automatically request Copilot code review"
   (otherwise the Copilot review count is 0 by construction). Optional but
   recommended: without it the merge gate relies on the skill alone.
   **Also optional:** add `'trial/**'` to `on.push.branches` in
   `.github/workflows/ci.yml` (a one-line PR to `main`, merged before T0) so a
   merge into a trial base runs CI; without it the "red CI on the base after a
   merge" measure in `PROTOCOL.md` §6 is `not observable`.
5. **Dry runs (one tiny docs-only issue, 45-minute cap, not a queue issue).**
   **[supervisor]** cuts `trial/dry-cy-claude`, `trial/dry-cy-codex` and
   `trial/dry-cx` from `main` at T0, like the four bases; a dry branch
   fast-forwards with the bases on a re-cut only until a dry run has committed
   to it, after which it stays on its cut as evidence. The dry missions are in
   [`missions/dry/`](missions/dry/) and use a synthetic docs-only task, so no
   backlog issue is touched. **[owner]** also opens one scratch issue, writes
   `Trial-Closes: <its number>` (no `#`) in a dry-run PR body, and confirms the
   scratch issue's timeline shows no event and the issue stays open; then
   closes the scratch issue by hand.
   **[owner]** launches each harness exactly as its real invocation says, with
   the dry mission. **[supervisor]** verifies on GitHub that the skill loaded, a
   PR targeted the dry base, the gate completed and a run report was written,
   and lists blockers. Fix blockers before run 1 (step 8); if a fix lands on
   `main` after the bases were cut, step 6 re-cuts them. Keep the dry branches
   until the trial report is written; they are its evidence. **The three dry
   runs are done (2026-10-18, see [`DRY-RUNS.md`](DRY-RUNS.md)), and the
   `Trial-Closes:` scratch-issue check was done 2026-10-18T03:55Z (status
   table above).**
6. **[supervisor, on the owner's explicit go] Cut the bases.** Only after this
   package has merged, since the clones must contain the missions. T0 is the
   `main` commit the bases are cut from; the missions do not bake it in (a
   clone cut from T0 cannot contain its own SHA) but derive it with
   `git merge-base origin/<base> origin/main`, and the status table above
   identifies the PR whose merge commit it is. Dry runs may still be in progress
   when the bases are cut; if a dry run forces a fix to the package, the fixing
   PR updates the T0 row and the bases are re-cut from its merge commit before
   run 1 (nothing is on them until then).
7. **[owner, Mac] Four fresh clones**, one per run, never the daemon's checkout.
   Use the same git identity in all four (the diagnostic found a second identity
   on the daemon checkout that confounded attribution):
   ```bash
   export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
   NAME="$(git config --global user.name)"; EMAIL="$(git config --global user.email)"
   echo "identity for all four clones: $NAME <$EMAIL>"   # must be your GitHub identity
   for r in a1-cd b2-cy-codex a2-cy-claude b1-cx; do
     git clone --branch "trial/$r" https://github.com/blamechris/chroxy "$HOME/trial/$r"
     git -C "$HOME/trial/$r" config user.name  "$NAME"
     git -C "$HOME/trial/$r" config user.email "$EMAIL"
     (cd "$HOME/trial/$r" && npm install)
   done
   (cd "$HOME/trial/a1-cd" && node scripts/compile-skill-targets.mjs --targets codex && git rev-parse HEAD)  # recompile at T0; note the SHA
   ```
8. **Run 1 — `A1-cd`.** **[owner]** waits for the Claude weekly reset if the
   allowance is low, tells the supervisor "starting A1-cd" (that timestamp is the
   run's start), sets the no-prompt permission mode before the first message,
   then follows `missions/A1-cd.md` → *Invocation*.
   **[supervisor]** arms a 3-hour check-in, watches PRs and CI on `trial/a1-cd`
   and the CCR session list, and reports stalls (> 90 min quiet), red CI on the
   base (only observable if step 4's push trigger was added), or rule violations
   (a PR to `main`, a `Closes #`, a `#N` in a title, an issue comment).
   It never messages the running session. When the session ends, **[owner]**
   says "done" and adds the cost if the harness showed one; **[supervisor]**
   confirms `runs/A1-cd/REPORT.md` is on the base, records the end time,
   disarms the check-in.
9. **Run 2 — `B2-cy-codex`.** Same as step 8 with `missions/B2-cy-codex.md`.
   **[owner]** records the Codex cost from the ChatGPT usage page (the harness
   does not expose it) and confirms the session header shows `gpt-6-astra`
   before the first message (#8609).
10. **Run 3 — `A2-cy-claude`**, then **Run 4 — `B1-cx`.** Same pattern. Runs
    never overlap; between runs wait for the relevant vendor's reset if needed.
11. **[owner] Unseal.** Decrypt straight into a clone of `trial/eval` (the
    supervisor creates the branch), never back into the vault where Obsidian
    could re-save it:
    `openssl enc -d -aes-256-cbc -pbkdf2 -in ~/Obsidian/no-it-all/reviews/harness-trial-2026-10/KEY.md.enc -out <clone>/docs/reports/harness-evals/trial/eval/KEY.md`,
    then `shasum -a 256` on that file and confirm it matches `KEY-COMMITMENT.md`
    before committing. A mismatch here is a key change for the owner to explain
    in `eval/KEY-NOTE.md` beside the key, not a grader incident; the graders'
    own check is against the committed file. Commit directly to `trial/eval`.
    Any follow-ups the runs deferred can be filed now.
12. **Grading.** **[supervisor]** spawns a fresh cloud session with
    `graders/G-claude.md` as its prompt and supervises it. **[owner]** opens
    Codex desktop (astra, xhigh) in a fresh clone of `trial/eval` and pastes
    `graders/G-codex.md`. Both write to their own `trial/eval-*` branch, then
    exchange disputes through `../mailbox/`.
13. **[supervisor] Trial report.** Adapt the diagnostic's scripts to the trial
    branches, compute the measures in `PROTOCOL.md` §6, merge both gradings and
    the owner's tiebreaks, and write `REPORT.md` here with the inputs committed
    so it reproduces. **[owner]** decides what to do with the `trial/*`
    branches (keep as evidence or delete after the report is merged).

## Stop and ask

Stop the trial and ask the owner if: a run pushes to `main`; two runs overlap;
a vendor outage or rate-limit stall exceeds the 60-minute rule; a dry run shows
the skill does not load in CY; or the key is found to have leaked into the repo
before step 11.
