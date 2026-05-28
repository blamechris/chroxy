# /merge

Merge PRs, verify post-merge version bump, and run post-merge actions (build, deploy, etc.).

## Arguments

- `$ARGUMENTS` - PR numbers, `all`, or flags:
  - `123` or `123 456` — specific PR(s)
  - `all` — all open PRs targeting main
  - `--no-build` — skip post-merge Tauri desktop rebuild
  - `--build-only` — rebuild desktop on current main without merging
  - `--skip-version-check` — don't wait for auto-version CI

## Instructions

### Phase 0: Mandatory Review Gate

**CRITICAL: Every PR MUST be reviewed before merging. No exceptions for "obvious" fixes.**

For each PR to be merged, check if `/full-review` has already been run:

```bash
# Check for existing review comments (agent-review posts a structured review)
gh api repos/${REPO}/issues/${PR_NUM}/comments --jq '[.[] | select(.body | test("Code Review|Review Comments Addressed"))] | length'
```

If no review exists, run `/full-review ${PR_NUM}` **before proceeding to merge**. For multiple PRs, run reviews in parallel (background agents), then merge sequentially after all reviews complete.

Pure documentation/skill file changes (.md files) with zero code changes may skip review.

### Phase 1: Pre-Merge Preparation

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
```

If the post-merge-only flag is set, skip to Phase 3.

Parse PR numbers from arguments. For `all`:

```bash
gh pr list --base main --state open --json number,title,headRefName,mergeStateStatus
```

For each PR, pre-check:

```bash
# CI status
gh pr checks ${PR_NUM}

# Merge state
gh pr view ${PR_NUM} --json mergeable,mergeStateStatus
```

Display summary table (no confirmation gate — user invoked the command explicitly):

```markdown
## Merge Queue ({N} PRs)

