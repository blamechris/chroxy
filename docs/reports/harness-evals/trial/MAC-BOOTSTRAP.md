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

## Before run 2 (Chroxy with Codex)

7. **Unattended Codex in Chroxy.** Needs the fix for #8619 merged and the daemon
   updated, plus `allowAutoPermissionMode: true` in the daemon config (already on
   if Auto was accepted on the Claude dry run). Restart the daemon only when no
   trial run is live.
8. **Codex binary parity (#8609).** Upgrade the PATH codex so Chroxy sees the
   same model roster as the Codex app, otherwise the arm-B worker tiers differ:
   ```bash
   npm install -g @openai/codex@latest && codex --version
   ```

## Before every Chroxy run (run 3 and any B2 re-run; run 4 is a desktop-app run)

9. **Take the daemon's auto-deploy agent out for the rest of the trial.** Run 2 was
   killed at 07:52Z by a deploy tick that judged the daemon idle while the codex
   session was mid-turn, then restarted the daemon under the live session
   (`README.md`, run 2 row). The tick only acts when `main` moves, and the
   supervisor's status-table merges move it, so unload the agent before the
   session is created and load it again only after the trial. The daemon itself
   stays up on the commit it already runs and is not updated between runs, so the
   harness version is constant; a repeat `bootout` on an unloaded agent fails
   harmlessly. Unload only when no tick is in flight, or the interrupted deploy
   is left half-applied until the agent returns; the first line below prints a
   PID and skips the unload while a tick runs:
   ```bash
   pgrep -f deploy-daemon.mjs || launchctl bootout gui/$UID ~/Library/LaunchAgents/com.chroxy.deploy.plist   # before the run
   launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.chroxy.deploy.plist                                 # after the trial
   ```
   Confirm with `launchctl print gui/$UID/com.chroxy.deploy`, which must report
   that the service is not found while a run is live.

## Per run

10. Launch per `missions/<RUN_ID>.md` → *Invocation*. The A1-cd session is the
    subject itself: the owner types that one directly in the Claude desktop app.
    Say "starting <RUN_ID>" to the supervisor when you type the invocation and
    "done <RUN_ID>" (plus the Codex cost from the usage page for the two GPT runs)
    when the session ends.

    **Chroxy dashboard runs: set the header model first, then press Enter once, then keep
    your hands off that session.** A new Claude (SDK) dashboard session starts on the
    daemon's default model, Sonnet 5.5, unless the dashboard's Settings → Default model is
    set; confirm the header shows the mission's model before sending (run 5's second
    attempt ran on the default).
    Escape in the composer (with no picker open), the Stop button that takes Send's
    place while a turn runs, and Cmd+. anywhere in the dashboard all interrupt the
    turn (the composer's hint reads "Escape to interrupt"), so a second press on the
    button or a stray cancel keystroke ends the run. The slash palette's "No commands
    found" while typing a command with arguments is cosmetic and closes on send. Run 5's
    first attempt ended on such an interrupt within seconds of the send: the daemon
    logged `[ws] Interrupt from <client>` and `Query aborted after user stop`, and
    Claude Code's transcript recorded no model usage and its last conversation entry
    was a single user message, "[Request interrupted by user]". Do not change the model or permission mode after
    sending either: the daemon refuses a mid-turn model change, and a switch to Auto
    applies live and changes the run's conditions. If the first tool call has not
    appeared within a few minutes, check the daemon log for an `Interrupt` line before
    assuming a stall.
