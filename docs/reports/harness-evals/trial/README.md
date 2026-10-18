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
| Run 2 `B2-cy-codex` | **ended early 2026-10-18T07:52:22Z**, killed by the daemon's auto-deploy (cause below) — started 07:29Z in the Chroxy dashboard (daemon v0.11.4 at `59b77bb9` for the whole run), provider Codex app-server, ChatGPT connection, gpt-6-astra / xhigh, permission mode Auto, sandbox default (workspace-write), worktree isolation off; `/prompts:prime-directive` expanded; unattended, 0 human approvals; 2 PRs opened against `trial/b2-cy-codex` (8645 for 7771 at 07:45Z and 8646 for 8595 at 07:51Z, both green, left open as evidence), 0 merged, no report; clone `~/trial/b2-cy-codex` at T0. Cause: #8644 merged to `main` at 07:46Z; the idle-only auto-deploy tick judged the daemon idle while the codex session was still streaming (last codex event 07:52:16Z), sent SIGTERM at 07:52:22Z and restarted onto `91956e79` at 07:52:41Z; the restored session failed with "Codex native restore: this saved session has no native locator", so the session was lost. Counted as a Chroxy harness incident (two daemon defects to file); whether B2 is re-run is recorded here when decided |
| Run 3 `A2-cy-claude` | not started |
| Run 4 `B1-cx` | not started |
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