| # | PR | Title | CI | Merge State |
|---|-----|-------|----|-------------|
| 1 | #123 | feat: add feature | PASS | CLEAN |
```

### Phase 2: Merge Execution

#### Small batch (1-2 PRs): Direct merge

For each PR:

1. **Check CI** — if any checks are pending, poll every 30s up to 3 min. If failed, run `/fix-ci` once and retry.
2. **Check merge state** — if BLOCKED, diagnose:

   | Error Pattern | Action | Max Retries |
   |---|---|---|
   | "not up to date" / "branch is behind" | `gh api repos/${REPO}/pulls/${PR_NUM}/update-branch -X PUT`, wait for CI, retry | 1 |
   | "status check" / "required status" | `/fix-ci`, retry | 1 |
   | "review" / "unresolved threads" | Resolve via GraphQL (see below), retry | 1 |
   | "conflict" / "not mergeable" | Skip, report conflict | 0 |
   | "already merged" | Skip silently | 0 |
   | Rate limit (403/429) | Back off 60s, retry | 2 |
   | Unknown | Log error, skip | 0 |

3. **Resolve review threads** if blocking merge:

   ```python
   # MUST use Python — bash corrupts Base64 thread IDs in GraphQL mutations
   python3 -c "
   import subprocess, json
   result = subprocess.run(['gh', 'api', 'graphql', '-f',
     'query={repository(owner:\"OWNER\",name:\"REPO\"){pullRequest(number:PR_NUM){reviewThreads(first:50){nodes{id,isResolved}}}}}'],
     capture_output=True, text=True)
   data = json.loads(result.stdout)
   for t in [x for x in data['data']['repository']['pullRequest']['reviewThreads']['nodes'] if not x['isResolved']]:
       mutation = 'mutation { resolveReviewThread(input: {threadId: \"' + t['id'] + '\"}) { thread { isResolved } } }'
       subprocess.run(['gh', 'api', 'graphql', '-f', f'query={mutation}'], capture_output=True, text=True)
   "
   ```

4. **Squash merge:**
   ```bash
   gh pr merge ${PR_NUM} --squash --delete-branch
   ```

5. **Verify:** `gh pr view ${PR_NUM} --json state -q .state` should be `MERGED`

#### Large batch (3+ PRs): Delegate to /batch-merge

Run `/batch-merge ${PR_NUMS}` — it handles sequential merge with update-branch, CI waiting, Copilot gating, and conflict resolution. After delegation completes, continue to Phase 2b with the list of successfully merged PRs.

### Phase 2b: Version Verification

After merging, ask the user if they want to bump the version:

```
Current version: vX.Y.Z
Bump version? (patch → vX.Y.(Z+1), or skip)
```

If yes:

```bash
bash scripts/bump-version.sh
git checkout -b chore/bump-version main
git add packages/server/package.json packages/app/package.json packages/desktop/package.json packages/protocol/package.json packages/dashboard/package.json packages/store-core/package.json package.json packages/desktop/src-tauri/tauri.conf.json packages/desktop/src-tauri/Cargo.toml
NEXT=$(grep '"version":' packages/server/package.json | head -1 | sed 's/.*"\([^"]*\)".*/\1/')
git commit -m "chore: bump version to v${NEXT}"
git push -u origin chore/bump-version
gh pr create --title "chore: bump version to v${NEXT}" --body "Patch version bump."
```

Merge after CI passes (version-only change, review gate exception).

If `--skip-version-check` is set, skip this phase.

### Phase 3: Post-Merge Actions

**Skip conditions:**
- `--no-build` flag is set
- No PRs were merged (all skipped/blocked)
- Merged PRs only touch: `docs/`, `.github/`, `packages/app/`, `scripts/`, `*.md`

#### Step 3a: Pull latest main

```bash
git checkout main
git pull --ff-only origin main
# If fast-forward fails (divergent from stale cherry-picks/worktrees):
# git reset --hard origin/main
```

Verify local version matches the auto-versioned remote:
```bash
echo "Local version: $(grep '"version":' packages/server/package.json | head -1 | sed 's/.*"\([^"]*\)".*/\1/')"
```

#### Step 3b: Rebuild Tauri Desktop App

```bash
# Set Node 22 and full PATH for npm/sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH:/usr/bin:/bin:/usr/sbin:/sbin"

# Build dashboard with Tauri platform flag
cd packages/dashboard
TAURI_ENV_PLATFORM=darwin npm run build

# Bundle server resources
cd ../desktop
bash scripts/bundle-server.sh

# Force binary relink and rebuild
touch src-tauri/src/lib.rs
cd src-tauri
cargo build --release

# Clear aggressively cached bundles and create new app bundle
rm -rf target/release/bundle
cargo tauri bundle

# Ad-hoc sign and install
codesign --force --deep --sign - target/release/bundle/macos/Chroxy.app
pkill Chroxy 2>/dev/null || true
rm -rf /Applications/Chroxy.app
cp -R target/release/bundle/macos/Chroxy.app /Applications/

# Verify dashboard base path is correct (must be /assets/ not /dashboard/assets/)
grep 'src=' /Applications/Chroxy.app/Contents/Resources/dist/index.html | head -1
```

### Phase 4: Report

```markdown
## Merge Complete

| PR | Title | Status |
|----|-------|--------|
| #123 | feat: add feature | Merged |
| #456 | fix: resolve crash | Skipped (conflict) |

**Version:** v1.2.3 → v1.2.4
**Desktop app rebuilt:** Tauri bundle installed to /Applications/Chroxy.app
```

## Error Recovery

| Error | Recovery |
|---|---|
| CI failure on PR | Run `/fix-ci`, wait, retry merge |
| Unresolved review threads | Resolve via GraphQL Python script, retry |
| Merge conflict | Skip PR, report to user |
| Version bump timeout | Warn and continue to post-merge actions |
| Dashboard build failure | Check `TAURI_ENV_PLATFORM=darwin` is set, verify Node 22, retry |
| Tauri bundle white screen | Verify `grep 'src=' dist/index.html` shows `/assets/` not `/dashboard/assets/` — rebuild with `TAURI_ENV_PLATFORM=darwin` |
| Stale .app after rebuild | `rm -rf target/release/bundle` clears cache, `touch src-tauri/src/lib.rs` forces relink |
| Divergent local branches | `git reset --hard origin/main` |

## Critical Rules

1. **NEVER merge without /full-review** — every PR must be reviewed before merging. This is a hard gate. Run Phase 0 first.
2. **For 3+ PRs, delegate to /batch-merge** — don't reinvent sequential merge logic
3. **Version verification is informational** — never block post-merge actions on it
4. **GraphQL resolveReviewThread must use Python** — bash corrupts Base64 thread IDs
5. **Never use --admin** — respect branch protections
6. **Idempotent** — safe to re-run; already-merged PRs detected and skipped
7. **No attribution** — Zero Attribution Policy applies to all commits
8. **TAURI_ENV_PLATFORM=darwin is mandatory** — without it, Vite uses `/dashboard/` base path and dashboard is blank in the app
9. **Always rebuild dashboard before bundling** — source changes are not visible without rebuild
10. **Clear bundle cache aggressively** — `rm -rf target/release/bundle` before `cargo tauri bundle` to avoid stale .app installs
11. **Use full PATH in all npm commands** — `/opt/homebrew/opt/node@22/bin:$PATH:/usr/bin:/bin:/usr/sbin:/sbin` ensures npm finds sh and other tools
<!-- skill-templates: merge 9652481 2026-05-27 -->
