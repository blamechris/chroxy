# Handoff: start trial run A2c-cy-claude on Wednesday 2026-10-21, after the Claude reset

For the operator and the Codex assistant who guides the start. Read it whole before the
reminder fires. Everything here is read-only except the two steps marked **WRITE**.

## Purpose

`A2c-cy-claude` is the controlled arm-A run of the harness trial: Opus 5.5 at effort `high`
in a Chroxy dashboard session on the fixed ten-issue queue (`missions/A2c-cy-claude.md`).
The two earlier attempts were lost to a setup interrupt and a missed model pick, so this one
is run by checklist. Two measurement rules decide the timing and who does the watching:

1. **Full allowance at the start.** The run begins only after the owner's weekly Claude
   reset, Wednesday 2026-10-21 at 16:00 local (2026-10-21T23:00Z), with both Claude meters
   read and noted before the first message.
2. **No Claude usage during the run.** The run's cost is read from the Claude usage page
   before and after, so nothing else on this account may draw on the Claude plan while it
   runs: no Claude web or desktop chats, no Claude Code sessions, and no messages to the
   cloud supervisor session. The reminder, the start checklist and the three-hourly checks
   are done by the operator with a Codex assistant and the read-only script below. The
   cloud supervisor is told only after the run has ended.

## Reminder that costs no Claude usage

Create a macOS Reminder for five minutes after the reset (one line in Terminal):

```
osascript -e 'tell application "Reminders" to make new reminder with properties {name:"Start trial run A2c-cy-claude: follow docs/reports/harness-evals/trial/handoffs/A2c-cy-claude-wednesday.md", due date:date "Wednesday, October 21, 2026 at 4:05:00 PM"}'
```

If the date literal is refused on this Mac's locale, create the same reminder by hand in
Reminders.app, or a Calendar event with an alert, for 4:05 PM local on 2026-10-21.

## Pre-checks (read-only, expected output after each)

1. Claude usage page: both meters show a fresh week (0% used of the 5-hour and the weekly
   allowance; the Fable meter is separate and does not matter here). Note the three numbers.
2. No live trial run: the dashboard sidebar shows every trial session idle and
   `bash docs/reports/harness-evals/trial/scripts/check-run.sh B2c-cy-codex` (from any
   chroxy checkout with `gh` logged in) shows B2c's report on its base or its cap passed.
3. Deploy agent still unloaded:

   ```
   launchctl list | grep -c com.chroxy.deploy        # expect 0
   ```

4. Daemon alive and unchanged since the trial began (v0.11.4 at `91956e79`; the dashboard
   footer shows v0.11.4):

   ```
   ps -axo pid,etime,command | grep -E "[c]hroxy" | head -3
   ```

5. The clone, at the mission commit, clean:

   ```
   export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
   git clone --branch trial/a2c-cy-claude https://github.com/blamechris/chroxy ~/trial/a2c-cy-claude \
     && cd ~/trial/a2c-cy-claude && npm ci --no-audit --no-fund >/dev/null \
     && git status --short && git log --oneline -1          # expect 78ad56cd, nothing else printed
   ```

6. Effort comes from the user settings, not the dashboard:

   ```
   grep -A3 modelSettings ~/.claude/settings.json          # expect claude-opus-5-5 → effortLevel: "high"
   claude --version                                        # expect 2.1.280 or later (2.1.296 was installed)
   ```

If any check fails, stop and fix the cause first; nothing below is time-critical except that
the first message must go out while the meters are still fresh.

## Start (the invocation from `scripts/runs.json`, step by step)

1. Dashboard → New Session → provider **Claude (SDK)** → worktree isolation **off** → working
   directory `~/trial/a2c-cy-claude` → Create.
2. **Set the model first.** In the session header pick the Opus 5.5 entry labelled
   `(provider alias)`. A new dashboard session starts on Sonnet 5.5 otherwise, which is how
   the second attempt went wrong. Confirm the daemon recorded it for this session:

   ```
   grep -n "Model change" ~/.chroxy/logs/chroxy.log | tail -2
   ```

   Both lines must end in `opus`. The first, `Model change from <client> on session <id>: opus`,
   carries the new session's id; the second, `Model changed to opus`, carries none (the run
   entry in `scripts/runs.json` says "both lines" show the id, which is stricter than the log).

