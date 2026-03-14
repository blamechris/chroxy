# /merge

Merge PRs, verify auto-version bump, and rebuild the Tauri desktop app.

## Arguments

- `$ARGUMENTS` - PR numbers, `all`, or flags:
  - `2248` or `2248 2249` — specific PR(s)
  - `all` — all open PRs targeting main
  - `--no-build` — skip desktop app rebuild
  - `--build-only` — skip merging, just rebuild from current main
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

**The only exception:** Pure documentation/skill file changes (`.md` files in `.claude/commands/`, `docs/`) with zero code changes may skip review.

### Phase 1: Pre-Merge Preparation

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
```

If `--build-only`, skip to Phase 3.

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

Display summary table (no confirmation gate — user invoked explicitly):

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
     'query={repository(owner:\"blamechris\",name:\"chroxy\"){pullRequest(number:PR_NUM){reviewThreads(first:50){nodes{id,isResolved}}}}}'],
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

After merging, wait for the auto-version CI to bump the patch version:

```bash
# Wait 15s for the workflow to trigger
sleep 15

# Poll for completion (every 15s, max 3 min)
for i in $(seq 1 12); do
  STATUS=$(gh run list --workflow auto-version.yml --branch main --limit 1 --json status,conclusion,headSha --jq '.[0]')
  CONCLUSION=$(echo "$STATUS" | jq -r '.conclusion // empty')
  if [ "$CONCLUSION" = "success" ]; then
    break
  fi
  sleep 15
done

# Fetch the new version
PRE_VERSION=$(node -p "require('./packages/server/package.json').version")
NEW_VERSION=$(gh api repos/${REPO}/contents/packages/server/package.json --jq '.content' | base64 -d | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).version")
echo "Version: v${PRE_VERSION} → v${NEW_VERSION}"
```

If the workflow doesn't complete in 3 min, warn and continue — never block the rebuild on version verification.

If `--skip-version-check` is set, skip this phase.

### Phase 3: Desktop App Rebuild (Tauri)

**Skip if ANY of:**
- `--no-build` flag is set
- No PRs were merged (all skipped/blocked)
- Merged PRs only touch files in: `docs/`, `.github/`, `packages/app/`, `scripts/`, `*.md`

**Always rebuild when ANY merged PR touches:**
- `packages/server/` (server code or dashboard)
- `packages/desktop/` (Tauri app)
- `packages/protocol/` (shared protocol)

#### Step 3a: Pull version-bumped main

```bash
git checkout main
git pull --ff-only origin main
# If fast-forward fails (divergent from stale cherry-picks/worktrees):
# git reset --hard origin/main
```

Verify local version matches expected:
```bash
LOCAL_VERSION=$(node -p "require('./packages/server/package.json').version")
echo "Local version: v${LOCAL_VERSION}"
```

#### Step 3b: Build dashboard

**CRITICAL: Set `TAURI_ENV_PLATFORM=darwin` — without it, Vite uses `/dashboard/` base path instead of `/`, causing white screen in the Tauri webview.**

```bash
TAURI_ENV_PLATFORM=darwin PATH="/opt/homebrew/opt/node@22/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:$PATH" \
  npm run --workspace=packages/server dashboard:build
```

#### Step 3c: Verify dashboard base path

```bash
grep 'src=' packages/server/src/dashboard-next/dist/index.html
# MUST show: src="/assets/..."
# If it shows: src="/dashboard/assets/..." → STOP. Rebuild with TAURI_ENV_PLATFORM=darwin.
```

#### Step 3d: Bundle server

```bash
PATH="/opt/homebrew/opt/node@22/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:$PATH" \
  bash packages/desktop/scripts/bundle-server.sh
```

#### Step 3e: Build Rust binary

```bash
cd packages/desktop
touch src-tauri/src/lib.rs    # Force relink to pick up new resources
cargo build --release --manifest-path src-tauri/Cargo.toml
```

#### Step 3f: Bundle, sign, and install

```bash
cd packages/desktop
rm -rf src-tauri/target/release/bundle    # Clear cached bundles
cargo tauri bundle --bundles app
# Tauri's codesign will fail ($APPLE_SIGNING_IDENTITY not set) — ad-hoc sign instead:
codesign --force --deep --sign - src-tauri/target/release/bundle/macos/Chroxy.app
rm -rf /Applications/Chroxy.app
cp -R src-tauri/target/release/bundle/macos/Chroxy.app /Applications/Chroxy.app
```

#### Step 3g: Verify installation

```bash
# Binary exists
ls -la /Applications/Chroxy.app/Contents/MacOS/chroxy-desktop

# Server bundle exists
ls /Applications/Chroxy.app/Contents/Resources/server/src/

# Dashboard base path is correct
grep 'src=' /Applications/Chroxy.app/Contents/Resources/server/src/dashboard-next/dist/index.html
# MUST show: src="/assets/..." NOT src="/dashboard/assets/..."
```

### Phase 4: Report

```markdown
## Merge Complete

| PR | Title | Status |
|----|-------|--------|
| #123 | feat: add feature | Merged |
| #456 | fix: resolve crash | Skipped (conflict) |

**Version:** v0.5.0 → v0.5.1
**Desktop app:** Rebuilt and installed at /Applications/Chroxy.app (v0.5.1)
**Dashboard base path:** /assets/ (verified)
```

## Common Pitfalls

1. **White screen after launch**: Dashboard built without `TAURI_ENV_PLATFORM=darwin` — assets load from `/dashboard/assets/` which doesn't exist in Tauri webview. Always set `TAURI_ENV_PLATFORM=darwin`.

2. **Stale .app after rebuild**: `cargo tauri bundle` only re-bundles when the binary is relinked. `touch src-tauri/src/lib.rs` forces relink. Also `rm -rf target/release/bundle` clears cached bundles.

3. **`npm` commands fail with `ENOENT spawn sh`**: PATH doesn't include `/usr/bin:/bin`. Use full PATH: `PATH="/opt/homebrew/opt/node@22/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:$PATH"`

4. **Cargo.lock outdated after dependency changes**: Run `cargo generate-lockfile` in `src-tauri/` and commit.

5. **Divergent branches after cherry-pick sessions**: `git reset --hard origin/main` to sync.

6. **Code signing fails**: No Apple signing identity on dev machine. Use ad-hoc: `codesign --force --deep --sign -`

## Critical Rules

1. **NEVER merge without /full-review** — every PR must be reviewed before merging. This is a hard gate. Run Phase 0 first. The only exception is pure .md skill/doc files with zero code changes.
2. **For 3+ PRs, delegate to /batch-merge** — don't reinvent sequential merge logic
3. **Always set TAURI_ENV_PLATFORM=darwin** for dashboard builds
3. **Always touch src-tauri/src/lib.rs** before cargo build to force resource re-bundling
4. **Always rm -rf target/release/bundle** before cargo tauri bundle
5. **Always verify dashboard base path** — `/assets/` not `/dashboard/assets/`
6. **Version verification is informational** — never block the rebuild on it
7. **GraphQL resolveReviewThread must use Python** — bash corrupts Base64 thread IDs
8. **No attribution** — Zero Attribution Policy applies to all commits
9. **Node 22 required** — always prefix npm commands with Node 22 PATH
