# trialctl — controlled harness trial runner

`trialctl` takes a run from a trial's roster to a ready-to-launch state, checks
that the harness is at the intended model, effort and permission mode before
and after the send, and collects the finished run into the trial's `data/` so
`../trial/scripts/measures.py` prints the report tables. It replaces the hand-work
of the October trial's README steps 2–12 (`../trial/README.md`); the plan it
serves is `../trial-2/PLAN.md`.

It is standard-library Python with no model calls, so an operator can run it
during a Claude run without drawing on the Claude plan. It never launches a run,
never sends a message to a session and never restarts the daemon. What it
writes: a run's fresh clone (and its `node_modules` from `npm ci`), the run's
state file, `trial.json`'s `t0`, rendered missions and grader prompts (previews;
`missions/*.md` other than the template is gitignored, because the real copy is
committed on each base by `cut`), the trial's `data/`, and in the checkout `cut`
runs from, a `git fetch`, a temporary worktree it removes again, and with
`--push` the new `trial/*` base branches. `evidence` also writes, outside the
repository, a run's raw transcripts (see "Evidence" below), and
`queue-candidates` only reads from GitHub.

## Layout

| Path | What |
|---|---|
| `trialctl.py` | the command (`python3 trialctl.py --trial <trial dir> <command>`) |
| `trialkit/` | the implementation, one module per concern (`config`, `render`, `launch`, `native`, `collect`, `verdicts`, …) |
| `tests/run.py` | the test suite; CI runs it in the `Scripts Tests` job and it fails below a test-count floor |
| `<trial>/trial.json` | everything about one trial: roster, cells, arms, harnesses and their invocations, queue slots, blockers, local paths, allowance floors |
| `<trial>/missions/TEMPLATE.md`, `<trial>/graders/GRADER-PROMPT.md` | the templates `render` fills |
| `<paths.state_dir>/<RUN>.json` | the run's state on the Mac: clone, preflights, send, readings, applied settings, end |
| `<paths.evidence_dir>/<RUN>/` | the run's raw transcripts and a SHA-256 manifest, on the owner's Mac, in the private vault, never in a work tree (`evidence`) |
| `<trial>/data/native/<RUN>.json` | the public, derived extract of those transcripts: counts, models, tokens, hashes, no text (`evidence`) |

A second trial is a second directory with its own `trial.json`; the scripts do
not change.

## Commands

Every check prints `PASS`, `FAIL` or `UNVERIFIED` with its evidence. Exit codes:
0 when every check passed, 1 when any failed, 2 when nothing failed but
something could not be checked (a missing file, a tool that is not installed, a
GitHub error). "Could not check" is never reported as a pass.

