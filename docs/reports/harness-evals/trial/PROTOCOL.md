# Controlled harness trial — protocol (draft v1)

**Origin:** designed in the cloud review session that produced
[`../2026-10-17-harness-diagnostic-cd-cx-cy.md`](../2026-10-17-harness-diagnostic-cd-cx-cy.md),
after both-way reconciliation with the Codex evaluation (see `../mailbox/`). The
diagnostic found no CY-coordinated prime-directive (PD) run on record and no
per-run cost for any harness; this trial exists to produce both under controlled
conditions. Status: **queue set (section 5); awaiting the dry runs and T0 (README steps 5–6).**

Harness codes as in the diagnostic: **CD** = Claude desktop app (local Claude Code
session), **CX** = Codex desktop app, **CY** = Chroxy daemon session.

## 1. Question and estimand

Holding the coordinator model constant, does the harness change how a PD run
performs on identical work? Two paired contrasts, each a within-vendor pair:

| Arm | Native harness | Chroxy harness | Coordinator model | Effort |
|---|---|---|---|---|
| A (Claude) | CD | CY, `claude-sdk` provider | `claude-opus-5-5` | high |
| B (GPT) | CX | CY, codex app-server provider | `gpt-6-astra` | xhigh |

Arm A matches the Oct 7–11 PD chain (Opus 5.5, high — the CCR session records say
so). Arm B matches the owner's CX orchestration setting (astra, xhigh). Arm A vs
arm B (CD vs CX) is a different estimand — "best configured stack" — and is only
reported descriptively, never as a harness effect.

**Why not one run per model:** a single CD run and a single CX run confound
harness with model. The harness effect needs the same model in two harnesses, so
the minimum is four runs.

## 2. Runs and order

| Order | Run id | Harness | Base branch | Invocation |
|---|---|---|---|---|
| 1 | `A1-cd` | CD | `trial/a1-cd` | `/prime-directive "…missions/A1-cd.md"` |
| 2 | `B2-cy-codex` | CY (codex) | `trial/b2-cy-codex` | compiled codex prompt (see mission) |
| 3 | `A2-cy-claude` | CY (claude-sdk) | `trial/a2-cy-claude` | `/prime-directive "…missions/A2-cy-claude.md"` |
| 4 | `B1-cx` | CX | `trial/b1-cx` | `/prompts:prime-directive …` |

Runs are **sequential and never overlap**. The order alternates vendors so that
consecutive runs never share a rate-limit pool, and within each arm the native
harness goes first once (arm A) and second once (arm B), so "ran later" is not
systematically a CY property.

## 3. Controls (what is held fixed)

- **Base.** All four base branches are cut from one `main` SHA, `T0`, identified
  in `README.md`'s status table and derivable from any base with
  `git merge-base origin/<base> origin/main`. `main` may keep moving; runs never
  rebase onto it. Every PR targets the run's own `trial/<run>` branch.
- **Queue.** The same fixed issue list (section 5) in every mission, verbatim.
- **Mission text.** One template (`missions/TEMPLATE.md`) rendered per run by
  `scripts/render_missions.py`; only the run fields differ.
- **Checkout.** A fresh clone per run at `T0`, never the daemon's checkout; same
  git identity in all four (the diagnostic found a second identity on the daemon
  checkout that confounded attribution); Node 22; same `gh` account.
- **Skill source.** `/prime-directive` and the skills it composes come from the
  same commit (`T0`): the compiled `.claude/skills/*` for Claude harnesses, and
  `~/.codex/prompts/*` for Codex harnesses, compiled from a `trial/*` clone
  **after** the bases are cut (`node scripts/compile-skill-targets.mjs --targets
  codex`, README step 7), with the compile SHA written into the run report.
  Compiling from `main` earlier would let the two vendor arms run different skill
  text if `main` moved in between. The invocation method is recorded per run as
  a harness attribute, not hidden.
- **Worker tier.** Each harness's default worker models; the run report records
  what was actually used. Within an arm they are expected to match (same vendor).
- **Stop.** A run ends when the queue is exhausted (each issue merged into the
  base or flagged blocked with a reason), at 12 h wall clock from the first
  command, or after a 60-minute rate-limit stall — whichever comes first. The run
  then writes its report (section 6) and stops. Compaction or restart resumes the
  same attempt; the clock keeps running.

## 4. Isolation between runs (leakage)

The runs share one repository, so later runs could in principle see earlier
runs' work. Rules, in order of how much they buy:

1. **Merges into `trial/*` never close issues.** GitHub only auto-closes on merge
   into the default branch, so every run sees the same open queue.
2. **`Trial-Closes: N` (bare number, no `#`) instead of `Closes #N`** in PR
   bodies, and no `#N` in PR titles or commit subjects. A closing keyword would
   link the PR into the issue's timeline, where the next run's "read the issue
   and linked threads" step would find it — and any `#N` anywhere in a PR body,
   title or commit message posts a cross-reference event on that timeline even
   without a keyword. Whether GitHub treats `Trial-Closes:` itself as a closing
   keyword is unverified; README step 5 checks it on a scratch issue before run 1.
3. **No writes to shared state during a run:** no comments, labels or closures on
   queue issues, no new issues. Follow-ups go in the run report, and the owner
   files them after run 4.
4. **Never read another run's branch or PRs** (`trial/*` other than your own, or
   PRs whose base is one), and **never read the owner's vault** (`~/Obsidian`)
   or any file named `KEY.md` / `KEY.md.enc`: the sealed answer key (section 5)
   lives there, on the same Mac the runs use. Self-report any accidental read in
   the run report.
5. **Graders audit** PR bodies and transcripts for violations of 2–4 and for
   solutions that are byte-identical to an earlier run's.

