# Mac bootstrap for the harness trial

Everything in this file runs on the owner's Mac, because the cloud supervisor
session cannot reach it. Fastest way: open one local Claude session in your
chroxy checkout and tell it

> Read docs/reports/harness-evals/trial/MAC-BOOTSTRAP.md and do the "Now"
> section. Setup only: do not commit, do not touch `.claude/`, stop and show me
> anything that fails.

or run the commands by hand. Design and rules: `PROTOCOL.md`; step list and live
status: `README.md`.

## Now

1. **Compile the Codex prompts** so both Codex harnesses run the same skill text
   as the Claude ones (writes `~/.codex/prompts/*.md`, nothing in the repo):
   ```bash
   export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
   git fetch origin && git checkout main && git pull --ff-only
   node scripts/compile-skill-targets.mjs --targets codex
   ls ~/.codex/prompts/prime-directive.md ~/.codex/prompts/tackle-issues.md ~/.codex/prompts/full-review.md ~/.codex/prompts/swarm-audit.md ~/.codex/prompts/session-lifecycle.md
   ```
2. **Dry-run clones** (the branches already exist):
   ```bash
   for r in dry-cy-claude dry-cy-codex dry-cx; do
     git clone --branch "trial/$r" https://github.com/blamechris/chroxy "$HOME/trial/$r"
     (cd "$HOME/trial/$r" && npm install)
   done
   ```
3. **Ruleset for `trial/**`** (optional, recommended): copy `main`'s branch
   ruleset to the pattern `refs/heads/trial/**` — required status checks,
   required conversation resolution, block force-push. Either in GitHub →
   Settings → Rules → Rulesets, or with `gh api repos/blamechris/chroxy/rulesets`
   (list, read main's, POST a copy with the new include pattern).
4. **Sealed key scaffold** (the owner fills the content; it never enters the repo
   until README step 11):
   ```bash
   mkdir -p ~/Obsidian/no-it-all/reviews/harness-trial-2026-10
   f=~/Obsidian/no-it-all/reviews/harness-trial-2026-10/KEY.md
   [ -e "$f" ] || { echo "# Sealed key — harness trial 2026-10"; echo; for n in 8233 8215 7771 8595 8364 8282 8277 8567 8303 7815; do printf '## #%s\n\n- Expected root cause:\n- Acceptance checks:\n- Fix already known (yes/no):\n\n' "$n"; done; } > "$f"
   echo "$f"
   ```
5. **Launch the three dry runs**, one at a time, each with its invocation from
   `missions/dry/<name>.md` and a 45-minute cap: Chroxy dashboard (claude-sdk),
   Chroxy dashboard (codex), Codex desktop app. These are app launches: a human,
   or a local Claude session with computer use acting on the owner's say-so.
   Tell the supervisor session when each one ends; it verifies on GitHub.

## After T0 is cut (the supervisor announces the SHA)

6. **Four fresh clones**, same git identity in all four, never the daemon's
   checkout:
   ```bash
   export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
   for r in a1-cd b2-cy-codex a2-cy-claude b1-cx; do
     git clone --branch "trial/$r" https://github.com/blamechris/chroxy "$HOME/trial/$r"
     git -C "$HOME/trial/$r" config user.name  "$(git config user.name)"
     git -C "$HOME/trial/$r" config user.email "$(git config user.email)"
     (cd "$HOME/trial/$r" && npm install)
   done
   ```
   The identity lines copy the name and email of the checkout you run this from;
   make sure that is your GitHub identity, not the daemon's.

## Per run

7. Launch per `missions/<RUN_ID>.md` → *Invocation*. The A1-cd session is the
   subject itself: the owner types that one directly in the Claude desktop app.
   Say "starting <RUN_ID>" to the supervisor when you type the invocation and
   "done <RUN_ID>" (plus the Codex cost from the usage page for the two GPT runs)
   when the session ends.