| Command | Who, where | What |
|---|---|---|
| `render [RUN…] [--graders]` | supervisor | missions (and grader prompts) from `trial.json`; refuses an empty queue or an unfilled placeholder |
| `key-template` | owner | the structured answer-key skeleton, one section per slot |
| `gate RUN [--accept-open N=REASON]` | either | blocking issues closed, queue still open, T0 set, `ci.yml` at T0 runs on push to the base, no other run live |
| `cut --run RUN --t0 SHA [--push]` (or `--all`) | supervisor | each base = T0 plus the run's mission as the only commit; without `--push` it builds locally and prints the push. Cut each base just before its run: a new base fires a full CI push run |
| `clone RUN` | owner, Mac | fresh clone outside the daemon checkout and every other work tree; git identity; `npm ci` under Node 22 |
| `preflight RUN [--phase session --session ID]` | owner, Mac | clone shape, mission bytes, identity, Node, `gh` login, no `ci.yml` run queued or in progress (the runners the subject machine hosts are idle); Claude effort in `~/.claude/settings.json`; Codex prompts compiled from this clone and CLI parity with the Codex app; Chroxy `allowAutoPermissionMode`, deploy agent unloaded, daemon commit unchanged; in the session phase, the daemon log's model and permission-mode lines for the new session and no interrupt |
| `prepare RUN` | owner, Mac | `gate`, `clone`, `preflight`, then the launch card with the exact invocation |
| `start RUN --meter …` | owner, Mac | records the usage readings and the send; refuses below the allowance floor, without a passing gate at the current T0 followed by a passing preflight (and session phase, for Chroxy), and for a run that already finished |
| `verify-start RUN` | owner, Mac | reads the applied model, effort, permission mode and the mission's `TRIAL-PROBE` line back from the native transcript (Claude Code) or rollout (Codex); prints `STOP:` on any mismatch |
| `finish RUN --meter … [--cost …] [--stop …]` | owner, Mac | end readings, stop cause, and whether `~/.claude/settings.json` changed during the run (#8704) |
| `status RUN` | operator, anywhere with `gh` | read-only live view (October's `check-run.sh` for any trial): base tip, commits since T0, the base's PRs with mission-rule flags, the queue issues that must stay untouched, the main tip, whether the report has landed |
| `evidence RUN [--state FILE] [--data DIR]` | owner, Mac, after `finish` | copies the run's native transcripts (and, for Chroxy, the daemon log lines of its window) into the vault with a SHA-256 manifest, and writes the derived extract `data/native/<RUN>.json`; refuses, writing nothing, when the vault path is inside the repository, the run's clone or a git work tree |
| `queue-candidates [--json] [--limit N]` | supervisor | PLAN.md section 4's mechanical filters over the open backlog: a candidate table plus the rule that dropped each other issue; read-only |
| `collect RUN` | supervisor | GitHub evidence into `data/evidence/<RUN>.json` (October's grader-evidence schema plus timeline cross-references and each merge's push CI on the base) and the run's row in `data/runs.json`; a re-collect keeps verdicts already applied. The window starts at the probe's time from `verify-start` (else the recorded send) and ends at the report PR's merge (else `finish`'s end, else the cap); an optional `finish.queue_cutoff` in the state file overrides "queue done", which otherwise is the last queue merge. When `data/native/<RUN>.json` exists it also fills the run's `approvals`, `compactions` and `workers` in `runs.json`, only while each is absent or `not recorded` |
| `apply-verdicts FILE` | supervisor | folds a grader's `verdicts.json` into the evidence; refuses while a merged PR has no verdict |
| `disputes A B [--markdown]` | supervisor | the items where the two graders differ, for the owner's rulings |
| `verify-key KEY.md` | grader, owner | digest and size against `<trial>/KEY-COMMITMENT.md` |

Meter keys for `start` and `finish`: `claude_5h_used`, `claude_weekly_used`,
`claude_fable_used` (percent used) and `codex_weekly_left` (percent left), as the
usage pages show them.

## On the Mac

Make one control clone of `main` that is neither the daemon's checkout nor a
run's clone, and an alias for it:

```bash
git clone https://github.com/blamechris/chroxy ~/trial/t2/control
```

```bash
alias trialctl='python3 ~/trial/t2/control/docs/reports/harness-evals/runner/trialctl.py --trial ~/trial/t2/control/docs/reports/harness-evals/trial-2'
```

Per run, in order: `trialctl prepare <RUN>`; create the session as the launch
card says (for a Chroxy run, then `trialctl preflight <RUN> --phase session
--session <id>`); `trialctl start <RUN> --meter …`; send the invocation once;
within ten minutes `trialctl verify-start <RUN>`; every three hours `trialctl status <RUN>`; when the run ends `trialctl
finish <RUN> --meter …`, then `trialctl evidence <RUN>`, and hand the state file and
`data/native/<RUN>.json` to the supervisor, who copies them to `<trial>/data/state/<RUN>.json`
and `<trial>/data/native/<RUN>.json` and runs `collect`.

## Evidence

The repository is public and a raw transcript holds everything a run read and
said, so `trialctl evidence <RUN>` keeps raw material in the owner's private vault
and commits only a derived extract.

**Where.** `paths.evidence_dir` in `trial.json` (trial 2: `~/Obsidian/no-it-all/reviews/harness-trial-2/evidence`,
inside the sealed key's folder on purpose: the mission already forbids subjects to
read that folder). The run's copy is `<evidence_dir>/<RUN>/`:
`claude-projects/<clone slug>/...` (every file under the clone's folder in
`paths.claude_projects` modified in the run window, subagent transcripts and tool
results included), or `codex-sessions/YYYY/MM/DD/rollout-*.jsonl` (every rollout
whose `session_meta.cwd` is the clone or below it, coordinator and subagents), plus
`daemon.log` (the daemon log lines of the window, rotated files read oldest first)
for a Chroxy run, and `MANIFEST.sha256` (`<sha256>  <relative path>`, sorted).
Files and folders are mode 0600/0700. The window is the earlier of `start.sent_at` and
`verify_start.first_command_at`, to `finish.ended_at`; a file is copied if it was
modified from five minutes before the start to ten minutes after the end, and a file
modified later is reported (`UNVERIFIED`, exit 2) rather than silently left out. An
existing non-empty `<RUN>/` is never overwritten: evidence is written once.

**Never in the repository.** The command refuses, exit 1 and nothing written, when
`<evidence_dir>/<RUN>` resolves (symlinks followed) inside the trial repository, the
run's clone or any git work tree. The one exception is the work tree named by
`paths.evidence_vault` (`~/Obsidian/no-it-all`, which is itself a private git
repository): it is allowed only when it is the only work tree around the destination,
so a repository nested in the vault, or a vault inside the trial repository, is still
refused.
Remove that key and every work tree is refused. The copy is staged next to its
destination and moved into place last, and the extract is written after it; if
either step fails the other is removed.

**The extract** `data/native/<RUN>.json` holds only aggregates and short identifiers:
per-model turn counts and the observed efforts (Claude), or `turn_context` models,
efforts, approval policies and sandboxes (Codex); worker (subagent) turns per model;
token totals by model (Claude: `message.usage` deduplicated by `message.id`, largest
value per field; Codex: the largest cumulative token record of each rollout, with the
cached part split out and `stale_final_rollouts` counting the rollouts whose last
`token_count` was below an earlier one); human messages after the first, interrupts
and compactions; for a Chroxy run the permission counts from the daemon log (below);
isolation-pattern hits; and the manifest's SHA-256 and file count. It never holds
message text, tool output, a command line or file content. An isolation hit
(another run's `trial/*` branch, the key folder, `KEY.md`/`KEY.md.enc`, a `NEXT-*.md`
seed, another project's folder under `~/.claude/projects/`, `~/.codex/sessions/`) is
a pattern name, a count and a SHA-256 of each distinct matched string; the patterns
read tool inputs only (Claude `tool_use.input`, Codex function-call arguments), and
`tool_inputs_scanned` is recorded so an unreadable transcript shows as zero scanned
rather than as clean.

**Shapes.** The Claude Code and Codex record shapes the extract reads beyond those
`trialkit/native.py` documents (`message.id` and `message.usage`, `isMeta`,
`isCompactSummary`, `compact_boundary`, entry `uuid`; Codex `token_count`,
`token_usage_record`, `user_message`, `compacted`, function-call arguments) are taken from
the Claude Code and Codex versions named there and from the October review, not read
from a live store while this was written. A shape that drifts shows as an `UNVERIFIED`
check (no usage record, no tool input scanned) rather than as a zero; the dry runs
(PLAN.md section 9, step 5) are where the readers first meet real files.

**Permissions** come from the daemon log, whose messages the patterns in
`trialkit/extract.py` quote and `tests/test_extract.py` pins to the server source.
The log says who answered only for the notification action (`resolved via HTTP`), which
a person taps; a plain `resolved:` line may be a client or an automatic responder, and
is counted as `unattributed`. An Auto-mode allow that short-circuits writes no line, and
the lines carry no session id, so the counts cover prompts, across every session the
daemon ran in the window.

**Cost.** `prices` in `trial.json` is `null` (cost is `n/a`) or a dated table:

```json
"prices": {"as_of": "2026-11-01", "source": "where the rates were read",
           "per_mtok": {"claude-opus-5-5": {"input": 5, "output": 25, "cache_read": 0.5, "cache_write": 6.25},
                        "gpt-6-astra": {"input": 2, "output": 10, "cache_read": 0.2}}}
```

in dollars per million tokens. One model with tokens and no rate (or a cache rate
missing where it has cached tokens) makes the whole cost `n/a`, with the reason in `cost_note`.

## Queue candidates

`trialctl queue-candidates [--json] [--limit N]` reads the open backlog and applies
PLAN.md section 4's filters that need no judgement. Every issue it drops is listed with
the first rule that applies, in this order (cheapest first, so an issue's timeline is
read only when nothing in the listing rules it out): `not-owner`, `listed`
(`queue_rules.exclude_issues`, the October queue), `reserved` (`queue_rules.reserved`),
`blocker` (a trial blocker), `label` (`queue_rules.exclude_labels`), `structure` (an
epic's parent or child), `scope` (the body mentions `.claude/`, `.github/workflows` or
`docs/reports/harness-evals/`), `mentions-blocked` (the body mentions a blocker or a
reserved issue), `trial-files` (the body names a file that a PR into a `trial/*`
branch changed; those PRs are enumerated once, from `git/matching-refs/heads/trial/`),
`open-pr` (an open PR cross-references it), `connected-pr`, `trial-xref` (a PR into or
from a `trial/*` branch cross-references it). A request GitHub cannot answer makes the
issue `unverified`: neither a candidate nor ruled out, listed apart, exit 2. Survivors
show their labels, creation date, whether the body has an acceptance-criteria section,
and a type and package guess from labels; `--limit` shortens that list, never the scan.
`queue_rules` in `trial.json` rejects an unknown key, so a misspelt list cannot silently
filter nothing.

## Owner commands (accounts)

These touch the owner's GitHub settings or keys, so the runner prints them and
never runs them.

**Ruleset for the trial-2 bases**, created after `cut --push` and before run 1,
deleted after the trial. It mirrors `main`'s branch protection: no force push or
deletion, pull requests with resolved threads, and `main`'s required checks.

```bash
gh api -X POST repos/blamechris/chroxy/rulesets --input - <<'JSON'
{
  "name": "Trial 2 bases",
  "target": "branch",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["refs/heads/trial/t2-*"], "exclude": ["refs/heads/trial/t2-eval*"]}},
  "rules": [
    {"type": "non_fast_forward"},
    {"type": "deletion"},
    {"type": "pull_request", "parameters": {"required_approving_review_count": 0, "dismiss_stale_reviews_on_push": false, "require_code_owner_review": false, "require_last_push_approval": false, "required_review_thread_resolution": true}},
    {"type": "required_status_checks", "parameters": {"strict_required_status_checks_policy": false, "required_status_checks": [
      {"context": "Server Tests"}, {"context": "App Type Check"}, {"context": "Server Lint"}, {"context": "Dashboard Tests"},
      {"context": "Dashboard Type Check"}, {"context": "Protocol Tests"}, {"context": "Store Core Type Check"}, {"context": "App Tests"},
      {"context": "Store Core Tests"}, {"context": "Desktop Rust Tests"}, {"context": "App Expo Doctor"}, {"context": "Server Windows Tests"},
      {"context": "Design Tokens Tests"}, {"context": "Scripts Tests"}, {"context": "Release PR Subject"}, {"context": "Resolve Runner Target"}]}}
  ]
}
JSON
```

After the trial: `gh api repos/blamechris/chroxy/rulesets --jq '.[] | select(.name == "Trial 2 bases") | .id'`
gives the id for `gh api -X DELETE repos/blamechris/chroxy/rulesets/<id>`.

**Copilot.** The only repository ruleset requests Copilot review on the default
branch; Copilot reviewed the October trial PRs through the account's automatic
review setting. Leave it on for block 1 (the slot ids remove the number it used
to cross-reference). If `collect` records Copilot cross-references on queue
issues in block 1, turn the account's automatic Copilot code review off for
block 2 and record that in the report.

**Answer key** (PLAN.md §5), in the vault, never in a clone:

```bash
K=~/Obsidian/no-it-all/reviews/harness-trial-2
mkdir -p "$K" && trialctl key-template > "$K/KEY.md"
```

Fill it, run the dry grading, revise, then seal it: the digest and size go into
`trial-2/KEY-COMMITMENT.md` by PR before T0, and the plaintext is removed only
after the encrypted copy decrypts to the same digest (macOS's `/usr/bin/openssl`
is LibreSSL; use the same binary to unseal):

```bash
shasum -a 256 "$K/KEY.md" && wc -c < "$K/KEY.md"
```

```bash
openssl enc -aes-256-cbc -pbkdf2 -salt -in "$K/KEY.md" -out "$K/KEY.md.enc" && openssl enc -d -aes-256-cbc -pbkdf2 -in "$K/KEY.md.enc" | shasum -a 256
```

Compare the two digests by eye, then `rm "$K/KEY.md"`. At unseal, decrypt
straight into a clone of `trial/t2-eval` and run `trialctl verify-key` on it
before committing.

## Tests

```bash
python3 docs/reports/harness-evals/runner/tests/run.py
```

The suite uses a temporary repository, a fake HOME, scripted subprocesses and
recorded GitHub responses (`tests/fixtures/`); it never reads the real
`~/.claude`, `~/.codex`, `~/.chroxy` or the daemon. The collector is checked
against one October run's recorded responses, and `measures.py` against
October's committed output byte for byte.
