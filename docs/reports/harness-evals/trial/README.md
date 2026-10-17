# Controlled harness trial — runbook

Design: [`PROTOCOL.md`](PROTOCOL.md). Missions: [`missions/`](missions/). Grader
prompts: [`graders/`](graders/). This file is the step list and the live status.

## Status

| Item | Value |
|---|---|
| T0 (base SHA) | not yet cut |
| Queue | not yet set — see [`queue.md`](queue.md) |
| Run 1 `A1-cd` | not started |
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
measures and grades. Steps are tagged **[owner]** or **[supervisor]**.

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
3. **[owner, Mac] Compile the Codex prompts** from current `main` so both Codex
   harnesses run the same skill text as the Claude ones:
   ```bash
   cd <your chroxy checkout> && git checkout main && git pull
   PATH="/opt/homebrew/opt/node@22/bin:$PATH" node scripts/compile-skill-targets.mjs --targets codex
   ls ~/.codex/prompts/prime-directive.md ~/.codex/prompts/tackle-issues.md ~/.codex/prompts/full-review.md
   ```
4. **[owner, GitHub] Ruleset for `trial/**`.** Settings → Rules → Rulesets → New
   branch ruleset, target `refs/heads/trial/**`, copy `main`'s required status
   checks, required conversation resolution and block-force-push. Optional but
   recommended: without it the merge gate relies on the skill alone.
5. **Dry runs (one tiny docs-only issue, 45-minute cap, not a queue issue).**
   **[supervisor]** pushes `trial/dry-cy-claude`, `trial/dry-cy-codex`,
   `trial/dry-cx` from `main` and writes a one-paragraph dry mission for each.
   **[owner]** launches each harness exactly as its real invocation says, with
   the dry mission. **[supervisor]** verifies on GitHub that the skill loaded, a
   PR targeted the dry base, the gate completed and a run report was written,
   and lists blockers. Fix blockers before step 6. Then delete the dry branches.
6. **[supervisor, on the owner's explicit go] Cut the bases.** Record
   `T0 = origin/main` HEAD, push the four `trial/*` branches at `T0`, set `T0`
   in `scripts/runs.json`, re-render missions, commit, update the status table.
7. **[owner, Mac] Four fresh clones**, one per run, never the daemon's checkout.
   Use the same git identity in all four (the diagnostic found a second identity
   on the daemon checkout that confounded attribution):
   ```bash
   export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
   for r in a1-cd b2-cy-codex a2-cy-claude b1-cx; do
     git clone --branch "trial/$r" https://github.com/blamechris/chroxy "$HOME/trial/$r"
     git -C "$HOME/trial/$r" config user.name  "<your GitHub name>"
     git -C "$HOME/trial/$r" config user.email "<your GitHub email>"
     (cd "$HOME/trial/$r" && npm install)
   done
   ```
8. **Run 1 — `A1-cd`.** **[owner]** waits for the Claude weekly reset if the
   allowance is low, tells the supervisor "starting A1-cd" (that timestamp is the
   run's start), then follows `missions/A1-cd.md` → *Invocation*.
   **[supervisor]** arms a 3-hour check-in, watches PRs and CI on `trial/a1-cd`
   and the CCR session list, and reports stalls (> 90 min quiet), red CI on the
   base, or rule violations (a PR to `main`, a `Closes #`, an issue comment).
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
