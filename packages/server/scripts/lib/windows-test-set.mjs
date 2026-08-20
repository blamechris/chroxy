// windows-test-set.mjs — the ONE enumeration of which server test files run on
// Windows, and the manifest of the ones that do not (#7270).
//
// ── Why this file exists ────────────────────────────────────────────────────
//
// `Server Windows Tests` used to name EIGHT test files by hand while
// `packages/server/tests/` grew to 553. Anything added after that list was
// written — including `setup-sandbox-binding-forms.test.js` (#7266), which is
// entirely about path handling and errno behaviour and is precisely what
// Windows coverage is for — was never run there, and nothing said so. The job
// went green in 58 seconds and its green told you nothing about the file.
//
// That is `docs/false-safety-guards.md`'s "Checked a subset" mode, in CI config
// rather than in a script: a hardcoded list beside a set that grows.
//
// The list is now INVERTED, per that document's own guidance (:283):
//
//   > A list of things to CHECK fails silently when it falls behind; a list of
//   > things EXEMPT from a walk over everything fails loudly, because the walk
//   > hits the missing entry and complains. Same data structure, opposite
//   > failure direction.
//
// So: walk every `*.test.js`, subtract `WINDOWS_EXEMPT`, run the rest. A new
// test file runs on Windows BY DEFAULT. There is no "unclassified" state to
// detect — an unclassified POSIX-only file simply makes the job red, in its own
// TAP output, naming itself. Silence is not reachable.
//
// ── What the gate is actually for ───────────────────────────────────────────
//
// Because the structure above cannot fail silently, the gate's job is narrower
// and sharper: stop `WINDOWS_EXEMPT` from becoming the new silent skip. It is
// checked by `lint-windows-test-exemptions.mjs`, which runs on LINUX in
// `Server Lint` — a REQUIRED status check. `Server Windows Tests` is not one,
// so a manifest defect has to be caught somewhere that actually blocks a merge.
//
// ── The seeding rule, which is not optional ─────────────────────────────────
//
// Every row here was seeded from a MEASURED run on a real Windows host, never
// from grep. Grep cannot do this job in either direction:
//
//   * `tests/built-in-tools/bash-exec.test.js` contains no `spawn(` at all, yet
//     `src/built-in-tools/bash-exec.js` spawns `bash -c` — hostile, invisible
//     to a grep of the test.
//   * All 46 files matching /docker/i drive fakes; none spawns a real docker.
//     A grep-seeded list would have exempted 46 files that pass fine.
//
// The measurement is recorded in `docs/records/windows-test-coverage-7270.md`.

import { readdirSync, existsSync, statSync } from 'node:fs'
import { join, relative, sep, resolve } from 'node:path'

