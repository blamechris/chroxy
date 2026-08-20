# Windows test coverage measurement — #7270

Provenance for the `WINDOWS_EXEMPT` manifest in
`packages/server/scripts/lib/windows-test-set.mjs`. Every row in that manifest
was seeded from this measurement, not from grep.

## Method

Each `packages/server/tests/**/*.test.js` was run **in isolation**, with the
flags the CI Windows job uses:

```
node --import ./tests/_setup.mjs --experimental-test-module-mocks --test <one file>
```

| | |
|---|---|
| date | 2026-08-19 |
| host | Windows 11 (10.0.26100), i9-9900K — the same physical box as the `chroxy-win` runner |
| node | 22.23.1 (the runner tool-cache build, matching `setup-node`'s `node-version: 22`) |
| commit | `97ef8a030` |
| files measured | 553 |
| per-file timeout | 180s |

Two lanes walked the file list from opposite ends and met in the middle, so
54 files were measured twice. **All 54 agreed**, including
10 failing files that reproduced identical failure counts — so
these verdicts are deterministic, not flaky.

## Result

| | files | tests |
|---|---|---|
| pass — the derived run set | 481 | 10964 |
| fail / timeout — `WINDOWS_EXEMPT` | 72 | 2286 |

The Windows job ran **8 files / 193 tests** before this change.

Of the 2286 tests inside the exempt files, **1967 pass** and
only 315 fail. Exempting whole files is the blunt instrument: most of
these files fail a handful of their tests and the rest of the file is fine.
Reclaiming that coverage by guarding the individual tests with
`{ skip: process.platform === 'win32' }` is #7273 / #7274.

## The exempt files, as measured

| file | verdict | failed / total | reason | issue |
|---|---|---|---|---|
| `tests/anthropic-compatible.test.js` | fail | 10 / 79 | `posix-mode-assertion` | — |
| `tests/append-memory.test.js` | fail | 5 / 9 | `posix-perm-denied` | — |
| `tests/built-in-tools/bash-exec.test.js` | fail | 2 / 10 | `posix-signals` | — |
| `tests/byok-mcp-client.test.js` | fail | 2 / 33 | `posix-signals` | — |
| `tests/byok-mcp-config-mutation.test.js` | fail | 3 / 50 | `posix-mode-assertion` | — |
| `tests/byok-mcp-config-symlink-write.test.js` | fail | 5 / 17 | `posix-mode-assertion` | — |
| `tests/byok-mcp-trust-spawn-config.test.js` | fail | 3 / 37 | `posix-mode-assertion` | — |
| `tests/byok-mcp-trust.test.js` | fail | 1 / 43 | `posix-mode-assertion` | — |
| `tests/byok-session.test.js` | fail | 4 / 148 | `posix-shell-cmdstring` | — |
| `tests/byok-tool-executor.test.js` | fail | 9 / 85 | `posix-shell-cmdstring` | — |
| `tests/checkpoint-manager.test.js` | fail | 1 / 24 | `posix-perm-denied` | — |
| `tests/claude-tui-attachments.test.js` | fail | 2 / 19 | `node-pty` | — |
| `tests/claude-tui-ensure-cwd-trusted-write.test.js` | fail | 5 / 7 | `posix-mode-assertion` | — |
| `tests/claude-tui-session.test.js` | timeout | — / — | `node-pty` | — |
| `tests/componentwise-resolver.test.js` | fail | 2 / 12 | `posix-perm-denied` | — |
| `tests/config-dir-migration.test.js` | fail | 5 / 36 | `posix-mode-assertion` | — |
| `tests/config-dir.test.js` | fail | 1 / 15 | `posix-abs-path` | — |
| `tests/config-scheduler-gate.test.js` | fail | 1 / 9 | `posix-mode-assertion` | — |
| `tests/control-room-integrations.test.js` | fail | 23 / 72 | `windows-defect` | #7274 |
| `tests/control-room-reindex.test.js` | fail | 1 / 26 | `symlink-create` | — |
| `tests/control-room-repo-set.test.js` | fail | 4 / 11 | `windows-defect` | #7274 |
| `tests/control-room-rerun.test.js` | fail | 2 / 18 | `symlink-create` | — |
| `tests/control-room-runners.test.js` | fail | 5 / 39 | `windows-defect` | #7274 |
| `tests/conversation-scope.test.js` | fail | 1 / 8 | `windows-defect` | #7273 |
| `tests/credential-store.test.js` | fail | 1 / 22 | `posix-mode-assertion` | — |
| `tests/credentials-file.test.js` | fail | 4 / 5 | `posix-mode-assertion` | — |
| `tests/deepseek-credentials.test.js` | fail | 5 / 10 | `posix-mode-assertion` | — |
| `tests/deepseek-session.test.js` | fail | 1 / 21 | `posix-mode-assertion` | — |
| `tests/discord-webhook-sink.test.js` | fail | 2 / 114 | `posix-mode-assertion` | — |
| `tests/event-ingest.test.js` | fail | 1 / 52 | `posix-mode-assertion` | — |
| `tests/file-ref-attachments.test.js` | fail | 1 / 16 | `symlink-create` | — |
| `tests/git-stage-commit.test.js` | fail | 2 / 9 | `windows-defect` | #7273 |
| `tests/handler-utils.test.js` | fail | 5 / 142 | `windows-defect` | #7273 |
| `tests/handlers/checkpoint-handlers.test.js` | fail | 1 / 37 | `windows-defect` | #7273 |
| `tests/handlers/conversation-handlers.test.js` | fail | 3 / 38 | `windows-defect` | #7273 |
| `tests/is-entry-point.test.js` | fail | 1 / 14 | `posix-perm-denied` | — |
| `tests/lint-entry-point-guard.test.js` | fail | 1 / 62 | `posix-perm-denied` | — |
| `tests/list-files.test.js` | fail | 4 / 18 | `windows-defect` | #7273 |
| `tests/logger-audit-retention.test.js` | fail | 4 / 19 | `windows-defect` | #7274 |
| `tests/memory-read.test.js` | fail | 4 / 18 | `windows-defect` | #7273 |
| `tests/node-version-check.test.js` | fail | 2 / 4 | `posix-shell-spawn` | — |
| `tests/orchestration-git-ops.test.js` | fail | 3 / 19 | `windows-defect` | #7274 |
| `tests/pairing-refresh-qr.test.js` | fail | 1 / 3 | `windows-defect` | #7274 |
| `tests/permission-hook-failclosed.test.js` | fail | 4 / 4 | `posix-shell-spawn` | — |
| `tests/permission-hook-floor.test.js` | fail | 50 / 98 | `posix-shell-spawn` | — |
| `tests/permission-hook-multi-question.test.js` | fail | 17 / 17 | `posix-shell-spawn` | — |
| `tests/permission-hook-posttooluse-cleanup.test.js` | fail | 6 / 6 | `posix-shell-spawn` | — |
| `tests/permission-hook-sanitization.test.js` | timeout | — / — | `posix-shell-spawn` | — |
| `tests/permission-hook-sibling-deny.test.js` | fail | 11 / 11 | `posix-shell-spawn` | — |
| `tests/permission-hook-sidecar-integration.test.js` | fail | 9 / 9 | `posix-shell-spawn` | — |
| `tests/permission-manager-floor-symlink-evasion.test.js` | fail | 2 / 21 | `symlink-create` | — |
| `tests/permission-manager.test.js` | fail | 1 / 96 | `windows-defect` | #7274 |
| `tests/permission-resolver.test.js` | fail | 2 / 17 | `windows-defect` | #7274 |
| `tests/permission-rule-store.test.js` | fail | 4 / 34 | `windows-defect` | #7274 |
| `tests/providers.test.js` | fail | 7 / 98 | `windows-defect` | #7274 |
| `tests/scheduled-task-store.test.js` | fail | 1 / 51 | `posix-abs-path` | — |
| `tests/security/path-traversal.test.js` | fail | 1 / 14 | `symlink-create` | — |
| `tests/skills-inventory-survey.test.js` | fail | 1 / 16 | `posix-abs-path` | — |
| `tests/skills-trust.test.js` | fail | 2 / 59 | `windows-defect` | #7274 |
| `tests/skills-usage.test.js` | fail | 1 / 24 | `windows-defect` | #7274 |
| `tests/snapshots-store.test.js` | fail | 1 / 23 | `posix-abs-path` | — |
| `tests/spawn-env.test.js` | fail | 1 / 48 | `posix-abs-path` | — |
| `tests/statusline.test.js` | fail | 9 / 25 | `posix-shell-cmdstring` | — |
| `tests/user-shell-session.test.js` | fail | 1 / 25 | `node-pty` | — |
| `tests/worktree-gc.test.js` | fail | 2 / 38 | `windows-defect` | #7274 |
| `tests/write-file.test.js` | fail | 6 / 15 | `windows-defect` | #7273 |
| `tests/ws-file-ops-common.test.js` | fail | 4 / 8 | `windows-defect` | #7273 |
| `tests/ws-file-ops-error-paths.test.js` | fail | 5 / 12 | `windows-defect` | #7273 |
| `tests/ws-file-ops-git-paths.test.js` | fail | 2 / 16 | `windows-defect` | #7273 |
| `tests/ws-file-ops-raw-path-symlink-evasion.test.js` | fail | 3 / 13 | `symlink-create` | — |
| `tests/ws-git-result-schemas.test.js` | fail | 1 / 5 | `windows-defect` | #7274 |
| `tests/ws-server-file-ops.test.js` | fail | 18 / 53 | `windows-defect` | #7273 |

## Slowest files in the run set

A single file that hangs is worse than one that fails: it eats the job budget,
and a timeout kill is indistinguishable from a hang. The two timeouts above are
exempt for exactly that reason. The slowest files that DO pass:

| file | ms |
|---|---|
| `tests/lint-config-dir.test.js` | 27624 |
| `tests/tunnel/cloudflare.test.js` | 27513 |
| `tests/byok-mcp-fleet.test.js` | 21861 |
| `tests/environments/backends/backend-seam.test.js` | 17696 |
| `tests/ws-server.test.js` | 13862 |
| `tests/cli/schedule-cmd.test.js` | 12684 |
| `tests/push.test.js` | 12311 |
| `tests/lint-session-opt-forwarding.test.js` | 11508 |
| `tests/ws-server-auth.test.js` | 10678 |
| `tests/session-manager-worktree.test.js` | 10634 |

Total sequential time for the run set is 590s; the job runs
them concurrently, so wall-clock is far lower.

## Re-measuring

The harness is not committed — it is ~80 lines that spawn one child per file and
record the verdict. If the manifest needs re-seeding, the shape is:

1. clone the repo on a Windows host, `npm ci`, build `@chroxy/protocol`
2. for each `tests/**/*.test.js`, spawn the command at the top of this file with
   a wall-clock timeout, and record `{ exit, timedOut, tests, fail }`
3. re-run the failures once more and keep only verdicts that agree

Step 3 is not optional: it is what distinguishes a POSIX dependency from a flake,
and it is why every row in the manifest carries a `symptom`.

## Known limitation

This is a snapshot of ONE host. The measuring box's Defender configuration,
PATH, and service-account home differ from the `chroxy-win` runner's, and fork
PRs run on `windows-latest`, which is a different image again. Expect the first
few CI runs to be the second measurement.
