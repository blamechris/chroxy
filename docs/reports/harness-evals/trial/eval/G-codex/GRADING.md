# Independent grading — controlled harness trial

Initial independent round; cross-review has not started. This file contains arm A first, followed by arm B when its separate grading commit lands. No product fixes, test executions, mutations, CI reruns, issue writes or PR comments were made by this grading session.

## Evidence and interpretation

The plaintext key is **7,782 bytes**, SHA-256 **`fb5599f33ddac7eb230b7edc29f0fefd5b3be7c39c746bf5dcd7055d24d40f23`**, matching `KEY-COMMITMENT.md` on freshly fetched main `f48cda8d5fa5838c50fee2810cf7e598dd366e63`. The key/evaluation input commit is `7b92999d8a5c90f0992ddadbc4dd3310e691e0cb`; common product baseline T0 is `932bd3a4ef40bc9634cab390e6cf0facadd801d7`. Protocol, issue bodies, run missions, reports, immutable squash diffs/tests, GitHub review/comment bodies, issue timelines and Actions records were read. The source snapshot for conditions is [the README at main](https://github.com/blamechris/chroxy/blob/f48cda8d5fa5838c50fee2810cf7e598dd366e63/docs/reports/harness-evals/trial/README.md).

`yes` means the inspected implementation meets the key’s checks; `partial` identifies an explicit unmet check; `no` would mean the central fix is absent; `key-unknown` is reserved for work whose answer is not known, not missing execution telemetry. All ten key entries supply an acceptance direction. A “merged and correct” delivery counts only a merged queue PR graded `yes`; partials and verified no-change outcomes are shown separately. These are first-round judgments, not owner tiebreaks.

Test sensitivity is **static reasoning from code and assertions**. `R` means the historical red/mutation demonstration is reported by the run, not independently witnessed here. No subject tests or mutations were rerun. A fresh correctness test can pass on T0 when the behavior was already there; that is distinct from an ineffective regression test.

The public input at `trial/eval` has the older diagnostic attachment `mailbox/attachments/Report.md`, but no run transcripts, permission journal or raw smoke artifacts. Therefore forbidden local reads, actual worker execution, human-approval event totals and historical mutation execution are **unverified**, even when a report says none/zero. Reported/private incidents are retained with that evidence class. Private findings are not reconstructed or disclosed here.

### Criterion index

The ordered K checks below combine the issue acceptance and sealed key. Each issue row reports its K checks in the same order: **P** pass from inspected code/tests, **F** fail, **partial** only some inputs covered, **R** historical execution reported.

| Issue | Ordered K checks |
|---|---|
| 8233 | K1 flag > env > file > 8765; K2 config-only test names the configured port; K3 explicit port still wins. A different valid fixture port from 8794 is equivalent. |
| 8215 | K1 complete 7f00–7fff mapped first hextet; K2 both bad forms false and both good forms true; K3 tests pin those cases; K4 key’s explicit “dotted branch is unchanged.” |
| 7771 | K1 finite guard replaces type guard; K2 false for NaN and no row/override mutation; K3 historical old-guard red demonstration. |
| 8595 | K1 cross-family modelChoices labels have one discriminator; K2 distinct targets and original selection IDs retained. |
| 8364 | K1 amber terminated reason in both components; K2 component tests for both; K3 historical red without change. The key expressly requires no simulator evidence. |
| 8282 | K1 reasoning has optional kind, reply does not; K2 legacy state restores/classifies; K3 persist/restore/truncation preserve kind; K4 replay and optional schema/old-client compatibility; K5 dropping recorder flag turns test red. |
| 8277 | K1 dormant stored override visible; K2 undismissed notice in Settings with shared dismissal; K3 behavior tests. |
| 8567 | K1 shared default definition; K2 server and both clients consume it, or server comparison in both directions; K3 one-sided mutation red; K4 protocol dist consistent. |
| 8303 | K1 roots/subdirectories browse and outside roots/home refuse; K2 allowed default cwd browsable; K3 note for unbrowsable prefilled cwd; K4 startup warning for refused config.cwd; K5 tests for roots/default/credential deny-list; K6 blank-cwd Create left unchanged. |
| 7815 | K1 both literal sites stop depending on those ambient ports; K2 owned pass/warn coverage or permitted relaxed assertion plus held-port warn; K3 old test red under bound literal ports. |

### Measurement rules

[EVIDENCE-A.json](EVIDENCE-A.json) records full SHAs, exact timestamps, CI run IDs/head SHAs/attempts, review-body IDs, diff sizes and public audit events. Reproduction: list PRs with `GET /repos/blamechris/chroxy/pulls?state=all&base=trial/<run>&per_page=100`; follow pagination for `/pulls/<N>/reviews`, `/issues/<N>/comments`, `/pulls/<N>/commits`, `/issues/<N>/timeline`, and `/actions/runs?branch=<head>&per_page=100`. Keep `path == .github/workflows/ci.yml`, use the run’s start/end window (branch names recur), and count distinct run IDs separately from the sum of `run_attempt`. Compare each merge SHA to its first parent for the actual delivered patch. Blank formal review bodies are excluded.

Review columns count **Copilot nonempty formal bodies / owner-account nonempty review-summary comment bodies**. Owner summaries sometimes combine several internal rounds, so these observable counts are not a claim that only that many internal reviewers ran. Smoke-only comments are excluded; additional preflight/review-disposition comments are identified when present. CI means the named `CI` workflow (`ci.yml`); ancillary Repo Relay and Copilot workflows are excluded. All PR-triggered workflow totals are also retained in the evidence and shown separately below. CI counts exclude report-only PRs in queue totals and include failed/closed queue attempts; per-PR counts include cancelled superseded runs. Median cycle uses merged queue PRs only; p90 is nearest rank `ceil(0.9*n)`. Abandoned-attempt time remains in wall time and is reported separately.

Wall time is first-command anchor → **last report-PR commit’s committer timestamp**, with report landing shown separately. This avoids treating prose “report written” times or merge times as the same measure. Native starts are report-supplied, except where README describes the supervisor/daemon anchor. [T0 ci.yml](https://github.com/blamechris/chroxy/blob/932bd3a4ef40bc9634cab390e6cf0facadd801d7/.github/workflows/ci.yml#L3) triggers pushes only on main, unchanged on every trial base. Actions returned no base push runs; **red CI on the base after merge is not observable for every issue/run**, not zero.

## Arm A — controlled pair and descriptive runs

The controlled comparison is **A1-cd vs A2c-cy-claude**. A2 is the medium-effort deviation; A2b is the different-model/medium-effort deviation. Their README conditions take precedence over reports claiming the intended setting. A2c’s configured high effort was not read through the applied-effort variable; model/effort pairing is supported by the recorded setup, not a supplied execution transcript.

| Measure | A1-cd (CD) | A2c-cy-claude (CY, controlled) | A2 (CY, medium effort) | A2b (CY, different model/medium effort) |
|---|---|---|---|---|
| Merged queue PRs | 10 | 10 | 10 | 9 |
| Strict key delivery / 10 | 8 | 8 | 8 | 7 |
| Merged partials | 2 | 2 | 2 | 2 |
| Verified already-satisfied, no PR | 0 | 0 | 0 | 1 |
| Wall to last report commit, minutes | 105.683 | 145.5 | 117.467 | 103.183 |
| Wall to report merge, minutes | 119.883 | 157.283 | 130.667 | 112.483 |
| Queue CI run IDs / attempts | 21 / 21 | 20 / 20 | 21 / 22 | 16 / 16 |
| All PR workflow IDs (including relay/review) | 53 | 57 | 54 | 45 |
| Cycle median / p90, minutes | 58.08 / 72.22 | 39.88 / 53.60 | 65.93 / 76.12 | 21.45 / 65.17 |
| SDK API-rate equivalent (not a charge) | n/a | $26.5742 (README meter) | $22.18 (README meter) | $15.55 (README meter) |
| Human approvals | 0 reported; journal unavailable | 0 reported; journal unavailable | 0 reported; journal unavailable | 0 reported; journal unavailable |
| Compactions / restarts | 0 / 0 reported | 0 / 0 reported | 0 / 0 reported | 0 / 0 reported |
| Red base CI | not observable | not observable | not observable | not observable |

A2c’s last report commit is 39.82 minutes later from its start than A1’s (145.50 vs 105.68 minutes), while its median merged-PR cycle is 18.21 minutes shorter (39.88 vs 58.08). Both merge ten queue PRs; both are 8/10 under the literal-key judgments below. This is **n = 1 per controlled cell** with different worker/review mixes and machine/permission incidents; it supports an observed contrast, not a general harness ranking or significance claim. The later controlled rerun also loses the original ordering counterbalance.

The strict totals exclude all four loopback fixes for a narrow key-contract deviation, not because the specified bad inputs still pass. Waiving that key-only restriction adds one to each run (A1/A2c/A2: 9; A2b: 8), while preserving the Browse-note partials. The separate 8282 no-change outcome explains one further count difference without implying a missing feature.

### A1-cd

Evidence: [run report](https://github.com/blamechris/chroxy/blob/fe7ea87ec8b704a4f1bff92266d99f7478563e82/docs/reports/harness-evals/trial/runs/A1-cd/REPORT.md); final base [`fe7ea87e`](https://github.com/blamechris/chroxy/commit/fe7ea87ec8b704a4f1bff92266d99f7478563e82). Report final commit [`36d1a3a4`](https://github.com/blamechris/chroxy/commit/36d1a3a410ee936427bd7d0ee03fce364fe1d0da) at `2026-10-18T05:52:42Z`.

| Issue | Outcome / correct vs key | Acceptance, tests and sensitivity |
|---|---|---|
| 8233 | merged [8636](https://github.com/blamechris/chroxy/pull/8636) / **yes** | P,P,P. `runDoctorChecks` feeds parsed config and the explicit option to `mergeConfig`; `doctor-cmd-port.test.js` covers config, env, flag, default and the real Commander path. Added tests would fail at config/env cases under the old constant-port implementation; invalid-port handling is additional scope. |
| 8215 | merged [8638](https://github.com/blamechris/chroxy/pull/8638) / **partial** | P,P,P,**F**. `mappedV6ToV4` rejects both short forms and accepts the two required loopbacks; `bind-host.test.js` pins them. It also replaces the dotted prefix branch and rejects formerly accepted malformed dotted inputs: correct hardening, but contrary to K4 (D1). Added negative tests fail under the old prefix. |
| 7771 | merged [8634](https://github.com/blamechris/chroxy/pull/8634) / **yes** | P,P,R. `Number.isFinite` precedes both writes; `models.test.js` checks false, unchanged rows and a refresh exposing leaked overrides. Added NaN test fails under the old guard; `models-overlay-reload.test.js` is changed for the new behavior. Historical red run is reported in PR 8634, not independently replayed. |
| 8595 | merged [8632](https://github.com/blamechris/chroxy/pull/8632) / **yes** | P,P. Original base is carried alongside each choice; exact cross-family labels and unchanged IDs/full IDs are asserted in `model-display.test.ts`. Added collision test fails with the old augmented-label fallback. |
| 8364 | merged [8633](https://github.com/blamechris/chroxy/pull/8633) / **yes** | P,P,R. Shared `ToolTermination` renders amber reason text; the reason is threaded through `ChatView` to the modal. Added component tests for both surfaces and a wiring test fail when the old components or omitted prop are substituted. Live lone-path reachability is not required by the key (D3). |
| 8282 | merged [8637](https://github.com/blamechris/chroxy/pull/8637) / **yes** | P,P,P,P,R. Production behavior already exists at T0. Added `session-history-stream-kind.test.js` exercises real serialize/restore and >50 KiB truncation, with an opaque ID; schema tests assert retained kind and ignored unknown fields. Tests pass on baseline production; removing the stamp/retention would fail them (D2). |
| 8277 | merged [8635](https://github.com/blamechris/chroxy/pull/8635) / **yes** | P,P,P. Disabled selected dormant option plus hint, shared `SessionDefaultsNotice` and shared dismiss action. Added/changed Settings tests assert the stored value, notice and dismiss; they fail without each UI change. |
| 8567 | merged [8640](https://github.com/blamechris/chroxy/pull/8640) / **yes** | P,P,R,P. Protocol `defaultBypass` flags derive the export; both clients consume it, server retains an independently checked literal. Added bidirectional roster tests and client guards fail on a one-sided addition; source and checked-in dist carry the same derivation. |
| 8303 | merged [8639](https://github.com/blamechris/chroxy/pull/8639) / **partial** | P,P,**partial**,P,P,P. Roots/default-cwd admission, outside refusal, deny-list and startup warning are implemented and tested. The note deliberately skips absolute paths containing `..` and otherwise compares only trailing separators; an unbrowsable prefilled `/var/tmp/../outside` gets no note. Added Browse/warning/note tests catch canonical cases, not this AC3 gap (D4). |
| 7815 | merged [8641](https://github.com/blamechris/chroxy/pull/8641) / **yes** | P,P,R. Both literals are replaced by OS-assigned ports; added held-port tests assert warn and aggregate pass semantics, while free-port pass remains. Old custom-port assertion fails when its literal is held, as reported. Bind-release still has a small allocation race explicitly accepted by the key’s preferred design (D7). |

| Issue / PR | Merge | Copilot / owner review bodies | CI IDs / attempts (all workflows) | Cycle minutes |
|---|---|---|---|---|
| 8233 / [8636](https://github.com/blamechris/chroxy/pull/8636) | [`c375e66e`](https://github.com/blamechris/chroxy/commit/c375e66eae3bb85b655d73b5187f25ff2d5b03b7) | 1 / 1 | 2 / 2 (5) | 68.60 |
| 8215 / [8638](https://github.com/blamechris/chroxy/pull/8638) | [`0402cad0`](https://github.com/blamechris/chroxy/commit/0402cad09c3f48b0f72dfbcff5b83e5d00652aa2) | 1 / 1 | 2 / 2 (5) | 72.22 |
| 7771 / [8634](https://github.com/blamechris/chroxy/pull/8634) | [`58f76578`](https://github.com/blamechris/chroxy/commit/58f765783d0c07091c2ab9618845a7b89ed39923) | 1 / 1 | 3 / 3 (7) | 44.72 |
| 8595 / [8632](https://github.com/blamechris/chroxy/pull/8632) | [`6e736239`](https://github.com/blamechris/chroxy/commit/6e7362397a01b6f29243f5fa7b52e61c69e09920) | 1 / 1 | 2 / 2 (5) | 48.67 |
| 8364 / [8633](https://github.com/blamechris/chroxy/pull/8633) | [`2da32ee3`](https://github.com/blamechris/chroxy/commit/2da32ee3c7145e83a7163bf9da8ca30175a1514b) | 1 / 1 | 2 / 2 (5) | 69.22 |
| 8282 / [8637](https://github.com/blamechris/chroxy/pull/8637) | [`27d74dc1`](https://github.com/blamechris/chroxy/commit/27d74dc1ec07a31ac3ef1c5eaa61c2756ec00ba8) | 1 / 1 | 2 / 2 (5) | 57.75 |
| 8277 / [8635](https://github.com/blamechris/chroxy/pull/8635) | [`f53cfe46`](https://github.com/blamechris/chroxy/commit/f53cfe46c7edc4bf8c845024cfddfa565011a8bd) | 1 / 1 | 1 / 1 (3) | 44.25 |
| 8567 / [8640](https://github.com/blamechris/chroxy/pull/8640) | [`b47a85a6`](https://github.com/blamechris/chroxy/commit/b47a85a63cfb76a91df3538b09e1aa61d2abb343) | 1 / 1 | 2 / 2 (5) | 58.42 |
| 8303 / [8639](https://github.com/blamechris/chroxy/pull/8639) | [`38d3aa30`](https://github.com/blamechris/chroxy/commit/38d3aa304a5a20ad0c17b1d7e34c6667a8283924) | 1 / 2 | 3 / 3 (8) | 75.08 |
| 7815 / [8641](https://github.com/blamechris/chroxy/pull/8641) | [`34c3dadb`](https://github.com/blamechris/chroxy/commit/34c3dadbf39f074215dd06d74b6417f50e6397cc) | 1 / 1 | 2 / 2 (5) | 51.82 |

The desktop run reported disk exhaustion during coverage/mutation work, runner load near 170, a forbidden pattern kill, and a watcher that returned before the CI matrix was registered; it recovered and landed all ten PRs. Its Browse change fixes Windows canonicalization and adds an independent reply listener, while UI smoke could exercise only the grouped tool path. No >90-minute stall or human approval is reported, but one private finding remains unassessed here, so this is not a clean-security verdict.

Isolation: all ten bodies use bare `Trial-Closes`; no closing keyword or queue number in the authored PR title/squash subject was found. Queue timelines show Copilot-origin cross-references from 8632 to 8595 and 8637 to 8282, a real leakage channel absent from a simple issue-comment count. No direct queue comments/label/closure events or newly created issues fall in the run window; forbidden reads and journal totals remain unverified. All rows inherit these run-wide limits; the two cross-reference rows are the exceptions to otherwise absent visible issue interactions.

### A2c-cy-claude

Evidence: [run report](https://github.com/blamechris/chroxy/blob/bda6f2e677dc531b573e93f8a0e7d3755281b9f9/docs/reports/harness-evals/trial/runs/A2c-cy-claude/REPORT.md); final base [`bda6f2e6`](https://github.com/blamechris/chroxy/commit/bda6f2e677dc531b573e93f8a0e7d3755281b9f9). Report final commit [`141aab34`](https://github.com/blamechris/chroxy/commit/141aab34ce310db86bb1206e4faa32caa4dd2ad7) at `2026-10-22T09:30:51Z`.

| Issue | Outcome / correct vs key | Acceptance, tests and sensitivity |
|---|---|---|
| 8233 | merged [8730](https://github.com/blamechris/chroxy/pull/8730) / **yes** | P,P,P. `mergeConfig` resolves valid flag/env/file/default ports; added tests in `doctor.test.js` cover every tier and would fail for config/env under the old code. Invalid input fallback is an extra limitation, not one of the key’s valid-port fixtures. |
| 8215 | merged [8729](https://github.com/blamechris/chroxy/pull/8729) / **partial** | P,P,P,**F**. A strict mapped-hex regex plus `isIPv6` rejects both bad inputs; existing/new cases pin the two good ones. `isIPv6` also gates the dotted branch, changing malformed dotted behavior contrary to K4 (D1); new negative tests are sensitive to the old prefix. |
| 7771 | merged [8728](https://github.com/blamechris/chroxy/pull/8728) / **yes** | P,P,R. Finite guard precedes mutation; added `models.test.js` rejects NaN/±Infinity and checks rows and refresh. Overlay tests changed to reject NaN; new test would return true under the old guard. Red-first claim is recorded in PR 8728. |
| 8595 | merged [8732](https://github.com/blamechris/chroxy/pull/8732) / **yes** | P,P. Fallback reads `baseLabel(unique[i] ?? m)` from the aligned original list. Added `model-display.test.ts` asserts the two exact labels plus original selection/full IDs, and would fail under the old fallback. |
| 8364 | merged [8735](https://github.com/blamechris/chroxy/pull/8735) / **yes** | P,P,R. `resolveToolTermination` and amber note are shared with ActivityGroup; bubble → ChatView → modal forwards the reason. Added tests cover both components, normal controls and image-only termination. Old components lack the icon/note; device reachability is outside the key (D3). |
| 8282 | merged [8733](https://github.com/blamechris/chroxy/pull/8733) / **yes** | P,P,P,P,R. Test-only `session-history-stream-kind-persist.test.js` records >50 KiB streams, reads disk, restores and checks kind directly; legacy numeric and bare thinking suffixes are classified. Baseline schema/replay cover K4; removing the recorder stamp makes direct kind assertions fail (D2). |
| 8277 | merged [8736](https://github.com/blamechris/chroxy/pull/8736) / **yes** | P,P,P. Dormant selected disabled option and hint; shared notice/dismiss action; effective-provider model field preserved. Added Settings tests fail without those UI branches. The report’s unavailable model-field smoke does not remove the unit evidence. |
| 8567 | merged [8734](https://github.com/blamechris/chroxy/pull/8734) / **yes** | P,P,R,P. Protocol flags/export, imports in app/dashboard, and two-direction server comparison. Added nonempty/set-difference tests reject unilateral additions; dist mirrors source and the client defaults are no longer independent literals. |
| 8303 | merged [8737](https://github.com/blamechris/chroxy/pull/8737) / **partial** | P,P,**partial**,P,P,P. Server admission, denial and startup-warning code are present, with focused tests. `usePathAutocomplete` matches probe and reply after stripping trailing separators only; `/var/tmp//outside` is normalized by the server to `/var/tmp/outside`, so denial never sets the prefilled note. Existing hook tests cover matching canonical paths, not normalization (D4). |
| 7815 | merged [8731](https://github.com/blamechris/chroxy/pull/8731) / **yes** | P,P,R. Both literals replaced, free-port pass retained, bound-port warn added; shared fixture cleaned up after rebase. Test would expose a probe that always passes; original red-under-held-literals result is reported. Residual release/rebind race is acknowledged (D7). |

| Issue / PR | Merge | Copilot / owner review bodies | CI IDs / attempts (all workflows) | Cycle minutes |
|---|---|---|---|---|
| 8233 / [8730](https://github.com/blamechris/chroxy/pull/8730) | [`f295618e`](https://github.com/blamechris/chroxy/commit/f295618ef5439ff18a9975ce5fcab6cc8d5df990) | 1 / 1 | 1 / 1 (3) | 28.10 |
| 8215 / [8729](https://github.com/blamechris/chroxy/pull/8729) | [`c3bd7d1f`](https://github.com/blamechris/chroxy/commit/c3bd7d1f938e7f9f890f6fbd47d972e05aa46ae5) | 1 / 1 | 2 / 2 (5) | 36.85 |
| 7771 / [8728](https://github.com/blamechris/chroxy/pull/8728) | [`2429d74b`](https://github.com/blamechris/chroxy/commit/2429d74b26a46c2bc5191754d46d1ccfdeacb26a) | 1 / 1 | 2 / 2 (5) | 36.85 |
| 8595 / [8732](https://github.com/blamechris/chroxy/pull/8732) | [`6a134995`](https://github.com/blamechris/chroxy/commit/6a13499525611430acfcb46e91db86f40f513627) | 1 / 2 | 2 / 2 (6) | 53.60 |
| 8364 / [8735](https://github.com/blamechris/chroxy/pull/8735) | [`d97dae8b`](https://github.com/blamechris/chroxy/commit/d97dae8b2e3e531d627ad12d5b76c5a8649de9e9) | 1 / 2 | 2 / 2 (6) | 43.38 |
| 8282 / [8733](https://github.com/blamechris/chroxy/pull/8733) | [`7b302392`](https://github.com/blamechris/chroxy/commit/7b30239297c9016a5cb916d6dcf5521a0f3c4136) | 1 / 2 | 2 / 2 (5) | 39.80 |
| 8277 / [8736](https://github.com/blamechris/chroxy/pull/8736) | [`f9ac84ac`](https://github.com/blamechris/chroxy/commit/f9ac84ac01c91dc924e48ae5b301ab9956fbefb2) | 1 / 2 | 2 / 2 (6) | 39.95 |
| 8567 / [8734](https://github.com/blamechris/chroxy/pull/8734) | [`7d39e986`](https://github.com/blamechris/chroxy/commit/7d39e9861349aa64ebce3c32808fec4901878181) | 1 / 1 | 1 / 1 (4) | 39.80 |
| 8303 / [8737](https://github.com/blamechris/chroxy/pull/8737) | [`9021940a`](https://github.com/blamechris/chroxy/commit/9021940aa269380f8c5dd3b7daefb08494adec34) | 1 / 3 | 3 / 3 (10) | 57.03 |
| 7815 / [8731](https://github.com/blamechris/chroxy/pull/8731) | [`bb2f9e4b`](https://github.com/blamechris/chroxy/commit/bb2f9e4b268880bcfe8f2dc347c54b36dd42c63a) | 1 / 2 | 3 / 3 (7) | 53.50 |

Chroxy’s permission floor repeatedly timed out on Edit operations inside a `.claude/worktrees` path; the README’s external capture describes unanswered five-minute waits, and the run report describes completing edits through checked script replacements. A wave-one host load spike caused local test timeouts, while CI caught typechecking and Windows path problems that were fixed before merge. It completed without reported compaction, restart or human intervention, but the applied effort and one private finding remain unverified, and the live lone-tool smoke was unreachable.

Isolation: bare `Trial-Closes` in all bodies and no forbidden closing keyword/title/squash issue number. **Additional verified interaction:** owner review comment [6335575942](https://github.com/blamechris/chroxy/pull/8728#issuecomment-6335575942) repeats the original issue number and creates an owner-origin cross-reference on issue 7771 at `2026-10-22T07:46:55Z` (D6); “no issue updated” in the README is not a complete timeline audit. No direct comments/label/closure events or new issues occur in-window. The report’s reviewer mention of another PR has unknown base, and same-named-branch Actions metadata exposure is acknowledged; neither proves code was read, and absent transcripts prevent a clean isolation certificate.

### A2-cy-claude

Evidence: [run report](https://github.com/blamechris/chroxy/blob/bc0b6c9e407d15196512b046a84af7c8b36ec2da/docs/reports/harness-evals/trial/runs/A2-cy-claude/REPORT.md); final base [`bc0b6c9e`](https://github.com/blamechris/chroxy/commit/bc0b6c9e407d15196512b046a84af7c8b36ec2da). Report final commit [`3363a5d4`](https://github.com/blamechris/chroxy/commit/3363a5d444e75060ccf1c2e1edc54a5d64000755) at `2026-10-18T18:01:44Z`.

| Issue | Outcome / correct vs key | Acceptance, tests and sensitivity |
|---|---|---|
| 8233 | merged [8651](https://github.com/blamechris/chroxy/pull/8651) / **yes** | P,P,P. One shared config merge feeds provider and port resolution; explicit option, env, file and 8765 paths are asserted in added `doctor-port-resolution.test.js`. Old code fails config/env tests. Invalid/zero-port semantics are additional behavior; valid-port key is met. |
| 8215 | merged [8648](https://github.com/blamechris/chroxy/pull/8648) / **partial** | P,P,P,**F**. Full hextet regex fixes the specified false positives; tests pin all four cases. The dotted branch now requires `isIPv4(rest)`, rejecting scoped/malformed forms previously accepted, contrary to K4 (D1). Old hex predicate fails added negatives. |
| 7771 | merged [8652](https://github.com/blamechris/chroxy/pull/8652) / **yes** | P,P,R. Finite guard, active-window snapshots and refresh checks; overlay test changed and fractional persistence control added. Added NaN/Infinity cases fail the old guard; the report supplies historical red results. |
| 8595 | merged [8649](https://github.com/blamechris/chroxy/pull/8649) / **yes** | P,P. Fallback uses the index-aligned `unique[i]` base. Added test asserts exact two labels and original IDs; full IDs remain untouched by the spread. Old code adds the unwanted pinned descriptor. |
| 8364 | merged [8653](https://github.com/blamechris/chroxy/pull/8653) / **yes** | P,P,R. Shared termination helper, amber icon/note and modal reason forwarding; both component suites add positive/normal controls. The old components fail the new positives. Live chat still groups all tools, which does not fail this key (D3). |
| 8282 | merged [8657](https://github.com/blamechris/chroxy/pull/8657) / **yes** | P,P,P,P,R. Added `session-manager-history-stream-kind.test.js` covers old-file restore and recorder→disk→restore; T0 has direct `truncateEntry` and schema tests for remaining criteria. No new oversized integrated roundtrip here; that is a coverage-depth difference, not missing production behavior (D2). |
| 8277 | merged [8655](https://github.com/blamechris/chroxy/pull/8655) / **yes** | P,P,P. Dormant option/hint plus shared migration banner/dismiss satisfy the key. Added tests prove both; the PR also switches the model roster to the dormant provider and hides the model field, a separate behavior concern recorded below (D8). |
| 8567 | merged [8654](https://github.com/blamechris/chroxy/pull/8654) / **yes** | P,P,R,P. Protocol `bypassByDefault` flags derive one export; both clients copy values from that export, rather than maintain literals. Bidirectional independent server-set assertions catch unilateral additions; source and dist agree. |
| 8303 | merged [8656](https://github.com/blamechris/chroxy/pull/8656) / **partial** | P,P,**partial**,P,P,P. Shared Create/Browse policy, native path resolution, startup warning and separate probe dispatcher are implemented/tested. The probe deliberately skips `~` and matches only trailing-slash normalization; a normalized reply to `/var/tmp//outside` misses the note. Canonical-path tests pass but do not cover that AC3 input (D4). |
| 7815 | merged [8650](https://github.com/blamechris/chroxy/pull/8650) / **yes** | P,P,R. Both literal ports replaced by allocated free ports; an added held-port warn case owns the listener. The original fixed-port test fails with its port held; the new warn assertion detects an always-pass probe. Release/rebind caveat is D7. |

| Issue / PR | Merge | Copilot / owner review bodies | CI IDs / attempts (all workflows) | Cycle minutes |
|---|---|---|---|---|
| 8233 / [8651](https://github.com/blamechris/chroxy/pull/8651) | [`d1cbafd3`](https://github.com/blamechris/chroxy/commit/d1cbafd36c8a3cc4a8df687d93b0f90dd3f273dd) | 1 / 1 | 5 / 5 (11) | 68.27 |
| 8215 / [8648](https://github.com/blamechris/chroxy/pull/8648) | [`7241b459`](https://github.com/blamechris/chroxy/commit/7241b459cff9ff7b17b814b8e3523d54c458386b) | 1 / 1 | 2 / 2 (5) | 69.40 |
| 7771 / [8652](https://github.com/blamechris/chroxy/pull/8652) | [`0d565e10`](https://github.com/blamechris/chroxy/commit/0d565e102b1e22b9caad2e2495fda6fec38d5079) | 1 / 1 | 2 / 2 (5) | 52.63 |
| 8595 / [8649](https://github.com/blamechris/chroxy/pull/8649) | [`07dc9d67`](https://github.com/blamechris/chroxy/commit/07dc9d6714e7587c95e88f30623b24489612c6e4) | 1 / 1 | 1 / 1 (3) | 53.98 |
| 8364 / [8653](https://github.com/blamechris/chroxy/pull/8653) | [`22c14da2`](https://github.com/blamechris/chroxy/commit/22c14da2833bdd842ba64831f52c22c0fc1ab17d) | 1 / 1 | 1 / 1 (3) | 63.60 |
| 8282 / [8657](https://github.com/blamechris/chroxy/pull/8657) | [`72c4e6b9`](https://github.com/blamechris/chroxy/commit/72c4e6b94077c2a5c1fd3d6d33357114eaf7d0c6) | 1 / 1 | 1 / 2 (3) | 76.12 |
| 8277 / [8655](https://github.com/blamechris/chroxy/pull/8655) | [`3854587e`](https://github.com/blamechris/chroxy/commit/3854587eb0519cb1ce2d69116e3d463230fb0b5b) | 1 / 1 | 2 / 2 (6) | 71.05 |
| 8567 / [8654](https://github.com/blamechris/chroxy/pull/8654) | [`48fc9ca9`](https://github.com/blamechris/chroxy/commit/48fc9ca9880f9f6c1fb7039cc38f2a9df9dfc0ab) | 1 / 1 | 1 / 1 (3) | 51.63 |
| 8303 / [8656](https://github.com/blamechris/chroxy/pull/8656) | [`b23c2db8`](https://github.com/blamechris/chroxy/commit/b23c2db87137d67ce120b45585dffb0991b50493) | 1 / 3 | 5 / 5 (12) | 87.58 |
| 7815 / [8650](https://github.com/blamechris/chroxy/pull/8650) | [`80ace565`](https://github.com/blamechris/chroxy/commit/80ace565e7a98f43a306aa32017e6e15fc434b1c) | 1 / 1 | 1 / 1 (3) | 46.60 |

This run’s model matched arm A but its effort did not, so it is descriptive. It recovered from a backgrounded watcher, a server-test retry, relay failure and repeated Windows fixes, with five internal review rounds compressed into three public summary bodies on the Browse PR. It reports no >90-minute stall, compaction, restart or human approval, and reached ten merges; its report’s 33 claimed CI counts reduce to 21 distinct run IDs / 22 attempts when old same-named branches are excluded (D5).

Isolation: bodies use bare `Trial-Closes` and no forbidden closing keyword/title/squash issue number; no direct queue comments/label/closure events or new issues occur in-window. Copilot cross-references are confirmed for 8648→8215 and 8657→8282. Scratch-directory names were observed according to the report, but other-run contents and forbidden vault reads are unverified, not certified absent.

### A2b-cy-claude

Evidence: [run report](https://github.com/blamechris/chroxy/blob/f882b5e928cd2806e8d27c74d19d7b27c5495676/docs/reports/harness-evals/trial/runs/A2b-cy-claude/REPORT.md); final base [`f882b5e9`](https://github.com/blamechris/chroxy/commit/f882b5e928cd2806e8d27c74d19d7b27c5495676). Report final commit [`39a17cbe`](https://github.com/blamechris/chroxy/commit/39a17cbe2f5a4dc379a9e65c14bbdc887d70918f) at `2026-10-19T02:36:04Z`.

| Issue | Outcome / correct vs key | Acceptance, tests and sensitivity |
|---|---|---|
| 8233 | merged [8678](https://github.com/blamechris/chroxy/pull/8678) / **yes** | P,P,P. Explicit port wins, otherwise `mergeConfig(...).port`, then 8765. Added config/explicit test fails without config lookup; env precedence follows the shared merge but has no new direct test in this PR. |
| 8215 | merged [8679](https://github.com/blamechris/chroxy/pull/8679) / **partial** | P,P,P,**F**. Strict full-hextet regex and four-case tests meet the issue; `return isIPv6(h)` on the dotted branch changes its malformed-input behavior contrary to K4 (D1). Negative tests would fail the old prefix. |
| 7771 | merged [8680](https://github.com/blamechris/chroxy/pull/8680) / **yes** | P,P,R. Finite guard and added factory test reject NaN/±Infinity; registry refresh with a new catalogue window demonstrates no stored override. Existing overlay assertion updated. Old guard returns true; red proof is reported. |
| 8595 | merged [8681](https://github.com/blamechris/chroxy/pull/8681) / **yes** | P,P. Carries original base beside each choice; added cross-family test asserts labels, IDs and full IDs. Old fallback produces the repeated descriptor. |
| 8364 | merged [8682](https://github.com/blamechris/chroxy/pull/8682) / **yes** | P,P,R. Bubble and modal render amber reason and forward it through ChatView. Added component tests assert both plus normal controls; four reported red cases align with the removed UI. No simulator requirement (D3). |
| 8282 | untouched (already satisfied) / **yes on T0** | P,P,P,P,R on T0; **untouched**, explicitly verified already satisfied, not an external blocker. No PR or new tests. Baseline recorder, legacy classifier, truncation and optional schema provide the behavior; report says 97 replay tests and five stamp-removal failures (execution unverified). Not counted as merged delivery (D2). |
| 8277 | merged [8683](https://github.com/blamechris/chroxy/pull/8683) / **yes** | P,P,P. Disabled dormant option/hint and shared `SessionDefaultsNoticeBanner` render/dismiss; Settings tests pin the stored value and shared action and fail without the change. |
| 8567 | merged [8684](https://github.com/blamechris/chroxy/pull/8684) / **yes** | P,P,R,P. Shared protocol flags/export, both clients consume it, server literal checked both ways; added client/roster tests and matching dist. One-sided additions would fail the independent comparisons. |
| 8303 | merged [8685](https://github.com/blamechris/chroxy/pull/8685) / **partial** | P,P,**partial**,P,P,P. Server Browse/root/default/deny-list and startup warning are present. The modal installs a one-shot callback which autocomplete replaces after 200 ms; a slower denial is lost. It also explicitly suppresses the note for credential-directory refusals (`CreateSessionModalBrowsableNote.test.tsx`). Both miss the general prefilled-unbrowsable criterion (D4). |
| 7815 | merged [8686](https://github.com/blamechris/chroxy/pull/8686) / **yes** | P,P,R. OS-assigned free ports replace both literals and retain pass assertions, with a separate owned bound-port case asserting warn. The new warn assertion is sensitive; the old red-under-bound-literals demonstration is not separately recorded in this PR, so historical proof remains unverified (D7). |

| Issue / PR | Merge | Copilot / owner review bodies | CI IDs / attempts (all workflows) | Cycle minutes |
|---|---|---|---|---|
| 8233 / [8678](https://github.com/blamechris/chroxy/pull/8678) | [`3d1bfc8a`](https://github.com/blamechris/chroxy/commit/3d1bfc8ae96f9fab06d9d3784484888224943435) | 1 / 1 | 1 / 1 (3) | 14.02 |
| 8215 / [8679](https://github.com/blamechris/chroxy/pull/8679) | [`48564cbf`](https://github.com/blamechris/chroxy/commit/48564cbfe680cbe587956d99c43b36d27cafe4dc) | 1 / 1 | 2 / 2 (5) | 19.95 |
| 7771 / [8680](https://github.com/blamechris/chroxy/pull/8680) | [`d13765cf`](https://github.com/blamechris/chroxy/commit/d13765cfd66f14ff3031ec66b1824024ac6b2df4) | 1 / 1 | 3 / 3 (7) | 65.17 |
| 8595 / [8681](https://github.com/blamechris/chroxy/pull/8681) | [`90d29ddc`](https://github.com/blamechris/chroxy/commit/90d29ddc401d3f79daab3a2e5136a954e225578a) | 1 / 1 | 2 / 2 (8) | 37.17 |
| 8364 / [8682](https://github.com/blamechris/chroxy/pull/8682) | [`9a3f05bd`](https://github.com/blamechris/chroxy/commit/9a3f05bdef31212880d624ce65de9e782f2adf96) | 1 / 1 | 1 / 1 (3) | 20.28 |
| 8282 / none | — | 0 / 0 | 0 / 0 | n/a |
| 8277 / [8683](https://github.com/blamechris/chroxy/pull/8683) | [`825c6a16`](https://github.com/blamechris/chroxy/commit/825c6a16a7c8ac757b5719698b039671965eb384) | 1 / 1 | 1 / 1 (3) | 25.08 |
| 8567 / [8684](https://github.com/blamechris/chroxy/pull/8684) | [`06114d68`](https://github.com/blamechris/chroxy/commit/06114d686f9fae9c849571423c8463d705351ad7) | 1 / 1 | 2 / 2 (5) | 21.45 |
| 8303 / [8685](https://github.com/blamechris/chroxy/pull/8685) | [`cfe84e3e`](https://github.com/blamechris/chroxy/commit/cfe84e3eeaa224f1c99d14e80f5018cdad6667c0) | 1 / 1 | 3 / 3 (8) | 27.73 |
| 7815 / [8686](https://github.com/blamechris/chroxy/pull/8686) | [`ec45d7d3`](https://github.com/blamechris/chroxy/commit/ec45d7d3a943538551aea642d6d96fc94d31ffce) | 1 / 1 | 1 / 1 (3) | 12.98 |

This descriptive run used the unintended coordinator model/effort and no implementation subagents; it merged nine PRs and correctly identified 8282 as already satisfied. It recovered from merge-comment hook blocks and a preview session that temporarily registered a user-level hook, while a bounded Codex review returned probe output without a final summary. No >90-minute stall/compaction/restart/human approval is reported; its table’s 35 claimed CI runs are 16 distinct in-window CI IDs, and unavailable app smoke is documented rather than counted as a code failure (D3/D5).

Isolation: no closing keywords and no direct queue comment/label/closure events or new issues occur in-window. PR 8685’s body contains an issue reference to 8011, confirmed by its timeline at `2026-10-19T02:09:42Z`; this violates the mission’s issue-reference isolation rule even though 8011 is outside the fixed queue (D6). Copilot also cross-references 8679→8215 and 8680→7771. Other forbidden reads and the report’s zero-approval count remain unverified without attachments.

### Arm A findings expected to need cross-review

- **D1 — literal dotted-branch restriction.** PRs 8638, 8729, 8648 and 8679 all pass the issue’s three stated criteria but change the dotted branch contrary to the sealed key. This is a `partial` **against the key**, with the alternate count disclosed; no unsafe behavior is alleged. The malformed input `::ffff:127.x` went from accepted to rejected in each, and A2 additionally rejects a scoped dotted form. A key tiebreak may reasonably decide this extra hardening is acceptable, but the initial grader cannot silently delete K4.
- **D2 — pre-existing 8282.** T0 `session-message-history.js:104–124,633–705` already provides the classifier and recorder stamp; `truncateEntry` spreads the entry, the state loader restores history and the stream schema accepts kind. Test-only PRs are legitimate merged work, while A2b’s no-PR outcome is legitimate acceptance satisfaction with zero incremental delivery. Old-client compatibility is schema tolerance evidence, not a device execution claim.
- **D3 — no simulator penalty for 8364.** The sealed key explicitly says no simulator evidence is required. Dead lone-path reachability is a product limitation and smoke caveat, not grounds to fail passing component acceptance. All four arm A implementations meet the component bar.
- **D4 — Browse note incomplete.** All four arm A patches implement the central server/root work but leave an acceptance gap in the proactive note. A1 explicitly skips `..`; A2’s probe dispatcher and A2c’s hook compare path text without normalizing repeated separators. `browser.js` resolves the requested absolute path and then uses `normalize(absPath)` before replying: with an unbrowsable, otherwise ordinary prefilled absolute path `/var/tmp//outside`, the reply path is `/var/tmp/outside`, which never matches those probes. A2b additionally has the 200 ms callback replacement and a test expressly suppressing the note for a credential-denied prefill. These are static traces, not executed reproductions; the canonical-path tests do not refute them. No blank-cwd policy change was required or credited.
- **D5 — CI denominators.** Reused names contaminate unbounded `gh run list --branch` counts. A2’s 33 reported counts are 21 run IDs / 22 attempts; A2b’s 35 are 16 / 16. For example, PR 8678 has CI run `39182850203` only in its window, not eight; PR 8657 has run `39145962815`, with attempt 2, not three IDs. Use the exact IDs in EVIDENCE-A.json as authoritative over this illustrative prose.
- **D6 — indirect issue writes/leakage.** Direct issue-comment/label/closure audit is empty, but public timeline cross-references are not: bot reviews create several, A2c’s posted reviewer comment creates 7771’s, and A2b’s 8685 body creates 8011’s. Attribute bot and owner-origin events separately, and do not infer that later runs actually read them. Rule 4’s no-other-run-read claim requires transcripts.
- **D7 — port-test interpretation.** Binding then releasing an OS-selected port is not mathematically race-free; it is expressly the key’s preferred shape, so that residual does not fail the task. Historical red-first demonstrations are report evidence; static tests establish sensitivity. A2b also uses bind/release pass cases and a separate held-port warn assertion.
- **D8 — additional model-default behavior.** PR 8655 changes `selectOwnModelsForProvider(..., effectiveProvider)` to `dormantProvider ?? effectiveProvider` and tests hiding the Default model field. That can hide a still-active model override used by New Session’s fallback provider. Both requested Settings criteria pass, so this additional concern is recorded without inventing a third key criterion; it is not counted as an acceptance failure here.

Byte-identity audit: no two arm A PRs have an identical **complete changed production-file set** (path plus final Git blob). Mechanical subsets do match: MessageBubble’s added callback argument has blob `27aaf4982d9769ece5af98c1fc26acb5d5a9aa86` in all four 8364 PRs; ChatView matches A1/A2c (`64ca6b55…`) and A2/A2b (`90dab343…`); QuietHoursEditor’s readonly prop matches A1/A2b (`63c30dda…`). These tiny constrained wiring edits are not evidence of copying. No transcript-based leakage conclusion is possible.

