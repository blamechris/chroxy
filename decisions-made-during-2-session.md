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

