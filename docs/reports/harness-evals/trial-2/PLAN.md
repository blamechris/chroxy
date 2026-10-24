# Controlled harness trial 2 — plan

**Status (2026-10-22): draft, not started.** Trial 2 repeats the October trial
([`../trial/`](../trial/)) with two runs per cell, a fresh queue, and the hand-work
of README steps 2–12 replaced by the runner in [`../runner/`](../runner/). Nothing
here launches a run. The first run waits on the entry gate (§2), which today fails:
every blocking defect below is open.

The October trial answered its question at n = 1 (REPORT §1): same delivery, Chroxy
slower by 40 and 68 minutes, and Chroxy lost on reliability. It cost five days for
eight runs, mostly in setup that went wrong by hand (wrong effort, wrong model, a
stray interrupt, a deploy kill). Trial 2 keeps the estimand and the controls and
changes three things: each cell gets two repeats; every precondition the October
runs got wrong is checked by a script before the send and read back from the
native transcript minutes after it; and each run's measures are collected from
GitHub and the run's state file rather than transcribed into the README.

## 1. What changes from October

| October problem (REPORT) | Trial 2 change | Enforced by |
|---|---|---|
| n = 1 per cell (§8) | 2 repeats per cell, 8 runs, counterbalanced (§3) | `trial.json` roster; `measures.py` per-cell table |
| Effort never read from inside a Claude run (§8); run 3 at `medium`, run 5 on Sonnet (§6.4) | settings checked before the send; applied model and effort read from the native transcript after it | `trialctl preflight`, `trialctl verify-start` |
| Key ambiguous in four places (§8, rec 4) | structured key, dry-graded by both graders before it is sealed (§5) | owner step; digest committed before T0 |
| Transcripts and permission journal not attached (§8, rec 5) | native evidence copied to the vault with a hash manifest; a derived, public extract committed to `data/` (§7) | `trialctl evidence` (package P2) |
| "Red CI on the base" not observable (§8, rec 5) | `trial/**` in `ci.yml`'s push trigger before T0 | `trialctl gate` refuses a T0 whose `ci.yml` lacks it |
| Copilot review bodies cross-referenced queue issues (§5, rec 6) | PR bodies name an opaque slot, not the issue; residual mentions measured (§6) | mission rule; `trialctl collect` timeline scan |
| No Codex cost (§7, rec 7) | token totals from the Codex rollouts, usage-page readings at start and end (§7) | `trialctl start` / `evidence` |
| Two allowance states, a quota stop (§8, run 6) | every Codex run starts on a fresh allowance; Claude runs under a stated ceiling (§3) | `trialctl start` records the readings; refuses below the floor |
| Hand-written README rows, five days of setup | per-run state file on the Mac; `collect` writes `data/`; `measures.py` prints the tables | runner |

## 2. Entry gate (before T0)

A run is prepared only when every defect that can change its result is closed.
The lists live in `trial.json` (`blockers`) so the owner can edit them;
`trialctl gate <run>` reads each issue's state from GitHub and refuses while any
is open, unless the owner records an override with a reason, which is kept in
the run's state (`data/state/<run>.json` once collected). `trialctl start`, the
step that commits a run, refuses unless a passing gate at the current T0 is
recorded, followed by a passing preflight (and, for a Chroxy run, a passing
session-phase preflight), so running the steps by hand cannot skip the gate.

| Harness | Blocking (gate refuses) | Why | Mitigated by procedure instead |
|---|---|---|---|
| CY-codex | #8710, #8743 | REPORT rec 1: both incident runs were harness kills (false idle, deploy-tick kill) | #8744 (restore after restart): the deploy agent stays unloaded and the daemon is not restarted during a run (procedure; preflight checks that the deploy agent is unloaded and that the daemon checkout's commit is the same for every run) |
| CY-claude | #8741, #8700 | REPORT rec 2–3: floored worktree edits cost five-minute timeouts; the header's effort control is not Claude Code's effort | — |
| every CY run | — | — | #8703 (first-seconds interrupt): hands-off rule and `verify-start` catches an aborted first turn within minutes; #8704 (preview daemon writes user settings): `trialctl start` records the hash of `~/.claude/settings.json` and `finish` compares it |
| none | — | #8709 (state reconciliation) helps supervision but does not change a run's result | — |

