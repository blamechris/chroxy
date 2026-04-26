# /manual-testing-mode

Bootstrap a dogfooding session, then capture issues as the user finds them — defaulting to filing GitHub issues over fixing.

This is a **mode**, not a one-shot. Once entered it changes how you respond to subsequent user messages until the user explicitly exits or pivots.

## Arguments

- `$ARGUMENTS` - Optional. Forms accepted:
  - empty → bootstrap a new manual-testing branch + bump patch version, then enter capture mode
  - `bump:false` → enter capture mode without creating a branch / bumping version (use the user's current branch)
  - `done` / `wrap` / `exit` → produce the summary report and leave the mode
  - `status` → list everything filed in this session so far without exiting

## Why this exists

When the user is the sole tester driving real workflows through a working build, the dominant output is *issues filed*, not *code changed*. The friction of "open browser → repo → New Issue → fill template → upload screenshot" is what kills the feedback loop. This mode collapses that to "describe the bug + drop the screenshot, the assistant files it." Fixes happen only when the user explicitly asks.

## Instructions

### Phase 1: Session bootstrap (run once on entry, unless `bump:false`)

1. **Detect the current version** by reading `packages/server/package.json`.
2. **Compute the next patch version** (e.g., `0.6.10` → `0.6.11`).
3. **Confirm with user** before creating the branch:
   ```
   Bootstrapping manual-testing session.
     • Branch: manual-testing/v{NEXT}
     • Version bump: {CURRENT} → {NEXT} across {N} files
     • What are you testing? (feature scope, surface, anything off-limits?)
   Proceed?
   ```
4. **On confirmation**:
   - `git checkout -b manual-testing/v{NEXT}`
   - Bump version across all version-bearing files: `package.json` (root), `packages/{app,desktop,protocol,dashboard,store-core}/package.json`, `packages/server/package.json`, `packages/desktop/src-tauri/Cargo.toml`, `packages/desktop/src-tauri/tauri.conf.json`
   - Run `grep '"version":' package.json packages/*/package.json packages/desktop/src-tauri/tauri.conf.json && grep '^version' packages/desktop/src-tauri/Cargo.toml` and confirm each file shows the new version.
   - Commit: `chore(release): bump version to {NEXT}` with a body explaining why (so manual-testing builds are visibly distinct from main).
5. **Save bootstrap state** to a session-scoped task list (use TaskCreate) for the running list of filed issues:
   - One `manual-testing tracker` task that you'll update as issues accumulate, with metadata holding `{ issues: [], fixes: [] }`.

### Phase 2: Steady-state issue capture (every user message after bootstrap)

For each user message in this mode, classify the intent:

| Intent | Signal | Action |
|--------|--------|--------|
| **New bug report** | description of broken behavior, often with screenshot | File a GitHub issue (default) — see template below |
| **Feature request** | "we should have…", "I wish it…", "would be nice if…" | File a GitHub issue with `enhancement` label |
| **Fix request** | "fix this", "fix it now", "let's fix it" — explicit fix verb | Switch to normal flow: investigate, fix, commit. Still file an issue if it merits tracking. |
| **Wrap / exit** | "done", "wrap up", "we're done", "exit" | Run Phase 3 (summary) and leave the mode |
| **Status check** | "what have we filed?", "show me the list" | Print the running issue table from the tracker task |
| **Conversation / clarification** | question, design discussion, "why does X happen?" | Answer normally — do NOT file an issue for design questions |

**The default is to file, not fix.** When in doubt, file. Better to capture and triage later than lose a real bug while debating whether to fix it inline.

#### Issue template

For every filed issue:

```markdown
## Summary
{1-2 sentence description}

## Expected
{what the user said should happen — paraphrased if not verbatim}

## Actual
{what actually happened — include exact UI labels, error text, etc.}

## Repro
{numbered steps the user took, in order — include device/surface}

## Environment
- Build: {version + branch — read from version source}
- Surface: {desktop / mobile / web / specific screen}
- OS / device: {detected from screenshot or session context}
- Date: {YYYY-MM-DD}

## Likely culprits
{2-4 short hypotheses with file:line citations when you have them — empty section is OK if you don't yet}

## Notes
Discovered while dogfooding {version} on the {branch} branch.
```

**Labels:** Always tag with one severity (`bug` / `enhancement` / `ux`) plus one or more surface labels: `desktop`, `app`, `server`, `tunnel`, `dashboard`.

**Screenshots:** When the user attaches an image, copy it to a stable temp path (e.g., `/tmp/{repo}-{slug}.png`) and call out in the issue body: *"Screenshot at `<path>` — drag-drop into the issue from the web UI to attach."* The `gh` CLI cannot upload images to issues; the user has to do that step manually.

**After filing:**
- Append to the tracker task's metadata: `{ issueNumber, title, severity, surface, status: 'open' }`.
- One-line confirmation back to the user: `Filed #{N} — {title}. Anything else?`

#### When to switch from "file" to "fix"

If the user says any of these (regardless of how the message starts), proceed to fix the issue inline:
- `fix this`, `fix it`, `let's fix this now`, `we should fix that`
- `do it`, `make the change`, `patch it`
- Direct imperatives that imply code change without filing: `rename X to Y`, `bump the timeout to 30s`, `disable the X feature`

In that case:
1. Still file the issue first (so the fix has a tracking number for the PR).
2. Investigate, fix, run relevant tests.
3. Commit on the manual-testing branch with `fix(scope): {message} (#{issueN})`.
4. Append to tracker metadata: `{ issueNumber, title, fixCommitSha }`.
5. Confirm: `Fixed #{N} in {commit-sha}. Test status: {pass/fail}.`

**Do NOT split the manual-testing branch into per-fix branches** — that defeats the dogfooding loop. All fixes accumulate on `manual-testing/v{NEXT}` and ship together when the session ends.

### Phase 3: Wrap-up (when user says done / wrap / exit)

1. **Read the tracker task metadata** for the full list of issues filed and fixes committed.
2. **Print a summary table** to the user:

   ```markdown
   ## Manual testing session: v{NEXT} ({DATE})
   {N} issues filed, {M} fixed inline, {commits} commits on `manual-testing/v{NEXT}`.

   ### Filed
   | # | Title | Severity | Surface | Status |
   |---|-------|----------|---------|--------|
   | #N | … | bug | desktop | open |

   ### Fixed inline
   | # | Title | Commit |
   |---|-------|--------|
   | #N | … | abc1234 |
   ```
3. **Offer follow-ups:**
   - Want me to open a PR rolling up the manual-testing branch into main? (only if there are fixes — bare version-bump branches don't need a PR)
   - Want me to `/schedule` triage of the open issues for next week?
4. **Clear the tracker task** (set status: completed) so the next `/manual-testing-mode` invocation starts fresh.

## Critical rules

1. **The user is the sole author.** No AI attribution in commits, PR bodies, or issue text.
2. **One issue per filed report.** Do not bundle multiple distinct bugs into one issue, even if reported in the same message — file them separately and link them with `Related: #N`.
3. **Never fix without filing first.** Even when explicitly asked to fix, the issue gets filed for tracking. Reason: the manual-testing branch may not merge for days; the issue tracker is the durable record.
4. **Never silently switch modes.** When you decide to fix instead of file, say so explicitly: `Switching to fix mode for #{N}. Investigating now.`
5. **Default to short responses.** The user is in flow — they don't need essays back. One sentence per filed issue. Save long-form for the wrap-up summary.
6. **Re-enter the mode if interrupted.** If the user breaks out for an unrelated task (e.g., asks a question about a different repo), pause the mode. Resume on next bug-shaped message.

## What this skill does NOT do

- It does not run automated UI tests or smoke checks (`/smoke-test` handles that).
- It does not triage previously-filed issues (use the standard issue triage flow).
- It does not auto-create PRs unless asked at wrap-up.
- It does not block on Copilot reviews or CI — those happen post-session when the branch eventually PRs.

## Example session

```
user: /manual-testing-mode

A: Bootstrapping. v0.6.10 → v0.6.11, branch manual-testing/v0.6.11.
What are you testing? (mobile, desktop, full app?)

user: full app — desktop and android side by side

A: Got it. Branch created, version bumped, committed (abc123). I'll
default to filing each issue you find — say "fix it" if you want me to
patch instead. Go.

user: [screenshot] the New Session modal is cut off at the top on Android

A: Filed #3068 — Android: New Session modal clipped at top. Anything else?

user: also the QR is binding to the active session — fix it

A: Filed #3069 first (default-to-file rule), now switching to fix mode.
Investigating ws-server.js auth context...
{works on it, commits, reports back}
Fixed #3069 in 56d6405. Tests pass. Anything else?

user: done

A: ## Manual testing session: v0.6.11 (2026-04-26)
2 issues filed, 1 fixed inline, 3 commits on manual-testing/v0.6.11.
{table}

Want me to open a PR for the fixes, or leave the branch local?
```
<!-- skill-templates: manual-testing-mode  2026-04-26 -->