// ── The reason taxonomy ─────────────────────────────────────────────────────
//
// Reasons are a CLOSED SET of category tokens, not free prose. Free text in an
// exemption list decays into "windows lol" within a year and cannot be checked
// by anything. The category says why the CLASS is exempt; each row's `note`
// says why THAT FILE is in the class.
//
// `kind` is the half that matters most:
//   * 'permanent' — the mechanism has no Windows analogue and never will. There
//     is nothing to fix, so the row must NOT carry an issue number.
//   * 'debt'      — the file COULD run on Windows; it doesn't yet. The row MUST
//     carry an issue number, or it is a permanent exemption wearing a temporary
//     label, which is the failure mode this whole taxonomy exists to prevent.
export const EXEMPT_REASONS = {
  'node-pty': {
    kind: 'permanent',
    why: "node-pty's Windows backend is ConPTY, with different exit, signal and resize semantics. These suites assert POSIX PTY behaviour directly.",
  },
  'posix-shell-spawn': {
    kind: 'permanent',
    why: "spawns /bin/bash or /bin/sh as argv[0]. Neither path exists on Windows; C:\\Windows\\System32\\bash.exe is WSL and has no distro under the runner's service account (see the shell: powershell note in ci.yml).",
  },
  'shebang-exec': {
    kind: 'permanent',
    why: 'writes a #!/usr/bin/env node shim, chmods it 0o755 and execs it directly. Windows honours no shebang and has no exec bit.',
  },
  'posix-signals': {
    kind: 'permanent',
    why: 'depends on real POSIX signal delivery — a SIGTERM grace window before SIGKILL, say. Windows has no signals; a child terminates at once, so the timing under test cannot happen.',
  },
  'posix-mode-assertion': {
    kind: 'permanent',
    why: 'asserts statSync(p).mode & 0o777 against a POSIX value. Windows reports 0o666/0o444 regardless, so the security-boundary assertion is not merely failing — it is meaningless.',
  },
  'posix-perm-denied': {
    kind: 'permanent',
    why: 'stages an EACCES fixture by chmod 0o000/0o500. Windows ACLs do not map to chmod, the denial never happens, and the negative test proves nothing.',
  },
  'posix-uid': {
    kind: 'permanent',
    why: 'process.getuid()/getgid() are undefined on Windows, used for root-detection skips and ownership assertions.',
  },
  'symlink-create': {
    kind: 'permanent',
    why: 'fs.symlinkSync needs SeCreateSymbolicLinkPrivilege or Developer Mode; unprivileged CI gets EPERM. Mostly path-traversal and floor-evasion security tests.',
  },
  'launchd-systemd': {
    kind: 'permanent',
    why: 'asserts .plist / LaunchAgents / systemd-unit generation and launchctl / systemctl invocation. The Windows analogue is schtasks, a different code path with its own coverage.',
  },
  'posix-shell-cmdstring': {
    kind: 'permanent',
    why: "passes a POSIX shell command string (';', '>&2', 'exit 42', 'sleep', 'pwd') to a helper that shells out. cmd.exe and PowerShell parse none of it.",
  },
  'posix-tooling': {
    kind: 'permanent',
    why: "invokes POSIX-only tooling such as `which` (Windows is `where`), often at module scope so the file cannot even load.",
  },
  'posix-abs-path': {
    kind: 'permanent',
    why: "hardcodes rooted POSIX paths ('/tmp/…', '/etc/…', '/usr/…') as real filesystem targets. On Windows these resolve onto the current drive and the semantics under test do not survive the translation.",
  },
  'windows-defect': {
    kind: 'debt',
    why: 'a genuine cross-platform defect in the code or the test, not a POSIX dependency. The file SHOULD run on Windows once the linked issue is fixed.',
  },
  'windows-slow': {
    kind: 'debt',
    why: 'hangs or is pathologically slow on Windows for a reason not yet diagnosed. Excluded so it cannot eat the job budget; the linked issue tracks the diagnosis.',
  },
}

// The MEASURED observation that justifies the row, from a real Windows run.
// 'fail' — ran and reported failing assertions. 'timeout' — did not terminate.
// 'load-error' — could not even be imported.
export const EXEMPT_SYMPTOMS = new Set(['fail', 'timeout', 'load-error'])

// Ceiling on how much of the suite may be exempt. Exempting in BULK is how
// #7270 happened in the first place, and no per-row check can see it: every
// individual row can be impeccable while the aggregate quietly becomes "most of
// the suite". Measured at 13.0% (72/553) when this landed; the ceiling is set
// with headroom for honest growth and nowhere near a doubling.
export const MAX_EXEMPT_RATIO = 0.20