`gate` also checks: `ci.yml` at T0 runs on push to `trial/**` (§1); no other
trial-2 run is live (its state file has a start and no end); and the queue's
issues are still open. (No open PR for a queue issue is a selection rule, checked
when the queue is picked, §4.)

## 3. Cells, repeats, order and allowance

Four cells as in PROTOCOL §1: arm A (Claude Opus 5.5 / high) in CD and CY-claude,
arm B (gpt-6-astra / xhigh) in CX and CY-codex. Two repeats each:

| Order | Run id | Cell | Base branch | Block |
|---|---|---|---|---|
| 1 | `A-cd-r1` | A native | `trial/t2-a-cd-r1` | 1 |
| 2 | `B-cy-r1` | B Chroxy | `trial/t2-b-cy-r1` | 1 |
| 3 | `A-cy-r1` | A Chroxy | `trial/t2-a-cy-r1` | 1 |
| 4 | `B-cx-r1` | B native | `trial/t2-b-cx-r1` | 1 |
| 5 | `A-cy-r2` | A Chroxy | `trial/t2-a-cy-r2` | 2 |
| 6 | `B-cx-r2` | B native | `trial/t2-b-cx-r2` | 2 |
| 7 | `A-cd-r2` | A native | `trial/t2-a-cd-r2` | 2 |
| 8 | `B-cy-r2` | B Chroxy | `trial/t2-b-cy-r2` | 2 |

Vendors alternate at every step, so consecutive runs never share an allowance.
Within each arm the native harness goes first in one block and second in the
other, so "ran later" is not a property of either harness. All eight bases are
cut from one T0 with the run's mission as the only commit over it (the pattern
A2c, B2b and B2c used), so a clone contains only its own mission.

**Allowance.** B2c used half of the owner's weekly Codex allowance in 3 h 43 min
(REPORT Table 3), so two Codex runs cannot share a week, and a run that starts on
a part-spent allowance risks run 6's quota stop. Rule: **every Codex run starts at
100% of its allowance**, after the weekly reset or an owner-applied reset, and the
reading is recorded; a Claude run starts with the 5-hour meter below 20% and the
weekly meter below 70%. `trialctl start` takes the readings and refuses below the
floor. A quota stop is recorded as an incident row, and the repeat is a new roster
entry (`<id>-a2`, its own base cut at the same T0) added to `trial.json` by PR
before its `prepare`; `start` refuses a second start of a finished run. Expected span: about one week if the owner
applies Codex resets between arm-B runs, four weeks if only the weekly reset is used.

Stop rules are PROTOCOL §3's: queue exhausted, 12 h from the first command, or a
60-minute rate-limit stall.

## 4. Queue

The October queue is spent: all ten issues are solved on `trial/*` branches and
Copilot's review bodies link several of them to those PRs. Trial 2 draws ten new
issues with PROTOCOL §5's criteria and the same stratification (bugs, features,
one or two cross-package items, one test or tooling item, spread across packages),
plus three exclusions:

1. no issue with a cross-reference or mention from a `trial/*` PR on its timeline;
2. no issue whose subject files a `trial/*` PR changed (a run could find a
   solution there by `git log -- <path>` across branches);
3. no issue that depends on a blocking defect in §2 or on the runner itself.

`trialctl queue-candidates` (package P2) applies the mechanical filters (open,
owner-filed, no open or closing PR, excluded labels, the three exclusions above,
no `.claude/` / `.github/workflows` / `docs/reports/harness-evals/` scope) to the
open backlog and prints a table; a read-only exploration session reads the
survivors' bodies for concrete acceptance criteria, as in October; the owner picks
ten. Each issue gets an opaque slot id (`Q01`…`Q10`, assigned in a random order
that `trial.json` records), used in PR bodies (§6).

## 5. Answer key: structured, dry-graded, sealed

1. **Write** (owner): `trialctl key-template` prints one section per slot with
   numbered acceptance checks, each with *pass when*, *partial when* and *fail
   when*, the expected root cause, whether the fix is known, and *readings to rule
   out*. The four October rulings (TIEBREAKS T1–T4) are the examples of the
   ambiguity to remove: "unchanged" (behavioural or textual?), "notes when" (which
   spellings?), "preferred both" (is one a partial?).
