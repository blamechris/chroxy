# B2c-cy-codex trial report

All ten fixed queue items were squash-merged into `trial/b2c-cy-codex`.
Queue execution ended at `2026-10-19T22:45:44Z`; report preparation and delivery follow it.
No queue item was replaced, decomposed or left blocked. Original issues were not closed.
The changes were exercised in isolated previews; the daily daemon was not deployed or restarted.

## Run metadata

| Field | Observed value |
|---|---|
| Run | `B2c-cy-codex` |
| Session | `01a15598-65cf-76e2-939b-32c4d322b8c3` |
| Mode / package | PRIME; only the ten-item mission queue and its report |
| Start, UTC | `2026-10-19T19:18:00.437Z` |
| Fixed queue execution end, UTC | `2026-10-19T22:45:44Z` |
| Report prepared, UTC | `2026-10-19T22:46:48Z`; report delivery occurs afterward through its own PR |
| Harness | CY — Chroxy Codex app-server via ChatGPT connection |
| Coordinator model / effort | `gpt-6-astra` / `xhigh` |
| Worker model / effort | `gpt-6.1-sol` / `high` |
| Nested read-only pass efforts | `xhigh`, `high` |
| Chroxy daemon version | `0.11.4` |
| Codex binary version | `0.163.0` |
| Node version | `22.23.2` |
| Base / only merge target | `trial/b2c-cy-codex` |
| T0 | `932bd3a4ef40bc9634cab390e6cf0facadd801d7` |
| Final queue merge | `6c369095b254b2304e0568fc02a67210feaa90f2` |
| Permission observation | Dashboard: Auto; native host: workspace-write/on-request |
| Human approvals | 0 separate human approval messages observed; exact event audit unavailable |
| Invocation | Manual fallback: read the exact repository compiled `.claude/skills/prime-directive/SKILL.md`; native prompt expansion unavailable |
| Invocation deviation | Repository manual fallback used; neither native expansion nor the mission's pasted-prompt fallback is claimed |
| SDK-reported total_cost_usd | `n/a` |

Model and effort fields are trial measurements. Cost was unavailable: the Claude-only usage
checkpoint tools refused this Codex session identifier. No other session was substituted,
no cost or token estimate was produced, and no historical benchmark row was appended.
An SDK-reported total, had one been available, would be an API-rate equivalent rather than
a subscription charge.

## Fixed queue outcomes

All timestamps below are UTC. Each CI link names the final verification run, **not** an
exhaustive inventory of attempts. Failed Browse CI attempts appear separately below.
Review rounds include retries where recorded.

