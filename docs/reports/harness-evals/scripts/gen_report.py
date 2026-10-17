import json, csv, collections
from datetime import datetime
runs=json.load(open('data/runs.json'))
R={o['run']:o for o in runs}
def ts(s): return datetime.fromisoformat(s)
def fmt_win(o):
    a=ts(o['window_start']); b=ts(o['window_end'])
    return f"{a:%m-%d %H:%M}→{b:%m-%d %H:%M}"
def rate(o): 
    return o['prs']/o['span_h'] if o['span_h']>0.5 else None
def pct(a,b): return f"{100*a/b:.0f}%" if b else "–"
def rv(o,k,default='–'):
    return o.get('review',{}).get(k,default)
def row_main(o):
    return (f"| {o['run']} | {o['harness']} | {o['mode']} | {fmt_win(o)} | {o['span_h']} | {o['prs']} | {o['files']} | +{o['ins']:,} / −{o['dels']:,} | "
            f"{o['commits']} | {o['median_cycle_min']} / {o['p90_cycle_min']} | {o['ci_runs']} / {o['ci_failure']} | {o['issues_closed']} ({o['closed_filed_in_window']}) | {o['issues_filed_in_window']} ({o['from_review_filed']}) |")
HDR=("| Run | Harness | Mode | Window (UTC) | Span h | PRs | Files | Lines | Commits | Cycle med/p90 min | CI runs / fails | Issues closed (filed in-window) | Issues filed in-window (from-review) |\n"
     "|---|---|---|---|---|---|---|---|---|---|---|---|---|")
