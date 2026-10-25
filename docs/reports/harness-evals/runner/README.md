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
state file, `trial.json`'s `t0` and `queue-t0.json` (the queue issues' text digests at T0), rendered missions and grader prompts (previews;
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
| `<trial>/queue-t0.json` | each queue slot's issue number and SHA-256 digests of its title, body and comments at T0, written by `cut` with T0 and read by `gate` (see "Queue text at T0") |
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
| `gate RUN [--accept-open N=REASON] [--accept-changed SLOT=REASON]` | either | blocking issues closed, queue still open, each queue issue's title, body and comments unchanged since T0 (`queue-t0.json`; `--accept-changed Q03=REASON` accepts one slot's change and records it in the state's `overrides`), T0 set, `ci.yml` at T0 runs on push to the base, no other run live |
| `cut --run RUN --t0 SHA [--push]` (or `--all`) | supervisor | each base = T0 plus the run's mission as the only commit; without `--push` it builds locally and prints the push. Cut each base just before its run: a new base fires a full CI push run. Recording T0 also records `queue-t0.json`, read before anything is written (an unreadable queue issue or comments listing refuses the cut, exit 2, with no T0 and no snapshot); an existing snapshot is never overwritten |
| `clone RUN` | owner, Mac | fresh single-branch clone (`git clone --branch BASE --single-branch`, so the only remote-tracking ref is the base's) outside the daemon checkout and every other work tree; git identity; `npm ci` under Node 22 |
| `preflight RUN [--phase session --session ID]` | owner, Mac | clone shape (the only remote-tracking ref is `origin/BASE` and the only fetch refspec is the base's own), mission bytes, identity, Node, `gh` login, no `ci.yml` run queued or in progress (the runners the subject machine hosts are idle); Claude effort in `~/.claude/settings.json`; Codex prompts compiled from this clone and CLI parity with the Codex app; Chroxy `allowAutoPermissionMode`, deploy agent unloaded, daemon commit unchanged; in the session phase, the daemon log's model and permission-mode lines for the new session and no interrupt |
| `prepare RUN [--accept-open N=REASON] [--accept-changed SLOT=REASON]` | owner, Mac | `gate` (with the same acceptances), `clone`, `preflight`, then the launch card with the exact invocation |
| `start RUN --meter …` | owner, Mac | records the usage readings and the send; refuses below the allowance floor, without a passing gate at the current T0 followed by a passing preflight (and session phase, for Chroxy), and for a run that already finished |
| `verify-start RUN` | owner, Mac | reads the applied model, effort, permission mode and the mission's `TRIAL-PROBE` line back from the native transcript (Claude Code) or rollout (Codex); prints `STOP:` on any mismatch |
| `finish RUN --meter … [--cost …] [--stop …]` | owner, Mac | end readings, stop cause, and whether `~/.claude/settings.json` changed during the run (#8704) |
| `status RUN` | operator, anywhere with `gh` | read-only live view (October's `check-run.sh` for any trial): base tip, commits since T0, the base's PRs with mission-rule flags, the queue issues that must stay untouched, the main tip, whether the report has landed |
| `evidence RUN [--state FILE] [--data DIR]` | owner, Mac, after `finish` | copies the run's native transcripts (and, for Chroxy, the daemon log lines of its window) into the vault with a SHA-256 manifest, and writes the derived extract `data/native/<RUN>.json`; refuses, writing nothing, when the vault path is inside the repository, the run's clone or a git work tree, or (with `paths.evidence_vault` set) outside the vault |
| `queue-candidates [--json] [--limit N]` | supervisor | PLAN.md section 4's mechanical filters over the open backlog: a candidate table plus the rule that dropped each other issue; read-only |
| `collect RUN` | supervisor | GitHub evidence into `data/evidence/<RUN>.json` (October's grader-evidence schema plus timeline cross-references and each merge's push CI on the base) and the run's row in `data/runs.json`; a re-collect keeps verdicts already applied. The window starts at the probe's time from `verify-start` (else the recorded send) and ends at the report PR's merge (else `finish`'s end, else the cap); an optional `finish.queue_cutoff` in the state file overrides "queue done", which otherwise is the last queue merge. When `data/native/<RUN>.json` exists it also fills the run's `approvals`, `compactions` and `workers` in `runs.json`, only while each is absent or `not recorded`; an extract that could not verify one of them leaves it out (no `approvals` from an unverified daemon log), and the placeholder stays |
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

## Queue text at T0

A run reads its queue issues from GitHub while it works, so an edit or a new comment between run 1 and
run 8 would change the task for the later runs. `cut` therefore writes `queue-t0.json` beside
`trial.json` when it records T0:

```json
{"t0": "<sha>", "at": "<UTC time the text was read>",
 "slots": {"Q01": {"issue": 1234, "title_sha256": "…", "body_sha256": "…", "comments_sha256": "…", "comments": 3}}}
```

The title is hashed as a string, the body as a string (`''` for none), and the comments as canonical JSON
(`sort_keys`, no padding, UTF-8) of `[{"id", "user" (login), "body"}]` in id order. Labels, assignees, state
and `updated_at` are not task text and are left out; the file holds digests and a count, never text.
Everything is read before anything is recorded, so a slot whose issue or comments cannot be read refuses
the cut with no T0 and no snapshot. The snapshot is never overwritten: a later `cut` for the same T0 leaves
it alone (and reads nothing), another T0 refuses, and if T0 was recorded without it the next `cut` writes
it, its `at` saying when. The supervisor commits `trial.json`'s `t0` line and `queue-t0.json` together by
PR after the first cut; the control clone on the Mac pulls that commit before any `gate`. The file is not
in the runs' clones: their bases are cut from T0, which is older.

`gate` reads each issue again and fails, naming the slot, when a digest differs. Its detail says which
parts changed (title, body, or comments with the count before and after; `comments (2, text changed)` is
an edited comment). A missing file, a file taken at another T0, an entry missing for a slot or for another
issue are failures; a GitHub error or an unreadable file is `UNVERIFIED`, never a pass. A change the owner
accepts is `gate RUN --accept-changed Q03=REASON` (also on `prepare`): that slot's check passes with the
reason shown and `{"kind": "accept-changed", "slot": "Q03", "reason": …}` goes into the state's
`overrides`, as `--accept-open` does for a blocker. The acceptance covers a changed slot only, not a
missing baseline.

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
the destination resolves (symlinks followed) inside the trial repository, the run's
clone or any git work tree. The one exception is the work tree named by
`paths.evidence_vault` (`~/Obsidian/no-it-all`, which is itself a private git
repository): it is allowed only when it is the only work tree around the destination,
so a repository nested in the vault, or a vault inside the trial repository, is still
refused. When `paths.evidence_vault` is set the destination must also be *inside* it: a
folder outside the vault is refused even though no work tree holds it. Remove that key
and every work tree is refused, and nothing else is required of the place.

`evidence_dir` is resolved once and everything is written under the resolved directory.
That directory, `<RUN>` and the stage `.<RUN>.partial` beside it are all checked (so a
link at `<RUN>` that points into the vault cannot hide a base inside the repository), a
link at `<RUN>` or at the stage is refused rather than followed or removed, and the check
is made again just before staging and again just before the move, so a destination that
changed while the transcripts were being read stops the move and removes the stage. The
threat model is an accidental misconfiguration on the owner's own machine, not an
adversary with write access to the home directory. Missing parent directories are created
mode 0700. The copy is staged next to its destination and moved into place last, and the
extract is written after it. On any failure, an I/O error or any other exception, the
stage is removed, and so is the copy if the extract was not written; a stage that cannot
be removed is a `FAIL cleanup` that names it, never a silent leftover. A failure prints
the exception's class, not its message, which can quote the line that caused it.

**The extract** `data/native/<RUN>.json` holds only aggregates and short identifiers:
per-model turn counts and the observed efforts (Claude), or `turn_context` models,
efforts, approval policies and sandboxes (Codex); worker (subagent) turns per model;
token totals by model (Claude: `message.usage` deduplicated by `message.id`, largest
value per field; Codex: the largest cumulative token record of each rollout, with the
cached part split out and `stale_final_rollouts` counting the rollouts whose last
`token_count` was below an earlier one); human messages after the first, interrupts
and compactions; for a Chroxy run the permission counts from the daemon log (below);
isolation-pattern hits; the `transcript_lines` read and skipped; a `checks` list (each
check's name and status, no detail text), `notes` and the manifest's SHA-256 and file count. It never holds
message text, tool output, a command line or file content. A name taken from a
transcript or the log is checked by the rule of its field and recorded as `<other>`
when it fails, in the extract and on the terminal alike: effort, Claude permission mode,
Codex approval policy and sandbox, permission decision and the daemon's mode take only
their known values (`extract.py`, the last two pinned to the server source); a model
is a known family's name (`claude`, `gpt`, `o1`-`o9`, `codex`, `gemini`, `opus`, `sonnet`,
`haiku`, `deepseek`, `llama`, `qwen`, `mistral`) then `[a-z0-9-]` with a `.` only between
two digits (`gpt-5.1-codex`), 2 to 48 characters in all, so a path, URL, host or file name,
even one starting with a family's name (`claude.ai`), is `<other>`; a tool is `[A-Za-z][A-Za-z0-9_]{0,47}`;
a session id `[A-Za-z0-9][A-Za-z0-9-]{0,63}`. Nothing that starts like a credential
(GitHub `ghp_`/`gho_`/`ghs_`/`ghu_`/`ghr_`/`github_pat_`, `sk-`/`sk_`, Slack `xox`/`xapp-`,
AWS `AKIA`/`ASIA`, Google `AIza`, npm, Hugging Face, GitLab, a JWT `eyJ`; any case) passes
any of them, nor does a value holding a run of 32 hex digits (33 for a session id, which
the daemon makes from 32). An isolation hit
(another run's `trial/*` branch, the key folder, `KEY.md`/`KEY.md.enc`, a `NEXT-*.md`
seed, another project's folder under `~/.claude/projects/`, `~/.codex/sessions/`, any path
under `docs/reports/harness-evals/` (`harness_evals_other`) other than the run's own mission,
its report and the report's folder) is
a pattern name, a count and a SHA-256 of each distinct matched string (for
`harness_evals_other`, of the path from `harness-evals` on, with `.`/`..` resolved, so the
clone's prefix does not change it); the patterns
read tool inputs only (Claude `tool_use.input`, Codex function-call arguments), and
`tool_inputs_scanned` (tool inputs holding text; one input counts once, however many
strings it holds) is recorded so an unreadable transcript, or a renamed input field, shows
as zero scanned rather than as clean. The scan counts what a tool input spells, not what the
shell resolves: `cat trial/queue.md` run from inside `docs/reports/harness-evals/` names no
`harness-evals/` and is not counted by itself (the `cd` that put the shell there is, and the
graders' audit of the transcripts covers the rest). Three more limits are left to that audit:
October's candidate read is out of the tree but not out of the history (a read that names its
path, such as `git show <commit>:<path>`, is counted; a content search such as `git log -S` is
not); a read of `main` or of a PR the run did not open is forbidden by mission rule 5 but not
measured; and an exclusion glob, or the run's own mission spelled as a URL, counts as a hit. A
hit is a lead for the graders, not a verdict.

**What is not carried when it is not verified.** A figure whose check is not a pass is
left out of the extract (null, or absent from `runs_row`), not shown as data, and the
reason is a fixed phrase with no path:

- the daemon log is not verified (path unset, unreadable, no readable timestamp, rotated
  past the window start, nothing in the window): `permissions` and `daemon` are null,
  `permissions_unavailable` says why, and `runs_row` has no `approvals`, so `collect`
  leaves it `not recorded`;
- the daemon log is read but holds a line that opens like a permission message
  (`Permission ...`, `Pending-permission ...`) and matches none this reader knows, other
  than the daemon's own non-outcome messages (mode changes, rule updates, floor-clear
  debug lines, ...): `UNVERIFIED permission lines`, and the permission figures are
  withheld as for an unverified log, because a changed or damaged message would
  otherwise read as a count of zero;
- no human message is found in the coordinator transcripts (every run opens with its
  invocation, so none means the reader failed): the three people counts are null and
  `people.unverified` says why;
- a transcript or rollout has more than 5 lines, or more than 1% of its lines, that are
  unusable (not a JSON object, or a known type without the object it carries: an
  `assistant`/`user` record without a `message` object, a Codex `session_meta`,
  `turn_context`, `event_msg` or `response_item` without a `payload` object), has no
  usable record at all (an empty file), or cannot be opened: `UNVERIFIED transcript
  lines`. Token totals, cost and every people count are then withheld too (null, with the
  reason), and the isolation scan is `UNVERIFIED`: what was counted is a lower bound of
  unknown size. A valid record beside a truncated remainder is not a clean read. One
  unreadable line in a long transcript is a mid-write tail and is tolerated;
- `runs_row` is written field by field: `workers` only while `coordinator transcripts`
  and `transcript lines` are both a pass, `compactions` only while `human messages` is a
  pass as well, `approvals` only from a verified permission summary. With no coordinator
  transcript read it is empty;
- a Codex rollout whose `session_meta` names the thread it was forked or resumed from
  (`forked_from`, `forked_from_id`, `resumed_from`, at the top or in `source`), or that
  holds a cumulative usage record another rollout also holds (a replay): token totals are
  withheld, the cost is `n/a`, and `forked_rollouts` / `replayed_rollouts` say how many.
  A subagent's `parent_thread_id` alone is not a fork, since every Codex run with workers
  has one; its records are compared instead. `stale_final_rollouts` is also written as a
  note.

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
Each request id has exactly one outcome. A request answered over HTTP (the notification
action, which a person taps) logs a plain `resolved:` line and then `resolved via HTTP:`
for the same id; the second line makes it `human`, not also `unattributed`. A plain
`resolved:` line alone may be a client or an automatic responder and is `unattributed`;
after those come a timeout, a closed connection and no outcome (`unresolved_requests`),
so `requests` is the sum of the outcomes. A rule match and a pending-permission cap log
no `Permission request`, so they are counted apart (`without_prompt`) and `decided_by`
never exceeds `requests`; an auto-mode switch allows requests that were logged without
naming them, so its count comes out of the requests that have no other outcome. An
Auto-mode allow that short-circuits writes no line, and the lines carry no session id, so
the counts cover prompts, across every session the daemon ran in the window.

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
branch changed, a renamed file under both names; a changed file whose name GitHub does
not report makes the issues that name a file `unverified`; those PRs are read once from the
repository's PR list, `pulls?state=all`, every page, keeping those whose base starts with
`trial/`, so a PR whose base branch was deleted still counts),
`open-pr` (an open PR cross-references it), `connected-pr`, `trial-xref` (a PR into or
from a `trial/*` branch cross-references it). A request GitHub cannot answer makes the
issue `unverified`: neither a candidate nor ruled out, listed apart, exit 2. So does an
empty answer where one cannot be: no PR into a `trial/*` branch at all, or a PR in the
list with no readable base, or a cross-referencing PR with no readable base or head,
means `trial-files` and `trial-xref` could not be applied, and no issue they would have
cleared is a candidate (an issue an unaffected rule rejects stays rejected).

**The list is cross-checked.** An issue on `queue_rules.exclude_issues` is rejected as
`listed`, which would hide every later rule, so each one is also run through them and the
output says, per listed issue, which rule would also have rejected it (`also <rule>: ...`)
or that `only the list rejects it` (`--json`: `cross_check` `also-rejected` /
`only-the-list` / `unverified`, with `also` and `also_detail`, and a
`listed_cross_check` summary). A cross-check GitHub could not answer is
`NOT cross-checked`, never "only the list", and makes the exit code 2. Checked against the
live backlog on 2026-10-24, the mechanical rules reject eight of October's ten (six by
`trial-files`, two by `trial-xref`); #8364 and #8277 are rejected only by the list, which
is why the list exists. Survivors
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
