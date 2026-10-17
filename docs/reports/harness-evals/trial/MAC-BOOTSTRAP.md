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

1. **Dry-run clones** (the branches already exist):
   ```bash
   export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
   for r in dry-cy-claude dry-cy-codex dry-cx; do
     git clone --branch "trial/$r" https://github.com/blamechris/chroxy "$HOME/trial/$r"
     (cd "$HOME/trial/$r" && npm install)
   done
   ```
2. **Compile the Codex prompts for the dry runs** from one of those clones, so
   the dry runs use the same skill text as this package (writes
   `~/.codex/prompts/*.md`, nothing in the repo). They are recompiled from a T0
   clone in step 6 before run 1:
   ```bash
   (cd "$HOME/trial/dry-cx" && node scripts/compile-skill-targets.mjs --targets codex)
   ls ~/.codex/prompts/prime-directive.md ~/.codex/prompts/tackle-issues.md ~/.codex/prompts/full-review.md ~/.codex/prompts/swarm-audit.md ~/.codex/prompts/session-lifecycle.md
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
   When the content is final, seal and encrypt it (the digest goes to the
   supervisor for `KEY-COMMITMENT.md`; the live plaintext must not stay
   readable on the Mac during the runs; the passphrase stays out of the repo
   and the vault). If `KEY-COMMITMENT.md` already carries a digest, the
   `shasum` line must print that digest before you encrypt; otherwise stop and
   tell the supervisor. macOS's `/usr/bin/openssl` is LibreSSL; confirm it
   accepts `-pbkdf2` and use the same binary at unseal.
   ```bash
   shasum -a 256 "$f"
   openssl enc -aes-256-cbc -pbkdf2 -salt -in "$f" -out "$f.enc" && rm "$f" && ls -l "$f.enc"
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
   NAME="$(git config --global user.name)"; EMAIL="$(git config --global user.email)"
   echo "identity for all four clones: $NAME <$EMAIL>"   # must be your GitHub identity, not the daemon's
   for r in a1-cd b2-cy-codex a2-cy-claude b1-cx; do
     git clone --branch "trial/$r" https://github.com/blamechris/chroxy "$HOME/trial/$r"
     git -C "$HOME/trial/$r" config user.name  "$NAME"
     git -C "$HOME/trial/$r" config user.email "$EMAIL"
     (cd "$HOME/trial/$r" && npm install)
   done
   # Recompile the Codex prompts at T0 and note the SHA for the run reports:
   (cd "$HOME/trial/a1-cd" && node scripts/compile-skill-targets.mjs --targets codex && git rev-parse HEAD)
   ```
   The identity comes from your global git config, echoed first so you can stop
   if it is not your GitHub identity.

## Per run

7. Launch per `missions/<RUN_ID>.md` → *Invocation*. The A1-cd session is the
   subject itself: the owner types that one directly in the Claude desktop app.
   Say "starting <RUN_ID>" to the supervisor when you type the invocation and
   "done <RUN_ID>" (plus the Codex cost from the usage page for the two GPT runs)
   when the session ends.
