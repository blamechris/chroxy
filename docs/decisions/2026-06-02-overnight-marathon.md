# Decisions made during 2-session marathon (overnight 2026-06-02)

Running autonomous in parallel with another agent. Each non-trivial decision (queue scoping, triage classification, PR-vs-issue conflicts, defer/skip reasons) gets logged here as it happens. Trivial impl choices stay in commit messages.

## Session bootstrap

- **Time start:** 2026-06-02T08:51 UTC (after 60.5-min first marathon)
- **First marathon outcome:** 12/12 issues → 12 PRs, all approved, follow-ups #4848–#4853 filed.
- **User instruction:** batch-merge the 12 → cut v0.9.35 → start `/tackle-issues` aggressively on the rest of the backlog without re-confirming → append decisions here. User going to sleep, will check in tomorrow.
- **Parallel-agent caution:** Another agent in a separate session is doing the same. `/tackle-issues` Phase 0 pre-queue scan (existing-PR check via `gh pr list --search "Closes #N"`) handles dedup at marathon-start time, but mid-marathon collisions are still possible. Treat any PR created by `@blamechris` after our SESSION_START as a possible collision → defer instead of override.

## Batch-merge of v0.9.35 Wave-1 PRs (4845, 4847, 4843, 4840, 4844, 4838, 4836, 4841, 4837, 4842, 4839, 4846)

- **Decision: do NOT force-unlock leftover agent worktrees.** `git worktree list` shows ~70 worktrees all locked by pid 59850 — that's the other (parallel) claude agent currently running. Force-unlocking would risk corrupting its checkouts mid-marathon. The cosmetic `failed to delete local branch` errors from `gh pr merge --delete-branch` are non-blocking — the remote branch IS deleted GitHub-side, the merge succeeds, only the local branch ref hangs around. Will sweep the worktrees once the other agent finishes.
- **Decision: chroxy main is `strict: false`** per project memory, so `gh api .../update-branch` between merges is NOT required. Will skip Steps 2e + 2f in `/batch-merge` and run a tight merge-then-merge loop instead.
- **Result: 10/12 merged on first pass.** Two true content conflicts on `packages/app/src/hooks/useSpeechRecognition.ts`:
  - **#4836** (#4829 isRecognizing soft-error) conflicted with the merged #4838's `inFlightRef`. Resolution: keep `inFlightRef.current = false` AND #4836's continuous-mode soft-error early-return. Hard-error branch additionally clears `inFlightRef` before returning (the in-flight session IS dead on a hard error). Rebased + force-pushed → CI green → merged.
  - **#4837** (#4827 SpeechModule helper) conflicted with the merged #4838's `inFlightRef.current = true` assignments after `.start()` calls. Resolution: keep the helper-call (`SpeechModule.start(buildStartOptions(lang))`) AND the `inFlightRef.current = true;` line that comes after. Rebased + force-pushed → CI green → merged.
- **Did the rebases in detached worktrees at /tmp/rebase-*** because the original Wave-1 agent worktrees are locked by the other parallel claude session. Cleanup of those locked worktrees deferred until other session finishes.

## v0.9.35 release

