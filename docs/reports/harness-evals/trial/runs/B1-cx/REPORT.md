# B1-cx trial report

9 of the ten fixed queue items have verified merges into trial/b1-cx; 1 flagged blocked and 0 pending. The fixed queue is settled; reporting delivery is tracked separately below.

## Run identity and limits

| Field | Observation |
|---|---|
| Run | B1-cx |
| Session | 01a15049-21c7-7152-b85e-797294237501 |
| Mode | PRIME fixed trial |
| Start UTC | 2026-10-18T18:32:41.649Z (conservative cap anchor before first command) |
| End UTC | 2026-10-18T20:55:44.226162Z (fixed-queue execution cutoff; report landing follows) |
| Harness | Codex desktop app; native host |
| Coordinator model / effort | gpt-6-astra / xhigh; observed session turn metadata |
| Worker models / effort | gpt-6.1-sol / high |
| Harness version | 26.1013.40934; build 20770; prod channel |
| Runtime versions | Codex CLI 0.163.0; Node 22.23.2; Chroxy daemon version not applicable to native desktop host |
| Invocation | User supplied expanded prime directive; manual read of exact checkout compiled skill and user-global Codex prompt; native discovery not verified |
| Permission mode | Requested unattended full access; observed workspace-write/on-request, network disabled, automatic approval reviewer |
| Human approvals | 0 observed; automatic review rejections counted separately |
| Base / T0 | trial/b1-cx / 932bd3a4ef40bc9634cab390e6cf0facadd801d7 |
| Wall-clock cap UTC | 2026-10-19T06:32:41.649Z |
| Retry limits | Wave 2 of 3; 2 corrections per item per wave; counters cumulative |
| Compactions / restarts | 5 compactions; 0 session restarts |
| SDK-reported total_cost_usd | n/a; no harness-exposed session total; API-rate equivalent is not a subscription charge |

## Queue results

