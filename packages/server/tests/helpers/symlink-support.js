// Does THIS account, on THIS host, get to create a symlink? (#7273)
//
// On Windows `fs.symlink` needs SeCreateSymbolicLinkPrivilege, granted by
// Developer Mode or by holding the privilege outright. An interactive developer
// account usually has it; the GitHub Actions service account usually does not,
// and gets EPERM. Same physical box, different answer — which is exactly how
// this got missed: every one of the fifteen #7273 files was measured over SSH as
// the interactive user, where symlinks work, while `Server Windows Tests` runs
// as NETWORK SERVICE, where they do not. The failure surfaced only in CI, as
//
//   EPERM: operation not permitted, symlink
//     'C:\WINDOWS\SERVIC~1\NETWOR~1\AppData\Local\Temp\...'
//
// so the capability must be PROBED, never inferred from the platform.
//
// ── Why this is a probe and not a try/catch around each test ────────────────
//
// The tempting shape is `try { symlinkSync(...) } catch { return }` — several
// tests in this repo already do it. That is `docs/false-safety-guards.md` mode
// (4): "cannot check this" silently becoming "nothing to check". The test
// reports a PASS having asserted nothing, and would keep reporting a pass if the
// behaviour it guards were deleted.
//
// A `{ skip }` says so out loud instead: node prints `# SKIP <reason>` and
// counts it under `# skipped`, so the TAP output distinguishes "verified" from
// "could not verify". The security assertions these guard still RUN in full on
// every Linux CI job, which is where the coverage actually lives — Windows
// merely cannot build the fixture.

import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function probeSymlinkSupport() {
  let dir = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-symlink-probe-'))
    // Mirror what the guarded tests actually do: link to a real DIRECTORY with
    // no explicit type, so node picks 'dir'. A junction would succeed without
    // the privilege and would make this probe lie.
    const target = join(dir, 'target')
    mkdirSync(target)
    symlinkSync(target, join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
}

/** True when this account can create a symlink. Probed once, at import. */
export const SYMLINK_SUPPORTED = probeSymlinkSupport()

/**
 * Pass straight into a node:test `it`/`describe` options bag:
 *   it('...', { skip: SKIP_NO_SYMLINK }, async () => { ... })
 * `false` runs the test; a string skips it and prints the reason.
 */
export const SKIP_NO_SYMLINK = SYMLINK_SUPPORTED
  ? false
  : 'needs symlink creation privilege (fs.symlink -> EPERM for this account); the assertion runs on POSIX CI'

// ── `link/..` in a raw path: POSIX follows the link, Windows never sees it ───
//
// The #6921 / #6923 evasion rests on open(2) semantics: the kernel follows
// `link` FIRST and applies the `..` from the link's TARGET, so
// `<cwd>/link/../x` lands beside the target, not beside the link. On Windows
// that never happens. Node's fs calls `path.toNamespacedPath()` before any
// syscall, and on win32 that is `path.resolve()` plus a `\\?\` prefix — the
// `..` is collapsed as TEXT and the write lands on the lexical target.
// Measured on chroxy-win-01 under the #7288 symlink grant, node 22.23.1:
//
//   toNamespacedPath('<root>/link/../target.txt') -> \\?\<root>\target.txt
//   real/target.txt stays ORIGINAL; <root>/target.txt is created
//
// So a test that PROVES the attack with a raw write asserts something false on
// Windows. The guards themselves stay correct there: the BYOK executor writes
// to the walker's validated `realPath`, never the raw path, and the permission
// floor scans the lexical target before the component walk, so the target
// Windows actually writes is always one of the two it checks.
//
// This is a PLATFORM check on purpose, not a probe like SYMLINK_SUPPORTED
// above. The difference is not a privilege one account has and another lacks;
// it is what Node's win32 path layer does, on every account. A probe here could
// only ever add one failure mode — returning "unsupported" on POSIX for some
// unforeseen reason — and that would silently skip the proof on exactly the
// Linux job where it is load-bearing. On POSIX this is always `false`, so if
// the semantics ever changed there the test goes red instead of skipping.
export const SKIP_WIN32_LEXICAL_DOTDOT = process.platform === 'win32'
  ? 'Node collapses .. in a raw path as text on win32 (path.toNamespacedPath), so a write never follows the link first; the premise runs on POSIX CI'
  : false