// ── The manifest ────────────────────────────────────────────────────────────
//
// Every row was seeded from a measured run of that file, in isolation, on a
// real Windows host with the flags the CI job uses. 481 of the 553 files pass
// unmodified; these 72 do not. Per-file verdicts and durations are recorded in
// docs/records/windows-test-coverage-7270.md.
//
// A category may currently classify zero rows. That is not dead weight: it
// means every file using that mechanism already guards its POSIX-only tests
// with `{ skip: process.platform === 'win32' }`, which is the PREFERRED fix and
// the reason those files run here at all. Exempting a whole file is the blunt
// instrument — most rows below fail only a handful of their tests (measured:
// tests/permission-manager.test.js fails 1 of 96, tests/discord-webhook-sink.test.js
// 2 of 114), so ~1,967 passing tests sit inside these 72 files and are not run
// on Windows. Reclaiming them by guarding the individual tests is #7273/#7274.
export const WINDOWS_EXEMPT = [
  // ── node-pty / ConPTY (3)
  {
    file: 'tests/claude-tui-attachments.test.js',
    reason: 'node-pty',
    symptom: 'fail',
    note: 'numbers PTY-delivered attachments sequentially against POSIX temp paths',
  },
  {
    file: 'tests/claude-tui-session.test.js',
    reason: 'node-pty',
    symptom: 'timeout',
    note: 'drives a real PTY for the claude TUI trust dialog; on Windows the ConPTY session never reaches the expected state and the file does not terminate',
  },
  {
    file: 'tests/user-shell-session.test.js',
    reason: 'node-pty',
    symptom: 'fail',
    note: 'asserts the primary API_TOKEN is stripped from the shell PTY env, over a real PTY',
  },
  // ── spawns a POSIX shell or a .sh script (8)
  {
    file: 'tests/node-version-check.test.js',
    reason: 'posix-shell-spawn',
    symptom: 'fail',
    note: 'spawns the version-check through a POSIX shell and asserts on its stderr',
  },
  {
    file: 'tests/permission-hook-failclosed.test.js',
    reason: 'posix-shell-spawn',
    symptom: 'fail',
    note: 'spawns hooks/permission-hook.sh via /bin/bash to prove an unreachable daemon denies by default',
  },
  {
    file: 'tests/permission-hook-floor.test.js',
    reason: 'posix-shell-spawn',
    symptom: 'fail',
    note: 'spawns hooks/permission-hook.sh via /bin/bash for the whole protected-path floor matrix',
  },
  {
    file: 'tests/permission-hook-multi-question.test.js',
    reason: 'posix-shell-spawn',
    symptom: 'fail',
    note: 'spawns hooks/permission-hook.sh via /bin/bash to prove multi-question forms are denied',
  },
  {
    file: 'tests/permission-hook-posttooluse-cleanup.test.js',
    reason: 'posix-shell-spawn',
    symptom: 'fail',
    note: 'spawns hooks/permission-hook.sh via /bin/bash to exercise the PostToolUse lock cleanup',
  },
  {
    file: 'tests/permission-hook-sanitization.test.js',
    reason: 'posix-shell-spawn',
    symptom: 'timeout',
    note: 'spawns hooks/permission-hook.sh via /bin/bash; on Windows the spawn never resolves and the file does not terminate',
  },
  {
    file: 'tests/permission-hook-sibling-deny.test.js',
    reason: 'posix-shell-spawn',
    symptom: 'fail',
    note: 'spawns hooks/permission-hook.sh via /bin/bash to exercise the sibling AskUserQuestion lock',
  },
  {
    file: 'tests/permission-hook-sidecar-integration.test.js',
    reason: 'posix-shell-spawn',
    symptom: 'fail',
    note: 'spawns hooks/permission-hook.sh via /bin/bash to exercise sidecar newline and CRLF handling',
  },
  // ── passes a POSIX shell command string (3)
  {
    file: 'tests/byok-session.test.js',
    reason: 'posix-shell-cmdstring',
    symptom: 'fail',
    note: 'runs a Bash command through the unstubbed executor and asserts secret redaction in the subprocess env',
  },
  {
    file: 'tests/byok-tool-executor.test.js',
    reason: 'posix-shell-cmdstring',
    symptom: 'fail',
    note: 'runs POSIX shell command strings through the executor and captures stdout and exit codes from them',
  },
  {
    file: 'tests/statusline.test.js',
    reason: 'posix-shell-cmdstring',
    symptom: 'fail',
    note: 'drives the statusline command through a POSIX shell string that cmd.exe does not parse',
  },
  // ── POSIX signal semantics (2)
  {
    file: 'tests/built-in-tools/bash-exec.test.js',
    reason: 'posix-signals',
    symptom: 'fail',
    note: 'asserts SIGKILL escalation after the child ignores SIGTERM (#4067), and asserts cwd is /tmp (measured: /mnt/a/tmp)',
  },
  {
    file: 'tests/byok-mcp-client.test.js',
    reason: 'posix-signals',
    symptom: 'fail',
    note: 'asserts destroy() waits KILL_GRACE_MS between SIGTERM and SIGKILL; measured 4ms against an expected ~1000ms because the child dies at once',
  },
  // ── asserts POSIX mode bits (NTFS reports 0666/0444 regardless) (14)
  {
    file: 'tests/anthropic-compatible.test.js',
    reason: 'posix-mode-assertion',
    symptom: 'fail',
    note: 'asserts a credentials file is refused unless mode 0600; NTFS reports 0666 so the security boundary under test does not exist',
  },
  {
    file: 'tests/byok-mcp-config-mutation.test.js',
    reason: 'posix-mode-assertion',
    symptom: 'fail',
    note: 'asserts the MCP config is created 0600 and that an existing mode is preserved; measured 384 expected, 438 actual',
  },
  {
    file: 'tests/byok-mcp-config-symlink-write.test.js',
    reason: 'posix-mode-assertion',
    symptom: 'fail',
    note: 'preserves the symlink TARGET\'s POSIX mode on the target while keeping the link intact',
  },
  {
    file: 'tests/byok-mcp-trust-spawn-config.test.js',
    reason: 'posix-mode-assertion',
    symptom: 'fail',
    note: 'warns only when the config is group/world-readable, which is a POSIX mode concept with no NTFS equivalent',
  },
  {
    file: 'tests/byok-mcp-trust.test.js',
    reason: 'posix-mode-assertion',
    symptom: 'fail',
    note: 'asserts recordTrust creates the trust file with mode 0600; measured 384 expected, 438 actual',
  },
  {
    file: 'tests/claude-tui-ensure-cwd-trusted-write.test.js',
    reason: 'posix-mode-assertion',
    symptom: 'fail',
    note: 'asserts a 0600 config is still 0600 after the trust pre-write, through a dotfiles symlink',
  },
  {
    file: 'tests/config-dir-migration.test.js',
    reason: 'posix-mode-assertion',
    symptom: 'fail',
    note: 'asserts 0600 file modes survive the migration, and shells out to a printed cp command',
  },
  {
    file: 'tests/config-scheduler-gate.test.js',
    reason: 'posix-mode-assertion',
    symptom: 'fail',
    note: 'asserts the scheduler config is written with restricted 0600 permissions',
  },
  {
    file: 'tests/credential-store.test.js',
    reason: 'posix-mode-assertion',
    symptom: 'fail',
    note: 'asserts a persisted Anthropic key lands at mode 0600',
  },
  {
    file: 'tests/credentials-file.test.js',
    reason: 'posix-mode-assertion',
    symptom: 'fail',
    note: 'refuses a credentials file more permissive than 0600 and returns a chmod hint; the whole file is about POSIX modes',
  },
  {
    file: 'tests/deepseek-credentials.test.js',
    reason: 'posix-mode-assertion',
    symptom: 'fail',
    note: 'reads the key only at mode 0600 and refuses 0644 as a security boundary',
  },
  {
    file: 'tests/deepseek-session.test.js',
    reason: 'posix-mode-assertion',
    symptom: 'fail',
    note: 'start() resolves credentials through the file path with 0600 enforcement',
  },
  {
    file: 'tests/discord-webhook-sink.test.js',
    reason: 'posix-mode-assertion',
    symptom: 'fail',
    note: 'refuses a credentials file that is not 0600, and stages an EACCES stat failure by chmod',
  },
  {
    file: 'tests/event-ingest.test.js',
    reason: 'posix-mode-assertion',
    symptom: 'fail',
    note: 'asserts the ingest secret is created 0600 with base64url content',
  },
  // ── stages EACCES with chmod, which Windows ACLs do not honour (5)
  {
    file: 'tests/append-memory.test.js',
    reason: 'posix-perm-denied',
    symptom: 'fail',
    note: 'stages an unwritable CLAUDE.md by chmod to prove the error path; Windows never denies, so the write succeeds and the assertion inverts',
  },
  {
    file: 'tests/checkpoint-manager.test.js',
    reason: 'posix-perm-denied',
    symptom: 'fail',
    note: 'makes the disk write fail by chmod to prove checkpoint_persist_failed is emitted; the write succeeds on Windows so nothing is emitted',
  },
  {
    file: 'tests/componentwise-resolver.test.js',
    reason: 'posix-perm-denied',
    symptom: 'fail',
    note: 'asserts EACCES on an unreadable directory propagates from both resolvers, and stages a symlinked-parent escape',
  },
  {
    file: 'tests/is-entry-point.test.js',
    reason: 'posix-perm-denied',
    symptom: 'fail',
    note: 'chmods argv[1] unreadable to reach the undecidable-case warning (#7226); Windows still reads it',
  },
  {
    file: 'tests/lint-entry-point-guard.test.js',
    reason: 'posix-perm-denied',
    symptom: 'fail',
    note: 'stages an unreadable file to prove the lint exits 2 rather than 1; Windows reads it and the fail-closed path is never taken',
  },
  // ── needs symlink creation privilege (6)
  {
    file: 'tests/control-room-reindex.test.js',
    reason: 'symlink-create',
    symptom: 'fail',
    note: 'accepts a symlink that realpaths to a surveyed repo and runs against the canonical path',
  },
  {
    file: 'tests/control-room-rerun.test.js',
    reason: 'symlink-create',
    symptom: 'fail',
    note: 'runs against the canonical realpath for a symlinked repo path',
  },
  {
    file: 'tests/file-ref-attachments.test.js',
    reason: 'symlink-create',
    symptom: 'fail',
    note: 'asserts an error for a symlink escaping the project directory; the link cannot be created so the file is merely not found',
  },
  {
    file: 'tests/permission-manager-floor-symlink-evasion.test.js',
    reason: 'symlink-create',
    symptom: 'fail',
    note: 'the #6921 PoC needs a real symlink to prove the floor blocks the escape; without it the raw write lands on the fixture, not the target',
  },
  {
    file: 'tests/security/path-traversal.test.js',
    reason: 'symlink-create',
    symptom: 'fail',
    note: 'the unicode-normalisation and percent-encoding cases are staged through symlinks that cannot be created unprivileged',
  },
  {
    file: 'tests/ws-file-ops-raw-path-symlink-evasion.test.js',
    reason: 'symlink-create',
    symptom: 'fail',
    note: 'the raw-path PoC needs work -> .claude/worktrees to be a real symlink to resolve out of the project',
  },
  // ── hardcodes a rooted POSIX path as the expected value (5)
  {
    file: 'tests/config-dir.test.js',
    reason: 'posix-abs-path',
    symptom: 'fail',
    note: 'expects configPath() to return \'/tmp/relocated-chroxy\'; Windows correctly yields the same path drive-rooted',
  },
  {
    file: 'tests/scheduled-task-store.test.js',
    reason: 'posix-abs-path',
    symptom: 'fail',
    note: 'expects \'/home/x/.chroxy/scheduled-tasks.json\'; Windows correctly yields the drive-rooted spelling',
  },
  {
    file: 'tests/skills-inventory-survey.test.js',
    reason: 'posix-abs-path',
    symptom: 'fail',
    note: 'expects \'/home/u/.chroxy/skills.lock\' as a literal string rather than composing it with path.join',
  },
  {
    file: 'tests/snapshots-store.test.js',
    reason: 'posix-abs-path',
    symptom: 'fail',
    note: 'expects the CHROXY_CONFIG_DIR override to yield \'/tmp/chroxy-test-config-x/snapshots\' as a literal POSIX string',
  },
  {
    file: 'tests/spawn-env.test.js',
    reason: 'posix-abs-path',
    symptom: 'fail',
    note: 'asserts PATH and HOME are preserved by comparing against literal \'/usr/bin\'',
  },
  // ── TRACKED DEBT — not a POSIX mechanism; should pass on Windows (26)
  {
    file: 'tests/control-room-integrations.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'the configured-repo snapshot and report command produce no conformant output on Windows',
    issue: 7274,
  },
  {
    file: 'tests/control-room-repo-set.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'repo discovery misses .git entries and does not de-dupe config entries by realpath',
    issue: 7274,
  },
  {
    file: 'tests/control-room-runners.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'the runner survey groups nothing (expected 4, measured 0) and gh enrichment does not run',
    issue: 7274,
  },
  {
    file: 'tests/conversation-scope.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'cwd exact-match and subdirectory filtering does not match on Windows paths',
    issue: 7273,
  },
  {
    file: 'tests/git-stage-commit.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'staging an in-project file is refused: \'Access denied: path outside project directory\'',
    issue: 7273,
  },
  {
    file: 'tests/handler-utils.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'backslash traversal (..\\) is not caught on Windows, where it IS a real separator — security-relevant',
    issue: 7273,
  },
  {
    file: 'tests/handlers/checkpoint-handlers.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'the \'files\' restore mode does not revert the real working tree on Windows',
    issue: 7273,
  },
  {
    file: 'tests/handlers/conversation-handlers.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'a spoofed client-supplied cwd hint is honoured instead of the recorded cwd — security-relevant',
    issue: 7273,
  },
  {
    file: 'tests/list-files.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'recursive depth counting is wrong, most likely counting separators',
    issue: 7273,
  },
  {
    file: 'tests/logger-audit-retention.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'truncate-in-place while a writer holds the handle is not permitted on Windows',
    issue: 7274,
  },
  {
    file: 'tests/memory-read.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'CLAUDE.md precedence and @import resolution fail on Windows path composition',
    issue: 7273,
  },
  {
    file: 'tests/orchestration-git-ops.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'git operations fail on Windows; no per-assertion detail was captured in the measurement',
    issue: 7274,
  },
  {
    file: 'tests/pairing-refresh-qr.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'PairingManager does not emit pairing_refreshed on a manual refresh',
    issue: 7274,
  },
  {
    file: 'tests/permission-manager.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'a persistent project rule does not reach the audit sink with the expected projectKey',
    issue: 7274,
  },
  {
    file: 'tests/permission-resolver.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'allowAlways carries a projectKey that is not the stable normalized key on Windows',
    issue: 7274,
  },
  {
    file: 'tests/permission-rule-store.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'normalizeProjectKey does not collapse Windows path spellings to a stable key',
    issue: 7274,
  },
  {
    file: 'tests/providers.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'provider auth status misreports readiness and source when the key is in credentials.json',
    issue: 7274,
  },
  {
    file: 'tests/skills-trust.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'the write-failure path does not throw, so callers cannot surface persistence errors',
    issue: 7274,
  },
  {
    file: 'tests/skills-usage.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'a corrupt usage file does not degrade to an empty store',
    issue: 7274,
  },
  {
    file: 'tests/worktree-gc.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'a relative gitdir pointer is not resolved against the worktree dir, and a dirty-dead worktree is dropped',
    issue: 7274,
  },
  {
    file: 'tests/write-file.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'a plain in-project write is refused with \'Access denied: file writing is restricted to the project directory\'',
    issue: 7273,
  },
  {
    file: 'tests/ws-file-ops-common.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'realpath resolution of existing and non-existent leaves disagrees with the POSIX result',
    issue: 7273,
  },
  {
    file: 'tests/ws-file-ops-error-paths.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'ENOTDIR and not-found paths surface as \'Access denied\' instead of their real errors',
    issue: 7273,
  },
  {
    file: 'tests/ws-file-ops-git-paths.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'gitStage rejects valid relative paths within CWD as outside the workspace',
    issue: 7273,
  },
  {
    file: 'tests/ws-git-result-schemas.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'the fixture never produces a commit, so its own CONTROL assertion fails before any schema is checked',
    issue: 7274,
  },
  {
    file: 'tests/ws-server-file-ops.test.js',
    reason: 'windows-defect',
    symptom: 'fail',
    note: 'browse/read reject in-project paths with \'Access denied: directory listing is restricted\'',
    issue: 7273,
  },
]

