# Controlled harness trial — report

*Trial of 2026-10-18 to 2026-10-22 on `blamechris/chroxy`; protocol in [`PROTOCOL.md`](PROTOCOL.md), run-by-run record in the [README status table](README.md#status), gradings on `trial/eval-claude` and `trial/eval-codex`, the owner's tiebreaks on `trial/eval`. Written by the cloud supervisor (PROTOCOL §9 role) from committed inputs; every table below is printed by [`scripts/measures.py`](scripts/measures.py) from [`data/`](data/).*

## 1. Bottom line

**Holding the coordinator model constant, the harness did not change what was delivered; it changed how long the run took and how it got there.**

| Arm | Native harness | Chroxy harness | Delivered (merged and correct, of 10) | Wall clock, first command to last report commit | PR cycle median |
|---|---|---|---|---|---|
| A (Claude, Opus 5.5 / high) | A1-cd, Claude desktop | A2c-cy-claude, Chroxy daemon (Claude SDK) | **10 vs 10** | 1 h 46 min vs 2 h 26 min (**+40 min**) | 58 min vs 40 min |
| B (GPT, gpt-6-astra / xhigh) | B1-cx, Codex desktop | B2c-cy-codex, Chroxy daemon (Codex app-server) | **9 vs 9** | 2 h 24 min vs 3 h 32 min (**+68 min**) | 31 min vs 15 min |

- **Correctness: no visible harness effect.** In arm A both runs delivered all ten items and five of the ten design choices coincide down to the module name. In arm B each run missed one item for a different reason: B1-cx declared 8282 "blocked" and merged nothing for it; B2c-cy-codex merged a test-only PR for 8282 but dropped the `pass` direction of 7815's test, which the owner ruled partial.
- **Time: the Chroxy-hosted run was slower in both arms,** by 40 minutes in arm A and 68 in arm B, while its per-PR cycles were shorter. The Chroxy runs worked in waves (two of five in A2c, one PR at a time in B2c) where the native runs opened everything at once (A1: ten PRs in 23 minutes) or in two quick waves (B1). Part of arm A's gap is attributable to a Chroxy defect: the permission floor fired on every Edit inside Claude Code's worktree directory, each costing a five-minute timeout (§6). Part of arm B's gap is the two retried items (8364 and 8303 took three waves each); the rest is the serial shape.
- **Reliability is where Chroxy actually lost.** Two of the three Chroxy-hosted attempts in arm B never finished: run 2 was killed 23 minutes in by the daemon's own auto-deploy, and run 6 lost its dashboard turn at 11 minutes and then what remained of the owner's Codex allowance at 2 h 01 min, with the daemon showing an idle session throughout (#8710). Arm A's first two Chroxy attempts ran at the wrong effort (run 3, `medium`, because the dashboard's thinking control does not set Claude Code's effort) and the wrong model (run 5 attempt 2, Sonnet 5.5, the new-session default). Every one of these is a harness or setup defect, not a model behaviour, and each cost a day.
- **n = 1 per cell.** Eight runs over five days, with runner contention, allowance states and vendor queues that varied. The numbers describe these runs; they do not estimate a harness effect. The descriptive runs (A2 at medium, A2b on Sonnet) fall below A2c on both time and cost without changing what was delivered, which says the wall clock moves more with model, effort and wave shape than with the harness.

## 2. What was run

| # | Run | Harness | Coordinator / effort | Date (UTC) | Outcome |
|---|---|---|---|---|---|
| 1 | `A1-cd` | CD — Claude desktop app 2.42304.0, Claude Code 2.1.296 | Opus 5.5 / high | 10-18 | done, 10 of 10 |
| 2 | `B2-cy-codex` | CY — Chroxy daemon at `59b77bb9`, Codex app-server | gpt-6-astra / xhigh | 10-18 | killed at 23 min by the daemon's auto-deploy; 2 green PRs left open |
| 3 | `A2-cy-claude` | CY — daemon at `91956e79`, Claude SDK | Opus 5.5 / **medium** (deviation) | 10-18 | done, 10 of 10 |
| 4 | `B1-cx` | CX — Codex desktop 26.1013.40934, CLI 0.163.0 | gpt-6-astra / xhigh | 10-18 | done, 9 of 10 (8282 blocked) |
| 5 | `A2b-cy-claude` | CY — daemon at `91956e79`, Claude SDK | **Sonnet 5.5 / medium** (deviation); attempt 1 aborted by a dashboard interrupt | 10-19 | done, 9 merged, 8 correct |
| 6 | `B2b-cy-codex` | CY — daemon at `91956e79`, Codex app-server | gpt-6-astra / xhigh | 10-19 | stopped at 2 h 01 min on Codex quota, unsurfaced (#8710); 4 merged, 3 correct |
| 7 | `B2c-cy-codex` | CY — daemon at `91956e79`, Codex app-server | gpt-6-astra / xhigh | 10-19 | done, 10 merged, 9 correct |
| 8 | `A2c-cy-claude` | CY — daemon at `91956e79`, Claude SDK | Opus 5.5 / high | 10-22 | done, 10 of 10 |

The controlled pairs are runs 1 and 8 (arm A) and runs 4 and 7 (arm B). Runs 3 and 5 are extra CY-claude points at other settings; runs 2 and 6 are harness incidents graded for their merged PRs only. Every run worked the same ten issues (8233, 8215, 7771, 8595, 8364, 8282, 8277, 8567, 8303, 7815; [`queue.md`](queue.md)) from the same base commit `932bd3a4` (T0), unattended, with `/prime-directive` and the per-run mission as the first message, merging into its own `trial/*` branch. Details, times and incidents per run are in the README status table.

## 3. Method

**Design.** Two within-vendor paired contrasts (PROTOCOL §1): the same coordinator model and effort in the vendor's native harness and in Chroxy. CD vs CX is a different question and is only described. Order, controls and isolation rules are PROTOCOL §2–§5; the actual run sequence is PROTOCOL §2 "Actual runs".

**Grading.** Two graders with fresh context and different vendors (PROTOCOL §7): `G-claude`, a cloud session spawned by the supervisor (22 minutes by the supervisor's session record, [`eval/G-claude/GRADING.md`](https://github.com/blamechris/chroxy/blob/trial/eval-claude/docs/reports/harness-evals/trial/eval/G-claude/GRADING.md) at `4f663eee`), and `G-codex`, Codex desktop at astra / xhigh started by the owner (27 minutes by the owner's screenshot, [`eval/G-codex/GRADING.md`](https://github.com/blamechris/chroxy/blob/trial/eval-codex/docs/reports/harness-evals/trial/eval/G-codex/GRADING.md) at `ca51d4fe` with `EVIDENCE-A.json` and `EVIDENCE-B.json`). Both verified the key's digest (`fb5599f3…d40f23`, 7782 bytes) against [`KEY-COMMITMENT.md`](KEY-COMMITMENT.md) before grading, graded the other vendor's arm first, read diffs from the squash commits and metadata from the GitHub API, and ran nothing. Each posted a dispute list (13 and 12 items) and a cross-review reply (`1b3e5a66`, `5ee4e0cc`). The graders' per-issue verdicts agree except on four key readings, which the owner ruled on in [`eval/TIEBREAKS.md`](https://github.com/blamechris/chroxy/blob/trial/eval/docs/reports/harness-evals/trial/eval/TIEBREAKS.md) (`6a955c27`):

| Ruling | Owner's call | Effect |
|---|---|---|
| T1 — 8215, "the dotted branch is unchanged" | behavioural: tightening the `::ffff:127.` branch against malformed input is acceptable | all six completed runs `yes` on 8215 |
| T2 — 8303, the New Session note | a non-canonical spelling (`..`, a doubled separator) slipping past the note is a follow-up, not a miss | A1, A2, A2c `yes` on 8303 |
| T3 — 8303 in A2b | suppressing the note by design for credential directories narrows the check | A2b `partial` on 8303 |
| T4 — 7815 in the Codex runs | "I preferred both but it delivered one; that's not a pass" | B2c and B2b `partial` on 7815 |

Five further items were conventions (8282 label, `#N` in PR comments, wall-clock endpoint, CI counting, review-body denominator); the owner took G-codex's conventions, which match the protocol's wording. Both graders' counts under their own readings and the counts under the rulings are in TIEBREAKS.md; the rulings leave arm A at 10 = 10 and make arm B 9 = 9.

**Measurement.** [`scripts/measures.py`](scripts/measures.py) reads [`data/`](data/) (G-codex's evidence files copied byte-for-byte, the owner's rulings as verdict overrides, and the run anchors from the README) and prints §4's tables; [`data/PROVENANCE.md`](data/PROVENANCE.md) names each input's source commit. Delivered means merged into the run's base **and** `yes` against the key after the rulings. Wall clock is first command to the run report's last commit (PROTOCOL §6), with the report-PR merge time beside it. PR cycle is `created_at` to `merged_at` of the merged queue PRs; p90 is nearest-rank. CI runs are `ci.yml` runs on the queue PRs' branches inside the run window; G-claude's own-commit figure differs only for A2c (18 rather than 20, two cancelled runs on rebased-away commits of PR 8731). "Red CI on the base after a merge" is **not observable** for every run: `ci.yml` runs on push to `main` only, and no run pushed `trial/**` into it (README step 4 was not taken), so the measure is omitted from the tables rather than written as 0.

## 4. Results

### Table 1 — delivery and time

| Run | Role | Merged | Delivered (merged and correct) | Partial | Not delivered | Wall clock: first command to last report commit | to report PR merged | Queue done |
|---|---|---|---|---|---|---|---|---|
| A1-cd | controlled native | 10 | **10** | — | — | 1 h 46 min | 2 h 00 min | 1 h 42 min |
| A2c-cy-claude | controlled Chroxy | 10 | **10** | — | — | 2 h 26 min | 2 h 37 min | 2 h 25 min |
| A2-cy-claude | descriptive (effort deviation: medium) | 10 | **10** | — | — | 1 h 57 min | 2 h 11 min | 1 h 57 min |
| A2b-cy-claude | descriptive (model deviation: Sonnet 5.5 / medium) | 9 | **8** | 8303 | 8282 | 1 h 43 min | 1 h 52 min | 1 h 41 min |
| B1-cx | controlled native | 9 | **9** | — | 8282 | 2 h 24 min | 2 h 38 min | 2 h 23 min |
| B2c-cy-codex | controlled Chroxy | 10 | **9** | 7815 | — | 3 h 32 min | 3 h 43 min | 3 h 28 min |
| B2b-cy-codex | incident (quota stop) | 4 | **3** | 7815 | 8215, 8233, 8282, 8303, 8364, 8567 | n/a | n/a | 1 h 44 min |
| B2-cy-codex | incident (killed) | 0 | **0** | — | 7771, 7815, 8215, 8233, 8277, 8282, 8303, 8364, 8567, 8595 | n/a | n/a | n/a |

For the two incident runs "queue done" is the last merge before the stop; B2b also left PR 8696 (8233) mergeable and green and PR 8693 (8364) in draft, and B2 left PRs 8645 (7771) and 8646 (8595) open and green.

### Table 2 — PR cycle, CI and review

| Run | PR cycle median / p90 (min, n) | `ci.yml` runs on queue PRs (attempts) | All workflow runs | Copilot review bodies | Owner disposition bodies (all owner comments) | Closed unmerged / left open | Diff on merged PRs (+/−) | Closing keyword | `#N` in PR bodies |
|---|---|---|---|---|---|---|---|---|---|
| A1-cd | 58.1 / 72.2 (n = 10) | 21 (21) | 53 | 10 | 11 (16) | 0 / 0 | +2441 / −188 | 0 | none |
| A2c-cy-claude | 39.9 / 53.6 (n = 10) | 20 (20) | 57 | 10 | 17 (17) | 0 / 0 | +1331 / −174 | 0 | none |
| A2-cy-claude | 65.9 / 76.1 (n = 10) | 21 (22) | 54 | 10 | 12 (12) | 0 / 0 | +1419 / −131 | 0 | none |
| A2b-cy-claude | 21.4 / 65.2 (n = 9) | 16 (16) | 45 | 9 | 9 (9) | 0 / 0 | +1061 / −133 | 0 | 8011 |
| B1-cx | 30.9 / 42.3 (n = 9) | 11 (11) | 41 | 10 | 16 (16) | 1 / 0 | +1271 / −204 | 0 | none |
| B2c-cy-codex | 14.8 / 17.0 (n = 10) | 15 (15) | 68 | 12 | 26 (27) | 2 / 0 | +1399 / −497 | 0 | 8715 |
| B2b-cy-codex | 28.3 / 90.9 (n = 4) | 7 (7) | 23 | 6 | 11 (14) | 0 / 2 | +187 / −80 | 0 | none |
| B2-cy-codex | — | 2 (2) | 6 | 1 | 1 (1) | 0 / 2 | +0 / −0 | 0 | none |

Copilot posted exactly one review body per PR in every run except B2, where PR 8646, opened a minute before the kill, got none; the owner-account bodies are the runs' own merge-gate review comments (B2c posts two per PR, the Claude runs one per review round). The `#N` column counts references in PR bodies: A2b's `8011` is a non-queue issue, B2c's `8715` is its own closed draft PR. No PR body in any run used a closing keyword, and no run commented on, labelled or closed a queue issue. A1's diff is the largest because its 8303 PR (+1184) added a store listener registry and a malformed-port failure row its reviewer asked for.

### Table 3 — cost, allowance, approvals, compactions

| Run | Coordinator | Cost | Allowance | Human approvals | Compactions | Waves | Stop |
|---|---|---|---|---|---|---|---|
| A1-cd | claude-opus-5-5 / high | n/a (the desktop app exposes no total) | Claude meters not read | 0 | 0 | 1 | complete |
| A2c-cy-claude | claude-opus-5-5 / high (modelSettings; applied level not read from inside) | $26.5742 SDK-reported total_cost_usd (API-rate equivalent, not a charge) | Claude weekly all-models 0% to 3% used; 5-hour window reset mid-run | 0 | 0 | 2 | complete |
| A2-cy-claude | claude-opus-5-5 / medium (Claude Code default; the thinking control sets no effort) | $22.18 badge (SDK-reported); $22.64 transcript-priced lower bound | Claude 5-hour 15%, weekly 30% at start | 0 | 0 | 1 | complete |
| A2b-cy-claude | claude-sonnet-5-5 / medium (the daemon's new-session default; header not changed) | $15.55 badge (SDK-reported) | Claude weekly 50% to 66% across attempts 1 and 2 | 0 | 0 | 1 | complete |
| B1-cx | gpt-6-astra / xhigh | n/a (no harness-exposed total; ChatGPT usage-page figure still owed) | not read | 0 | 5 | 2 | complete |
| B2c-cy-codex | gpt-6-astra / xhigh | n/a (Codex app-server reports none) | Codex weekly 100% to 50% left across the run (about 14 points an hour) | 0 | 7 | 3 | complete |
| B2b-cy-codex | gpt-6-astra / xhigh | n/a; exhausted the owner's Codex weekly allowance | Codex allowance exhausted at 06:16:45Z | 0 | 1 observed (a `compacted` entry before the 06:16Z `turn_context` re-entry; four re-entries in all) | 1 | Codex usage-limit exhaustion at 06:16:45Z, unsurfaced: the daemon had taken the turn as complete at 04:26:37Z (#8710) |
| B2-cy-codex | gpt-6-astra / xhigh | n/a | not read | 0 | 0 | 1 | killed at 07:52:22Z by the daemon's idle-only auto-deploy after #8644 merged to main; the restored session had no native locator |

Claude costs are the SDK's `total_cost_usd`, an API-rate equivalent computed from tokens and not a charge on the subscription (#8624); the desktop app shows none. Codex exposes no cost in any harness; the only Codex figure is the owner's usage-page reading for B2c (half of the weekly allowance in 3 h 43 min, if nothing else drew on it). "Human approvals" is 0 in every run by report and README row; in A2c the floored requests timed out unanswered by protocol, and in B2c the sandbox escalations were, on the README's reading, decisions of Chroxy's permission pipeline under Auto (the rollout has not been read to confirm). Rate-limit pauses: none in any completed run.

### 4.1 Arm A — A1-cd vs A2c-cy-claude

Same ten items, same verdicts, diffs of the same shape (a shared termination module for 8364, the per-category `defaultBypass` flag for 8567, `$HOME` plus the configured roots for 8303, `Number.isFinite` for 7771). The Chroxy-hosted run took 40 minutes longer to its report commit (2 h 26 min vs 1 h 46 min) and 37 minutes longer to the report merge. Its per-PR cycles were shorter (median 40 vs 58 minutes) because it opened five PRs, merged them, then opened five more, whereas A1 opened all ten in 23 minutes and queued them on the same CI runners (load about 170 by A1's report). Two things in the gap are attributable from the evidence: the permission-floor timeouts on worktree edits (five minutes each, once for the coordinator and several times for workers; §6.3) and a wave-1 load spike when five workers ran the full server suite at once. A1's report records its own costs (a disk-full on coverage output, a forbidden `pkill -f` by one implementer) that did not show in its clock. Both runs withheld one security finding to the owner. A2c authored the only `#N` cross-reference to a queue issue in a run's own text (a review comment on PR 8728), recorded without a violation finding (T6).

### 4.2 Arm B — B1-cx vs B2c-cy-codex

Nine delivered each, but not the same nine: B1 merged nothing for 8282 ("acceptance already fulfilled at T0") where B2c pinned the criteria in a test-only PR, and B2c's 7815 kept only the `warn` direction where B1's test covers both. The Chroxy-hosted run took 68 minutes longer to its report commit (3 h 32 min vs 2 h 24 min). It worked one PR at a time (twelve opens, ten merged and two closed, from 19:50 to 22:32, cycles of 10–22 minutes), so its per-PR cycle is half of B1's while its total is longer; the two retried items account for most of the extra time (8364: draft 8715 closed after 1 h 25 min, redone as 8723; 8303: a never-published first wave, PR 8724 closed after Windows CI failed, PR 8725 merged on the third wave). B1 also retried 8303 once (8671 closed, 8672 merged) after Windows CI failures of the same kind, the 8.3 short-name path mismatch that every run reaching 8303 hit (six of eight; B2 and B2b never got there). Both ran at workspace-write with escalated retries; for B1 that departed from its mission's full access, for B2c it was the mission's setting. B2c's dashboard showed the session idle about ten minutes in, the #8710 pattern, so its liveness had to be read from GitHub.

### 4.3 Descriptive rows

- **A2-cy-claude (Opus 5.5 / medium):** 10 of 10 in 1 h 57 min to the report commit, $22.18, the longest cycles of any run (median 66 minutes) with one wave of ten and five review rounds on 8303. It ran at `medium` because Chroxy's thinking-level control sets a thinking-token budget, not Claude Code's effort level (README run 3).
- **A2b-cy-claude (Sonnet 5.5 / medium):** 9 merged, 8 correct, in 1 h 43 min, $15.55, serial with no implementation subagents, the only arm-A run to leave 8282 without a PR and the only one ruled partial on 8303 (T3). It ran on Sonnet because the header model was not changed on the new session (README run 5).
- **B2b-cy-codex and B2-cy-codex:** incident records, not comparisons (§6.1, §6.2). In the two hours B2b ran it behaved like B2c (serial, short cycles) and merged four PRs, one of them partial under T4.
- **CD vs CX (descriptive only):** A1-cd delivered 10 in 1 h 46 min against B1-cx's 9 in 2 h 24 min. Different models, different days, one parallel wave against two; no inference.

## 5. Isolation and leakage

- **Direct writes to shared state: none.** No run commented on, labelled or closed a queue issue, filed an issue, or used a closing keyword; every PR body carries `Trial-Closes: N`.
- **Cross-references on the queue issues' timelines did happen**, through a channel the protocol did not anticipate: Copilot's automatic review bodies name the issue as `#N`, and GitHub posts a "mentioned" event on the issue. G-codex counted 13 such events on 7771, 8215, 8282, 8567, 8595 and the non-queue 8011 ([`data/G-codex-EVIDENCE-A.json`](data/G-codex-EVIDENCE-A.json), `observed_trial_timeline_events`): 11 from Copilot (runs 1, 2, 3, 5, 4, 7) and 2 from the owner account (A2c's review comment on PR 8728; A2b's `#8011` in PR 8685's body). So from run 2 onwards, an agent opening a queue issue's page could see links to earlier runs' PRs. Whether any run followed one is not observable from GitHub; every run's isolation self-report says no other `trial/*` branch or PR was read, and both graders' byte-identity checks found no diff identical across runs (only mechanical one-line hunks coincide: the `model-display.ts` fallback in B1 = B2c = B2's open PR, the `MessageBubble.tsx` type line in every run, a `readonly string[]` in four). Design convergence is visible and expected (both Codex runs added a `requestId` nonce for 8303; every Claude run but A2b built a shared termination module for 8364) and is not evidence of copying.
- **Transcripts were not attached** for the graders, so "no forbidden read" rests on self-reports. The owner holds the native transcripts of A2c (85 files, hash manifest) and B2b, redactable for a later audit.
- **Human approvals:** 0 in every run; the counts for B2c and A2c rest on the run reports and the operator's observation rather than an attached permission journal.

## 6. Harness incidents and defects

Everything in this section is a Chroxy behaviour observed during the trial, verified from the daemon log, the Codex rollout, the dashboard code or GitHub as the README rows record. Issue numbers are given where one is filed.

### 6.1 Run 2 killed by the daemon's auto-deploy (B2-cy-codex)
`#8644` merged to `main` at 07:46Z while the run was 17 minutes in. The idle-only auto-deploy tick judged the daemon idle although the Codex session was emitting events every few seconds, sent SIGTERM at 07:52:22Z and restarted onto `91956e79`; the restored session failed with "Codex native restore: this saved session has no native locator". Two green PRs were left open. The deploy agent was unloaded for the rest of the trial. Issues: the deploy tick's idle test and the native-restore failure are not yet filed (README run 2 lists them as two daemon defects to file); #8710 notes the same idle mismatch.

### 6.2 Run 6's turn taken as complete at 11 minutes, quota stop unsurfaced (B2b-cy-codex, #8710)
The daemon logged `[result]` for the Codex turn at 04:26:37Z, right after the agent's first status line, and from then on discarded every app-server notification but token usage, model reroutes and deprecation notices (`codex-app-server-session.js`, `_onNotification` between turns). The agent kept working inside the same Codex turn for 1 h 50 min more, merged four PRs, and stopped at 06:16:45Z when the owner's Codex allowance ran out (`task_complete` with "You've hit your usage limit"); the dashboard showed an idle session with a frozen chat until the 12-hour cap. B2c, on the same build by design, showed the same idle dot ten minutes in and was supervised from GitHub instead. Issue: #8710.

### 6.3 Permission floor fires inside Claude Code worktrees (A2c-cy-claude)
An Edit to `<cwd>/.claude/worktrees/a2c-7771/packages/server/tests/models.test.js` was floored (`permission-floor.js` protects any `.claude` segment below the session cwd; the #6794/#6806 carve-out covers only a worktree used *as* the cwd). Under Auto the request waited 300 s, was denied as `timeout` at 07:19:24Z, and a second request went unanswered; the report records the Edit hook answering "Permission timed out" once for the coordinator and several times for workers, after which the edits were applied by script, which the floor leaves out of scope by design. Cost: five-minute waits per floored edit, no human involvement. To file (drafted).

### 6.4 Effort and model not what the header suggested (runs 3 and 5)
Run 3 ran at Claude Code's default `medium` effort: the dashboard's thinking-level control sets `maxThinkingTokens`, not the effort level, and at Auto sets none; no effort level was saved at run 3, and the Opus level saved later does not apply to Sonnet (run 5). Run 5 attempt 2 ran on Sonnet 5.5, the daemon's new-session default, because the header model was not changed before the send. Both are recorded as deviations; A2c fixed both by procedure (header set and verified from the daemon log before the send). Neither is observable from inside the session, and none of the Claude runs read `CLAUDE_EFFORT`. Issues: #8700 covers the effort control; the model-default case is recorded as a related gap in #8704.

### 6.5 Dashboard interrupt aborted a first turn with no trace (run 5 attempt 1)
A user-initiated interrupt from the owner's dashboard client arrived 2 s before Claude Code's init, aborted the query (`$0.0000 in 38ms`), and left a session that looked identical to one never sent a message; 105 minutes passed before the restart. Which control fired (Escape, Cmd+., Stop, Control Room) is not confirmed. Issue: #8703 (the first-seconds guard and the marker; the marker also in #8709).

### 6.6 Isolated preview daemon wrote to the user-level Claude settings (run 5)
During the A2b smoke of PR 8683, the preview daemon's New Session fell back to the `claude-cli` provider, which registered Chroxy's permission hook in `~/.claude/settings.json`. The agent stopped the preview and found the file intact. Issue: #8704.

### 6.7 Smaller findings
`/prompts:prime-directive` did not expand natively in the B2c app-server session (the agent read the compiled skill instead; run 2's row records an expansion on the same provider, unresolved). A preview daemon from a B2 smoke was still running four days later (PID 8527; to file). Codex app-server exposes no cost, so arm B has no cost measure at all. The daemon's five-session limit forced the operator to close the run 5 attempt-1 session before run 8. Every Claude run that used Codex read-only passes, and every Codex run whose smoke created a Claude session, drew a little on the other vendor's plan.

## 7. Cost

Arm A's Chroxy runs cost $26.57 (A2c), $22.18 (A2) and $15.55 (A2b) in SDK-reported API-rate equivalents; the desktop run exposes no figure. Arm B has no harness-exposed cost in either harness; the one reading is B2c's half of a weekly Codex allowance in 3 h 43 min. The two incident runs cost the owner what remained of a weekly Codex allowance after B1 (run 6) and a day each. Grading cost $78.74 for G-claude's initial pass and $18.49 for its cross-review (SDK equivalents on the owner's Claude plan, about 32 minutes of session time, read from the grader session's meter by the supervisor and recorded nowhere else); G-codex ran on the owner's ChatGPT plan with no exposed figure. The supervisor's own usage across the trial was not metered separately.

## 8. Caveats

- **n = 1 per cell**, five days, two allowance states (B2c on a fresh Codex allowance, A2c on a fresh Claude allowance, the native runs' allowances not read), runner contention that varied by the hour, and a Windows CI failure mode that hit six of eight runs on 8303. The gaps in §1 describe these runs.
- **The key was ambiguous in four places**, enough for two careful graders to differ by up to two items per run; the rulings are the owner's reading and are recorded. Under the strictest reading (G-codex's) the contrasts are 8 = 8 and 8 vs 9; under the loosest (G-claude's) 10 = 10 and 9 = 9; under the rulings 10 = 10 and 9 = 9. No reading changes the direction of the time gaps.
- **Invocation differed by vendor** (slash skill vs compiled prompt), and in B2c the compiled prompt did not expand; the agent recovered by reading the skill file. Recorded, not controlled.
- **Effort was never read from inside a Claude run.** A1, A2c and the graders report the configured level; the applied level is inferred from settings.
- **Red CI on the base after a merge** was not observable, so a measure the protocol wanted is missing from every row.
- **Transcripts, permission journals and daemon logs were not attached** for grading; isolation and approval counts rest on self-reports and the operator's observations.
- **Supervision drew on the same Claude plan** as the Claude runs (except during run 8, when the supervisor was silent by rule), and the dashboard's own smoke sessions drew on both plans.

## 9. Recommendations for a next trial

1. **Fix #8710 and the auto-deploy idle test before another CY-codex run**; both incident runs were harness kills, and the second cost a weekly allowance.
2. **Carve `.claude/worktrees/<name>/` out of the permission floor** (§6.3) before another CY-claude run that uses worktrees, and make a floored request under Auto deny at once with a clear message instead of a 300 s prompt nobody will answer.
3. **Make the header honest:** apply the saved effort level when the model is switched, and show the effective model and effort in the daemon log line the operator checks before the send.
4. **Pre-register the key's wording** against the graders' reading: a dry grading of one issue before run 1 would have caught "unchanged" and "notes when" as ambiguous.
5. **Attach transcripts and the permission journal** (redacted) to `trial/eval` before grading, and add `trial/**` to `ci.yml`'s push trigger so "red CI on the base" is observable.
6. **Close the Copilot cross-reference channel** on trial PRs (disable automatic review on `trial/**`, or accept and record it) if issue-page isolation matters.
7. **Expose cost for Codex sessions** (token usage from the app-server's `thread/tokenUsage/updated` into the badge) so arm B has a cost measure.

## 10. Reproduction and files

- Tables: `python3 docs/reports/harness-evals/trial/scripts/measures.py` from the repository root; inputs and their provenance in [`data/`](data/).
- Runs: the README status table; each run's `runs/<RUN_ID>/REPORT.md` on its `trial/*` base; missions in [`missions/`](missions/); dry runs in [`DRY-RUNS.md`](DRY-RUNS.md).
- Gradings: `trial/eval-claude` (`6fbbe4a4`, `4f663eee`, `a1107d8b`, `1b3e5a66`), `trial/eval-codex` (`61623852`, `ca51d4fe`, `ac80a5f3`, `5ee4e0cc`); the mailbox files under `docs/reports/harness-evals/mailbox/` on those branches.
- Key and rulings: `trial/eval` (`7b92999d` key, `6a955c27` tiebreaks); [`KEY-COMMITMENT.md`](KEY-COMMITMENT.md) on `main`.
- The trial branches stay as evidence until the owner decides otherwise (README step 13).