- PR [#4854](https://github.com/blamechris/chroxy/pull/4854) open against main. CHANGELOG.md covers all 12 merged PRs with cross-refs.
- `decisions-made-during-2-session.md` accidentally committed to release branch. Decision: leave it (PR body notes it; trivial to gitignore later if undesirable as a permanent artifact). Per project memory, prefer creating new commits over amending — not worth a follow-up just for this.

## Next marathon — triage of remaining open issues (run after v0.9.35 lands)

46 unassigned open issues. Triaged to **16 actionable items** for the next marathon:

**EXCLUDE — already has open PR (defer, run /check-pr separately):**
- #4655 → PR #4725 | #4682 → PR #4723 | #4733 → PR #4765

**EXCLUDE — too big / feature work (separate cycle):**
- #2450 + #3193–3196 (K8s/Rancher epic, 5 items)
- #2661 (handler unification epic)
- #3699 (account-linked daemon discovery)
- #3855 (Provider Credentials pane)
- #3951–3956 (claude --channels MCP spike, 6 items)
- #4048 (MCP server support for byok) | #4049 (Task subagent for byok) | #4053 (docker-byok)
- #4303 (pluggable sidebar slot — needs design)
- #3404 (dogfood checkpoint workflow — needs design)
- #4695 (New Session button + menu bar — needs design)
- #4831, #4832 (drag-reorder — UI features, explicitly deferred earlier)

**EXCLUDE — environment-dependent:**
- #4762 (Maestro multi-question E2E) — needs booted simulator + Metro that an autonomous worktree agent can't bring up

**EXCLUDE — process / cert / housekeeping:**
- #3808 (Windows MSI signing — needs cert) | #3816 (branch protection — GH settings, not code)
- #3840 (Codex --skip-git-repo-check revisit — speculative) | #4627 (tag backfill — repo housekeeping)

**MARATHON QUEUE (16):**
1. #4629 — Copy transcript button no-ops in Tauri
2. #4630 — Header buttons missing hover tooltips
3. #4635 — Multi-question form Submit fails on all-single-select (v0.9.20 driver gap)
4. #4685 — Dashboard: AskUserQuestion content visible before Allow click
5. #4755 — Mobile parity for single-question Other/freeform (#4651 follow-up)
6. #4756 — Wire 'stopped' event from CliSession through SessionManager (#4602 follow-up)
7. #4761 — widen sendQuestionResponse to per-question Record
8. #4764 — Surface multi-question intervention counter on mobile session header
9. #4778 — align ctx.currentToolUseId with synthesized fallback toolId
10. #4828 — second-wave loggerForSession migration sweep (#4823 follow-up)
11. #4848 — Empirical recorder pass for >9-option TUI keystroke (filed today)
12. #4849 — prune stale device-preferences entries (filed today)
13. #4850 — atomic writeFileRestricted (filed today)
14. #4851 — end handler gates continuous re-arm on inFlightRef (filed today)
15. #4852 — remove VoiceInputMode re-export shims (filed today)
16. #4853 — extract isVoiceInputMode runtime guard (filed today)

Cap at 16; 14 leaves headroom for any Wave-2/3 follow-up issues that get filed as decompositions during the run.

## v0.9.35 PR review round 2 (between marathons)

PR [#4854](https://github.com/blamechris/chroxy/pull/4854) first merge attempt blocked: `base branch policy prohibits the merge` despite MERGEABLE + green CI. Per CLAUDE.md merge-gate triage (conflicts → CI → threads): 3 unresolved Copilot threads.

- **CHANGELOG ordering** — `[Unreleased]` must be the first section per Keep a Changelog. Fixed; also folded the markdown-overflow test removal that was sitting in `[Unreleased]` into `[0.9.35]`'s `### Changed`.
- **Docker hint wording** — "no longer suggests `claude login` on the host" misled (hint applies *inside* containers; non-container providers keep the host hint unchanged). Reworded.
- **`decisions-made-during-2-session.md` at repo root** — moved to `docs/decisions/2026-06-02-overnight-marathon.md` matching the existing dated convention. (That's this file.)

All 3 fixed in `02ed331d6`, threads resolved via `resolveReviewThread`, merged at SHA `35236540c`, tagged `v0.9.35` → release workflow auto-triggered.

## Marathon 2 — 16 issues, mostly converged in Wave 1

Started 2026-06-02T09:18:31Z. End-of-marathon 2026-06-02T19:05Z. **Total elapsed ~9.8 hours** (mostly waiting on parallel-agent + CI cycles; my own active work was a small fraction).

### What landed
17 PRs merged → tagged v0.9.36:

| Wave | PRs |
|------|-----|
| W1 implementations (16) | #4855 (#4851) #4856 (#4852) #4857 (#4629) #4858 (#4853) #4859 (#4761) #4860 (#4685) #4861 (#4630) #4862 (#4764) #4863 (#4849) #4864 (#4755) #4865 (#4850) #4866 (#4848) #4867 (#4635) #4868 (#4756) #4869 (#4828) — 15 of 16 done; #4778 timed out |
| W2 retry (1) | #4885 (#4778) — straightforward narrow-scope retry after W1 timeout |
| Fix-CI (1) | #4886 — cross-PR test-timing collision between #4866 (added 100ms-wait tests) and #4867 (added 150ms settle). Bumped waits to 300ms per Copilot review. |

### Cross-PR breakages encountered + resolutions
1. **#4861 (#4630) rebase conflict** in `App.test.tsx` — same-location describe block collision with merged #4860 tests. Resolved by keeping BOTH describe blocks side-by-side.
2. **#4864 (#4755) rebase conflict** in `types.ts` + `connection.ts` — two PRs (#4761 multi-question Record + #4755 Other/freeform) BOTH widened `sendUserQuestionResponse` signature. Resolved by unioning the type to all three shapes (`string | Record<...> | { otherLabel, freeformText }`) and ordering shape-detection: freeform-check first, then multi-answer fallthrough, then string.
3. **#4869 (#4828) rebase conflict** in `claude-tui-session.js` — logger sweep PR conflicted with #4866's arrow-nav rewrite at the >9-option branch (HEAD had new arrow-nav code; INCOMING had logger-swap on the OLD teardown code that no longer exists). Resolved by taking HEAD's new code and applying the logger-swap pattern to it.
4. **Cross-PR test breakage on main** (#4866 vs #4867): post-merge, main went red because #4867's settle delay broke #4866's freshly-merged arrow-nav tests. Cut #4886 per the `batch_merge_cross_pr_test_breakage.md` memory's "tiny fix-PR on main" pattern. Copilot reviewed #4886 and asked for 200→300ms bump (200 felt too tight in CI); FIX applied + threads resolved.

### 14 new follow-up issues filed
- **Voice / dashboard:** #4870 (toast severity), #4871 (sidebar clipboard), #4872 (mobile VoiceInputMode validation gap), #4873 (status-dot live-region), #4874 (writeFileRestricted callers audit), #4875 (shared isFreeformAnswer predicate), #4876 (mobile touch target sweep), #4877 (Maestro freeform flow)
- **Server / TUI:** #4878 (dashboard session_stopped toast), #4879 (mobile session_stopped status), #4881 (SDK/Codex/Gemini stopped emit), #4882 (recorder pass on all-single-select), #4883 (tighten lastIsSingleSelect detection), #4884 (verify trailing \r on mixed forms)

### Surprises worth memory candidates
1. **#4858 verdict was Request Changes**, but only because agent-review caught the SAME bug pattern exists on mobile (#4872 filed). PR itself is correctly scoped to dashboard per its issue. Marked DONE because the deferral paper trail is clean — but it's worth noting that reviewers sometimes Request Changes for "this fix should also apply to X" out-of-scope concerns. Treating those as DONE + follow-up is the right call.
2. **Two PRs touching the same hot path (#4866 #4848 arrow-nav, #4867 #4635 settle) collided in main post-merge.** Both passed CI individually but interacted badly. The `batch_merge_cross_pr_test_breakage.md` recipe ("tiny fix-PR on main, not in the conflicted branch") still works exactly as documented — kept main red for ~20 minutes total.

### v0.9.36 release
- PR [#4888](https://github.com/blamechris/chroxy/pull/4888) merged at SHA `da997ba4d`.
- Tagged `v0.9.36` → `release.yml` workflow auto-triggers DMG/MSI builds in CI background.
- Same `[Unreleased]`-on-top Keep-a-Changelog gotcha from v0.9.35 fixed proactively this time.

### Local Tauri NOT rebuilt for v0.9.36
User asked me to NOT close their Tauri at start of session ("Also wait to close my existing tauri I have 2 cli sessions running"). They OK'd closing in the morning when sessions were done, and we did rebuild for v0.9.35. For v0.9.36 the rebuild is deferred until they're back. The running daemon is v0.9.35 (post-trap-fix), which already addresses the "Reconnecting…" loop they originally hit. v0.9.36 wins are nice-to-haves but not regression-triggers for any active session.

