---
title: Harness diagnostic — Claude desktop (CD) vs Codex (CX) vs Chroxy (CY), 2026-10-01 → 2026-10-17
date: 2026-10-17
type: harness-evaluation
repo: blamechris/chroxy
range: 2026-10-01..2026-10-17 (baselines 2026-09-13..09-30 and June 2026)
reviewer-harness: CD-cloud (Claude Code cloud sandbox launched from the Claude desktop app)
reviewer-model: claude-fable-5-1
reviewer-session: https://claude.ai/code/session_01QFgA5oVzgj3YV1GDozGXMv
status: draft for cross-review by the other evaluating agent
tags: [harness-eval, chroxy, codex, claude-desktop, prime-directive]
---

# Harness diagnostic: CD vs CX vs CY (Oct 1–17, 2026)

> **Where this review originates (for tracking harness evaluations).** Written by a Claude Code **cloud sandbox session launched from the Claude desktop app** (`origin: desktop_app`, environment kind `anthropic_cloud`, Claude Code 2.1.302), model **claude-fable-5-1** (configured and served), effort `xhigh`, permission mode `auto`. Session: <https://claude.ai/code/session_01QFgA5oVzgj3YV1GDozGXMv>. Working branch `claude/harness-diagnostic-cd-cx-cy-n619c8`. Four worker subagents collected GitHub data; all analysis and prose is the main session's.
>
> **What this review could and could not see.** It had GitHub (PRs, issues, Actions, review threads, PR head refs) and a clone of the repo. It had **no access to the private Obsidian vault** (benchmark rows from `usage-benchmark-row.py`, handoff seeds, smoke PNGs, session ledgers), no daemon logs, no session transcripts and no token meters. Everything below is reconstructed from durable GitHub state, so **cost is a proxy, not a measurement**, and harness attribution is evidence-graded (see §3). The vault-side agent should be able to join its rows to the run ids here.

## 1. Bottom line

