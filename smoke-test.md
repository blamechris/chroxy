# Control Room v2 — Smoke Test Checklist

Verification checklist for epic #5170. Relaunch the app with `cd packages/desktop && cargo tauri dev`. References: the two screenshots shared in the planning thread + the HTML brief at `~/Obsidian/no-it-all/briefs/host-repo-status-2026-06-04.html`. Tick a box once visually confirmed.

## A. Host/Repo Status Control Room
- [ ] A Control Room section is reachable from chroxy nav
- [ ] Summary chips: live / onboarded / likely-abandoned / investigate / recent
- [ ] "How to read the verdict" callout present
- [ ] Table columns: Repo/branch · Verdict · Onboarding · Tree · Wt · PRs · Attr · Last
- [ ] Verdict tags color-coded (LIVE / Investigate / abandoned / recent / Onboarded) per the HTML brief
- [ ] Live repos show a green dot; chroxy shows LIVE while a session runs
- [ ] Annotated `↳` note rows under repos
- [ ] Refresh button re-runs the survey; "generated Nm ago" updates
- [ ] Repos = config.repos ∪ auto-discovered under ~/Projects (configurable root)
- [ ] Per-session activity (running agents/shells/tools) still surfaced — drill into a live repo row (NOT lost)

## B. Background-work banner bug
- [ ] A finished background shell (e.g. a sleep loop) CLEARS the "Waiting on background work" banner (no longer sticks forever)

## C. Top-bar layout
- [ ] Token usage bar sits UNDER the "x / 200k tokens" text
- [ ] Nothing after the Approve dropdown is hidden by the bell / ⋯ / cost badge / tokens cluster
- [ ] Model dropdown handles short AND long model names without cramping or pushing neighbors under the sidebar

## D. Status-dot semantics
- [ ] Top green dot reflects CONNECTED (to tunnel), not "running"
- [ ] A "Running" indicator appears in the left projects/explorer

## E. Cost badge
- [ ] Cost badge defaults to provider/model
- [ ] Settings can switch it to cost / tokens / % context / session-type, and it persists
