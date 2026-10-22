# Independent grading — controlled harness trial

Initial independent round; cross-review has not started. This file contains arm A first, then arm B, delivered in separate grading commits. No product fixes, test executions, mutations, CI reruns, issue writes or PR comments were made by this grading session.

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

## Arm B — controlled pair and interrupted runs

The controlled comparison is **B1-cx vs B2c-cy-codex**. B1’s observed sandbox/approval setting differs from the mission’s requested full-access setup; both completed runs used manual invocation fallbacks and reported sandbox escalations. B2b is a quota-exhaustion run with a separate Chroxy visibility failure; B2 is an auto-deploy interruption. Neither incomplete run substitutes for the controlled B2c cell. Incomplete runs are graded **only for merged PRs**: “not graded” below does not assert that their open code is incorrect.

[EVIDENCE-B.json](EVIDENCE-B.json) supplies immutable PR/run/timestamp records, manual review-body exclusions and the cross-run byte-identity audit. All rows inherit the evidence limitations and measurement definitions above. Every merged Arm B final head has a matching successful `ci.yml` run in the Actions records; the base-after-merge measure remains **not observable** throughout.

| Measure | B1-cx (CX) | B2c (CY, controlled) | B2b (CY, quota stop) | B2 (CY, auto-deploy stop) |
|---|---|---|---|---|
| Merged queue PRs | 9 | 10 | 4 | 0 |
| Strict key delivery / 10 | 8 | 9 | 4 | 0 |
| Merged partials | 1 | 1 | 0 | 0 |
| Already satisfied, no PR | 1 (reported blocked) | 0 | not counted | not counted |
| Wall to last report commit, minutes | 143.5 | 211.626 | n/a — no report | n/a — no report |
| Wall to report landing / stop, minutes | 158.017 | 223.243 | 121.423 to quota; 720.001 to cap | ~23.367 to SIGTERM |
| Queue CI IDs / attempts | 11 / 11 | 15 / 15 | 7 / 7 | 2 / 2 |
| CI IDs on merged PRs only | 10 | 10 | 5 | 0 |
| All PR workflow IDs (including relay/review) | 41 | 68 | 23 | 6 |
| Merged cycle median / p90, minutes | 30.92 / 42.30 | 14.78 / 16.97 | 28.34 / 90.87 | n/a |
| Cost | n/a | n/a | n/a | n/a |
| Compactions / coordinator restarts | 5 / 0 reported | 7 / 0 reported | at least 1 compaction; no complete audit | daemon restart; session restore failed |
| Human approvals | 0 reported; exact journal unavailable | 0 reported; exact journal unavailable | 0 reported; exact journal unavailable | 0 reported; exact journal unavailable |
| Red base CI | not observable | not observable | not observable | not observable |

B2c took **211.63 minutes** to its last report commit versus **143.50** for B1 (68.13 minutes longer), while its merged-PR median was **14.78** versus **30.92** minutes. B2c’s extra delivered item is the test-only 8282 coverage; B1 verified that feature at T0 and made no PR, so 9 versus 8 strict delivered items does not mean one extra product defect fixed. Waiving the literal dotted-branch restriction changes the delivery totals to **B1 9 and B2c 10**, without changing either implementation. There is **n = 1** per controlled cell, unequal setup/permission conditions, different review/smoke scope and later rerun ordering: these are observed contrasts, not a ranking or significance claim.

The reports’ queue cutoffs are `2026-10-18T20:55:44.226162Z` for B1 and `2026-10-19T22:45:44Z` for B2c; neither is the report-commit timestamp. B2b’s 12-hour administrative observation is not 12 hours of active execution. B2c’s owner-read weekly allowance fell from 100% left before the start to 50% after completion, with concurrent consumption unisolated; this is neither a dollar cost nor a measured run-only token total (D10).

### B1-cx