3. Header thinking level stays **Auto** (it sets a thinking budget, not the effort level).
   Permission mode **Auto** in the header dropdown; if it reads "Auto (unavailable)", stop
   and do not run attended.
4. **WRITE (the only message to the session).** Paste exactly, press Enter once:

   ```
   /prime-directive "Trial run A2c-cy-claude: follow docs/reports/harness-evals/trial/missions/A2c-cy-claude.md exactly"
   ```

   If the command is not recognised, send instead:
   `Invoke the prime-directive skill with the argument: Trial run A2c-cy-claude: follow docs/reports/harness-evals/trial/missions/A2c-cy-claude.md exactly`
   and note "invocation: natural-language skill call" for the record.
5. Hands off that session from this moment. Escape in the composer, Cmd+. anywhere in the
   dashboard, and the Stop button that takes Send's place all interrupt the turn; the first
   attempt died that way within seconds of the send, two seconds before Claude Code's init. The slash palette's "No commands
   found" while typing is cosmetic and closes on send.
6. **WRITE (a local note, not GitHub).** Record in `~/trial/A2c-start-note.md`: the UTC time
   of the send, the three meter readings, the `claude --version` output and the `Model
   change` lines. The 12-hour cap is counted from the first command, so this time matters.

## During the run: three-hourly checks, read-only, from outside the Claude plan

Every three hours, from any chroxy checkout with `gh` logged in:

```
bash docs/reports/harness-evals/trial/scripts/check-run.sh A2c-cy-claude
grep -nE "\[(result|error|stream_end)\]|Interrupt from|Inactivity|stall|query:" ~/.chroxy/logs/chroxy.log | tail -10
```

The first prints PRs, commits, the untouched queue issues and whether the report exists; the
second shows the daemon's view of the session: a `[result]` line normally ends a turn (a stream
stall also produces one, after a `Stream stalled` line); `[error]` names a failed turn;
`Interrupt from` is a client interrupt, followed by `Query aborted after user stop`; the
inactivity warning only says the session has been quiet for 30 minutes.
Reading the dashboard is fine. What to do with what you see:

- PRs merging into `trial/a2c-cy-claude` and no `[error]`: the run is working. Nothing to do.
- No commit, PR or comment for more than 90 minutes and no `[error]`: note the time as a
  possible stall. Do not nudge, approve or restart anything; the run ends at its cap anyway.
- An `[error]` line, a `[ws] Interrupt from`, or a daemon restart: note the line and the
  time. It is an incident for the record, not a reason to intervene.
- A permission prompt waiting in the dashboard under Auto: do not answer it; note the time.
  Answering is a counted human approval.
- The dashboard's check-in chip ("Status update?") that appears after 30 quiet minutes: do not
  click it. Its button sends a human message into the session, which is an intervention.

## End of the run

The run is over when `docs/reports/harness-evals/trial/runs/A2c-cy-claude/REPORT.md` has
merged into `trial/a2c-cy-claude` (the check script says so), or when 12 hours have passed
since the first command. Then, in this order:

1. Read the Claude usage page again and add the three numbers to the start note.
2. Save the final `check-run.sh` output and the daemon-log grep to the start note.
3. Only now message the cloud supervisor session with the start note's contents. It records
   the run's row in `README.md` by PR, reads the report and schedules the grading.

## What the Codex assistant must not do

- Draw on the Claude plan in any way, or ask anyone to, until step 3 above.
- Write to GitHub: no comments, labels, issues or PRs on `blamechris/chroxy` during the run.
- Touch the trial session, the daemon, the clone or any `trial/*` branch.
- Interpret an idle-looking dashboard as a stopped run: this daemon build has shown a
  session idle while its agent worked for two hours (Codex app-server, daemon defect
  filed as 8710). For Claude SDK sessions the daemon-log grep above is the signal: `[result]`
  (normal end or stall), `[error]` (failed turn) or `Interrupt from` (user stop).