// The load-bearing suites, stated INDEPENDENTLY of the manifest above.
//
// This is the one thing here written twice, deliberately, and it is the same
// trade `docs/false-safety-guards.md:185-192` describes: a derived assertion
// cannot test the parameter it derives from. Everything else in this file is
// computed from WINDOWS_EXEMPT, so MOVING a file into WINDOWS_EXEMPT deletes
// both its Windows coverage and every derived objection to that deletion, in a
// single edit, with the suite still green. That mutation was run against an
// earlier draft and it passed.
//
// A roster is itself a hardcoded list beside a growing set, and it will degrade
// as the suite grows — accepted, because it can only ever ADD failures. It can
// never make this gate report false success. MAX_EXEMPT_RATIO covers bulk
// drift; this covers the single-file relocation of a security boundary.
export const MUST_RUN_ON_WINDOWS = [
  // The two suites #7270 was filed about: entirely path-handling and errno
  // behaviour, i.e. exactly what Windows coverage is for.
  'tests/setup-sandbox-binding-forms.test.js',
  'tests/setup-sandbox-coverage.test.js',
  // The platform seam itself.
  'tests/platform.test.js',
  'tests/platform-windows.test.js',
  'tests/win-spawn.test.js',
  'tests/windows-cmd-routing.test.js',
  'tests/resolve-binary.test.js',
  'tests/control-room-wsl.test.js',
  'tests/keychain-windows.test.js',
  'tests/service.test.js',
]