Final base [`3a521964`](https://github.com/blamechris/chroxy/commit/3a521964d131e876f972158da974056cdbb6e048). [Run report](https://github.com/blamechris/chroxy/blob/3a521964d131e876f972158da974056cdbb6e048/docs/reports/harness-evals/trial/runs/B1-cx/REPORT.md); last report commit [`bbef3fe4`](https://github.com/blamechris/chroxy/commit/bbef3fe4bd38f0b1d1a8760adf976f359298dbac) at `2026-10-18T20:56:11Z`.

| Issue | Outcome / correct vs key | Acceptance, tests and sensitivity |
|---|---|---|
| 8233 | merged [8666](https://github.com/blamechris/chroxy/pull/8666) / **yes** | P,P,P. `doctor.js` uses the shared merger; added `doctor-port.test.js` calls the real config reader and captures the actual socket argument for flag/env/file/default. The config/env cases fail with the old constant-port path. The fixture uses a different valid port, which is equivalent. |
| 8215 | merged [8668](https://github.com/blamechris/chroxy/pull/8668) / **partial** | P,P,P,**F**. Complete IPv6 validation plus `mappedV6ToV4` fixes both short forms; `bind-host.test.js` pins the four required inputs and expanded valid forms. It also replaces the dotted prefix branch, contrary to K4, as in arm A (D1). New negative cases fail the old prefix. |
| 7771 | merged [8662](https://github.com/blamechris/chroxy/pull/8662) / **yes** | P,P,R. Finite guard before mutation, active snapshots and absent/existing override refresh assertions in added `models.test.js` cases; obsolete overlay expectation changed. NaN would return true with the old guard. Red-first execution is reported, not replayed here. |
| 8595 | merged [8664](https://github.com/blamechris/chroxy/pull/8664) / **yes** | P,P. Indexed `unique[index]` supplies the original base; added cross-family test pins both exact labels, IDs, full IDs and source immutability. Old code repeats the pinned descriptor. Production file matches B2c byte-for-byte, tests differ (D11). |
| 8364 | merged [8669](https://github.com/blamechris/chroxy/pull/8669) / **yes** | P,P,R. Shared `ToolTerminationNote` supplies amber reason text in both components, forwarded through ChatView; `ToolTermination.test.tsx` tests reason variants, detail forwarding and normal controls. Removing the UI fails the new positives. Like ActivityGroup, termination is gated on a result/image being present; no new reason-only wire contract is assumed. The lone route remains unreachable in ordinary chat, which the sealed key does not require fixing (D3). |
| 8282 | blocked (reported; already satisfied) / **yes on T0** | P,P,P,P,R on T0; reported **blocked** because no scoped implementation delta was needed, not because behavior was missing. No PR/new tests. Baseline classifier, recorder, truncation and schema satisfy the feature; reported 245 tests and six scratch probes are unverified execution. Zero incremental merged delivery (D2). |
| 8277 | merged [8667](https://github.com/blamechris/chroxy/pull/8667) / **yes** | P,P,P. Selected disabled dormant provider and shared `SessionDefaultsNotice`/store dismissal; added Settings tests verify retention, available-provider recovery and both notice states. Model choices continue to use the usable fallback. Old Settings fails the new positives. |
| 8567 | merged [8670](https://github.com/blamechris/chroxy/pull/8670) / **yes** | P,P,R,P. One frozen protocol definition is re-exported by the server and app and imported by dashboard. A new dependency-free protocol subpath serves the server; source/dist agree. Added identity and exact default/override tests detect a consumer retaining an independent array; changed dashboard tests compare all selected values. Reported unilateral mutations remain execution-unverified. |
| 8303 | merged [8672](https://github.com/blamechris/chroxy/pull/8672) / **yes** | P,P,P,P,P,P. Shared resolved cwd policy retains credential/config boundaries and canonicalizes target/root/home natively. Added workspace/default/deny-list and startup-factory tests cover K1/K2/K4/K5; nonce-preserving schemas/store/handler plus hook and Browse tests cover normalized and stale replies for the prefill note. Blank Create semantics unchanged. Reverting policy or nonce propagation would fail distinct positive/negative tests; final patch repairs the arm-A normalization gap (D4/D9). |
| 7815 | merged [8663](https://github.com/blamechris/chroxy/pull/8663) / **yes** | P,P,R. Both literals become owned occupied listeners with warn assertions; a separate pass case redirects the actual bind to port zero and verifies the requested port/host. No release/rebind gap in the occupied tests. Changed tests detect an always-pass probe; old-literals red proof is reported (D7). |

| Issue / PR | Merge or attempt state | Copilot / owner review-disposition bodies | CI IDs / attempts (all workflows) | Cycle minutes |
|---|---|---|---|---|
| 8233 / [8666](https://github.com/blamechris/chroxy/pull/8666) | [`61c03c8e`](https://github.com/blamechris/chroxy/commit/61c03c8e5619ac94055549d13492f23282cd942d) | 1 / 1 | 1 / 1 (3) | 28.08 |
| 8215 / [8668](https://github.com/blamechris/chroxy/pull/8668) | [`38bea06f`](https://github.com/blamechris/chroxy/commit/38bea06f0e7b22d317beaf4380bb431758e452f2) | 1 / 1 | 1 / 1 (4) | 42.30 |
| 7771 / [8662](https://github.com/blamechris/chroxy/pull/8662) | [`7d992a43`](https://github.com/blamechris/chroxy/commit/7d992a43922c131b4fd849dfe52f9925e40ab291) | 1 / 2 | 1 / 1 (3) | 15.93 |
| 8595 / [8664](https://github.com/blamechris/chroxy/pull/8664) | [`e737889e`](https://github.com/blamechris/chroxy/commit/e737889ed97d5325587fcb4cb8f26fa7de070f9f) | 1 / 2 | 1 / 1 (4) | 33.08 |
| 8364 / [8669](https://github.com/blamechris/chroxy/pull/8669) | [`60abf9f7`](https://github.com/blamechris/chroxy/commit/60abf9f7939597f0ae0e8314f90a491a54e4132d) | 1 / 1 | 1 / 1 (4) | 29.13 |
| 8282 / none | no PR | 0 / 0 | 0 / 0 (0) | n/a |
| 8277 / [8667](https://github.com/blamechris/chroxy/pull/8667) | [`8f6a53ba`](https://github.com/blamechris/chroxy/commit/8f6a53bacbf8e1c4b5b4ad3015129e7c3289251d) | 1 / 1 | 1 / 1 (4) | 38.83 |
| 8567 / [8670](https://github.com/blamechris/chroxy/pull/8670) | [`d7d1edaf`](https://github.com/blamechris/chroxy/commit/d7d1edaf90fd04a533c75e60d2ea50f436e251d8) | 1 / 1 | 1 / 1 (4) | 31.50 |
| 8303 / [8671](https://github.com/blamechris/chroxy/pull/8671) | closed; unmerged | 1 / 2 | 1 / 1 (5) | n/a |
| 8303 / [8672](https://github.com/blamechris/chroxy/pull/8672) | [`9865eb62`](https://github.com/blamechris/chroxy/commit/9865eb624293725ef1f6d725430cda3622010234) | 1 / 3 | 2 / 2 (7) | 30.92 |
| 7815 / [8663](https://github.com/blamechris/chroxy/pull/8663) | [`9a6661ff`](https://github.com/blamechris/chroxy/commit/9a6661ff6baae122e8d1da0ccee50b41ae917a88) | 1 / 2 | 1 / 1 (3) | 20.17 |

The desktop run recovered from automatic approval rejections and five compactions without reported human intervention or a restart. Browse’s first PR 8671 failed Windows CI and closed unmerged; retry 8672 fixed native path spelling, then real smoke exposed a separate Browse reply-correlation gap that was also fixed before final CI passed. The report keeps four reproduced T0 suite failures and an additional readiness leak separate from passing hosted CI; it also admits unnecessarily stopping a nonoverlapping suite. No >90-minute stall is reported or visible in the queue activity. These are report-backed execution observations; raw local logs/smoke are unavailable.

Review-body counts include final gate summaries on 8662/8663/8664, the close/disposition on 8671 and the justification for a delta on 8672. They are not counts of fresh independent reviewers: for example 8672 has two approval bodies plus a review-justification body. B1’s report lists ancillary Relay run IDs alongside CI; the standardized count is 11 `ci.yml` IDs including the failed attempt, or 41 total PR-triggered workflows, rather than treating every listed workflow as CI (D5/D9).

Isolation: queue PR bodies use bare `Trial-Closes`, authored titles/squash subjects contain no queue numbers, and original queue-PR commit messages contain no issue references. No direct queue comments/labels/closures or new issues occur in-window. Copilot’s PR 8668 review creates a timeline cross-reference on 8215, separately attributable to the service. The report also records another trial’s process command line being incidentally exposed, startup reads before mission completion, and no deliberate other-trial/key/seed/brief reads. The latter and its zero-human-approval total cannot be independently certified without transcripts/journal. The byte match on 8595 is discussed in D11.

### B2c-cy-codex

Final base [`c612f842`](https://github.com/blamechris/chroxy/commit/c612f8422054102db22316d75584eaa631eb8c09). [Run report](https://github.com/blamechris/chroxy/blob/c612f8422054102db22316d75584eaa631eb8c09/docs/reports/harness-evals/trial/runs/B2c-cy-codex/REPORT.md); last report commit [`8bf88eae`](https://github.com/blamechris/chroxy/commit/8bf88eae66cbcbb7906ebeda4745700f53c6fda3) at `2026-10-19T22:49:38Z`.

| Issue | Outcome / correct vs key | Acceptance, tests and sensitivity |
|---|---|---|
| 8233 | merged [8719](https://github.com/blamechris/chroxy/pull/8719) / **yes** | P,P,P. Shared flag/env/file/default merge plus explicit invalid-port diagnostic. Added real CLI subprocess tests hold chosen ports and inspect their reported numbers, including flag-over-env-over-file. Old code fails configured/env cases. A different valid fixture port from the key is equivalent. |
| 8215 | merged [8720](https://github.com/blamechris/chroxy/pull/8720) / **partial** | P,P,P,**F**. `isIPv6` plus full mapped-hextet regex rejects the two short inputs and tests retain both required positives. The validator also changes malformed dotted input behavior contrary to K4 (D1). New negatives fail the original prefix. |
| 7771 | merged [8716](https://github.com/blamechris/chroxy/pull/8716) / **yes** | P,P,R. Finite guard plus factory tests for NaN/±Infinity, absent/existing overrides, refresh and a valid fractional control; overlay expectation corrected. Old guard returns true and mutates state. Historical RED/GREEN is report evidence. |
| 8595 | merged [8714](https://github.com/blamechris/chroxy/pull/8714) / **yes** | P,P. Original index-aligned base; added test puts a duplicate alias between the two unique targets and pins exact labels/IDs/full IDs/immutability. Old fallback fails. Complete changed production set matches B1, while tests differ (D11). |
| 8364 | merged [8723](https://github.com/blamechris/chroxy/pull/8723) / **yes** | P,P,R. Both components show shared amber termination guidance, and reason-only input also stops the pulse. Added component/ChatView tests pin forwarding and normal/error/group behavior. The run additionally routes singleton activity through ToolBubble and repairs its input preview, targets and four Maestro flows; that extra scope and retry cost earns no extra key point (D3/D9). |
| 8282 | merged [8721](https://github.com/blamechris/chroxy/pull/8721) / **yes** | P,P,P,P,R. Test-only `session-message-history-replay-parity.test.js` adds opaque start-only thinking, >50 KiB real serialization/disk/restore/replay and a pre-kind state file; baseline schema covers optional kind. Production already satisfied the key. Removing recorder retention fails direct kind assertions (D2). |
| 8277 | merged [8717](https://github.com/blamechris/chroxy/pull/8717) / **yes** | P,P,P. Dormant disabled selected option/hint, preserved fallback model roster and shared store-backed `SessionDefaultsNotice`. Added test mounts Settings and New Session together and dismisses both through one action; old UI fails the new assertions. |
| 8567 | merged [8722](https://github.com/blamechris/chroxy/pull/8722) / **yes** | P,P,**unverified**,P. Shared frozen protocol export consumed by server and both clients; source/dist agree. Added server/app identity guards detect restored literals; dashboard test supplies an alternate mocked shared default and asserts empty overrides remain empty. This proves consumption beyond a same-subject equality. The available PR records identity RED/GREEN and a freeze mutation, but do not document the exact one-place category-addition mutation; its sensitivity follows statically (D12). |
| 8303 | merged [8725](https://github.com/blamechris/chroxy/pull/8725) / **yes** | P,P,P,P,P,P. Shared canonical policy, native root/home/target spelling, explicit credential/config denial and startup diagnostic are implemented and tested. Optional request IDs survive the schema/store/handler round trip; exact-cwd probes show denied/pending/unknown states, suspend for Browse and ignore stale replies. Added policy, alias, hook, modal and real store-correlation tests fail without corresponding changes. Blank Create remains unchanged. Bound-client refusal is additional scope; no key penalty (D4/D9). |
| 7815 | merged [8718](https://github.com/blamechris/chroxy/pull/8718) / **yes** | P,P,R. Both literals replaced by owned ephemeral listeners held through the checks; each asserts warn, with aggregate pass/fail semantics retained. No new free-port pass case was added. This meets the allowed nonpreferred alternative because warning coverage is explicit; it is not a pass/warn assertion deletion (D7). Historical bound-old-port red is reported. |

| Issue / PR | Merge or attempt state | Copilot / owner review-disposition bodies | CI IDs / attempts (all workflows) | Cycle minutes |
|---|---|---|---|---|
| 8233 / [8719](https://github.com/blamechris/chroxy/pull/8719) | [`cd203db4`](https://github.com/blamechris/chroxy/commit/cd203db4c04df3357285373ee62508e85d00aebb) | 1 / 2 | 1 / 1 (5) | 10.68 |
| 8215 / [8720](https://github.com/blamechris/chroxy/pull/8720) | [`a8aed1cf`](https://github.com/blamechris/chroxy/commit/a8aed1cfc747ab681ab3a94414d2bfc82abf3c40) | 1 / 2 | 1 / 1 (5) | 21.75 |
| 7771 / [8716](https://github.com/blamechris/chroxy/pull/8716) | [`227965ce`](https://github.com/blamechris/chroxy/commit/227965ceb4f6c4eac511431284e9a780ccc0051e) | 1 / 2 | 1 / 1 (5) | 16.97 |
| 8595 / [8714](https://github.com/blamechris/chroxy/pull/8714) | [`cbc6c2c5`](https://github.com/blamechris/chroxy/commit/cbc6c2c5b295de11476d92d02393c857c31af222) | 1 / 2 | 1 / 1 (6) | 16.30 |
| 8364 / [8715](https://github.com/blamechris/chroxy/pull/8715) | closed; unmerged | 1 / 3 | 3 / 3 (13) | n/a |
| 8364 / [8723](https://github.com/blamechris/chroxy/pull/8723) | [`869fb60c`](https://github.com/blamechris/chroxy/commit/869fb60c7be8f5a3871e284f5b87060f2e8c2911) | 1 / 2 | 1 / 1 (5) | 12.85 |
| 8282 / [8721](https://github.com/blamechris/chroxy/pull/8721) | [`8e90c68d`](https://github.com/blamechris/chroxy/commit/8e90c68ddb7b7cc22159ef01a6f550ad7a5813a8) | 1 / 2 | 1 / 1 (3) | 9.78 |
| 8277 / [8717](https://github.com/blamechris/chroxy/pull/8717) | [`73a6c85e`](https://github.com/blamechris/chroxy/commit/73a6c85e76357116dcb6c8eea21a23b936582c04) | 1 / 2 | 1 / 1 (6) | 14.93 |
| 8567 / [8722](https://github.com/blamechris/chroxy/pull/8722) | [`f42cfc55`](https://github.com/blamechris/chroxy/commit/f42cfc5547268edc37bb4c7b3a900a82971941a0) | 1 / 2 | 1 / 1 (4) | 15.87 |
| 8303 / [8724](https://github.com/blamechris/chroxy/pull/8724) | closed; unmerged | 1 / 3 | 2 / 2 (8) | n/a |
| 8303 / [8725](https://github.com/blamechris/chroxy/pull/8725) | [`6c369095`](https://github.com/blamechris/chroxy/commit/6c369095b254b2304e0568fc02a67210feaa90f2) | 1 / 2 | 1 / 1 (3) | 13.45 |
| 7815 / [8718](https://github.com/blamechris/chroxy/pull/8718) | [`cebafe9d`](https://github.com/blamechris/chroxy/commit/cebafe9d56c1b632ee6a699d1fadfea79cca322c) | 1 / 2 | 1 / 1 (5) | 14.63 |

Chroxy completed all ten merges through three bounded waves and seven compactions, with no reported restart or rate-limit stall. It spent additional work making the singleton mobile route reachable, preserving ordinary errors/input previews and repairing Maestro selectors; first attempt 8715 closed after 84.52 minutes, then final 8723 opened much later in the work. Browse similarly closed 8724 after 33.97 minutes of Windows failures and completed as 8725; the final-PR cycle alone hides that earlier work. Local full-server failures/timeouts remain failures despite isolated passes and final green hosted CI. No >90-minute activity stall appears in the public attempt sequence.

The owner README reports 26 final check runs for 8725 (25 green plus one conditional skip), versus the report’s 24 + 1; those are job/check contexts, not the 15 workflow runs counted here. Sandbox retries, an omitted outbound requestId, native-path differences, missing dependencies and device setup caused recoverable work. The blue sidebar dot in an early owner screenshot raises a possible recurrence of false idle but does **not** prove a frozen chat for this run; the later daemon notification audit is unavailable. Isolated smoke invoked Haiku within this run, so reported worker setup is not proof of single-vendor quota consumption (D10).

Isolation: all queue bodies use bare markers and no closing keyword; the sole numeric body reference, 8723→8715, names its own earlier PR. Titles/original commit messages have no queue issue references; squash subjects have only their own permitted PR suffix. There are no direct queue comment/label/closure events or new issues in-window. Copilot reviews create cross-references 8716→7771, 8720→8215 and 8722→8567. Reported UI/process exposure of other session names, a private preview credential incident and imperfect mission-read ordering are retained as incidents; no credential value is reproduced. No clean forbidden-read or zero-approval certificate is possible without the missing journal/transcripts.

### B2b-cy-codex

Final base [`6762573b`](https://github.com/blamechris/chroxy/commit/6762573ba52c59805e4a903f8cde41a8c3eaef49). No run report. Stop/setup evidence comes from the [owner’s README record](https://github.com/blamechris/chroxy/blob/f48cda8d5fa5838c50fee2810cf7e598dd366e63/docs/reports/harness-evals/trial/README.md) and linked public PR records; raw daemon/transcript evidence is not attached.

| Issue | Outcome / correct vs key | Acceptance, tests and sensitivity |
|---|---|---|
| 8233 | blocked/open [8696](https://github.com/blamechris/chroxy/pull/8696) / **not graded** | No merged trial change; acceptance/tests/sensitivity not graded under the merged-only instruction. Checks completed after quota exhaustion; green/open is not merged delivery. |
| 8215 | untouched / **not graded** | No merged trial change; acceptance/tests/sensitivity not graded under the merged-only instruction. |
| 7771 | merged [8695](https://github.com/blamechris/chroxy/pull/8695) / **yes** | P,P,R. Finite guard, added factory rejection/refresh/valid-update tests and changed overlay/cache assertions; old guard returns true. PR evidence reports red against the old guard, with raw execution unverified. |
| 8595 | merged [8692](https://github.com/blamechris/chroxy/pull/8692) / **yes** | P,P. Indexed original base; added cross-family/alias test asserts exact labels, IDs/full IDs and unchanged source labels. Old fallback repeats the descriptor. |
| 8364 | blocked/open [8693](https://github.com/blamechris/chroxy/pull/8693) / **not graded** | No merged trial change; acceptance/tests/sensitivity not graded under the merged-only instruction. Draft remains; reported smoke item could not be checked. |
| 8282 | untouched / **not graded** | No merged trial change; acceptance/tests/sensitivity not graded under the merged-only instruction. The common T0 implementation is already satisfied as established in D2; no delivery credited here. |
| 8277 | merged [8694](https://github.com/blamechris/chroxy/pull/8694) / **yes** | P,P,P. Dormant selected option/hint and shared notice/dismissal; added/changed Settings tests cover both. The corrective change hides the model picker for dormant providers, the same additional behavior concern as A2 (D8), without failing the two requested criteria. |
| 8567 | untouched / **not graded** | No merged trial change; acceptance/tests/sensitivity not graded under the merged-only instruction. |
| 8303 | untouched / **not graded** | No merged trial change; acceptance/tests/sensitivity not graded under the merged-only instruction. |
| 7815 | merged [8691](https://github.com/blamechris/chroxy/pull/8691) / **yes** | P,P,R. Both sites hold owned OS-assigned listeners and assert warn, with explicit aggregate status assertion. No new free-port pass case; same nonpreferred permitted interpretation as B2c (D7). PR records original held-port red proof; tests are sensitive to incorrect warn behavior. |

| Issue / PR | Merge or attempt state | Copilot / owner review-disposition bodies | CI IDs / attempts (all workflows) | Cycle minutes |
|---|---|---|---|---|
| 8233 / [8696](https://github.com/blamechris/chroxy/pull/8696) | open; unmerged | 1 / 1 | 1 / 1 (3) | n/a |
| 8215 / none | no PR | 0 / 0 | 0 / 0 (0) | n/a |
| 7771 / [8695](https://github.com/blamechris/chroxy/pull/8695) | [`6762573b`](https://github.com/blamechris/chroxy/commit/6762573ba52c59805e4a903f8cde41a8c3eaef49) | 1 / 2 | 1 / 1 (3) | 14.00 |
| 8595 / [8692](https://github.com/blamechris/chroxy/pull/8692) | [`ddd52bc2`](https://github.com/blamechris/chroxy/commit/ddd52bc28964c4771b43dd9d448b8ca34e42e544) | 1 / 2 | 1 / 1 (3) | 13.27 |
| 8364 / [8693](https://github.com/blamechris/chroxy/pull/8693) | open; unmerged | 1 / 1 | 1 / 1 (5) | n/a |
| 8282 / none | no PR | 0 / 0 | 0 / 0 (0) | n/a |
| 8277 / [8694](https://github.com/blamechris/chroxy/pull/8694) | [`536c826b`](https://github.com/blamechris/chroxy/commit/536c826b5317644b49554baf0cb0da631a0e7e31) | 1 / 3 | 2 / 2 (5) | 42.68 |
| 8567 / none | no PR | 0 / 0 | 0 / 0 (0) | n/a |
| 8303 / none | no PR | 0 / 0 | 0 / 0 (0) | n/a |
| 7815 / [8691](https://github.com/blamechris/chroxy/pull/8691) | [`b475ff31`](https://github.com/blamechris/chroxy/commit/b475ff3104dff8e013be65578a6a8cdc3b565424) | 1 / 2 | 1 / 1 (4) | 90.87 |

Four merged changes meet the key; open 8693 and 8696 are not delivery, even though 8696 later had green checks. The owner’s post-cap diagnosis records a quota stop at `2026-10-19T06:16:45.324Z`, after about 121.42 minutes; the daemon had already marked the turn complete at 04:26:37 and stopped forwarding later work/errors, leaving the dashboard idle. Thus the failure has two components: shared-plan exhaustion and a Chroxy visibility/termination defect, not an unexplained twelve-hour reasoning stall. The long quiet tail through the 16:15:20 cap exceeds the protocol’s 90-minute threshold; active execution and administrative observation must not be conflated. No run report exists, so further compaction/restart counts, forbidden reads and exact approval events are unverified.

Isolation: the six PR bodies have bare markers, no forbidden closing keyword or issue reference; titles/original commit messages are clean, squash subjects carry only their own PR suffix. Queue timelines contain no direct comments/labels/closures or cross-references during this run window, and the new-issue audit finds none. Owner reports no human approvals. Smoke-only comments 6259875724, 6260013192 and 6260303581 are excluded from review-body counts despite mentioning review prerequisites: 8692 has two review/disposition bodies and 8694 has three, not three and five independent rounds. PR 8694’s model-field hiding is retained as D8, while the requested dormant-option/notice checks pass.

### B2-cy-codex

Final base [`932bd3a4`](https://github.com/blamechris/chroxy/commit/932bd3a4ef40bc9634cab390e6cf0facadd801d7). No run report. Stop/setup evidence comes from the [owner’s README record](https://github.com/blamechris/chroxy/blob/f48cda8d5fa5838c50fee2810cf7e598dd366e63/docs/reports/harness-evals/trial/README.md) and linked public PR records; raw daemon/transcript evidence is not attached.

| Issue | Outcome / correct vs key | Acceptance, tests and sensitivity |
|---|---|---|
| 8233 | untouched / **not graded** | No merged trial change; acceptance/tests/sensitivity not graded under the merged-only instruction. |
| 8215 | untouched / **not graded** | No merged trial change; acceptance/tests/sensitivity not graded under the merged-only instruction. |
| 7771 | blocked/open [8645](https://github.com/blamechris/chroxy/pull/8645) / **not graded** | No merged trial change; acceptance/tests/sensitivity not graded under the merged-only instruction. |
| 8595 | blocked/open [8646](https://github.com/blamechris/chroxy/pull/8646) / **not graded** | No merged trial change; acceptance/tests/sensitivity not graded under the merged-only instruction. |
| 8364 | untouched / **not graded** | No merged trial change; acceptance/tests/sensitivity not graded under the merged-only instruction. |
| 8282 | untouched / **not graded** | No merged trial change; acceptance/tests/sensitivity not graded under the merged-only instruction. The common T0 implementation is already satisfied as established in D2; no delivery credited here. |
| 8277 | untouched / **not graded** | No merged trial change; acceptance/tests/sensitivity not graded under the merged-only instruction. |
| 8567 | untouched / **not graded** | No merged trial change; acceptance/tests/sensitivity not graded under the merged-only instruction. |
| 8303 | untouched / **not graded** | No merged trial change; acceptance/tests/sensitivity not graded under the merged-only instruction. |
| 7815 | untouched / **not graded** | No merged trial change; acceptance/tests/sensitivity not graded under the merged-only instruction. |

| Issue / PR | Merge or attempt state | Copilot / owner review-disposition bodies | CI IDs / attempts (all workflows) | Cycle minutes |
|---|---|---|---|---|
| 8233 / none | no PR | 0 / 0 | 0 / 0 (0) | n/a |
| 8215 / none | no PR | 0 / 0 | 0 / 0 (0) | n/a |
| 7771 / [8645](https://github.com/blamechris/chroxy/pull/8645) | open; unmerged | 1 / 1 | 1 / 1 (3) | n/a |
| 8595 / [8646](https://github.com/blamechris/chroxy/pull/8646) | open; unmerged | 0 / 0 | 1 / 1 (3) | n/a |
| 8364 / none | no PR | 0 / 0 | 0 / 0 (0) | n/a |
| 8282 / none | no PR | 0 / 0 | 0 / 0 (0) | n/a |
| 8277 / none | no PR | 0 / 0 | 0 / 0 (0) | n/a |
| 8567 / none | no PR | 0 / 0 | 0 / 0 (0) | n/a |
| 8303 / none | no PR | 0 / 0 | 0 / 0 (0) | n/a |
| 7815 / none | no PR | 0 / 0 | 0 / 0 (0) | n/a |

This run delivered zero merged items before the daemon’s auto-deploy sent SIGTERM at 07:52:22, about 23.37 minutes after the approximate 07:29 start. The owner record says the daemon incorrectly judged an active session idle, restarted and could not restore it because its native locator was missing. Two green/open PRs do not compensate for this harness interruption; no report or independent local telemetry is available. This is a terminated run, not a >90-minute stall or a demonstrated task-correctness failure.

Isolation: both PRs use bare markers and no closing keyword/title/commit issue references; neither was merged. Copilot’s 8645 review cross-referenced 7771 within the window. Copilot’s 8646 body arrived after the SIGTERM cutoff, so its run-window count is zero, not “never reviewed.” No direct queue comments/labels/closures or new issues occur in-window. Human approvals are zero per the owner record, with journal verification unavailable; other-trial/key/seed/brief reads remain unverified. Unmerged solutions are deliberately excluded from both correctness and byte-identity grading.

### Arm B findings expected to need cross-review

- **D1 extends to 8668 and 8720.** Both satisfy the stated bad/good loopback examples but reject malformed dotted inputs the old branch accepted. Apply the same literal-key `partial` as arm A, with the alternate delivery count shown. No safety failure is alleged.
- **D2/D3 — asymmetric extra work is not asymmetric acceptance.** B1’s already-satisfied 8282 is a zero-delivery no-change outcome, whereas B2c’s test-only PR counts as a merged correct item. B2c additionally activates the singleton tool path; B1 and arm A do not fail the key for leaving that path dormant. Historical red/mutation/replay execution is reported, not independently replayed.
- **D4 — Arm B Browse differs from Arm A.** Final 8672 and 8725 carry request IDs through client schema, server reply, shared parser and UI. Their normalized-path/stale-reply tests directly address the Arm A gap, so both receive `yes`. A home-only blank listing request on 8725 does not fail the separate requirement that an explicitly requested, policy-allowed configured cwd is browsable; blank Create policy was explicitly deferred.
- **D7 — owned warning cases.** B2c 8718 and B2b 8691 retain deterministic warn assertions at both formerly literal sites but add no free-port pass case. I accept this under the key’s nonpreferred alternative: ambient dependency is removed and warn coverage is explicit. B1 8663 additionally has a socket-boundary pass control. A reviewer may prefer two real bind directions; the key labels that design preferred, not mandatory.
- **D8 extends to 8694.** Hiding the entire model field for a dormant provider can hide a still-active fallback model override. As with A2 8655, the requested provider/notice behavior passes; this additional concern is not converted into an invented key criterion.
- **D9 — attempts, reviews and timing denominators.** Include failed/closed queue attempts in CI counts; exclude them from merged-cycle median/p90 but retain their elapsed work in wall time. B1: 11 CI IDs/41 all workflows; B2c: 15/68; B2b: 7/23; B2: 2/6. Review/disposition bodies include coordinator gates, close notes and justifications, never an inferred number of hidden worker rounds. Smoke-only bodies are excluded. Report-commit times differ from queue cutoff and report merge; interrupted runs have no comparable report endpoint.
- **D10 — stop/cost/visibility attribution.** B2b’s underlying quota stop is distinct from Chroxy’s early false-idle/unsurfaced error. B2 was actively killed by auto-deploy and failed restoration. B2c’s early blue dot is only a possible visibility issue; no later daemon audit was attached. Weekly allowance readings are conditional owner observations, not exact run cost; cross-vendor smoke calls further limit attribution. No zero human approval or forbidden-read claim is independently verified without the journal/transcripts.
- **D11 — byte identity without a copying inference.** 8664 and 8714 produce the exact same changed production file, `model-display.ts` blob `43cf1d8ec9c65153b8de8db114013a5006d97849`; both independently express the same two-line indexed fallback, but their tests differ. No merged PR pair across all eight runs has an identical complete changed-file set including tests. Shared mechanical blobs also occur for `MessageBubble.tsx` (all six completed implementations), `QuietHoursEditor.tsx` and the one-line `ws-server.js` nonce roster. These constrained edits do not establish forbidden reading; the audit records the matches instead of certifying absence of leakage.

- **D12 — historical execution versus static sensitivity.** No grader tests or mutations were run. A `yes` certifies the inspected implementation and test sensitivity, with historical execution separately reported or unverified. In particular, 8722 documents identity RED/GREEN and a freeze mutation, not the exact category-addition mutant requested by the key; its added identity/default-consumption tests are statically sensitive to unilateral drift. Missing raw proof is not silently represented as an observed red run. A stricter proof-only scoring convention would need to be applied across all cells, whose raw mutation logs are likewise unattached.

Initial independent grading is complete. No other grader output was read and no cross-review reply has been attempted. The separate mailbox lists the anticipated disputes for the later round; owner tiebreaks remain pending that round rather than being silently incorporated here.