2. **Dry-grade** (both graders, before sealing): each grader gets the plaintext
   key and the issue texts, no solution, and returns for every check its own
   restatement of the pass rule and one borderline solution it would grade
   differently from a reasonable other grader. The owner compares the two
   restatements and rewords every check where they differ. G-claude-dry is a fresh
   cloud session (the key never sits on GitHub); G-codex-dry is a Codex desktop
   session in a scratch folder outside every clone, removed afterwards.
3. **Seal** (owner): digest and size into `KEY-COMMITMENT.md` before T0 (commands
   in the runner README), plaintext encrypted at rest, as in October.
4. **Unseal** after the last run into `trial/t2-eval`; `trialctl verify-key`
   checks the digest before any grader reads it.

## 6. Isolation

October's rules carry over (PROTOCOL §4, mission rules 1–6). Changes:

- **Copilot channel.** Copilot's automatic review is an account setting (no
  repository ruleset requests it on `trial/*`), and it wrote `#N` for the bare
  number in `Trial-Closes: N`. PR bodies now carry `Trial-Item: Q03`, the slot, and
  the mission keeps issue numbers out of PR titles, bodies, commit messages, branch
  names and PR comments. Code comments may cite issues as the repository's
  convention does. `trialctl collect` scans every queue issue's timeline for the
  trial window and records each cross-reference with its source PR and actor, so
  residual exposure is measured, not assumed. Fallback if mentions still appear in
  block 1: the owner turns off Copilot's automatic review for block 2 and the
  report says so (it then drops from both harnesses equally).
- **Native stores.** The mission adds: do not read another session's native
  transcript store (`~/.claude/projects/` outside your own clone's folder,
  `~/.codex/sessions/`), which is where the dry-grading sessions' copies of the key
  would sit.
- **Run namespace.** Trial-2 bases are `trial/t2-*`; the October `trial/*` branches
  stay as evidence and remain forbidden reads.

## 7. Evidence: transcripts, permission journal, cost

The repository is public, so raw transcripts never go on a branch. `trialctl
evidence <run>` (package P2), run on the Mac after the run ends:

- copies the run's native transcripts (Claude: the clone's folder under
  `~/.claude/projects/`, subagents included; Codex: every rollout whose
  `session_meta.cwd` is the clone or below it) and, for a Chroxy run, the daemon log
  lines of the run's window into the vault
  (`~/Obsidian/no-it-all/reviews/harness-trial-2/evidence/<run>/`) with a SHA-256
  manifest, refusing any destination inside the repository, the clone or a git work
  tree other than the declared private vault;
- writes a derived extract to `data/native/<run>.json`: models and efforts per turn
  (coordinator and workers apart), permission requests and their outcome as the daemon
  log records it (answered through a notification action, which a person taps; decided
  by a rule, a timeout or the pending cap; resolved by a client or an automatic
  responder the log does not name; floored), human messages after the first,
  interrupts, compactions, token totals by model, and isolation-pattern hits (other
  `trial/*` refs, the key folder, `NEXT-*.md`, native stores), with paths outside the
  clone reduced to a pattern name and a hash;
- commits the manifest's digest beside the extract, so the vault copy can be
  verified later.

Chroxy's permission audit is an in-memory ring of 500 entries
(`permission-audit.js`), lost on restart and not exported, so the permission
journal is reconstructed from the daemon log and the transcripts; a durable,
exportable audit is a follow-up issue, not a trial blocker.

**Cost.** Claude: the SDK-reported `total_cost_usd` where Chroxy shows it, and token
totals from the transcripts in every Claude harness (CD included). Codex: token
totals from the rollouts' token-count events, coordinator and workers. Either is
priced only against a dated price table the supervisor enters in `trial.json`;
without one the cost column says `n/a` and the token totals stand alone. Usage-page
readings before and after each run are recorded by `trialctl start` and `finish`.
Exposing Codex tokens in Chroxy's badge (REPORT rec 7) is a product follow-up.

## 8. Measures and grading

- `trialctl collect <run>` writes `data/evidence/<run>.json` in the same schema as
  October's grader evidence and the run's metadata into `data/runs.json`;
  `measures.py --data <trial-2>/data` prints the October tables for the eight runs
  plus a per-cell table (each repeat, and the median of the two). October's output
  is unchanged and pinned by a test.
