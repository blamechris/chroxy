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