| Issue | PR | Opened, UTC | Merged, UTC | Final verification CI | Independent review rounds | Squash merge SHA | Status |
|---|---|---|---|---|---|---|---|
| 8233 | [PR 8719](https://github.com/blamechris/chroxy/pull/8719) | 2026-10-19T20:33:23Z | 2026-10-19T20:44:04Z | [Run 39320295407](https://github.com/blamechris/chroxy/actions/runs/39320295407) | one independent focused round | `cd203db4c04df3357285373ee62508e85d00aebb` | merged |
| 8215 | [PR 8720](https://github.com/blamechris/chroxy/pull/8720) | 2026-10-19T20:41:54Z | 2026-10-19T21:03:39Z | [Run 39321484347](https://github.com/blamechris/chroxy/actions/runs/39321484347) | one independent focused round | `a8aed1cfc747ab681ab3a94414d2bfc82abf3c40` | merged |
| 7771 | [PR 8716](https://github.com/blamechris/chroxy/pull/8716) | 2026-10-19T20:05:15Z | 2026-10-19T20:22:13Z | [Run 39316368677](https://github.com/blamechris/chroxy/actions/runs/39316368677) | one independent focused round | `227965ceb4f6c4eac511431284e9a780ccc0051e` | merged |
| 8595 | [PR 8714](https://github.com/blamechris/chroxy/pull/8714) | 2026-10-19T19:50:04Z | 2026-10-19T20:06:22Z | [Run 39314263546](https://github.com/blamechris/chroxy/actions/runs/39314263546) | one independent focused round | `cbc6c2c5b295de11476d92d02393c857c31af222` | merged |
| 8364 | [PR 8723](https://github.com/blamechris/chroxy/pull/8723) | 2026-10-19T21:30:32Z | 2026-10-19T21:43:23Z | [Run 39328044578](https://github.com/blamechris/chroxy/actions/runs/39328044578) | W1 two full rounds; W2 one fresh full round | `869fb60c7be8f5a3871e284f5b87060f2e8c2911` | merged |
| 8282 | [PR 8721](https://github.com/blamechris/chroxy/pull/8721) | 2026-10-19T21:03:59Z | 2026-10-19T21:13:46Z | [Run 39324508489](https://github.com/blamechris/chroxy/actions/runs/39324508489) | one independent focused round | `8e90c68ddb7b7cc22159ef01a6f550ad7a5813a8` | merged |
| 8277 | [PR 8717](https://github.com/blamechris/chroxy/pull/8717) | 2026-10-19T20:10:12Z | 2026-10-19T20:25:08Z | [Run 39317062779](https://github.com/blamechris/chroxy/actions/runs/39317062779) | one independent focused round | `73a6c85e76357116dcb6c8eea21a23b936582c04` | merged |
| 8567 | [PR 8722](https://github.com/blamechris/chroxy/pull/8722) | 2026-10-19T21:06:55Z | 2026-10-19T21:22:47Z | [Run 39324912650](https://github.com/blamechris/chroxy/actions/runs/39324912650) | one independent two-dimension panel | `f42cfc5547268edc37bb4c7b3a900a82971941a0` | merged |
| 8303 | [PR 8725](https://github.com/blamechris/chroxy/pull/8725) | 2026-10-19T22:32:17Z | 2026-10-19T22:45:44Z | [Run 39335653485](https://github.com/blamechris/chroxy/actions/runs/39335653485) | Wave2: one two-dimension round, one two-dimension correction, one test-only delta; Wave3: one fresh two-dimension panel, zero findings | `6c369095b254b2304e0568fc02a67210feaa90f2` | merged |
| 7815 | [PR 8718](https://github.com/blamechris/chroxy/pull/8718) | 2026-10-19T20:21:35Z | 2026-10-19T20:36:13Z | [Run 39318649829](https://github.com/blamechris/chroxy/actions/runs/39318649829) | one independent focused round | `cebafe9d56c1b632ee6a699d1fadfea79cca322c` | merged |

For every merged item, independent full review was clean, posted service summaries and
inline findings were triaged, and all review threads were resolved with complete pagination.
Applicable final-head CI checks succeeded. Current trial-base rules and protections were
derived, and synchronous squash merges were verified `MERGED` into the intended trial base.
No required check or external approval was bypassed. Smoke scope was applied mechanically;
every in-scope item passed isolated owner-path acceptance.
PR 8725's final checks were 24 successful checks plus the conditional `Renovate Config` skip.

## Validation and real UI evidence

**Local full-server attempts failed.** Completed attempts encountered failures in unchanged
files or file timeouts under load; incomplete attempts were stopped and drained for corrections.
These outcomes are retained as failures. Targeted c8/raw isolation and unchanged-file evidence
classified the failures; those checks do not turn a failed full run into a pass.
**Final CI passed all applicable checks on the final heads**, separately from local results.

| Issue | Recorded acceptance and local evidence |
|---|---|
| 8233 | Configured-port precedence and invalid-port RED/GREEN; 145 related tests passed. Completed full-server run failed in unchanged files; the exact failing case passed isolated with c8 and raw execution. |
| 8215 | 49 related tests and independent enumeration of 65,536 mapped prefixes passed. Full-server attempt had zero assertion failures and two unchanged timeout files; 173 isolated c8 tests passed. |
| 7771 | Finite-input RED/GREEN and 256 related tests passed. Completed full-server run failed in unchanged files; isolated checks passed. |
| 8595 | Full store-core suite: 2,944 passed. Real dashboard owner path and collision labels passed. |
| 8364 | Full app suite: 212 suites / 2,855 tests passed. Real owner path, stopped lone bubble and detail modal passed; four actual renderer Maestro flows passed and screenshots were inspected. |
| 8282 | Production stream-kind behavior was already in T0. Added serializer, restore, replay and truncation acceptance coverage; 230 related plus 100 independent tests passed. Full-server run failed in unchanged files; 122 isolated c8 tests passed. |
| 8277 | Full dashboard suite: 7,892 passed. Real owner path and Settings DOM acceptance passed. |
| 8567 | Full protocol: 579; app: 2,839; dashboard: 7,891 passed. Full-server run failed in unchanged files; 51 isolated c8 tests plus prior 173 passed. Real owner path and Settings default, empty and single-override acceptance passed. |
| 8303 | Full protocol: 583; store-core: 2,945; dashboard: 7,911 passed. Focused: 167 passed; original alias and removed-containment controls went red. Final full-server attempt failed as detailed below. |
| 7815 | Occupied legacy-port control went red, then owned ephemeral-port tests passed. Completed full-server run failed in unchanged files; 257 isolated c8 tests passed. |

Browse's final full-server attempt ran from `2026-10-19T22:23:43.388817Z` to
`2026-10-19T22:29:54.831640Z` (371.440 seconds): 21,218 tests, 21,203 passed,
0 assertion failures, 2 cancelled and 13 skipped; exit code 1, therefore **FAILED**.
The same two files hit 120-second limits. Classification included prior 173/173 c8
isolation and identity of the 12-file dependency closure at final head `97bf0262`.

At `97bf0262273418f83df17e5ae39b422f5205e4b6`, Browse smoke passed the real owner
path, a Haiku reply, session switching, denied-default note/Browse behavior, normalized
external-workspace selection and startup warning. Screenshots were inspected and preview
teardown verified. Evidence reference: private vault `smoke/chroxy-pr8725-97bf026`.
Other UI changes also used isolated owner-path previews; these were real UI checks,
not a claim that the daily daemon or installed app had received the changes.

## Attempts, stalls and incidents

The run used 3 of 3 waves, with at most 2 corrections per item per wave.
Consumed attempts were carried forward. There were 7 coordinator compactions,
0 coordinator restarts and 0 minutes of rate-limit stall. The 12-hour deadline was
`2026-10-20T07:18:00.437Z`; queue completion preceded it. No spend cap was configured.

- Mobile's first attempt, [PR 8715](https://github.com/blamechris/chroxy/pull/8715),
  opened `2026-10-19T19:58:20Z` and closed unmerged `2026-10-19T21:22:51Z` for
  Wave 2 retry. Its final head was `e773618f4544e8312a611af69d36bf8faac0af66`.
  Wave 1 had two full review rounds; PR 8723 received one fresh full round.
- Browse Wave 1 remained unpublished after two corrections. Wave 2's
  [PR 8724](https://github.com/blamechris/chroxy/pull/8724) opened
  `2026-10-19T21:47:27Z` and closed unmerged `2026-10-19T22:21:25Z` after two
  corrections and failed Windows CI. Final head: `27abf53b6ecc8e502d7916d7ca8bbdcf395d2e5d`.
- Browse [run 39330237072](https://github.com/blamechris/chroxy/actions/runs/39330237072)
  exposed six new workspace-policy assertions failing on Windows. Its Linux server
  job also killed an unchanged `byok-mcp-client` file with SIGKILL at 64.003 seconds.
  Correction review caught a Windows ENOENT versus POSIX ENOTDIR fixture expectation
  before repush; an incomplete local full run was stopped and drained for that correction.
- Browse [run 39333327901](https://github.com/blamechris/chroxy/actions/runs/39333327901)
  passed the new Windows policy suite but failed an older `handler-utils` platform-temp
  precondition comparing JavaScript path spellings. Wave 2's allowance was exhausted.
  Wave 3 retained reviewed production, repaired that test precondition, received fresh
  two-dimension approval with zero findings, and consumed no corrective push.
- Sandbox network, loopback-listener and native-device restrictions required escalated
  retries. No separate human approval message was observed; exact approval-event auditing
  was unavailable. A final-wave runner hit sandbox-denied process accounting after launch;
  its exact owned subtree was drained and restarted with host access, without a source correction.
- Dependency links and missing workspace-local dependency mirrors caused initial bootstrap
  or build failures; these were repaired before accepted validation. Full suite attempts
  completed before corresponding pushes. Bounded server runs sometimes left children;
  owned descendants were drained after classification.
- Mobile smoke caught an unreachable singleton ToolBubble route despite passing initial
  tests. Review caught ordinary-error presentation, stale selectors and Show more/less
  controls below the tap-target floor. Maestro then exposed keyboard-obscured previews;
  Wave 2 preserved fixtures and dismissed the keyboard before Send.
- Mobile setup needed simulator-driver/onboarding retries and app-only reload recovery.
  A provider-hook denial was honored. A private automation log displayed part of a
  disposable preview credential; no value entered repository artifacts, and the preview
  and configuration were removed.
- Browse validation caught an omitted optional `requestId` in the outbound roster and
  obsolete source-comment assertions; runtime stale-response tests replaced them.
  Windows CI exposed native/JavaScript canonical-path divergence, and review caught the
  masked native error expectation.
- Copilot-generated summaries included original issue references despite authored PR bodies
  using bare `Trial-Closes` numbers. This run authored no issue comments, labels, closures,
  reopenings or new issues.

## Decisions and follow-ups retained without issue writes

The local-validation panel chose completed full local package attempts before draft
publication. Server runs retained setup, mocks, c8, test-count floor and WS assertions,
with concurrency 4, per-file 120-second and overall 1,800-second bounds. Failed attempts
were classified with unchanged-file and isolation evidence; final-head CI stayed mandatory.
Mobile and Browse moved to fresh-context retries after consuming their Wave 1 corrections,
without resetting counters or expanding scope. Browse stayed unpublished until a completed
full local attempt existed.

Windows native and JavaScript realpath representations were aligned in the shared policy
following actual CI evidence. Regression coverage retained alias inputs and separate allow/deny
controls. The computed-default test controls cwd; file-child error expectations follow native
platform semantics without a skip. Wave 3's temp/home precondition used explicit positive and
negative assertions while retaining the reviewed production change.

The following nonblockers remain recorded here because the mission forbids issue writes:

| Location | Follow-up and disposition |
|---|---|
| `packages/app/src/components/chat/MessageBubble.tsx:176` | Documentation calls `rawToolName` trailing after a new final optional argument was added; documentation-only nonblocker. |
| `packages/app/src/components/chat/MessageBubble.tsx:412` | Empty thinking indicator remained visible after a stopped turn in real smoke; independent review confirmed the renderer was unchanged, so retained as a nonblocking follow-up. |
| Typed `~/` paths | Browse expands tilde before resolving while explicit Create's existing validation stats the raw cwd. This preexisting syntax gap is outside absolute workspace/default-path acceptance; Browse Select supplies the canonical path. |

## Isolation self-report

- Startup ordering deviated: initial cwd/status/branch/worktree/file discovery preceded
  mission loading. The normal coordination note
  `/Users/blamechris/Obsidian/no-it-all/coordination/Core Goal.md` was read concurrently
  with mission loading; its contents were not copied into the repository.
- One post-compaction reload batched the mission with other required reads instead of
  reading the mission alone first; the next reload restored mission-first ordering.
- Read-only host UI observation exposed other session names, sidebar usage and a
  credential-bearing URL. No other session was selected; no credential value was persisted
  in repository artifacts.
- No other trial branch or PR was read, fetched, diffed or listed. No other trial seed or
  brief was opened. No sealed-key folder or `KEY.md` / `KEY.md.enc` was read.
- Only this run's Chroxy trial ref was fetched; registry fetches concerned the independent
  skill registry. The hosting daemon was not restarted, reconfigured or deployed.
- During final-wave recovery, a broad process inventory was accidentally printed while
  locating the owned test process. No other trial name/path was observed in the visible
  result; truncated output was not audited. No other trial ref or file was deliberately opened.

**In effect:** The ten changes are available on the isolated trial branch and were seen
working in real isolated previews where applicable. They are not installed in the daily
daemon or released mobile build; production deployment was outside this run's authority.
Chris owns any later rollout. The run's cleanup record confirms the mobile preview, Metro
and mock server stopped, and the temporary simulator was deleted. Report publication follows
queue completion as a separate documentation PR to this same trial branch.