| Issue | PR | Opened UTC | Merged UTC | CI runs | Review rounds | Merge SHA | Status |
|---|---|---|---|---|---|---|---|
| 8233 | [8666](https://github.com/blamechris/chroxy/pull/8666) | 2026-10-18T19:09:40Z | 2026-10-18T19:37:45Z | [39157482542](https://github.com/blamechris/chroxy/actions/runs/39157482542), [39157482652](https://github.com/blamechris/chroxy/actions/runs/39157482652) | 1 independent round | 61c03c8e5619ac94055549d13492f23282cd942d | merged |
| 8215 | [8668](https://github.com/blamechris/chroxy/pull/8668) | 2026-10-18T19:20:55Z | 2026-10-18T20:03:13Z | [39158355983](https://github.com/blamechris/chroxy/actions/runs/39158355983), [39158356016](https://github.com/blamechris/chroxy/actions/runs/39158356016), [39158621736](https://github.com/blamechris/chroxy/actions/runs/39158621736) | Initial Codex pass + 1 independent round | 38bea06f0e7b22d317beaf4380bb431758e452f2 | merged |
| 7771 | [8662](https://github.com/blamechris/chroxy/pull/8662) | 2026-10-18T18:46:52Z | 2026-10-18T19:02:48Z | [39155732566](https://github.com/blamechris/chroxy/actions/runs/39155732566), [39155732592](https://github.com/blamechris/chroxy/actions/runs/39155732592) | 1 independent round + fresh correction delta | 7d992a43922c131b4fd849dfe52f9925e40ab291 | merged |
| 8595 | [8664](https://github.com/blamechris/chroxy/pull/8664) | 2026-10-18T19:00:20Z | 2026-10-18T19:33:25Z | [39156746630](https://github.com/blamechris/chroxy/actions/runs/39156746630), [39156746739](https://github.com/blamechris/chroxy/actions/runs/39156746739), [39156830692](https://github.com/blamechris/chroxy/actions/runs/39156830692) | 1 independent round | e737889ed97d5325587fcb4cb8f26fa7de070f9f | merged |
| 8364 | [8669](https://github.com/blamechris/chroxy/pull/8669) | 2026-10-18T19:22:01Z | 2026-10-18T19:51:09Z | [39158439668](https://github.com/blamechris/chroxy/actions/runs/39158439668), [39158439686](https://github.com/blamechris/chroxy/actions/runs/39158439686) | 1 independent round | 60abf9f7939597f0ae0e8314f90a491a54e4132d | merged |
| 8282 | — | — | — | — | Read-only acceptance audit | — | blocked: acceptance already fulfilled at T0; no new scoped delta or trial merge |
| 8277 | [8667](https://github.com/blamechris/chroxy/pull/8667) | 2026-10-18T19:11:15Z | 2026-10-18T19:50:05Z | [39157604787](https://github.com/blamechris/chroxy/actions/runs/39157604787), [39157604831](https://github.com/blamechris/chroxy/actions/runs/39157604831), [39157799072](https://github.com/blamechris/chroxy/actions/runs/39157799072) | 1 independent round | 8f6a53bacbf8e1c4b5b4ad3015129e7c3289251d | merged |
| 8567 | [8670](https://github.com/blamechris/chroxy/pull/8670) | 2026-10-18T19:36:04Z | 2026-10-18T20:07:34Z | [39159512713](https://github.com/blamechris/chroxy/actions/runs/39159512713), [39159512720](https://github.com/blamechris/chroxy/actions/runs/39159512720), [39159538439](https://github.com/blamechris/chroxy/actions/runs/39159538439) | 1 independent round | d7d1edaf90fd04a533c75e60d2ea50f436e251d8 | merged |
| 8303 | [8672](https://github.com/blamechris/chroxy/pull/8672) | 2026-10-18T20:24:31Z | 2026-10-18T20:55:26Z | [39163162882](https://github.com/blamechris/chroxy/actions/runs/39163162882), [39163162936](https://github.com/blamechris/chroxy/actions/runs/39163162936), [39163384710](https://github.com/blamechris/chroxy/actions/runs/39163384710), [39164666016](https://github.com/blamechris/chroxy/actions/runs/39164666016), [39164666066](https://github.com/blamechris/chroxy/actions/runs/39164666066), [39164667574](https://github.com/blamechris/chroxy/actions/runs/39164667574) | Wave 1: initial Codex + one delta; independent full + fresh contract delta. Wave 2: fresh full round2 + justified fresh final delta approved. | 9865eb624293725ef1f6d725430cda3622010234 | merged |
| 7815 | [8663](https://github.com/blamechris/chroxy/pull/8663) | 2026-10-18T18:54:48Z | 2026-10-18T19:14:58Z | [39156336050](https://github.com/blamechris/chroxy/actions/runs/39156336050), [39156336052](https://github.com/blamechris/chroxy/actions/runs/39156336052) | 1 independent round | 9a6661ff6baae122e8d1da0ccee50b41ae917a88 | merged |

## Final report landing

This report is delivered by its containing PR against trial/b1-cx. GitHub records that PR’s final review, checks, merge timestamp and merge SHA. The end timestamp above is the fixed-queue execution cutoff, before report preparation and landing; this committed report does not predict its own merge.

## Gate evidence by item

| Issue | Reviewed head | Final-head CI | Review / disposition | Attempts / corrections |
|---|---|---|---|---|
| 8233 | 9cad6c378b34956744fc35fb40c78b9200197560 | 24 successful; 1 conditional skips | Independent review approved with 15 focused tests; Copilot clear.; Recorded final-review disposition | 1 / 0 |
| 8215 | e1750e75e1d0f753df9e3b2cbbce32b4a6364471 | 25 successful; 1 conditional skips | Initial read-only pass and independent review approved; 120 focused tests and 589,834 classification assertions passed; Copilot clear.; Recorded final-review disposition | 1 / 0 |
| 7771 | f7afa78d90844c853130d73f7cd962617b5cc169 | 24 successful; 1 conditional skips | Independent review and fresh corrective delta approved; Copilot reported no open issues.; Recorded final-review disposition | 1 / 1 |
| 8595 | 6c041dc8cb82114b347e65426dff9da8f92fc15e | 25 successful; 1 conditional skips | Independent review approved with 20 focused tests; optional literal-label overlap recorded as nonblocking; Copilot clear.; Recorded final-review disposition | 1 / 0 |
| 8364 | 899fdd9d4c6a41e6a26c544ab51778773cfecca5 | 22 successful; 3 conditional skips | Independent review approved with 68 focused tests; actual-component native smoke limits explicit; Copilot clear.; Recorded final-review disposition | 1 / 0 |
| 8282 | — | Not applicable: acceptance audit only, no PR | Read-only acceptance audit: 245 focused tests and six scratch probes; expected red mutation; No delivery PR or review threads | 1 / 0 |
| 8277 | f6460c2646188ff5e88877721e37baae5aefb0ba | 24 successful; 2 conditional skips | Independent review approved with 212 focused tests; Copilot clear.; Recorded final-review disposition | 1 / 0 |
| 8567 | d523c0c2da8937fdc826d38ded5f84f788b8d23a | 25 successful; 1 conditional skips | Independent review approved with 69 focused tests and complete native/dashboard control-state evidence; Copilot clear.; Recorded final-review disposition | 1 / 0 |
| 8303 | af8c588c008a89dc95d3b22da9045121f817d875 | 25 successful; 1 conditional skips | Full round 2 APPROVE at 088abed: all 26 files, 342 server and 59 dashboard tests, plus denied Create probe. Fresh final delta APPROVE at af8c588: 188 tests and both TEMP branches. Copilot found no objective defect; all applicable final-head CI passed, including Windows. Zero unresolved threads; synchronous squash merge verified.; Recorded final-review disposition | 2 / 4 total (2 in wave 2) |
| 7815 | d7d73ce84140ce949623872011abc414f865cc4f | 24 successful; 1 conditional skips | Independent review approved deterministic held/free-port cases; Copilot reported no open issues.; Recorded final-review disposition | 1 / 0 |

## Verification and delivery

- Initial freshly fetched fleet comparison passed for all classified rules and the full instruction load.
- Only the authorized trial base and main were fetched. The trial base had no existing PRs.
- All ten assigned issue bodies were read; none had comments. No issues were changed.
- Two selected items predate the wave by at least 30 days: 7771 and 7815; both were taken first and merged.
- Package suites, stable-head review, final-head CI, conversation resolution and required isolated smoke are delivery gates; only matching final-head evidence supports a pass.
- No production installation is authorized. Verified trial merges are effective on the trial branch only.

## Earlier attempts

| Issue | Wave | PR | Opened UTC | Closed UTC | Unmerged head | CI runs | Corrections consumed | Outcome |
|---|---|---|---|---|---|---|---|---|
| 8303 | 1 | [8671](https://github.com/blamechris/chroxy/pull/8671) | 2026-10-18T19:44:45Z | 2026-10-18T20:04:15Z | 503f5beed4db53b643694dcb95f46db1c9ebb6a9 | 39160160125, 39160160145, 39160185645, 39161618815 | 2 | retry; Windows CI six allowed-path failures |

## T0 acceptance audit

Item 8282 is flagged blocked for trial delivery because its scoped acceptance is already present at T0 (932bd3a4ef40bc9634cab390e6cf0facadd801d7), introduced by ancestor 2457e54fe40249adbf3ff4b9fa7161ac7a20c761. No implementation delta, PR or new merge is claimed. Existing focused coverage passed 245 tests; six scratch acceptance probes passed; dropping the recording flag made the existing reasoning test fail promptly with the expected assertion. Compatibility was checked at the actual old protocol-parser boundary; no old-client UI or binary was launched.

## Review corrections and bugs caught

Item 7771 consumed one correction to remove a stale test expectation accepting NaN; independent cache/restart assertions were retained and fresh delta review passed. Item 8303 initial Codex review found two P2 warning gaps: path normalization broke response matching, and blank input checked initialCwd instead of inherited defaultCwd. Correction 1 reuses optional request-ID correlation and selects the effective inherited path. Correction 2 updates the canonical wire-roster comment and two stale denial wording assertions exposed by the full server suite; a policy-bypass mutation proves both denial assertions still fail. Wave 2 corrected a real Windows short/long path mismatch by consistently using native realpath for targets and policy boundaries, with four independent red mutations. Its real smoke then found the Browse dialog separately discarding a normalized denial response; wave 2 correction 1 fixes that request correlation, verified by three red mutations and real final-head smoke. Actual Windows CI then passed all six original allowed-path failures but exposed two platform assumptions in tests; wave 2 correction 2 uses native temp/home expectations and the measured filesystem errno without weakening outside-path denial. Latest review and gate state are in the queue row; no completion is inferred from this narrative.

## Local suite limitations

Four server failures were reproduced on unchanged T0: grandchild reaping, POSIX forceKill, dev-preview process lifetime, and Unix fixture readiness. These are recorded baseline failures, not clean local-suite passes. The 8215 full-suite attempt additionally stalled on an unchanged MCPFleet readiness assertion at 300 ms; the leaked exact owned fixture and then exact test process were stopped, so that attempt is not a clean pass. The item 8215 bounded concurrency-four rerun completed 21,349 tests: 21,332 pass, four baseline failures and 13 skips; it is not a clean local pass. Item 8303 wave 1 suite at 503f5be completed 21,363 tests: 21,346 pass, the same four baseline failures and 13 skips. Wave 2 server suite at 1417df6 completed 21,381 tests: 21,364 pass, the same four baseline failures and 13 skips in 272.4 seconds; the complete final-head af8c588 rerun produced the same counts in 301.6 seconds. Every claimed merge still requires green CI on the final reviewed head; the per-item gate snapshots are reported separately.

## Affected-package execution

Full suites were run locally for affected packages; supplemental focused tests are labeled separately. The four reproduced T0 server failures remain failures in these counts. Hosted final-head CI is a separate gate.

| Item | Local suite evidence |
|---|---|
| 8233 | Server: 21,354 tests, 21,337 pass, 4 baseline failures, 13 skips; 15 focused tests and custom lints passed. |
| 8215 | Server: 21,349 tests, 21,332 pass, 4 baseline failures, 13 skips; independent 120 tests plus 589,834 classification assertions passed. |
| 7771 | Server: 21,353 tests, 21,336 pass, 4 baseline failures, 13 skips; 180 focused tests and custom lints passed. |
| 8595 | Store-core: 2,944 passed; supplemental dashboard coverage: 215 passed; type checks passed. |
| 8364 | App: 2,857 tests across 212 suites passed; type checks passed; 68 independent focused tests passed. |
| 8282 | No implementation: 245 existing focused tests plus six acceptance probes passed; flag-dropping mutant failed. |
| 8277 | Dashboard: 7,893 passed; type, style and token checks passed; 212 independent focused tests passed. |
| 8567 | Protocol 579, store-core 2,943, app 2,843 and dashboard 7,890 passed; builds/type checks passed. Server: 21,349 tests, 21,332 pass, 4 baseline failures, 13 skips. |
| 8303 | Final server: 21,381 tests, 21,364 pass, 4 baseline failures, 13 skips; dashboard 7,910, protocol 578 and store-core 2,945 passed; builds/type checks and 11 custom server lints passed. |
| 7815 | Server: 21,348 tests, 21,331 pass, 4 baseline failures, 13 skips; 123 focused tests passed. |

## Observed UI and runtime smoke

Observed outside tests: isolated real dashboards exercised explicit Browse → Select → Create, Haiku selection, a tiny real reply, session switching, and the changed model-label/Settings behavior. Item 8364 passed the native manual-connect product route on an isolated iOS simulator. Its dormant lone ToolBubble and ToolDetailModal were verified separately through a harness importing the actual production components; normal wire traffic groups tools into ActivityGroup, so this is not claimed as an ordinary wire-path lone-bubble repro. Physical-device visual/touch verification on an eventual installed build remains an extra owner-reserved check. No production client/daemon was deployed. Item-specific later smoke results follow below only when supplied in current queue/metadata.

- Item 8233: Not applicable: changed runtime files are outside the prescribed UI/session-runtime scope, or tests only.
- Item 8215: Not applicable: changed runtime files are outside the prescribed UI/session-runtime scope, or tests only.
- Item 7771: Not applicable: changed runtime files are outside the prescribed UI/session-runtime scope, or tests only.
- Item 8595: PASS full dashboard path and custom-label/ID acceptance; private vault smoke/chroxy-pr8664-6c041dc
- Item 8364: PASS: native product route plus a separate harness of the actual dormant components; private vault smoke/chroxy-pr8669-899fdd9
- Item 8277: PASS: real dashboard flow and Settings DOM evidence; private vault smoke/chroxy-pr8667-f6460c2
- Item 8567: PASS: final-head dashboard and native app; all 13 categories at default, singleton, reopened singleton, empty and reopened empty states; private vault smoke/chroxy-pr8670-d523c0c
- Item 8303: PASS: exact final-head feature/repro at af8c588; full SDK/Haiku/reply/session-switch path at parent 1417df6. All previews removed; private vault smoke/chroxy-pr8672-af8c588
- Item 7815: Not applicable: changed runtime files are outside the prescribed UI/session-runtime scope, or tests only.

- Notification defaults passed both actual dashboard and native app paths, with complete thirteen-category snapshots at default, singleton, singleton reopened, empty and empty reopened states. No Settings screenshots.
- Browse retry final af8c588 changed-feature/repro smoke passed normalized allowed and denied paths, outside-HOME navigation/selection, default warning and blank inheritance. The complete SDK/Haiku/reply/switch flow remains explicitly observed at parent 1417df6; only modal Browse correlation and tests changed afterward. All eight wave 2 preview daemons were stopped and scratch removed. Two corrected driver assertions were retained as driver-stop evidence, not product failures.
- After the tests-only final correction, Browse changed-feature/repro smoke was re-driven at af8c588 with twelve final PNGs. Runtime tree identity to 088abed was also verified; the final-head run is direct evidence, not inferred solely from that identity.

## Stalls, incidents and restarts

- Startup mission read was batched with git status, compiled directive and allowed private Core Goal note rather than completed before those reads. No forbidden path was read.
- Requested full-access unattended mode differs from observed workspace-write/on-request with network disabled and automatic approval reviewer. Initial sandboxed GitHub query failed; scoped escalation succeeded without human input.
- Mobile smoke worker process inspection incidentally exposed another trial process command line and small embedded flow shell. No other-trial file/branch/PR opened, no content used; exact owned PID inspection adopted.
- Automatic review rejected a permitted PR-number squash subject as an issue reference; retry omitted all numbers and merged. No human approval requested or supplied.
- 8567 automatic review rejected grouped generated xterm-copy plus protocol-test call as unrelated; worker continued unaffected checks and chose normal app bundle-xterm generation. No human approval.
- Coordinator unnecessarily stopped the corrected Browse server suite over suspected overlap; timestamps show initial run ended 19:27:46 and corrected began 19:27:50, so no overlap occurred. Exact owned wrapper SIGTERM after 60 seconds; final clean rerun started. Initial run was superseded by concurrent correction and not final-head evidence.
- The automatic Copilot review on PR 8668 included a `#8215` reference despite the authored PR using only the required bare `Trial-Closes` marker. This service-authored content was not edited or copied into authored public metadata; no issue-write tool was called.
- Repo-memory tools were unavailable; targeted source reads/searches were used as the specified fallback.
- The Claude usage-checkpoint and usage-benchmark scripts were attempted with the exact own session ID and returned REFUSE because no Claude transcript exists. No zero usage or benchmark row was fabricated. Own Codex parent-only cumulative usage checkpoints were saved under own evidence usage/; child aggregation is unavailable. These token observations do not expose a session dollar total. SDK-reported total_cost_usd remains n/a.
- Scratch-brief headless Chromium initially failed at macOS sandbox IPC registration. A scoped automatic escalation succeeded for the local file render; no human approval prompt was answered, no visible browser window opened, and no external website was visited.
- Copilot's service-authored mobile review on PR 8669 referred to an older issue; authored metadata retained only the bare Trial-Closes marker and no issue-write tool was used.
- Conditional skipped jobs were checked against successful same-run path-filter outputs and changed paths. They are reported as nonapplicable skips, not successful executed tests. The scratch merge gate rejects failed, pending, absent, unknown-skipped and mismatched-run evidence; seven negative fixtures failed immediately.
- The early report-evidence audit found no blocking factual error. It prompted explicit per-item suite counts and matching head/job conditional-skip proofs; completion rendering now refuses unresolved evidence gaps.
- Browse PR 8671 final-head Windows CI failed six new allowed-path assertions with Access denied; this was distinct from the posted symlink capability-skip review finding. Merge held and a fresh diagnosis started; the original two wave-1 corrections remain consumed.
- Wave 2 Browse smoke at 1417df6 found a separate normalized denied default leaving the dialog at Loading, despite the warning nonce working. The full ordinary outside-HOME SDK/Haiku/reply/switch path passed. Correction1 was recorded before implementation; no failing smoke was treated as a pass.
- Retry 088abed Windows CI passed the six formerly failing allowed-path cases but failed two assertions: the old temp/home test used non-native spelling and expected denial for a path the native policy accepts; the new allowed file/child assertion expected ENOTDIR wording but Windows returned the ENOENT wording. Correction2 was recorded before diagnosis/repair; the real Windows fixture and outside-denial assertions remain required.
- Session-lifecycle and visual-brief were loaded from this checkout as manual skill fallbacks. The learn gate found no separate memory update warranted beyond the fixes and trial report; no governance or global memory was changed.
- Final af8c588 Windows job 117785011598 passed both groups: 15,742 tests/15,638 pass/104 skip/0 fail, then 2,781 tests/2,726 pass/55 skip/0 fail. This is actual Windows execution after correction 2, not an alias-model inference.
- One progress message misstated its check timestamp as 20:51 UTC; the next update corrected it to the direct 20:49–20:50 UTC observations. Durable timestamps and CI job evidence were unchanged.
- Compactions: 5; session restarts: 0. Mission and compiled directive reloaded manually; cumulative retry and authority state retained. Rate-limit pauses: none.

## Follow-ups not filed and decisions

No issue creation, comments, labels or closures occurred.

- Model context validation: a separate session-adapter explanatory comment still describes the former NaN gap. Its own finite guard remains correct; this has no runtime or acceptance impact.
- Model labels: an additional operator-supplied label can literally equal a generated fallback label. All IDs/targets and dispatch remain distinct; the assigned two-row case passes. A formatter-wide uniqueness change is a nonblocking presentation follow-up outside the narrow correction.
- Full server tests: four failures reproduced on unchanged T0 (grandchild reaping, POSIX forceKill, dev-preview process lifetime, Unix fixture readiness). A later run also exposed an unchanged MCPFleet readiness assertion at 300ms that skips cleanup on failure; the leaked owned fixture/test were stopped and complete suites rerun with concurrency four. No clean local-suite claim was made for those failed runs.
- Mobile tool details: the existing native accessibility grouping flattens descendant controls; screenshots verified the new state and outside-overlay dismissal works. This is a nonblocking accessibility follow-up. Physical-device checks remain owner-reserved.
- Decisions by panel: none. Routine reversible choices retained blank-cwd inheritance and added the minimum requested startup warning for the Browse item; no extra permission semantics were authorized. Initial Browse review found two warning gaps (normalized path response matching and blank input checking initial rather than inherited default); correction reuses the existing optional request-ID pattern to retain stale-response safety.

- Browse Select remains enabled after a denied listing. Independent review verified the DirectoryBrowser blob is identical at base and final head; Select only fills the cwd and explicit Create still calls validateCwdAllowed before creation. This is pre-existing nonblocking UI polish; no policy bypass or acceptance gap was found.

## Isolation self-report

The startup batch read `/Users/blamechris/Obsidian/no-it-all/coordination/Core Goal.md`, an allowed coordination note, before the mission load completed. No sealed review directory, key file, other run's seed/brief, or other trial branch/PR was deliberately read. During native smoke diagnosis, a broad process listing filtered for Maestro/XCTest incidentally exposed another trial's process command line, including a small embedded flow shell. No referenced file/branch/PR was opened and the content was not used; subsequent process checks target only recorded owned PIDs. Initial focused server tests ran with the repository's redirected config directory before an additional operating-system read-denial layer was requested; those tests had no file-read tracing, so absence of incidental reads of live state cannot be independently claimed from their output. Subsequent server tests and preview daemons used an operating-system denial profile for live `.chroxy` reads and forbidden service ports; no further observed exception is omitted.

## Next work

The fixed queue is settled. The containing report PR completes the trial record through independent review and final-head CI. No further backlog work or production deployment is authorized by this trial.

In effect: Verified merges are usable as source on trial/b1-cx only; the real isolated dashboards and native simulator checks worked outside unit tests, while production installation and the eventual physical-device check remain outside this trial delivery.

Report evidence snapshot generated at 2026-10-18T20:56:10.954435Z.