1. **In Oct 1–17 the measurable output was overwhelmingly Claude-driven coordinator waves; Codex was a steady secondary; Chroxy-hosted (CY) work that can be *proven* from GitHub artifacts is one run.** Of **173 PRs merged** in the window, 142 came from Claude sessions whose host cannot be told apart from git (CD vs CY, labelled `CD?` below), 16 from Codex (`codex/` branches), 2 more are probably Codex (dialect), 12 are small bursts with no harness signal, and **1 PR is provably Chroxy-hosted** (#8276, see §3 and §6).
2. **The one documented CY prime-directive run (Oct 4–6, delivering #8265/#8266 as PR #8276) finished its delegated outcome but spent ~15.4 h of its 23.1 h PR lifetime stalled** on a Chroxy claude-sdk defect chain (#8300 orphan-task notification closing the permission channel, #8301 CI completion never waking an SDK session, #8302 roster `isBusy` stuck, #8303 Browse/Create cwd mismatch). The owner had to intervene; the run then produced four high-quality defect reports and the fixes landed the next morning (#8320, #8325, #8304). As a *harness* result it is a fail-then-fix: work preserved, autonomy lost.
3. **The Claude coordinator waves (most likely CD) set the throughput ceiling:** the Oct 7–9 wave merged **92 PRs in 29.7 h (3.1 PRs/h, +66.9k/−3.8k lines, 1,033 files)** with a 55-min median PR cycle, up to 12 PRs open at once, 7 branch CI failures in 208 runs and one red main-branch run. Half of the issues it closed (49/93) were filed during the wave itself, i.e. the wave fed on its own review and smoke findings as much as on backlog.
4. **Codex (CX) on Oct 13–14 ran a 12-PR, 33-h session at ~0.4 PRs/h** with a longer cycle (median 84 min, p90 246), **3.5 review events per PR** against 1.2–1.5 for Claude runs with a similar commit count (consistent with Codex re-requesting Copilot after each push), 3 branch CI failures in 26 runs and one red main run (#8607). It merged #8606 with its own PR body stating two strict smoke assertions still failed. Its best contribution of the period was finding that **Codex silently truncated this repo's 42.8 KB `AGENTS.md`** (#8577 → #8578), a harness defect no Claude run could have noticed.
5. **Cost cannot be compared from GitHub.** The only hard dollar figure in the period is Codex's own fixture trial inside #8200 ($3.81 for six Claude Code evaluation cases). Per-run cost must come from the vault's benchmark rows; §8 gives the join keys and the proxies (commits, review rounds, lines) that are available here.
6. **Single sessions (SS) across harnesses look alike in GitHub:** 1–5 PRs, 10–140 min cycles, one or two commits per PR, almost no review threads. The harness difference shows up only in **PD runs** (parallelism, self-healing, stall behaviour) and in **incidents** (§6).

## 2. Scope, data and method

**Window.** Runs whose PRs merged between 2026-10-01 00:00 and 2026-10-17 23:59 UTC (the evaluation range agreed with the other agent). Baselines: 2026-09-13 → 09-30 (pre-pilot Claude marathons and the first Codex PRs) and the June 2026 marathons recorded in `docs/decisions/2026-06-02-overnight-marathon.md` and `docs/reports/status-2026-06-13.html`.

**Sources (all collected 2026-10-17 08:50–09:15 UTC).**
- GitHub REST via MCP: 400 closed PRs (#7674–#8612) with head branch, timestamps; bodies for the 336 PRs created since Sep 22; 564 issues updated since Sep 22 (412 created since then); 6,300 Actions runs since Sep 13; per-PR commits, reviews and review threads for every PR created Sep 22 → Oct 17 (one worker per range).
- Git: `origin/main` deepened to 2026-06-01 for squash-merge sizes (`--shortstat`); `refs/pull/N/head` for 346 PRs to read commit author identity and timezone.
- Repo text: `AGENTS.md`, `.claude/skill-profile.md`, the prime-directive skill, `CHANGELOG.md`, `scripts/fixtures/prime-compatibility/`.

**Run detection.** Merge timestamps on `main` were clustered with a 3-hour gap rule (34 clusters Sep 22 → Oct 17), then each cluster was split by harness evidence. A run's **window** is first-PR-opened → last-merge. Where one session clearly spans two clusters (the Oct 8 wave's last PRs were opened at 21:40 and merged after 01:52), they are merged into one run.

**Metrics.**
- *Work*: merged PRs, files and +/− lines from the squash commit, distinct issues named by `Closes/Fixes/Resolves`, and how many of those were filed **during** the run (self-generated work vs backlog).
- *Time*: window span, PR cycle (opened → merged) median and p90, first commit → PR opened, last commit → merge, and commit spans (stalls).
- *Issues*: CI runs on the PR branches (success/failure/cancelled, where cancelled = superseded by a newer push), red `CI` runs on `main` traced to the run's merge commit, Copilot review threads and owner replies, follow-up `from-review` issues filed, follow-up PRs, abandoned PRs, and incidents documented in issue bodies.
- *Cost*: not observable here; proxies and join keys only.

**Attribution signals used** (details and confidence in §3): branch prefix, commit author identity, commit timezone, PR-body dialect, and explicit statements in issue bodies.

**Limitations that matter.** (a) `CD` and `CY` are both Claude Code on the owner's Mac committing as the same identity in the same timezone; only one run self-identifies. (b) Codex and Claude can both appear inside one PR (Claude waves used Codex as a reviewer, 11 PRs in R11 cite Codex review rounds). (c) Issue counts "filed in window" include the owner's own filing activity on those days. (d) Lines changed over-weight test-heavy PRs. (e) The failing test names behind the red `main` runs were not in the retrievable log tails (TAP output exceeded the 5,000-line tail), so those are classified only by job and by whether the PR branch was green. (f) A run window starts at its oldest PR's creation, so a long-open PR inflates the span of a baseline row; the Oct rows are not affected.

## 3. Attribution ledger (read this before trusting any harness column)

| Signal | What it shows | Where it holds | Confidence |
|---|---|---|---|
| Branch prefix `codex/` | Codex-authored PR | 25 PRs Sep 13 → Oct 17 (#7841–#7854, #8200/#8202/#8205, #8583–#8608, #8612) | High |
| PR-body dialect: no headings, a `Validation:` bullet block, "independent review … final head", "contained P3" | Codex authorship | All `codex/` PRs; also #8578 and #8581 on `fix/`/`feat/` branches (Oct 12) | High on `codex/`; probable on #8578/#8581 (#8578 also says it ran "fresh instruction-loading proofs … in Codex CLI 0.154.0") |
| Commit author `BlameChris <ChrisPishaki@gmail.com>` instead of `blamechris <christopher.bowenx@gmail.com>` (936 of 959 commits) | A different git identity, i.e. a different checkout or HOME: the Chroxy daemon's environment | Only PR #8276 (5 commits, Oct 4–5) and PR #7853 (2 commits, Sep 14, `codex/codex-native-endpoint`) | High for #8276 (issue #8300 and PR #8304 describe it as "an autonomous `claude-sdk` session in Auto mode" / "the 2026-10-05 delivery run"); #7853 therefore *probably* a Chroxy-hosted Codex-provider session — owner to confirm |
| Branch `llm-/great-tesla-uc8nfy`, commits at `+0000` | A cloud-sandbox Claude Code session with a non-default branch prefix (same adjective-scientist slug shape as the four `claude/…` branches on origin from July; this review's own session uses the same scheme) | #8131, #8149, #8157 (Sep 29–30, including the v0.11.1 release cut) | Probable; owner to confirm the `llm-/` prefix is their cloud-environment setting |
| Issue #8323 (Oct 6): "The maintainer's daily loop is a coordinator session fanning out reviewers, scopers and implementers. In the vendor desktop app a subagent's work is at least readable…" | The coordinator-wave pattern is the owner's **desktop-app** loop | Supports labelling the large coordinator waves (R11, R14, Sep marathons) as CD | Inferred, not proven per run |
| PR #8216 (Oct 3): "Under the delivery pilot it gets one independent review per round plus a Codex review" | A "delivery pilot" was running Oct 1–7 with Codex as a reviewer inside Claude runs | 11 PRs in R11 have "Codex round/delta" sections; #8320, #8330, #8423, #8476, #8512 | High (text) |
| Smoke table + `evidence: private vault smoke/chroxy-pr<N>-<head7>` | The prime-directive smoke step (added Oct 6 by #8304; first seen Oct 4 in #8272) → PD mode | 81 of 92 PRs in R11, 12/20 in R14, 5/12 in R18-CX | High for "PD-style", harness-neutral |

**Everything labelled `CD?` below is Claude Code on the owner's machine whose host (desktop app vs Chroxy) GitHub cannot show.** The owner's vault ledgers are the only source that can settle those rows; the per-PR CSV in `data/` is laid out so a vault-side join by PR number or window is a one-liner.

## 4. Run inventory

### 4.1 Oct 1–17 (evaluation window)

| Run | Harness | Mode | Window (UTC) | Span h | PRs | Files | Lines | Commits | Cycle med/p90 min | CI runs / fails | Issues closed (filed in-window) | Issues filed in-window (from-review) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R01 | CD? | PD? | 09-30 16:24→10-01 08:11 | 15.8 | 13 | 124 | +9,233 / −492 | 41 | 41 / 82 | 36 / 5 | 13 (3) | 12 (11) |
| R02-CX | CX | SS | 10-01 04:09→10-01 20:12 | 16.0 | 3 | 38 | +1,297 / −617 | 5 | 124 / 124 | 5 / 0 | 0 (0) | 0 (0) |
| R03 | CD? | SS? | 10-01 20:01→10-02 23:30 | 27.5 | 4 | 12 | +3,475 / −168 | 10 | 46 / 46 | 10 / 0 | 4 (0) | 4 (4) |
| R04 | CD? | SS | 10-03 07:58→10-03 08:53 | 0.9 | 1 | 7 | +956 / −27 | 4 | 56 / 56 | 4 / 0 | 1 (0) | 3 (3) |
| R05 | CD? | PD? | 10-04 20:44→10-04 22:17 | 1.6 | 1 | 47 | +3,588 / −127 | 13 | 93 / 93 | 2 / 1 | 1 (0) | 2 (0) |
| R06 | CD? | SS | 10-05 05:10→10-05 07:11 | 2.0 | 2 | 5 | +273 / −12 | 3 | 22 / 14 | 3 / 0 | 2 (1) | 1 (1) |
| R07-CY | CY | PD | 10-05 01:43→10-06 00:50 | 23.1 | 1 | 46 | +1,129 / −175 | 5 | 1387 / 1387 | 5 / 1 | 2 (0) | 21 (4) |
| R08 | CD? | SS | 10-06 01:39→10-06 10:33 | 8.9 | 3 | 64 | +6,066 / −214 | 28 | 82 / 82 | 16 / 2 | 3 (0) | 23 (0) |
| R09 | CD? | SS | 10-06 20:40→10-06 22:57 | 2.3 | 1 | 17 | +3,850 / −2 | 11 | 137 / 137 | 6 / 2 | 1 (0) | 4 (0) |
| R10 | CD? | SS | 10-07 01:41→10-07 19:34 | 17.9 | 5 | 108 | +6,587 / −175 | 15 | 31 / 76 | 12 / 4 | 2 (0) | 4 (2) |
| R11 | CD? | PD | 10-07 23:25→10-09 05:05 | 29.7 | 92 | 1033 | +66,853 / −3,776 | 221 | 55 / 157 | 208 / 7 | 93 (49) | 90 (9) |
| R12 | ? | SS | 10-09 08:04→10-09 08:48 | 0.7 | 3 | 35 | +1,845 / −46 | 5 | 23 / 23 | 5 / 1 | 3 (0) | 4 (4) |
| R13 | ? | PD? | 10-09 17:30→10-09 18:00 | 0.5 | 3 | 14 | +954 / −44 | 6 | 25 / 25 | 5 / 0 | 3 (0) | 0 (0) |
| R14 | CD? | PD | 10-10 07:21→10-10 14:04 | 6.7 | 20 | 136 | +6,111 / −961 | 41 | 27 / 41 | 41 / 0 | 19 (3) | 12 (8) |
| R15 | ? | PD? | 10-11 01:15→10-11 02:19 | 1.1 | 5 | 32 | +1,231 / −106 | 8 | 24 / 27 | 8 / 0 | 6 (1) | 2 (2) |
| R16-CX? | CX? | SS | 10-12 00:33→10-12 06:23 | 5.8 | 2 | 107 | +4,110 / −1,767 | 8 | 91 / 78 | 6 / 4 | 3 (0) | 2 (1) |
| R17 | ? | SS | 10-12 06:57→10-12 07:06 | 0.2 | 1 | 3 | +192 / −19 | 1 | 10 / 10 | 1 / 0 | 0 (0) | 0 (0) |
| R18-CX | CX | PD? | 10-13 01:22→10-14 10:38 | 33.3 | 12 | 245 | +9,021 / −1,431 | 31 | 84 / 246 | 26 / 3 | 10 (7) | 14 (1) |
| R19-CX | CX | SS | 10-17 06:39→10-17 06:56 | 0.3 | 1 | 4 | +514 / −0 | 2 | 17 / 17 | 2 / 0 | 0 (0) | 0 (0) |

Totals for the window, by harness bucket:

| Bucket | Runs | PRs | Files | Lines | Issues closed |
|---|---|---|---|---|---|
| CD? | 10 | 142 | 1,553 | +106,992 / −5,954 | 139 |
| CX | 3 | 16 | 287 | +10,832 / −2,048 | 10 |
| ? | 4 | 12 | 84 | +4,222 / −215 | 12 |
| CX? | 1 | 2 | 107 | +4,110 / −1,767 | 3 |
| CY | 1 | 1 | 46 | +1,129 / −175 | 2 |

PR membership of every run is in `data/runs-2026-10-17.csv` (column `pr_numbers`) and per-PR in `data/pr-attribution-2026-10-17.csv`.

Caveats on the issue columns: "filed in-window" counts every issue the owner's account opened during the window, so it includes planning that was not produced by the run. For **R07-CY the 21 issues are the Oct 5 #8280 epic family** (continue-a-conversation-with-another-provider), not run output; the run's own defect reports #8300–#8303 landed 46 minutes after the merge and so fall outside its window. For R08 the 23 are the Oct 6 knowledge-base epic (#8305–#8334). For R11, 69 of the 83 issues opened on Oct 8 carry no label, so the `from-review` column undercounts the wave's follow-up filings.

### 4.2 Baselines (Sep 13 → Sep 30) and June reference points

| Run | Harness | Mode | Window (UTC) | Span h | PRs | Files | Lines | Commits | Cycle med/p90 min | CI runs / fails | Issues closed (filed in-window) | Issues filed in-window (from-review) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B-CX-Sep13 | CX | SS? | 09-13 16:08→09-15 01:30 | 33.4 | 8 | 182 | +8,172 / −562 | 38 | 211 / 263 | 10 / 1 | 0 (0) | 1 (0) |
| B-CX-7854 | CX | SS | 09-18 06:01→09-26 07:28 | 193.5 | 1 | 20 | +6,535 / −6 | 12 | 11607 / 11607 | 7 / 0 | 0 (0) | 55 (42) |
| B1 | CD? | PD? | 09-22 06:17→09-22 23:48 | 17.5 | 8 | 56 | +5,004 / −262 | 28 | 877 / 884 | 27 / 0 | 9 (2) | 10 (8) |
| B2 | CD? | PD? | 09-12 04:33→09-24 18:49 | 302.3 | 21 | 87 | +8,701 / −1,261 | 54 | 174 / 295 | 53 / 2 | 20 (13) | 52 (21) |
| B3 | CD? | PD? | 09-25 01:54→09-26 05:36 | 27.7 | 28 | 150 | +17,152 / −941 | 82 | 241 / 914 | 59 / 6 | 37 (10) | 22 (19) |
| B4 | CD? | PD? | 09-26 08:04→09-28 07:28 | 47.4 | 26 | 176 | +13,963 / −4,302 | 93 | 88 / 227 | 68 / 3 | 23 (14) | 31 (22) |
| B5 | CD? | PD? | 09-28 10:51→09-28 14:55 | 4.1 | 10 | 67 | +3,822 / −218 | 32 | 54 / 98 | 30 / 1 | 10 (1) | 5 (5) |
| B6 | CD? | PD? | 09-28 15:46→09-29 02:36 | 10.8 | 10 | 91 | +7,697 / −457 | 25 | 64 / 118 | 23 / 3 | 10 (5) | 12 (12) |
| B7 | CD? | PD? | 09-29 06:08→09-30 07:41 | 25.5 | 42 | 289 | +20,373 / −1,412 | 106 | 28 / 71 | 103 / 2 | 49 (29) | 43 (36) |
| B8 | CD? | SS? | 09-30 10:07→09-30 18:03 | 7.9 | 5 | 49 | +5,096 / −286 | 13 | 100 / 110 | 12 / 0 | 5 (0) | 2 (2) |

Baseline windows start at the oldest PR's creation, so a long-open PR inflates the span: B2 includes a PR opened Sep 12 and merged Sep 24, and B-CX-7854 is a single PR open for eight days. Read the Sep rows for size and cycle time, not for PRs per hour.

June reference points (from repo records, not re-derived): the 2026-06-02 overnight run merged **12 PRs from 12 issues in a 60.5-minute first marathon** (12/12 approved) and continued as a two-session marathon; the 2026-06-13 status report records **28 PRs merged across that marathon**. Those were single Claude sessions without the Oct smoke/owner-reserved discipline, so they are a throughput ceiling for small, test-light fixes rather than a like-for-like baseline.

### 4.3 Review and commit shape per run

| Run | Harness | Mode | PRs covered | Commits/PR | PRs >1 commit | Review threads (resolved) | PRs with threads | Copilot comments | Owner replies | Reviews/PR | First commit→PR open (med min) | Last commit→merge (med min) | First→last commit (med min) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R01 | CD? | PD? | 13/13 | 3.2 | 11 | 6 (6) | 5 | 6 | 6 | 1.46 | 1 | 15 | 22 |
| R02-CX | CX | SS | 3/3 | 1.7 | 2 | 2 (2) | 2 | 2 | 2 | 1.67 | 0 | 16 | 6 |
| R03 | CD? | SS? | 4/4 | 2.5 | 4 | 1 (1) | 1 | 1 | 1 | 1.25 | 1 | 13 | 26 |
| R04 | CD? | SS | 1/1 | 4.0 | 1 | 0 (0) | 0 | 0 | 0 | 1.0 | 2 | 15 | 42 |
| R05 | CD? | PD? | 1/1 | 13.0 | 1 | 0 (0) | 0 | 0 | 0 | 3.0 | 82 | 30 | 145 |
| R06 | CD? | SS | 2/2 | 1.5 | 1 | 0 (0) | 0 | 0 | 0 | 1.0 | 0 | 17 | 2 |
| R07-CY | CY | PD | 1/1 | 5.0 | 1 | 0 (0) | 0 | 0 | 0 | 1.0 | 7 | 156 | 1237 |
| R08 | CD? | SS | 3/3 | 9.3 | 3 | 0 (0) | 0 | 0 | 0 | 1.0 | 2 | 17 | 66 |
| R09 | CD? | SS | 1/1 | 11.0 | 1 | 0 (0) | 0 | 0 | 0 | 1.0 | 12 | 16 | 133 |
| R10 | CD? | SS | 5/5 | 3.0 | 3 | 0 (0) | 0 | 0 | 0 | 1.0 | 1 | 17 | 15 |
| R11 | CD? | PD | 92/92 | 2.4 | 68 | 16 (16) | 16 | 16 | 16 | 1.18 | 1 | 31 | 16 |
| R12 | ? | SS | 3/3 | 1.7 | 2 | 0 (0) | 0 | 0 | 0 | 1.0 | 0 | 14 | 9 |
| R13 | ? | PD? | 3/3 | 2.0 | 2 | 0 (0) | 0 | 0 | 0 | 1.0 | 0 | 17 | 10 |
| R14 | CD? | PD | 20/20 | 2.0 | 16 | 5 (5) | 5 | 5 | 5 | 1.25 | 0 | 13 | 11 |
| R15 | ? | PD? | 5/5 | 1.6 | 3 | 3 (3) | 3 | 3 | 3 | 1.6 | 3 | 16 | 8 |
| R16-CX? | CX? | SS | 2/2 | 4.0 | 2 | 0 (0) | 0 | 0 | 0 | 1.0 | 18 | 15 | 87 |
| R17 | ? | SS | 1/1 | 1.0 | 0 | 0 (0) | 0 | 0 | 0 | 1.0 | 6 | 16 | 0 |
| R18-CX | CX | PD? | 12/12 | 2.6 | 8 | 7 (7) | 5 | 7 | 7 | 3.5 | 9 | 41 | 54 |
| R19-CX | CX | SS | 1/1 | 2.0 | 1 | 1 (1) | 1 | 1 | 1 | 2.0 | 1 | 12 | 6 |
| B-CX-Sep13 | CX | SS? | 0/8 | – | – | – | – | – | – | – | – | – | – |
| B-CX-7854 | CX | SS | 0/1 | – | – | – | – | – | – | – | – | – | – |
| B1 | CD? | PD? | 8/8 | 3.5 | 8 | 6 (6) | 5 | 6 | 6 | 2.12 | 1 | 618 | 241 |
| B2 | CD? | PD? | 20/21 | 2.7 | 17 | 14 (14) | 9 | 14 | 14 | 1.7 | 1 | 106 | 19 |
| B3 | CD? | PD? | 28/28 | 2.9 | 22 | 26 (26) | 17 | 26 | 26 | 1.93 | 1 | 147 | 19 |
| B4 | CD? | PD? | 26/26 | 3.6 | 21 | 14 (14) | 10 | 14 | 14 | 1.73 | 0 | 44 | 28 |
| B5 | CD? | PD? | 10/10 | 3.2 | 10 | 8 (8) | 7 | 8 | 8 | 1.8 | 0 | 22 | 29 |
| B6 | CD? | PD? | 10/10 | 2.5 | 9 | 9 (9) | 6 | 9 | 8 | 1.8 | 1 | 15 | 48 |
| B7 | CD? | PD? | 42/42 | 2.5 | 29 | 13 (13) | 12 | 13 | 13 | 1.31 | 1 | 14 | 10 |
| B8 | CD? | SS? | 5/5 | 2.6 | 3 | 1 (1) | 1 | 1 | 1 | 1.2 | 1 | 17 | 83 |

Reading the shape: Claude runs open the PR within about a minute of the first commit and then push follow-up commits (2–3 per PR, 16–30 min first→last) while Copilot reviews; "last commit → merge" of 13–17 min is essentially CI latency, so Claude waves merge as soon as CI is green. Codex (R18-CX) carries 2.6 commits per PR but waits a median 41 min after its last commit and accrues 3.5 review events per PR, consistent with re-requesting Copilot after each push. The CY run's 1,237-minute first→last commit span is the stall described in §6.

## 5. Comparison

### 5.1 Prime-directive style runs (the harness-sensitive mode)

| Metric | R11 (CD?/PD) | R14 (CD?/PD) | R18-CX (CX/PD?) | R07-CY (CY/PD) | B7 (CD?/PD?) | B3 (CD?/PD?) |
|---|---|---|---|---|---|---|
| Merged PRs | 92 | 20 | 12 | 1 | 42 | 28 |
| Window span (h) | 29.7 | 6.7 | 33.3 | 23.1 | 25.5 | 27.7 |
| PRs per hour of window | 3.10 | 2.99 | 0.36 | 0.04 | 1.65 | 1.01 |
| Lines +/− | +66,853 / −3,776 | +6,111 / −961 | +9,021 / −1,431 | +1,129 / −175 | +20,373 / −1,412 | +17,152 / −941 |
| Changed lines per PR (mean) | 767 | 353 | 871 | 1,304 | 518 | 646 |
| Files touched | 1,033 | 136 | 245 | 46 | 289 | 150 |
| Commits per PR | 2.4 | 2.0 | 2.6 | 5.0 | 2.5 | 2.9 |
| PR cycle, median / p90 (min) | 55 / 157 | 27 / 41 | 84 / 246 | 1387 / 1387 | 28 / 71 | 241 / 914 |
| Last commit → merge, median (min) | 31 | 13 | 41 | 156 | 14 | 147 |
| CI runs on PR branches / failures | 208 / 7 (3%) | 41 / 0 (0%) | 26 / 3 (12%) | 5 / 1 (20%) | 103 / 2 (2%) | 59 / 6 (10%) |
| Review threads per PR | 0.17 | 0.25 | 0.58 | 0.00 | 0.31 | 0.93 |
| Reviews per PR (Copilot + owner) | 1.18 | 1.25 | 3.5 | 1.0 | 1.31 | 1.93 |
| Issues closed (filed during the run) | 93 (49, 53%) | 19 (3, 16%) | 10 (7, 70%) | 2 (0, 0%) | 49 (29, 59%) | 37 (10, 27%) |
| Issues filed during the run (from-review) | 90 (9) | 12 (8) | 14 (1) | 21 (4) | 43 (36) | 22 (19) |

What the table supports:

- **Throughput.** The Claude coordinator waves run 3 PRs/hour sustained for 7–30 hours, roughly double the late-September marathons (B7: 1.6/h) and about eight times the Codex run (R18-CX: 0.36/h). The difference is parallelism: R11 kept a mean of 5.3 PRs open at once (max 12); R18-CX worked essentially serially (max 2 open).
- **PR size.** Codex PRs are larger per PR (870 changed lines vs ~770 for R11 and ~350 for R14) and touch more files per PR (20 vs 11), consistent with fewer, broader PRs.
- **Cycle time.** Claude waves: 55 and 27 min medians, p90 under 3 h. Codex: 84 min median, p90 4 h. CY (#8276): 23 h for one PR, 15.4 h of it idle.
- **CI.** Branch failure rates are similar and low for Claude (3.4% R11, 0% R14) and higher for Codex (11.5% R18-CX, 3 of 26). Red `main` runs after merge: R11 one (#8375, Desktop Rust Tests; log expired), R18-CX one (#8607, Server Tests, 2 failing of 21,319), plus R01 one (#8180), R02-CX two (#8200, #8202), R13 one (#8534, the Windows PodAgent suite, which has a flake history: #7709) and R15 one (#8576). Every one of those PR branches was green at its head and every red run failed a single test (two for #8607) out of 18–21k, so these read as flaky or order-dependent tests rather than harness-attributable breakage; the failing test names could not be retrieved (log tails).
- **Review pressure.** Copilot left 0.17 threads/PR on R11, 0.25 on R14 and 0.58 on R18-CX; the Sep baselines sat at 0.3–0.9. Every thread in every run was resolved with an owner reply (the agents reply as the owner, per the repo's zero-attribution policy). No PR in the whole window carried an APPROVED or CHANGES_REQUESTED review state; the repo's gate is Copilot comments plus conversation resolution, so "approvals" is not a usable quality signal here.
- **Self-generated work.** 53% of the issues R11 closed were filed during R11; 70% for R18-CX (it was fixing dogfood findings filed the same day: #8587, #8593, #8601, #8602, #8603); 16% for R14; 59% for B7. High self-generation is not bad per se (the smoke step is designed to find things) but it means "issues closed" overstates backlog burn-down by about half for the big waves.

### 5.2 Single sessions

SS runs in the window (R03, R04, R06, R08, R09, R10, R12, R16-CX?, R17, R19-CX) are 1–5 PRs each with 10–137 min cycles. Two things differ by harness: Codex SS PRs carry the `Validation:` block and no smoke table even when they touch the dashboard (#8578, #8581, #8612), while Claude SS PRs after Oct 6 carry the smoke table when in scope (R08, R09). PR size in SS is dominated by the task, not the harness (#8325 +4,156, #8330 +3,850, #8581 +3,233 are all SS). GitHub cannot separate CD-SS from CY-SS; the vault ledgers can.

### 5.3 Where CY stands, on the evidence available

- **Proven CY output in the window: one PD run, one PR, +1,129/−175 lines, 46 files, 2 issues closed, 23.1 h, with a 15.4 h stall and an owner intervention.** Compared with the smallest CD?-PD data point (R14: 20 PRs in 6.7 h, no stalls documented), CY is not yet competitive as an unattended PD host; this is a single data point, and the defects behind the stall were fixed the next day. Compared with CX, the CY run's *per-PR* quality was fine (the PR has a smoke section, mutation table and review fold-ins) and its failure mode was infrastructural, not model-quality.
- **CY's value in the period was diagnostic.** The run produced four precise defect reports with reproductions (#8300 includes a self-contained SDK-only repro script), which were fixed within a day (#8320, #8325) and converted into a dogfooding floor in the skill (#8304). Issue #8323 (desktop-parity: subagent transcripts invisible in Chroxy) and the Oct 13–14 Codex-in-Chroxy findings (#8593 fixed, #8609/#8610/#8611 open) are the same pattern: dogfooding the harness surfaces harness bugs.
- **Anything beyond that is unknown, not negative.** If the owner's ledgers show that R11, R14 or the Oct 9/11 bursts ran inside Chroxy, the picture changes completely; nothing in GitHub contradicts that, and nothing supports it either (see §3 and §9).

## 6. Incidents and harness defects observed

### 6.1 The CY run of Oct 4–6 (PR #8276)

| Step | Time (UTC) | Evidence |
|---|---|---|
| First commit (daemon identity `BlameChris`) | Oct 5 01:36 | PR head commits |
| PR opened | Oct 5 01:43 | PR #8276 |
| Commits 2–4 (review fold-ins) | Oct 5 02:32, 02:36, 06:49 | PR head commits |
| **Stall: no commits, session idle "on a permission nobody could resolve"** | Oct 5 06:49 → 22:14 (15 h 25 min) | commit gap; #8304 body: "sat idle for about 15 hours"; #8300: "three resumptions in a row began with a `<task-notification>` for background shells … each first tool call was cancelled" |
| Commit 5 | Oct 5 22:14 | PR head commits |
| Merged | Oct 6 00:50 | PR #8276 |
| Defects filed | Oct 6 01:36 (#8300, #8301, #8302, #8303) | issue timestamps |
| Fixes merged | Oct 6 02:26 (#8304 docs), 07:55 (#8320, +1,836/−135), 10:33 (#8325, +4,156/−55) | PR timestamps |

Root causes as filed: the Agent SDK closes the CLI's stdin at the first `result`, and a resumed turn that begins with an orphan-task notification emits a `num_turns: 0` result first, so every tool in the real turn is cancelled with the generic "user doesn't want to take this action" text and no `permission_request` is emitted (#8300); CI completion only wakes claude-tui PTYs, so the SDK session polled with a background `gh pr checks --watch` that became the orphan (#8301); the roster kept `isBusy: true` with no pending shells, so monitors read the idle agent as working (#8302). The owner's first manual action after the merge (Browse → Create with explicit cwd) also failed on a fixture every automated check had passed (#8303, still open).

### 6.2 Other harness-relevant findings in the window

- **Codex truncates this repo's rules.** #8577 (Oct 11): `AGENTS.md` at 42,813 bytes exceeded Codex's default `project_doc_max_bytes` (32 KiB) so every Codex session silently lost the last ~10 KB of project rules — including everything from "Testing Conventions" onward in the old layout. Fixed by #8578 (Oct 12), which made `AGENTS.md` the authored source with thin `CLAUDE.md`/`GEMINI.md` adapters and added an executable size floor. Any Codex PR before Oct 12 ran without the tail of the rules.
- **Chroxy's Codex provider failed on first use for the owner.** #8609 (Oct 14, open, priority high): chroxy spawns whichever `codex` is first on PATH (codex-cli 0.154.0) while the Codex desktop app bundles 0.162.0-alpha; the shared `~/.codex/config.toml` names `gpt-6.1-sol`, which the older client cannot use, so a default Codex session fails its first message with HTTP 400. #8610 (errors render as raw JSON, turn stays busy) and #8611 (New Session modal overflow) were filed with it. #8593 (composer accepted input ~90 ms before native startup) was fixed by #8600.
- **Running the server test suite on the owner's machine broke live Chroxy sessions.** #8352 (Oct 7): "several agents ran the full server suite on the owner's machine" and the suite deleted the live daemon's claude-tui hook-sink base, breaking every running claude-tui session. This is a direct hazard of running CD waves and CY sessions on the same host; fixed the same night (#8353).
- **Two PRs were abandoned** in the whole Sep 22 → Oct 17 range: #8182 (Sep 30, closed in 2 min, superseded) and #8212 (Oct 2, closed unmerged after 16 h with no review). Zero reverts on `main`.
- **Follow-up PRs fixing a run's own PRs** (same-day): #8409, #8442, #8494 (R11) and #8542 (R14, from the #8530 review). These are normal review fold-ins, not regressions reported by users.
- **Known flaky tests touched the window:** harness-case-floor (#8498, fixed by #8509 on Oct 8), PodAgent on Windows (#7709), both appearing in red `main` runs.

## 7. What each harness did well and badly (evidence-bound)

**CD (Claude coordinator waves, probable).** Best throughput and parallelism by a wide margin; consistent PR template (cause → fix → tests → mutation table → smoke → owner-reserved); low Copilot friction; CI mostly green. Costs: half the closed issues were self-generated, the waves file ~1 issue per PR (90 in R11), and the wave consumed the owner's machine (`#8352`). No stall or abandonment documented.

**CX (Codex).** Lower throughput and serial execution; bigger PRs; more review events per PR and the highest branch CI failure rate; two red `main` runs on Oct 1 and one on Oct 14 after green branches. It merged a PR acknowledging remaining smoke-assertion failures (#8606). On the plus side: it found and fixed its own instruction-loading defect (#8577/#8578), it brought the `AGENTS.md`-as-source migration, and its PRIME-compatibility work (#8200) included a paid, recorded fixture ($3.81) rather than an assertion. Codex also served as a reviewer inside Claude waves (11 PRs in R11), which is a harness *collaboration* pattern worth tracking separately.

**CY (Chroxy).** One proven run: outcome delivered, autonomy failed on infrastructure, recovery excellent. The dogfooding floor added on Oct 6 (no background shell or subagent may outlive a turn; CI watcher in the foreground; completion is the explicit handoff) is the right response and should make the next CY-PD run measurable. Chroxy-as-harness also lacks subagent visibility (#8323) and had Codex-provider first-run failures (#8609).

## 8. Cost

- **Measured in GitHub: nothing per run.** The vault's `usage-benchmark-row.py` rows are the only durable cost record (per `.claude/skill-profile.md`, budget tracking is "track-only" since 2026-09-24). This review cannot see them.
- **One hard figure:** Codex's PRIME-compatibility fixture (#8200) ran six Claude Code 2.1.285 cases on host-default `claude-opus-5-5` at $0.58–$0.72 each, **$3.81 total**, recorded in `scripts/fixtures/prime-compatibility/verification-2026-09-30.json`.
- **Proxies available here** (all in `data/runs-2026-10-17.csv`): commits per run (API-call proxy: R11 221, R14 41, R18-CX 31, R07-CY 5), review rounds (reviews per PR), lines changed, and the "coordinator smoke on a real Haiku session" count in PR bodies (51 Haiku mentions on Oct 8, 30 on Oct 10, i.e. cheap-tier sessions were used for smoke, a cost-shaping choice the vault rows should confirm).
- **Join keys for the vault-side agent:** run id, window start/end (UTC) and PR list per run. A benchmark row whose session start/end falls inside a window belongs to that run; the Oct 8 wave likely spans several rows (compactions and re-launches).

## 9. Open questions for the owner (the attribution the vault can settle)

1. Which of R01, R03–R06, R08–R15 and R17 ran inside Chroxy (CY) versus the Claude desktop app (CD)? The `CD?` label means "Claude, host unknown".
2. Is `llm-/` the branch prefix of a Claude Code cloud environment (the Sep 29–30 session that cut v0.11.1)?
3. Was #7853 (Sep 14, `codex/codex-native-endpoint`, daemon git identity) a Chroxy-hosted Codex-provider session?
4. Were #8578 and #8581 (Oct 12, Codex dialect on `fix/`/`feat/` branches) Codex sessions?
5. Which runs were prime-directive (`/prime-directive` invoked) versus `/tackle-issues` or plain sessions? The smoke-table marker is a proxy for PD after Oct 6 only.

## 10. Recommendations to make the next evaluation measurable from GitHub alone

1. **Tag the harness in a vendor-neutral way the attribution policy allows:** a branch prefix per host (`codex/` already exists; `cy/` for Chroxy worktree sessions, `cd/` for the desktop app, `cloud/` for sandboxes) or a `Run-Id: <harness>-<mode>-<date>` line in the PR body. Chroxy could set the branch prefix itself when it creates a worktree.
2. **Commit the benchmark row** (or a redacted copy) next to the run's ledger, keyed by the same run id, so cost joins without the vault.
3. **Keep the distinct daemon git identity** (it is the only reason the CY run is provable) and make it deliberate: set `user.name`/`user.email` per Chroxy session to a recognisable but neutral value.
4. **Record stalls as data:** the dogfooding floor's "completion is the explicit handoff" should also log `turn idle since <t>` so a 15-hour gap is a metric, not an anecdote.
5. **Run CY and CD on different hosts or config roots** until #8352-class interference is ruled out.

## 11. Verification log

| Claim | How it was verified |
|---|---|
| 88 PRs merged on 2026-10-08 (UTC) | Count of `merged_at` dates in the GitHub PR list equals the count of squash commits on `origin/main` that day (both 88) |
| Run windows, sizes and cycle times | Recomputed from GitHub `created_at`/`merged_at` and `git log --shortstat` on the squash commit; three PRs whose squash subject lacked `(#N)` (#8338, #8581, #8612) matched by title/manual map |
| Harness of #8276 | Issue #8300 ("autonomous `claude-sdk` session in Auto mode", observed 2026-10-05) and PR #8304 ("the 2026-10-05 delivery run on #8276") read in full; five head commits authored `BlameChris <ChrisPishaki@gmail.com>` |
| 15.4-hour stall | Commit timestamps on `refs/pull/8276/head`: Oct 5 06:49 → 22:14 UTC; matches "about 15 hours" in #8304 |
| Codex authorship of `codex/` PRs | Branch prefix plus body dialect on all 25; #8609 confirms the owner uses the Codex desktop app |
| Red `main` runs | Actions runs filtered to workflow `CI`, event `push`, branch `main`, conclusion `failure`; job lists fetched for all seven October cases; PR-branch CI history checked for each merge commit's PR |
| Review thread and commit metrics | Per-PR `get_commits`, `get_reviews`, `get_review_comments` for every PR created Sep 22 → Oct 17 (169 October PRs, all three calls succeeded; September coverage shown in the table) |
| Issue counts | 564 issues updated since Sep 22 paged to exhaustion (`hasNextPage=false`), 412 created in range; labels read from the API |
| $3.81 fixture cost | `scripts/fixtures/prime-compatibility/verification-2026-09-30.json` `cases.*.cost_usd` summed; matches "$3.8064" in #8200 |
| Not verified | Failing test names in the red `main` runs; token/cost per run; CD vs CY for `CD?` rows; whether any `?` burst was Codex or Claude |

## 12. Appendix: files and reproduction

- `data/runs-2026-10-17.csv` — one row per run with every metric above and the PR list.
- `data/pr-attribution-2026-10-17.csv` — one row per merged PR (Sep 13 → Oct 17): run, harness, mode, size, head commits, git identity, body signals.
- `data/review-metrics-2026-10-17.csv` — per-run review/commit shape.
- Raw collections (not committed; in the reviewing session's scratchpad): PR list pages, PR bodies, issues JSON, 6,300 Actions runs, per-PR detail CSVs, PR head-commit identities, and the Python scripts that produced every table.

*Suggested vault location:* `no-it-all/reports/harness-evals/2026-10-17-harness-diagnostic-cd-cx-cy.md` (copy this file and the `data/` folder together).