Residual leak: a run that deliberately lists merged PRs on other trial bases can
find them. This is **detected, not prevented**. The key itself is a different
case: it sits on the same Mac, so it is encrypted at rest (prevention) and its
digest is committed before run 1 (detection of any change). The stricter alternative — one
private fork per run — would lose Copilot auto-review, the repository rulesets and
repo-memory parity, so it is held in reserve for a second trial if graders find
leakage in this one.

## 5. Queue

Eight to twelve open issues, the same for every run, chosen by the owner from a
candidate list prepared in advance. Rules: open, concrete acceptance criteria,
no open PR, no owner-device or production dependency, no `.claude/`,
`.github/workflows` or `docs/reports/harness-evals/` changes, nothing about Codex
model admission (#8609 is reserved), stratified across bugs, features, one or two
cross-package items and one test or tooling item, spread across packages.

**Sealed answer key.** Before run 1 starts, the owner writes a private note per
issue in the vault (outside the repository): expected root cause, acceptance
checks, and whether the fix is already known. Nothing from it enters the repo
until all four runs are done, but its SHA-256 is committed in
`KEY-COMMITMENT.md` before run 1 so a later edit is detectable. After run 4 the
key is committed to `trial/eval` for the graders, who verify the digest first.
Where the owner does not know the answer, the four implementations are
cross-checked against each other, CI and the issue's own acceptance criteria —
that is the realistic case and is graded as such.

Why not re-run already-fixed issues: the merged fix is one `git log` or
`gh pr view` away, and the PD skill reads issues and history by design, so the
agents would find it in the normal course of work. Hiding it means a truncated
mirror with re-filed issues, which measures a crippled workflow, not the harness.

## 6. Measurements

Per run, per queue issue, computed from GitHub and the run report by the
diagnostic's scripts adapted to trial branches (reproducible, inputs committed):

| Measure | Source |
|---|---|
| Delivered: merged into base **and** grader-verified correct | PR + grader |
| Wall clock: first command → run report committed | run report, PR timestamps |
| Cost: Claude session cost (`/cost` or ccusage) ; Codex from the owner's usage page, else `n/a` | run report / owner |
| CI runs per PR | Actions API |
| Red CI on the base after a merge | Actions API — **observable only if** the owner adds `trial/**` to `on.push.branches` in `ci.yml` before T0 (README step 4); `ci.yml` runs on `pull_request` to any base but on `push` only to `main`, so without that change a merge into `trial/*` triggers nothing. Graders then record `not observable`, never `0`. |
| Review rounds, split Copilot vs owner-account bodies | PR reviews |
| PR cycle (opened → merged): median and nearest-rank p90 | PR timestamps |
| Stalls (> 90 min with no commit, CI or PR activity) and incidents | supervisor log + run report |
| Isolation violations (section 4) | grader audit |
| Secondary: diff size, tests added, follow-ups deferred, blocked issues and why | PR + run report |

Units stay separate; nothing is folded into one score.

## 7. Grading

Two graders, cross-origin, fresh context, both using `graders/GRADER-PROMPT.md`:

| Grader | Model | Where | First grades |
|---|---|---|---|
| `G-claude` | `claude-fable-5-1` | a fresh cloud session spawned by the supervisor | arm B |
| `G-codex` | `gpt-6-astra` (xhigh) | Codex desktop, started by the owner | arm A |

Each grades all four runs, writes to its own branch (`trial/eval-claude`,
`trial/eval-codex`), then the two cross-review through the mailbox protocol in
`../mailbox/README.md`. Disputes go to the owner, who decides with the sealed
key. A third, CY-hosted grader is deliberately omitted: CY is a subject here, and
three graders across two vendors would give one vendor two votes.

Blinding is not possible — each harness leaves fingerprints in PR bodies, branch
names and review patterns — so the cross-origin pairing is the substitute.

## 8. Caveats

- **n = 1 per cell.** This is a pilot. Report effect sizes with the raw numbers;
  make no significance claims.
- **Rate limits are per vendor, not per harness.** A1 and A2 draw on the same
  Claude allowance; B1 and B2 on the same ChatGPT plan. Start each run just after
  that vendor's reset, and record any throttling as an incident.
- **Non-default bases carry no branch protection** unless the owner adds a
  ruleset for `trial/**` mirroring `main` (recommended, see README step 4). The
  PD skill's own gates (green CI, clean `/full-review`, resolved threads) still
  apply because the mission says so.
- **CY has never run a PD mission** (diagnostic §9). The dry runs in README step 5
  exist to surface that before the clock starts.
- **Invocation differs by vendor** (slash skill vs compiled prompt). Recorded,
  not controlled.
- The version-bump workflow and issue auto-close do not fire on `trial/*`. Both
  are intended. Neither does CI on a *push* to `trial/*` unless the owner adds
  the trigger (README step 4): the "red CI on the base" measure is `not
  observable` without it, and a zero there is a missing measurement, not a
  clean record.

## 9. Roles

| Who | Does |
|---|---|
| Owner (Mac) | picks the queue and writes the sealed key; compiles codex prompts; makes the four clones; adds the ruleset; launches each run and types its invocation; records Codex cost; starts `G-codex`; unseals the key after run 4; files deferred follow-ups |
| Cloud supervisor (the session this protocol came from) | cuts `trial/*` at `T0` on the owner's go; renders missions; watches GitHub and the CCR session list on a 3-hour check-in while a run is live; reports stalls and violations; never messages a running subject; spawns and supervises `G-claude`; runs the measurement scripts; writes the trial report |

The supervisor cannot reach the Mac: it cannot start the desktop apps or the
daemon, and a message it sent into a running session would arrive as peer data,
not as the owner's authority — which a PD run needs for self-merge. The owner
types the invocations; the supervisor observes.