/**
 * Walk `testsRoot` for `*.test.js`, returning paths relative to the SERVER
 * package root (`tests/foo.test.js`), separator-normalised to `/`.
 *
 * Normalisation is not cosmetic. On Windows `relative()` yields backslashes;
 * unnormalised, ZERO manifest rows would match and the job would go red on
 * every POSIX-only file at once — loud, but baffling.
 */
export function enumerateTestFiles(testsRoot) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.test.js')) out.push(full)
    }
  }
  walk(testsRoot)
  const pkgRoot = resolve(testsRoot, '..')
  return out.map((p) => relative(pkgRoot, p).split(sep).join('/')).sort()
}

/**
 * The single derivation both the gate and the runner use.
 *
 * Returns `{ all, exempt, run, problems }`. `problems` is a list of
 * `{ severity, message }`; `severity` is 'broken' when the gate could not do
 * its job (exit 2) and 'manifest' when the manifest is wrong (exit 1). It never
 * throws for a manifest defect and never exits — the callers decide.
 */
export function resolveWindowsTestSet({
  testsRoot,
  manifest = WINDOWS_EXEMPT,
  mustRun = MUST_RUN_ON_WINDOWS,
  reasons = EXEMPT_REASONS,
  maxExemptRatio = MAX_EXEMPT_RATIO,
  minFiles = 0,
} = {}) {
  const problems = []
  const broken = (message) => problems.push({ severity: 'broken', message })
  const manifestErr = (message) => problems.push({ severity: 'manifest', message })

  if (!existsSync(testsRoot) || !statSync(testsRoot).isDirectory()) {
    broken(`tests root ${testsRoot} does not exist or is not a directory — refusing to report a set.`)
    return { all: [], exempt: [], run: [], problems }
  }

  const all = enumerateTestFiles(testsRoot)

  // "Walked zero files" and "walked 553 clean files" must never be the same
  // observable outcome (docs/false-safety-guards.md:307).
  if (all.length === 0) {
    broken(`walked 0 test files under ${testsRoot} — refusing to report a clean set.`)
    return { all, exempt: [], run: [], problems }
  }
  if (all.length < minFiles) {
    broken(
      `walked only ${all.length} test file(s) under ${testsRoot}, expected at least ${minFiles}. ` +
      'Either the walk broke or the --min-files floor is stale.',
    )
  }

  const known = new Set(all)
  const seen = new Set()
  const exempt = []

  for (const row of manifest) {
    const where = row && row.file ? row.file : JSON.stringify(row)

    if (!row || typeof row.file !== 'string' || !row.file) {
      manifestErr(`${where}: row has no 'file'.`)
      continue
    }
    if (seen.has(row.file)) {
      manifestErr(`${row.file}: appears twice in WINDOWS_EXEMPT. Whichever row is read first decides and the other silently means nothing.`)
      continue
    }
    seen.add(row.file)

    // A row pointing at a file that no longer exists means the manifest
    // describes a tree that is gone. That is the gate being broken, not the
    // manifest merely being wrong — exit 2, not 1.
    if (!known.has(row.file)) {
      broken(
        `${row.file}: exempt row points at a file that does not exist under ${testsRoot}. ` +
        'The manifest describes a tree that is gone — fix it before trusting this run.',
      )
      continue
    }

    const reason = reasons[row.reason]
    if (!reason) {
      manifestErr(
        `${row.file}: unknown reason ${JSON.stringify(row.reason)}. Reasons are a closed set — ` +
        `add a category to EXEMPT_REASONS with its rationale, or pick one of: ${Object.keys(reasons).join(', ')}.`,
      )
      continue
    }

    if (!EXEMPT_SYMPTOMS.has(row.symptom)) {
      manifestErr(
        `${row.file}: symptom must be one of ${[...EXEMPT_SYMPTOMS].join('|')} — the MEASURED observation ` +
        'from a real Windows run, not a guess. See docs/records/windows-test-coverage-7270.md.',
      )
    }

    if (typeof row.note !== 'string' || row.note.trim().length < 24) {
      manifestErr(
        `${row.file}: note is empty or too short. The category says why THIS CLASS is exempt; ` +
        'the note says why THIS FILE is in it.',
      )
    }

    if (reason.kind === 'debt' && !row.issue) {
      manifestErr(
        `${row.file}: reason ${JSON.stringify(row.reason)} is TRACKED DEBT and requires an issue number. ` +
        'A defect with no issue is a permanent exemption wearing a temporary label.',
      )
    }
    if (reason.kind === 'permanent' && row.issue) {
      manifestErr(
        `${row.file}: reason ${JSON.stringify(row.reason)} is permanent but carries issue ${row.issue}. ` +
        'If there is work to do, the reason is windows-defect or windows-slow.',
      )
    }

    exempt.push(row)
  }

  // The independently-stated roster (see MUST_RUN_ON_WINDOWS above).
  const exemptFiles = new Set(exempt.map((r) => r.file))
  for (const f of mustRun) {
    if (!known.has(f)) {
      broken(`${f}: named in MUST_RUN_ON_WINDOWS but not found under ${testsRoot}. The roster is stale.`)
      continue
    }
    if (exemptFiles.has(f)) {
      manifestErr(
        `${f} is in MUST_RUN_ON_WINDOWS and also in WINDOWS_EXEMPT. That is the exact mutation this ` +
        'roster exists to catch: relocating a load-bearing suite into the exempt list deletes its ' +
        'Windows coverage AND every derived objection to it in one edit.',
      )
    }
  }

  const run = all.filter((f) => !exemptFiles.has(f))

  if (all.length > 0) {
    const ratio = exempt.length / all.length
    if (ratio > maxExemptRatio) {
      manifestErr(
        `${exempt.length}/${all.length} = ${(ratio * 100).toFixed(1)}% of the server suite is exempt from ` +
        `Windows, above the ceiling of ${(maxExemptRatio * 100).toFixed(1)}%. Exempting in bulk is how ` +
        '#7270 happened; raise the ceiling only with a measured comment saying why.',
      )
    }
  }

  if (run.length === 0) {
    broken('the derived Windows run set is empty — refusing to report a green run.')
  }

  return { all, exempt, run, problems }
}
