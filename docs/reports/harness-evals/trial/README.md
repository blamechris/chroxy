# Controlled harness trial — runbook

Design: [`PROTOCOL.md`](PROTOCOL.md). Missions: [`missions/`](missions/). Grader
prompts: [`graders/`](graders/). This file is the step list and the live status.

## Status

| Item | Value |
|---|---|
| T0 (base SHA) | the squash-merge commit of the PR that last changed this row (re-cut after the sealed-key commitment and the vault-read rule landed, so the clones carry both); all seven `trial/*` branches fast-forward to it, and an existing clone follows with `git pull --ff-only` — verify with `git merge-base origin/trial/a1-cd origin/main` |
| Queue | set 2026-10-17, 10 issues — see [`queue.md`](queue.md) |
| Sealed key | sealed 2026-10-17T23:17Z; SHA-256 committed in [`KEY-COMMITMENT.md`](KEY-COMMITMENT.md) |
| Run 1 `A1-cd` | base cut from T0 on the owner's go; then waits for dry runs, clones and the owner's "starting A1-cd" |
| Run 2 `B2-cy-codex` | not started |
| Run 3 `A2-cy-claude` | not started |
| Run 4 `B1-cx` | not started |
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
   into the repository until step 11.
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
   **[supervisor]** pushes `trial/dry-cy-claude`, `trial/dry-cy-codex`,
   `trial/dry-cx` from this package's head commit — not from `main`, which does
   not carry the trial folder until this package merges; the dry missions are in
   [`missions/dry/`](missions/dry/) and use a synthetic docs-only task, so no
   backlog issue is touched. **[owner]** also opens one scratch issue, writes
   `Trial-Closes: <its number>` (no `#`) in a dry-run PR body, and confirms the
   scratch issue's timeline shows no event and the issue stays open; then
   closes the scratch issue by hand.
   **[owner]** launches each harness exactly as its real invocation says, with
   the dry mission. **[supervisor]** verifies on GitHub that the skill loaded, a
   PR targeted the dry base, the gate completed and a run report was written,
   and lists blockers. Fix blockers before run 1 (step 8); if a fix lands on
   `main` after the bases were cut, step 6 re-cuts them. Then delete the dry
   branches.
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
   run's start), then follows `missions/A1-cd.md` → *Invocation*.
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
11. **[owner] Unseal.** Copy the key into the repository as
    `docs/reports/harness-evals/trial/eval/KEY.md` on branch `trial/eval`
    (the supervisor creates the branch; a direct commit is fine). Any follow-ups
    the runs deferred can be filed now.
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