oct_runs=[o for o in runs if not o['run'].startswith('B')]
base_runs=[o for o in runs if o['run'].startswith('B')]
def table(rs): return HDR+"\n"+"\n".join(row_main(o) for o in rs)
def review_table(rs):
    h=("| Run | Harness | Mode | PRs covered | Commits/PR | PRs >1 commit | Review threads (resolved) | PRs with threads | Copilot comments | Owner replies | Reviews/PR | First commit→PR open (med min) | Last commit→merge (med min) | First→last commit (med min) |\n"
       "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    rows=[]
    for o in rs:
        r=o.get('review')
        if not r: rows.append(f"| {o['run']} | {o['harness']} | {o['mode']} | 0/{o['prs']} | – | – | – | – | – | – | – | – | – | – |"); continue
        rows.append(f"| {o['run']} | {o['harness']} | {o['mode']} | {r['coverage']} | {r['commits_per_pr']} | {r['prs_multi_commit']} | {r['threads_total']} ({r['threads_resolved']}) | {r['prs_with_threads']} | {r['copilot_comments']} | {r['human_replies']} | {r['reviews_per_pr']} | {r['median_first_commit_to_pr_min']} | {r['median_last_commit_to_merge_min']} | {r['median_commit_span_min']} |")
    return h+"\n"+"\n".join(rows)
def pr_list(o): return ", ".join(f"#{n}" for n in o['pr_numbers'])

# comparison picks
cmp_ids=['R11','R14','R18-CX','R07-CY','B7','B3']
def cmp_table():
    h=("| Metric | "+" | ".join(f"{i} ({R[i]['harness']}/{R[i]['mode']})" for i in cmp_ids)+" |\n|---|"+"---|"*len(cmp_ids))
    rows=[]
    def add(name, f): rows.append(f"| {name} | "+" | ".join(f(R[i]) for i in cmp_ids)+" |")
    add("Merged PRs", lambda o:str(o['prs']))
    add("Window span (h)", lambda o:str(o['span_h']))
    add("PRs per hour of window", lambda o:f"{rate(o):.2f}" if rate(o) else "n/a (1 PR)")
    add("Lines +/−", lambda o:f"+{o['ins']:,} / −{o['dels']:,}")
    add("Changed lines per PR (mean)", lambda o:f"{(o['ins']+o['dels'])//o['prs']:,}")
    add("Files touched", lambda o:f"{o['files']:,}")
    add("Commits per PR", lambda o:str(rv(o,'commits_per_pr')))
    add("PR cycle, median / p90 (min)", lambda o:f"{o['median_cycle_min']} / {o['p90_cycle_min']}")
    add("Last commit → merge, median (min)", lambda o:str(rv(o,'median_last_commit_to_merge_min')))
    add("CI runs on PR branches / failures", lambda o:f"{o['ci_runs']} / {o['ci_failure']} ({pct(o['ci_failure'],o['ci_runs'])})")
    add("Review threads per PR", lambda o:f"{rv(o,'threads_total',0)/o['prs']:.2f}" if o.get('review') else "–")
    add("Reviews per PR (Copilot + owner)", lambda o:str(rv(o,'reviews_per_pr')))
    add("Issues closed (filed during the run)", lambda o:f"{o['issues_closed']} ({o['closed_filed_in_window']}, {pct(o['closed_filed_in_window'],o['issues_closed'])})")
    add("Issues filed during the run (from-review)", lambda o:f"{o['issues_filed_in_window']} ({o['from_review_filed']})")
    return h+"\n"+"\n".join(rows)

def sm(rid): return R[rid]['signals'].get('smoke-step',0)
RS={x['run']:x['sessions'] for x in json.load(open('data/run_sessions.json'))}
def sess_table():
    h=("| Run | Session record (title) | Created → last turn (UTC) | Kind | Model | Context at end | PRs the session's own summary names that are in this run | Session's closing status |\n|---|---|---|---|---|---|---|---|")
    rows=[]
    for o in runs:
        for sx in RS.get(o['run'],[]):
            if not sx['match'] and o['run'] not in ('R05','R06','R07-CY','R08','R09','R10','R03','R04','B1'): continue
            kind={'bridge/claude_code_cli/rc-sdk':'bridged local CLI (`remote-control-sdk`)','cloud/desktop_app':'cloud sandbox from desktop app'}.get(sx['kind'],sx['kind'])
            cost=f" (${float(sx['cost']):.2f})" if sx['cost'] else ''
            m=', '.join(f"#{n}" for n in sx['match']) or '–'
            rows.append(f"| {o['run']} | {sx['title'][:70]} | {sx['created'][5:16]} → {sx['updated'][5:16]} | {kind} | {sx['model'].replace('claude-','')} | {int(sx['ctx']):,}{cost} | {m} | {(sx['status'] or sx['recent'] or '')[:90]} |")
    return h+"\n"+"\n".join(rows)
_iss=[i for i in json.load(open('data/issues_since_0922.json')) if i['created_at'][:10]=='2026-10-08']
OCT8_UNL=sum(1 for i in _iss if not (i.get('labels') or []))
tot=collections.defaultdict(lambda: collections.Counter())
for o in oct_runs:
    b=o['harness']; tot[b]['prs']+=o['prs']; tot[b]['ins']+=o['ins']; tot[b]['dels']+=o['dels']; tot[b]['files']+=o['files']; tot[b]['closed']+=o['issues_closed']; tot[b]['runs']+=1
tot_rows="\n".join(f"| {b} | {c['runs']} | {c['prs']} | {c['files']:,} | +{c['ins']:,} / −{c['dels']:,} | {c['closed']} |" for b,c in sorted(tot.items(), key=lambda kv:-kv[1]['prs']))
all_oct=sum(c['prs'] for c in tot.values())

md=f"""---
title: Harness diagnostic — Claude desktop (CD) vs Codex (CX) vs Chroxy (CY), 2026-10-01 → 2026-10-17
date: 2026-10-17
type: harness-evaluation
repo: blamechris/chroxy
range: 2026-10-01..2026-10-17 (baselines 2026-09-13..09-30 and June 2026)
reviewer-harness: CD-cloud (Claude Code cloud sandbox launched from the Claude desktop app)
reviewer-model: claude-fable-5-1
reviewer-session: https://claude.ai/code/session_01QFgA5oVzgj3YV1GDozGXMv
status: revised 2026-10-17 after reconciliation with the CX (Codex) evaluation; dispositions in §13
tags: [harness-eval, chroxy, codex, claude-desktop, prime-directive]
---

# Harness diagnostic: CD vs CX vs CY (Oct 1–17, 2026)

> **Where this review originates (for tracking harness evaluations).** Written by a Claude Code **cloud sandbox session launched from the Claude desktop app** (`origin: desktop_app`, environment kind `anthropic_cloud`, Claude Code 2.1.302), model **claude-fable-5-1** (configured and served), effort `xhigh`, permission mode `auto`. Session: <https://claude.ai/code/session_01QFgA5oVzgj3YV1GDozGXMv>. Working branch `claude/harness-diagnostic-cd-cx-cy-n619c8`. Four worker subagents collected GitHub data; all analysis and prose is the main session's.
>
> **What this review could and could not see.** It had GitHub (PRs, issues, Actions, review threads, PR head refs) and a clone of the repo. It had **no access to the private Obsidian vault** (benchmark rows from `usage-benchmark-row.py`, handoff seeds, smoke PNGs, session ledgers), no daemon logs, no session transcripts and no token meters. Everything below is reconstructed from durable GitHub state, so **cost is a proxy, not a measurement**, and harness attribution is evidence-graded (see §3). The vault-side agent should be able to join its rows to the run ids here.

## 1. Bottom line

1. **{all_oct} PRs merged in the window (UTC).** After reconciliation with the Codex-side evaluation (§13): **CD (Claude desktop app)** coordinated the Oct 7–11 prime-directive chain, R10–R15 = {R['R10']['prs']+R['R11']['prs']+R['R12']['prs']+R['R13']['prs']+R['R14']['prs']+R['R15']['prs']} PRs (the CX evaluation's native records show `entrypoint: claude-desktop` and a per-wave roster summing to 123 PD PRs across waves 1–30, which matches GitHub exactly); **CX (Codex desktop app)** delivered {tot['CX']['prs']} Chroxy PRs across six roots; the remaining {tot['CD?']['prs']} Claude-driven PRs (Oct 1–7, plus the Sep baselines) are tied to bridged coordinator sessions that the CX evaluation did not cover (`CD?`). **No CY-coordinated prime-directive run exists in the evidence of either report.** Chroxy appears as an *implementation worker* in four merged PRs, always under Codex coordination: #8276 (claude-sdk, Opus 5.5 plus four Sonnet children, NORMAL assignment), and #8581, #8591, #8600 (Chroxy-hosted native Codex workers, `originator=chroxy`). Only #8276 is provable from GitHub alone; the other three rest on the CX evaluation's native histories.
2. **The one Chroxy-hosted worker run GitHub can see (Oct 4–6, PR #8276) delivered its package but spent about 15 h of a 23 h PR lifetime stalled** on a claude-sdk defect chain (#8300 orphan-task notification closing the permission channel, #8301 CI completion never waking an SDK session, #8302 roster `isBusy` stuck). Before accepting, the owner hit a Browse/Create failure on the preview (#8303) at 17:23 PDT; acceptance came at 17:42 and the merge at 17:50 PDT. The root-cause reports and fixes (#8300–#8304, #8320, #8325) were produced the next morning by separate sessions, not by the stalled worker. Work preserved, autonomy lost, infrastructure fixed within a day.
3. **The CD coordinator waves set the throughput ceiling:** R11 merged 92 PRs in 29.7 h (3.1 PRs per window hour, +66.9k/−3.8k lines, 1,033 files) with a {R['R11']['median_cycle_min']}-min median PR cycle (nearest-rank p90 {R['R11']['p90_cycle_min']} min), up to 12 PRs open at once, 7 branch CI failures in 208 runs and one red `main` run. 49 of the 93 issues it closed were filed during the wave. The CX evaluation prices the chain's five later segments (34 PRs) at $195.47 observed helper-priced usage and the first mixed root (SS, release and waves 1–19) at $835.03 on a historical rate card; those are its figures.
4. **CX on Oct 13–14: 12 Chroxy PRs across three Codex roots in a 33.3 h window** (0.36 PRs per window hour; the nine-PR daily-driver root alone spans 18.55 h of transcript), median PR cycle {R['R18-CX']['median_cycle_min']} min, p90 {R['R18-CX']['p90_cycle_min']} min. Copilot reviewed each PR exactly once; the extra review events are 30 owner-account review bodies the agent posted (2.5 per PR). 3 branch CI failures in 26 runs and one red `main` run (#8607). #8606 merged with two strict smoke assertions still red, which the CX evaluation records as an explicit acceptance judgment, not as green. Codex also found that this repo's 42.8 KB `AGENTS.md` exceeded its default 32 KiB project-doc cap (#8577 → #8578); whether an earlier Codex run actually lost the tail depends on the cap configured at the time.
5. **Cost cannot be compared from GitHub.** Hard figures in the period: $35.67 recorded usage for the Sep 29–30 desktop-app cloud sandbox session (3 PRs including the v0.11.1 release cut), $3.81 for Codex's fixture trial inside #8200, and the CX evaluation's transcript-priced estimates listed in §8. Per-run subscription cost is unknown for all three harnesses.
6. **Single sessions look alike in GitHub** (1–5 PRs, 10–140 min cycles, 1–3 commits per PR, few review threads). Harness differences show up only in PD coordination (parallelism, continuation, stall behaviour) and in incidents (§6).

## 2. Scope, data and method

**Window.** Runs whose PRs merged between 2026-10-01 00:00 and 2026-10-17 23:59 UTC (the evaluation range agreed with the other agent). Baselines: 2026-09-13 → 09-30 (pre-pilot Claude marathons and the first Codex PRs) and the June 2026 marathons recorded in `docs/decisions/2026-06-02-overnight-marathon.md` and `docs/reports/status-2026-06-13.html`.

**Sources (all collected 2026-10-17 08:50–09:15 UTC).**
- GitHub REST via MCP: 400 closed PRs (#7674–#8612) with head branch, timestamps; bodies for the 336 PRs created since Sep 22; 564 issues updated since Sep 22 (412 created since then); 6,300 Actions runs since Sep 13; per-PR commits, reviews and review threads for every PR created Sep 22 → Oct 17 (one worker per range).
- Git: `origin/main` deepened to 2026-06-01 for squash-merge sizes (`--shortstat`); `refs/pull/N/head` for 346 PRs to read commit author identity and timezone.
- Repo text: `AGENTS.md`, `.claude/skill-profile.md`, the prime-directive skill, `CHANGELOG.md`, `scripts/fixtures/prime-compatibility/`.

**Run detection.** Merge timestamps on `main` were clustered with a 3-hour gap rule (34 clusters Sep 22 → Oct 17), then each cluster was split by harness evidence. A run's **window** is first-PR-opened → last-merge. Where one session clearly spans two clusters (the Oct 8 wave's last PRs were opened at 21:40 and merged after 01:52), they are merged into one run.

**Metrics.**
- *Work*: merged PRs, files and +/− lines from the squash commit, distinct issues named by `Closes/Fixes/Resolves`, and how many of those were filed **during** the run (self-generated work vs backlog).
- *Time*: window span, PR cycle (opened → merged) as the standard sample median and the nearest-rank p90 (`ceil(0.9·n)−1` on sorted minutes; for n ≤ 2 the p90 equals the maximum), first commit → PR opened, last commit → merge, and commit spans (stalls). The first publication used an upper-middle median and a mis-indexed p90; both were corrected in this revision (§13, F02).
- *Issues*: CI runs on the PR branches (success/failure/cancelled, where cancelled = superseded by a newer push), red `CI` runs on `main` traced to the run's merge commit, Copilot review threads and owner replies, follow-up `from-review` issues filed, follow-up PRs, abandoned PRs, and incidents documented in issue bodies.
- *Cost*: not observable here; proxies and join keys only.

**Attribution signals used** (details and confidence in §3): branch prefix, commit author identity, commit timezone, PR-body dialect, and explicit statements in issue bodies.

**Limitations that matter.** (a) `CD` and `CY` are both Claude Code on the owner's Mac committing as the same identity in the same timezone; only one run self-identifies. (b) Codex and Claude can both appear inside one PR (Claude waves used Codex as a reviewer, 11 PRs in R11 cite Codex review rounds). (c) Issue counts "filed in window" include the owner's own filing activity on those days. (d) Lines changed over-weight test-heavy PRs. (e) The failing test names behind the red `main` runs were not in the retrievable log tails (TAP output exceeded the 5,000-line tail), so those are classified only by job and by whether the PR branch was green. (f) A run window starts at its oldest PR's creation, so a long-open PR inflates the span of a baseline row; the Oct rows are not affected.

## 3. Attribution ledger (read this before trusting any harness column)

| Signal | What it shows | Where it holds | Confidence |
|---|---|---|---|
| Branch prefix `codex/` | Codex-authored PR | 25 PRs Sep 13 → Oct 17 (#7841–#7854, #8200/#8202/#8205, #8583–#8608, #8612) | High |
| PR-body dialect: no headings, a `Validation:` bullet block, "independent review … final head", "contained P3" | Codex authorship | All `codex/` PRs; also #8578 and #8581 on `fix/`/`feat/` branches (Oct 12) | High on `codex/`; probable on #8578/#8581 (#8578 also says it ran "fresh instruction-loading proofs … in Codex CLI 0.154.0") |
| Commit author `BlameChris <ChrisPishaki@gmail.com>` instead of `blamechris <christopher.bowenx@gmail.com>` (936 of 959 commits) | A *checkout* with its own git config (most plausibly the daily-daemon checkout), not a harness | PR #8276 (5 commits, Oct 4–5) and PR #7853 (2 commits, Sep 14, `codex/codex-native-endpoint`) | High that #8276 was made from that checkout by the Chroxy-hosted session #8300/#8304 describe; the CX evaluation shows #7853 was Codex-native despite the same identity, so the identity alone cannot attribute a harness |
| Branch `llm-/great-tesla-uc8nfy`, commits at `+0000` | A cloud-sandbox Claude Code session with a non-default branch prefix (same adjective-scientist slug shape as the four `claude/…` branches on origin from July; this review's own session uses the same scheme) | #8131, #8149, #8157 (Sep 29–30, including the v0.11.1 release cut) | Probable; owner to confirm the `llm-/` prefix is their cloud-environment setting |
| Issue #8323 (Oct 6): "The maintainer's daily loop is a coordinator session fanning out reviewers, scopers and implementers. In the vendor desktop app a subagent's work is at least readable…" | The coordinator-wave pattern is the owner's **desktop-app** loop | Supports labelling the large coordinator waves (R11, R14, Sep marathons) as CD | Inferred, not proven per run |
| PR #8216 (Oct 3): "Under the delivery pilot it gets one independent review per round plus a Codex review" | A "delivery pilot" was running Oct 1–7 with Codex as a reviewer inside Claude runs | 11 PRs in R11 have "Codex round/delta" sections; #8320, #8330, #8423, #8476, #8512 | High (text) |
| Smoke table + `evidence: private vault smoke/chroxy-pr<N>-<head7>` | The prime-directive smoke step (added Oct 6 by #8304; first seen Oct 4 in #8272) → PD mode | {sm('R11')} of {R['R11']['prs']} PRs in R11, {sm('R14')}/{R['R14']['prs']} in R14, {sm('R18-CX')}/{R['R18-CX']['prs']} in R18-CX | High for "PD-style", harness-neutral |

**Everything labelled `CD?` below is Claude Code on the owner's machine whose host (desktop app vs Chroxy) GitHub cannot show.** The owner's vault ledgers are the only source that can settle those rows; the per-PR CSV in `data/` is laid out so a vault-side join by PR number or window is a one-liner.

### 3.1 Session records (added 2026-10-17 12:30 UTC, after the first publication)

After the first version of this report was pushed, the reviewing session read the account's own Claude Code session list (105 sessions created since 2026-09-20: 100 are bridged local CLI sessions tagged `remote-control-sdk`, 3 are cloud sandboxes launched from the desktop app, 2 are cloud sandboxes launched from Android). Those records settle several rows and sharpen one correction:

- **The `llm-/great-tesla-uc8nfy` branch is a cloud sandbox launched from the Claude desktop app**, not a guess any more: session "Consolidate usage-normalize.js's UNSAFE_KEY set into @chroxy/protocol" (Sep 29 22:16 → Sep 30 04:39, model claude-opus-5-5) is PR #8131's subject, and its recorded usage is **$35.67**. That run is therefore CD (cloud) and cost is known for it.
- **Every Claude-driven run from Sep 22 to Oct 11 maps to a chain of bridged local sessions whose closing summaries name the run's PRs** (table below). The Sep 24 → Oct 2 chain is one `/prime-directive` run handed off across eleven sessions all titled "Prime directive readiness" (the Sep 24–26 segment alone reports "56 PRs merged (49 ours, 7 Renovate)"). The Oct 7 → Oct 11 chain is the "chroxy prime-directive #8340 #8253 #7356 #7353 — coordinator" / "prime wave 22" / "PD wave 23 coordinator" sessions; waves 23–28 name #8538 and #8568 (R14 exactly), waves 29–30 name #8570, #8572, #8573, #8575, #8576 (R15 exactly), wave 21 names #8530, #8526, #8527 (R12 exactly) and records "$21-23 spent" for those three PRs.
- **Mode is settled for those rows:** R11–R15 are PD waves 1–30 of one `/prime-directive` mission (the sessions are explicitly prime-directive waves with handoff seeds and budget pauses: "paused on weekly budget", "paused for cost until 00:00Z"). R12 and R13, which GitHub made look like small bursts, are waves 21 and 22. R10 stays SS: its PRs (#8339, #8342, release #8343 and two fixes) are NORMAL and release episodes recorded in the same native root before the PD mission began.
- **Harness is settled for the Oct 7–11 chain by the CX evaluation's native records, not by GitHub.** The Codex-side evaluation read the Claude transcripts on the owner's machine: root `532cf9d9` carries `entrypoint: claude-desktop`, so the chain is **CD**. It also resolved what the first version of this report called an accounting gap: the coordinator's "17 PRs merged" line was a waves-16–19 summary, and its per-wave roster (6, 5, 5, 6, 6; 4, 5, 6, 5, 3; 6, 5, 5, 5; 5, 4, 4, 4) sums to 89 PRs for waves 1–19, exactly the 89 PRs merged during that session's lifetime. No parallel unseen run is needed to explain Oct 8. This is a corroborated report (their evidence is private); it is consistent with every GitHub number here.
- **The bridged `remote-control-sdk` sessions are therefore desktop-app sessions**, at least for that chain. The Oct 5 Chroxy-hosted worker does not appear in the session list, which is consistent with Chroxy-spawned sessions not registering there. Rows still labelled `CD?` (Oct 1–7 and the Sep baselines) are the same kind of bridged session but were not covered by the CX evaluation's roster.
- **Correction to the identity row above:** the `BlameChris <ChrisPishaki@gmail.com>` identity marks a checkout's git config, not a harness. #7853 (Sep 14) carries it and was Codex-native per the CX evaluation.
- **Model mix is visible:** the coordinator chains ran claude-opus-5-5 at effort high; the Oct 6 root-cause sessions ("chroxy #8304 — trial RCA", "chroxy #8300 — stall fix") ran claude-fable-5-1; the Codex sessions and the Chroxy implementation session are not in this list at all. Context size at each session's last turn is recorded below as a proxy for how hard each segment was driven (it is not cumulative cost).

{sess_table()}

Only sessions whose summaries name PRs in the run, or that overlap the single-PR runs, are shown; the full 105-row list is in `data/ccr-sessions-2026-10-17.csv`. For R05–R09 the listed sessions overlap the window in time only; the CX evaluation shows that #8276's coordinator was a Codex chat, so the Claude sessions shown against R07-CY are concurrent owner sessions, not its coordinator.

### 3.2 What the CX evaluation's native records add (corroborated report)

The Codex-side evaluation (`reviews/harness-evaluation-cx-2026-10-17/Report.md`, attached under `mailbox/attachments/`) read the native Claude, Codex and Chroxy session stores on the owner's machine. Its attributions that this report adopts, all consistent with GitHub but not independently verifiable from here:

| Item | CX evaluation's finding | Effect here |
|---|---|---|
| Oct 7–11 chain | `entrypoint: claude-desktop`; roots `532cf9d9` (waves 1–19, 89 PRs), `c26d0267` (wave 20, 3), `b22bbf2b` (wave 21, 3), `34a55f19` (wave 22, 3), `28912bd5` (waves 23–28, 20), `3a0b4364` (waves 29–30, 5) = 123 PD PRs | R11–R15 labelled CD / PD |
| #8276 | Chroxy claude-sdk worker (Opus 5.5 + four Sonnet children) under a **CX coordinator**, assignment **NORMAL** | R07 relabelled "CY worker / CX coord", SS |
| #8581 | CX SS chat with a **Chroxy-hosted native Codex worker** (an interrupted thread, then a 3 h 34 min replacement thread; actual model 5.6 Sol) | CY worker contribution counted |
| #8591, #8600 | Chroxy-hosted native Codex workers (5.6 Sol/high) inside the CX daily-driver PD root `01a1365a`; #8600's first completion failed independent review with six P2 findings and needed two owner-authorised retries | CY worker contributions counted; quality note |
| #8578 | CX PD root `01a12d7b` (with MarchBorne #1033) | R16 labelled CX / PD |
| #8583, #8586, #8588 | CX roots `01a1329d` (SS) and `01a133a3` (PD) | R18 is three roots, not one session |
| #8612 | CX root `01a147f9`, selected package | R19 CX / SS |
| #7853 | Codex-native parent/child despite the `BlameChris` identity | identity is not a harness signal |
| Complete CY-coordinated PD runs | none established in retained evidence | matches this report |



## 4. Run inventory

### 4.1 Oct 1–17 (evaluation window)

{table(oct_runs)}

Totals for the window, by harness bucket:

| Bucket | Runs | PRs | Files | Lines | Issues closed |
|---|---|---|---|---|---|
{tot_rows}

PR membership of every run is in `data/runs-2026-10-17.csv` (column `pr_numbers`) and per-PR in `data/pr-attribution-2026-10-17.csv`.

Caveats on the issue columns: "filed in-window" counts every issue the owner's account opened during the window, so it includes planning that was not produced by the run. For **R07-CY the 21 issues are the Oct 5 #8280 epic family** (continue-a-conversation-with-another-provider), not run output; the run's own defect reports #8300–#8303 landed 46 minutes after the merge and so fall outside its window. For R08 the 23 are the Oct 6 knowledge-base epic (#8305–#8334). For R11, {OCT8_UNL} of the 83 issues opened on Oct 8 carry no label, so the `from-review` column undercounts the wave's follow-up filings.

### 4.2 Baselines (Sep 13 → Sep 30) and June reference points

{table(base_runs)}

Baseline windows start at the oldest PR's creation, so a long-open PR inflates the span: B2 includes a PR opened Sep 12 and merged Sep 24, and B-CX-7854 is a single PR open for eight days. Read the Sep rows for size and cycle time, not for PRs per hour.

June reference points (from repo records, not re-derived): the 2026-06-02 overnight run merged **12 PRs from 12 issues in a 60.5-minute first marathon** (12/12 approved) and continued as a two-session marathon; the 2026-06-13 status report records **28 PRs merged across that marathon**. Those were single Claude sessions without the Oct smoke/owner-reserved discipline, so they are a throughput ceiling for small, test-light fixes rather than a like-for-like baseline.

### 4.3 Review and commit shape per run

{review_table(oct_runs+base_runs)}

Reading the shape: Claude runs open the PR within about a minute of the first commit and then push follow-up commits (2–3 per PR, 16–30 min first→last) while Copilot reviews; "last commit → merge" of 13–17 min is essentially CI latency, so Claude waves merge as soon as CI is green. Codex (R18-CX) carries 2.6 commits per PR and waits a median 41 min after its last commit. Its 3.5 review events per PR are one Copilot review per PR plus 30 owner-account review bodies posted by the agent across the 12 PRs; Copilot reviewed every PR in every run exactly once, so the reviews-per-PR column measures how often the agent posted a review-shaped summary, not reviewer pressure. The CY run's 1,237-minute first→last commit span is the stall described in §6.

## 5. Comparison

### 5.1 Prime-directive style runs (the harness-sensitive mode)

{cmp_table()}

What the table supports:

- **Throughput.** The CD coordinator waves ran about 3 PRs per window hour for 7–30 hours, roughly double the late-September marathons (B7: 1.6/h) and about eight times the Oct 13–14 Codex roots (0.36/h). The waves kept a mean of 5.3 PRs open at once (max 12) while the Codex roots worked almost serially (max 2 open). That is an association between parallelism and throughput, not a demonstrated cause; task mix, model and acceptance burden also differed.
- **PR size.** Codex PRs are larger (about 870 changed lines and 20 files per PR against about 770/11 for R11 and 350/7 for R14), consistent with fewer, broader PRs.
- **Cycle time** (standard median / nearest-rank p90, minutes): R11 {R['R11']['median_cycle_min']} / {R['R11']['p90_cycle_min']}; R14 {R['R14']['median_cycle_min']} / {R['R14']['p90_cycle_min']}; R18-CX {R['R18-CX']['median_cycle_min']} / {R['R18-CX']['p90_cycle_min']}; the Chroxy-hosted worker's single PR took {R['R07-CY']['median_cycle_min']} min, about 15 h of it idle.
- **CI.** Branch failure rates: R11 7 of 208 runs, R14 0 of 41, R18-CX 3 of 26. Red `CI` runs on `main` after merge: R11 one (#8375, Desktop Rust Tests; log expired), R18-CX one (#8607, Server Tests, 2 of 21,319 tests), plus R01 one (#8180), R02-CX two (#8200, #8202), R13 one (#8534, the Windows PodAgent suite, which has a flake history: #7709) and R15 one (#8576). Every one of those PR branches was green at its head and each red run failed one test (two for #8607) out of 18–21k. That pattern is *consistent with* flaky or order-dependent tests, but the failing test names could not be retrieved from the log tails, so flakiness is not established and neither is a harness-attributable break.
- **Review events.** Copilot reviewed every PR exactly once in every run. Copilot *threads* per PR were 0.17 on R11, 0.25 on R14, 0.58 on R18-CX and 0.3–0.9 on the Sep baselines; every thread was resolved with an owner-account reply (the agents reply as the owner under the repo's zero-attribution policy). No PR in the window carried an APPROVED or CHANGES_REQUESTED state, so approvals are not a usable signal here.
- **Self-generated work.** 53% of the issues R11 closed were filed during R11; 70% for R18-CX (dogfood findings filed the same day: #8587, #8593, #8601, #8602, #8603); 16% for R14; 59% for B7. The smoke step is designed to find things, so this is not bad in itself, but "issues closed" overstates backlog burn-down by about half for the big waves, and concurrent owner filings fall inside the same windows (see the caveat under §4.1).

### 5.2 Single sessions

SS runs in the window (R03, R04, R06, R07-CY, R08, R09, R10, the #8581 half of R16-CX, R17, R19-CX) are 1–5 PRs each with 10–140 min cycles, except the stalled #8276. Two things differ by harness: Codex SS PRs carry the `Validation:` block and no smoke table even when they touch the dashboard (#8578, #8581, #8612), while Claude SS PRs after Oct 6 carry the smoke table when in scope (R08, R09). PR size in SS is dominated by the task, not the harness (#8325 +4,156, #8330 +3,850, #8581 +3,233 are all SS). GitHub cannot separate CD-SS from CY-SS; the vault ledgers can.

### 5.3 Where CY stands, on the evidence available

- **No CY-coordinated prime-directive run exists in either report's evidence.** Both the GitHub reconstruction here and the CX evaluation's native-store reading find zero complete runs in which Chroxy owned the queue, the review gate and the merge. What exists is Chroxy as an **implementation worker** under Codex coordination in four merged PRs: #8276 (claude-sdk, Oct 4–6), #8581 (native Codex, Oct 12), #8591 and #8600 (native Codex, Oct 13–14). GitHub alone proves only #8276; the other three are the CX evaluation's `originator=chroxy` histories.
- **As a worker, CY delivered.** #8276 is +1,129/−175 across 46 files with a smoke section, mutation table and review fold-ins; #8591 completed in a 5 min 34 s worker span; #8600's native thread survived an update and recalled its task afterwards. Its failure modes were infrastructural (the Oct 5 stall) or quality-gated by the coordinator (#8600's first completion failed independent review with six P2 findings and needed two owner-authorised retries).
- **As an unattended coordinator, CY is untested in this window**, so "how CY stacks up in PD" cannot be answered from these runs. The dogfooding floor added on Oct 6 (#8304), the Oct 6 fixes (#8320, #8325) and the native Codex continuity shown on Oct 13–14 are the prerequisites; a bounded CY-coordinated trial with the same queue, review gate and acceptance as a CD or CX run is the measurement still missing, and the CX evaluation recommends the same.

## 6. Incidents and harness defects observed

### 6.1 The Chroxy-hosted worker run of Oct 4–6 (PR #8276)

| Step | Time (UTC) | Evidence |
|---|---|---|
| First commit (checkout identity `BlameChris`) | Oct 5 01:36 | PR head commits |
| PR opened | Oct 5 01:43 | PR #8276 |
| Commits 2–4 (review fold-ins) | Oct 5 02:32, 02:36, 06:49 | PR head commits |
| **Stall: no commits; the worker sat on a tool denial nobody could resolve** | Oct 5 06:49 → 22:14 (15 h 25 min between commits; 15 h 01 min 56 s between retained transcript events per the CX evaluation) | commit gap; #8304: "sat idle for about 15 hours"; #8300: "three resumptions in a row began with a `<task-notification>` for background shells … each first tool call was cancelled" |
| Commit 5 | Oct 5 22:14 | PR head commits |
| Owner's preview check fails on Browse → Create (#8303); fixture repaired; workflow re-verified | Oct 6 00:23 (17:23 PDT) | CX evaluation timeline; #8303 |
| Owner acceptance; merge | Oct 6 00:42; 00:50 | CX evaluation timeline; PR #8276 |
| Defects filed by separate sessions | Oct 6 01:36 (#8300, #8301, #8302, #8303) | issue timestamps; session records "chroxy #8304 — trial RCA" (Oct 6 01:10) and "chroxy #8300 — stall fix" (06:01) |
| Fixes merged | Oct 6 02:26 (#8304 docs), 07:55 (#8320, +1,836/−135), 10:33 (#8325, +4,156/−55) | PR timestamps |

Root causes as filed: the Agent SDK closes the CLI's stdin at the first `result`, and a resumed turn that begins with an orphan-task notification emits a `num_turns: 0` result first, so every tool in the real turn is cancelled with the generic "user doesn't want to take this action" text and no `permission_request` is emitted (#8300); CI completion only wakes claude-tui PTYs, so the SDK session polled with a background `gh pr checks --watch` that became the orphan (#8301); the roster kept `isBusy: true` with no pending shells, so monitors read the idle agent as working (#8302). The CX evaluation adds that the worker was coordinated by a Codex chat with a NORMAL (not prime-directive) assignment, that the Browse/Create failure was a missed owner path by both worker and coordinator, and that the RCA and fixes were separate work rather than autonomous recovery by the stalled worker. The first version of this report placed the Browse/Create failure after the merge; it was before.

### 6.2 Other harness-relevant findings in the window

- **Codex's default project-doc cap was below this repo's rules file.** #8577 (Oct 11): `AGENTS.md` at 42,813 bytes exceeded Codex's default `project_doc_max_bytes` (32 KiB), so a Codex session running with the default cap would silently lose the last ~10 KB of project rules. Fixed by #8578 (Oct 12), which made `AGENTS.md` the authored source with thin `CLAUDE.md`/`GEMINI.md` adapters and added an executable size floor. The CX evaluation reports that its own sessions ran with a raised cap (a measured chain of 75,165 of 98,304 bytes before the migration), so which earlier Codex runs, if any, actually lost the tail depends on the cap configured at the time and is not established here. The first version of this report claimed every Codex PR before Oct 12 ran without the tail; that was unsupported.
- **Chroxy's Codex provider failed on first use for the owner.** #8609 (Oct 14, open, priority high): chroxy spawns whichever `codex` is first on PATH (codex-cli 0.154.0) while the Codex desktop app bundles 0.162.0-alpha; the shared `~/.codex/config.toml` names `gpt-6.1-sol`, which the older client cannot use, so a default Codex session fails its first message with HTTP 400. #8610 (errors render as raw JSON, turn stays busy) and #8611 (New Session modal overflow) were filed with it. #8593 (composer accepted input ~90 ms before native startup) was fixed by #8600.
- **Running the server test suite on the owner's machine broke live Chroxy sessions.** #8352 (Oct 7): "several agents ran the full server suite on the owner's machine" and the suite deleted the live daemon's claude-tui hook-sink base, breaking every running claude-tui session. This is a direct hazard of running CD waves and CY sessions on the same host; fixed the same night (#8353).
- **Two PRs were abandoned** in the whole Sep 22 → Oct 17 range: #8182 (Sep 30, closed in 2 min, superseded) and #8212 (Oct 2, closed unmerged after 16 h with no review). Zero reverts on `main`.
- **Follow-up PRs fixing a run's own PRs** (same-day): #8409, #8442, #8494 (R11) and #8542 (R14, from the #8530 review). These are normal review fold-ins, not regressions reported by users.
- **Known flaky tests touched the window:** harness-case-floor (#8498, fixed by #8509 on Oct 8), PodAgent on Windows (#7709), both appearing in red `main` runs.

## 7. What each harness did well and badly (evidence-bound)

**CD (Claude desktop app, coordinating).** Best throughput and parallelism by a wide margin; consistent PR template (cause → fix → tests → mutation table → smoke → owner-reserved); one Copilot review per PR with few threads; CI mostly green. Costs: half the closed issues were self-generated, the waves file about one issue per PR (90 in R11), the chain paused repeatedly on weekly budget and needed fresh-session relaunches, and the wave consumed the owner's machine (#8352). No stall or abandonment documented in GitHub for the chain itself.

**CX (Codex desktop app).** Lower throughput and near-serial execution; larger PRs; a review-posting habit (2.5 owner-account review bodies per PR) rather than more reviewer pressure; the highest branch CI failure rate in the window and three red `main` runs after green branches (Oct 1 ×2, Oct 14). It merged #8606 with two strict smoke assertions still red, recorded as an acceptance judgment. On the plus side: it found and fixed the project-doc cap problem (#8577 → #8578), brought the `AGENTS.md`-as-source migration, ran a paid, recorded fixture ($3.81) in #8200 rather than asserting, and coordinated all four Chroxy-hosted worker contributions in the window. Codex also served as a reviewer inside the CD waves (11 PRs in R11 cite Codex review rounds), a collaboration pattern worth tracking separately.

**CY (Chroxy, as a worker).** Four worker contributions, one provable from GitHub, all coordinated by Codex; the one run GitHub can see delivered its package after a 15-hour infrastructure stall that separate sessions root-caused and fixed within a day. Native Codex workers inside Chroxy completed small tasks and survived an update with context intact, and one first completion failed independent review. As a coordinator CY is untested in this window. Chroxy-as-harness also lacks subagent visibility (#8323) and had Codex-provider first-run failures for the owner (#8609).

## 8. Cost

- **Measured in GitHub: nothing per run.** Per-run subscription or invoice cost is unknown for all three harnesses; the CX evaluation reaches the same conclusion from the native stores.
- **Hard figures available:**
  - $35.67 recorded usage for the Sep 29–30 desktop-app cloud sandbox session that produced #8131, #8149 and #8157 (`llm-/great-tesla-uc8nfy`): 2,318 input, 298,950 output, 109,161,915 cache-read and 1,113,918 cache-write tokens on claude-opus-5-5. This is the cloud sandbox's own `usage.cost_usd` field, a metered API-equivalent figure for that session only; it is not an invoice line and is not comparable to transcript-priced subtotals without agreeing a rate card.
  - $3.81 for Codex's PRIME-compatibility fixture inside #8200 (six Claude Code 2.1.285 cases on host-default claude-opus-5-5 at $0.58–$0.72 each, `scripts/fixtures/prime-compatibility/verification-2026-09-30.json`); a fixture-local estimate, not the cost of the coordinating run.
- **CX evaluation's transcript-priced estimates** (its figures, on an installed historical rate card, "observed lower" bounds; reproduced for joining, not re-derived): CD root `532cf9d9` (SS + release + waves 1–19) $835.03; the five later CD segments (34 PRs) $195.47, about $5.75 per PR and 3.09 PRs per summed transcript hour; wave 21 (3 PRs) $21.72–$23.90, matching the session's own "$21-23 spent"; the Chroxy claude-sdk worker for #8276 with its four children $33.23–$36.55. For Codex it reports tokens, not dollars: daily-driver root 298.6M parent + 540.6M native-child tokens (+98.3M guardian) for 9 PRs. It flags a rate-card discrepancy for Sonnet 5.5 cache reads ($0.20 vs $0.10 per million) and 20 unpriced Haiku responses.
- **Proxies available here** (all in `data/runs-2026-10-17.csv`): commits per run (R11 {R['R11']['commits']}, R14 {R['R14']['commits']}, R18-CX {R['R18-CX']['commits']}, R07 {R['R07-CY']['commits']}), review events per PR, lines changed, and the "coordinator smoke on a real Haiku session" count in PR bodies (51 Haiku mentions on Oct 8, 30 on Oct 10). Commits are not API-call counts.
- **Join keys:** run id, window start/end (UTC) and PR list per run; the CX evaluation joins by native session id, role and PR receipt, which is the better key where it exists.

## 9. Open questions for the owner

1. The Oct 1–7 Claude runs (R01, R03–R06, R08–R09) and the Sep baselines are bridged coordinator sessions not covered by the CX evaluation's roster. Confirm they were desktop-app (or terminal) sessions, so the `CD?` labels can drop their question marks.
2. Was any Chroxy-coordinated prime-directive run attempted in Oct 1–17 that left no merged PR? Both reports find none with a merge; an attempt without a merge would still matter for the CY verdict.
3. The $35.67 cloud-sandbox figure: is a per-session metered figure the right unit to compare with the CX evaluation's transcript-priced estimates, or should both be restated on one declared rate card?

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
| Reconciliation with the CX evaluation (§13) | B2 contained Renovate PR #7718 (confirmed in the PR list; removed, all runs now exclude non-owner authors); R18's 42 review events are 12 Copilot + 30 owner-account COMMENTED (confirmed from the per-PR review data); the published medians used the upper-middle value and the p90 index was off by one (confirmed by recomputation; both replaced). The CX evaluation's native-record attributions (CD entrypoint, CY workers, Codex roots) are accepted as corroborated reports and are consistent with every GitHub number here, but were not independently verified |
| Not verified | Failing test names in the red `main` runs; token/cost per run; the host of the `CD?` rows; anything that rests on the CX evaluation's private native stores |


## 12. Appendix: files and reproduction

- `data/runs-2026-10-17.csv` — one row per run with every metric above and the PR list.
- `data/pr-attribution-2026-10-17.csv` — one row per merged PR (Sep 13 → Oct 17): run, harness, mode, size, head commits, git identity, body signals.
- `data/review-metrics-2026-10-17.csv` — per-run review/commit shape.
- `data/ccr-sessions-2026-10-17.csv` — the account's Claude Code session records since Sep 20.
- `data/raw/` — the inputs behind every table, added at the CX evaluation's request: `prs_closed.csv` (400 PRs), `pr_detail_oct.csv` and `pr_detail_sep.csv` (per-PR commits, reviews, review threads), `pr_head_commits.csv` (author identity and timezone per PR), `main_commit_stats.tsv` (squash-commit sizes), `issues_since_0922.csv`, `workflow_runs_since_0922.csv.gz` (6,300 Actions runs) and `workflow_runs_by_branch.csv`, `clusters.json`, `runs.json`, `run_sessions.json`.
- `scripts/` — the Python that produced every number (`build_master.py`, `cluster_sessions.py`, `clusters_v2.py`, `cluster_issues.py`, `runs_table.py`, `review_metrics.py`, `map_sessions.py`, `gen_report.py`). Re-running `runs_table.py`, `review_metrics.py`, `map_sessions.py` and `gen_report.py` in that order against `data/raw/` regenerates the report.
- `mailbox/` — the cross-review correspondence with the CX evaluation and its attached report.

## 13. Reconciliation register (CX evaluation findings F01–F10, dispositioned 2026-10-17)

| # | Finding (CX evaluation) | Disposition | What changed here |
|---|---|---|---|
| F01 | CX session identities and modes for #8578, #8581, #8583–#8612; CY worker roster | **Accept** (corroborated report) | R16/R18/R19 labels and modes; §3.2; §5.3; §7 |
| F02 | Cycle statistics used an upper-middle median and an off-by-one p90 (p90 < median on 2-PR runs) | **Accept** (verified by recomputation) | Standard median and nearest-rank p90 everywhere; convention stated in §2 |
| F03 | R18's 3.5 review events per PR are 1 Copilot + 2.5 owner-account bodies, not Copilot re-requests | **Accept** (verified from the per-PR review data) | §1, §4.3, §5.1, §7 |
| F04 | B2 included Renovate PR #7718 | **Accept** (verified) | Non-owner PRs excluded from every run; B2 is 20 PRs / 12.1 h |
| F05 | #7853 was Codex-native despite the `BlameChris` identity; identity marks a checkout | **Accept** (corroborated report) | §3 ledger row; §3.1 |
| F06 | #8276 timeline: Browse/Create failure before merge; RCA and fixes were separate work; event gap 15 h 01 min 56 s | **Accept** (merge time consistent with GitHub) | §1, §6.1 |
| F07 | #8606 merged with two red strict assertions as an explicit acceptance judgment | **Accept** | §1, §7 wording |
| F08 | "Every Codex PR before Oct 12 lacked the rules tail" was unsupported | **Accept** | §1, §6.2 narrowed to the default-cap defect |
| F09 | Scope frames differ: UTC 173 vs Pacific-midnight 160; Oct 1 Codex PRs come from an older root | **Accept, both kept** | §2 states UTC; this report keeps the Oct 1 Codex PRs because they merged in the window |
| F10 | Causal restraint: concurrency ≠ cause; green branch/red main ≠ proven flake; commits ≠ API calls; publish inputs | **Accept** | §5.1 and §8 wording; raw data and scripts published under `data/raw/` and `scripts/` |
| R-A | Oct 7–11 chain is CD (`entrypoint: claude-desktop`); "17 PRs" was waves 16–19 only; per-wave roster sums to 89 | **Accept** (corroborated; consistent with GitHub) | The "accounting gap" bullet replaced in §3.1; R10–R15 relabelled |


*Suggested vault location:* `no-it-all/reports/harness-evals/2026-10-17-harness-diagnostic-cd-cx-cy.md` (copy this file and the `data/` folder together).
"""
open('/home/user/chroxy/docs/reports/harness-evals/2026-10-17-harness-diagnostic-cd-cx-cy.md','w').write(md)
print("written", len(md), "chars")