- Graders write `verdicts.json` (per run, per slot, per acceptance check) beside
  their GRADING.md. `trialctl disputes` diffs the two graders' files, so the owner's
  tiebreak list is computed rather than negotiated through the mailbox;
  `trialctl apply-verdicts` folds one grader's verdicts into the evidence (a
  re-collect keeps them), and `measures.py` applies the owner's rulings from
  `tiebreaks.json` on top. A merged PR with no verdict stops `measures.py` rather
  than counting as not delivered.
- Red CI on the base is counted from each merge's own `ci.yml` push run, matched by
  the merge commit (a cancelled or skipped run counts only when a later finished
  push run covers it), plus any other `ci.yml` push run on the base in the window;
  anything unfinished or uncovered leaves the count unknown (`null`, printed as
  not observable), never 0.

## 9. Step list (replaces README steps 1–13)

| # | Step | Who | Command | Model usage |
|---|---|---|---|---|
| 1 | Land `trial/**` in `ci.yml`'s push trigger (one-line PR, merged before T0) | supervisor | PR | — |
| 2 | Ruleset for `trial/t2-*`, Copilot setting | owner | runner README, "Owner commands" | — |
| 3 | Queue candidates, owner picks ten, slots assigned | supervisor, owner | `trialctl queue-candidates` | one exploration session |
| 4 | Key written, dry-graded, sealed; digest committed | owner, graders | `trialctl key-template`, `verify-key` | two short grader sessions |
| 5 | Dry runs (the October three, on the current daemon), each with `prepare`, `start` and `verify-start`, so the transcript readers meet real files before run 1 | owner | as October step 5 | three short runs |
| 6 | Record T0; cut each base from it just before that run's step 7, not all at once: every cut fires one full CI push run on its new base, and eight at once would queue on the single macOS and Windows runners | supervisor | `trialctl cut --run <run> --t0 <sha> --push` | — |
| 7 | Per run: gate, clone, preflight (including no CI queued or running, so the base's own cut run has finished), launch card | owner on the Mac | `trialctl prepare <run>` | — |
| 8 | Per run: send the invocation, record the start | owner | `trialctl start <run>` | the run |
| 9 | Per run: confirm the applied settings | owner | `trialctl verify-start <run>` | — |
| 10 | Per run: watch (every 3 h, read-only) | operator | `trialctl status <run>` | — |
| 11 | Per run: end readings, native evidence | owner on the Mac | `trialctl finish <run>`, `trialctl evidence <run>` | — |
| 12 | Per run: collect | supervisor | `trialctl collect <run>` | — |
| 13 | Unseal, grade, disputes, rulings | owner, graders | `verify-key`, `disputes`, `apply-verdicts` | two grader sessions |
| 14 | Report | supervisor | `measures.py --data …` | — |

Every `trialctl` command is a stdlib Python script with no model calls, so the
operator can run steps 7–12 during a Claude run without drawing on the Claude plan
(the A2c rule).

## 10. Implementation packages

| Package | Contents | State |
|---|---|---|
| P1 | `trial.json` schema; `trialctl render`, `gate`, `cut`, `clone`, `preflight`, `prepare`, `start`, `verify-start`, `finish`, `status`, `collect`, `apply-verdicts`, `disputes`, `verify-key`, `key-template`; `measures.py --data` with October pinned; mission and grader templates v2; tests in CI | this plan's first PR |
| P2 | `trialctl evidence` (vault copy, manifest, derived extract, token totals), `queue-candidates` | delivered by the PR for blamechris/chroxy#8757 |
| P3 | `ci.yml` push trigger for `trial/**` | before T0 |
| Owner | ruleset, Copilot setting, key, launches, usage readings, unseal | before and during the trial |

## 11. Open decisions

1. The blocker lists in §2.
2. Codex resets between arm-B runs (about one week) or weekly resets only (about
   four weeks).
3. Copilot: slot ids plus measurement (recommended), or automatic review off for
   the whole trial.
4. Whether `trial/**` CI on push lands now or just before T0 (it runs the full
   matrix on every push to a trial base; `trial/t2-eval*` is excluded).
