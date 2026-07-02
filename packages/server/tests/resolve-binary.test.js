import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBinary, pickWindowsExecutable } from '../src/utils/resolve-binary.js'

const isWindows = process.platform === 'win32'

// Absolute-path shape differs per platform: `/usr/bin/node` vs `C:\...\node.exe`.
function assertAbsolutePath(p) {
  if (isWindows) {
    assert.match(p, /^[A-Za-z]:[\\/]/, `expected a Windows absolute path, got: ${p}`)
  } else {
    assert.ok(p.startsWith('/'), `expected a POSIX absolute path, got: ${p}`)
  }
}

describe('resolveBinary', () => {
  it('returns an absolute path for a binary that is on PATH', () => {
    // `node` is always on PATH when running these tests
    const result = resolveBinary('node', [])
    assertAbsolutePath(result)
  })

  it('returns the binary name as-is when not found anywhere', () => {
    const result = resolveBinary('__chroxy_nonexistent_binary__', [])
    assert.equal(result, '__chroxy_nonexistent_binary__')
  })

  it('falls back to a candidate path when binary is not on PATH', () => {
    // Resolve `node` first to get a real, existing absolute path on this host,
    // then ask for a name that is NOT on PATH but supply that path as a candidate.
    const nodePath = resolveBinary('node', [])
    assertAbsolutePath(nodePath)

    const result = resolveBinary('__fake_name_for_test__', [nodePath])
    assert.equal(result, nodePath)
  })

  it('returns the first matching candidate when multiple are provided', () => {
    const nodePath = resolveBinary('node', [])

    // Prepend a non-existent path so the function advances to the second
    const result = resolveBinary('__fake_name_for_test__', [
      isWindows ? 'C:\\does\\not\\exist\\at\\all' : '/does/not/exist/at/all',
      nodePath,
      isWindows ? 'C:\\another\\nonexistent' : '/another/nonexistent',
    ])
    assert.equal(result, nodePath)
  })

  it('skips candidate paths that do not exist', () => {
    const result = resolveBinary('__fake_name_for_test__', [
      isWindows ? 'C:\\does\\not\\exist\\a' : '/does/not/exist/a',
      isWindows ? 'C:\\does\\not\\exist\\b' : '/does/not/exist/b',
    ])
    // No candidates matched, so bare name is returned
    assert.equal(result, '__fake_name_for_test__')
  })

  it('returns a string in all cases', () => {
    const r1 = resolveBinary('node', [])
    const r2 = resolveBinary('__definitely_missing__', [])
    const r3 = resolveBinary('__definitely_missing__', ['/nonexistent'])
    assert.equal(typeof r1, 'string')
    assert.equal(typeof r2, 'string')
    assert.equal(typeof r3, 'string')
  })

  it('handles an empty candidates array gracefully', () => {
    const result = resolveBinary('__missing__', [])
    assert.equal(result, '__missing__')
  })

  it('handles an undefined candidates argument gracefully', () => {
    // preflight passes `spec.binary.candidates || []`, but guard the bare call too.
    const result = resolveBinary('__missing__')
    assert.equal(result, '__missing__')
  })

  // Windows-only: prove the `where`-output selection lands on a directly
  // spawnable executable rather than the bare POSIX shell wrapper npm installs.
  if (isWindows) {
    it('resolves an on-PATH binary to a PATHEXT executable, not the bare wrapper', () => {
      const result = resolveBinary('node', [])
      assertAbsolutePath(result)
      const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
        .split(';').map((s) => s.trim().toLowerCase()).filter(Boolean)
      const ext = result.slice(result.lastIndexOf('.')).toLowerCase()
      assert.ok(pathext.includes(ext), `expected a PATHEXT extension, got: ${result}`)
    })
  }
})

// Selection logic is host-independent (PATHEXT is forced below), so these run on
// every platform — they pin the exact behaviour the Windows `where` branch needs.
describe('pickWindowsExecutable', () => {
  // Force a known PATHEXT per-test so selection is deterministic on every host
  // (POSIX CI has no PATHEXT; a Windows host's may be customised). Hooks run at
  // execution time, unlike statements in the describe body which run at
  // registration time.
  let originalPathext
  beforeEach(() => {
    originalPathext = process.env.PATHEXT
    process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD'
  })
  afterEach(() => {
    if (originalPathext === undefined) delete process.env.PATHEXT
    else process.env.PATHEXT = originalPathext
  })

  const npm = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\'
  const local = 'C:\\Users\\dev\\.local\\bin\\'

  it('prefers a directly-spawnable .exe over a .cmd shim and the bare wrapper', () => {
    // This is exactly what `where claude` prints on a host with both installs:
    // extensionless POSIX wrapper, then the .cmd shim, then the native .exe.
    const lines = [npm + 'claude', npm + 'claude.cmd', local + 'claude.exe']
    assert.equal(pickWindowsExecutable(lines), local + 'claude.exe')
  })

  it('falls back to the .cmd shim when no native .exe exists (npm-only install)', () => {
    const lines = [npm + 'claude', npm + 'claude.cmd']
    assert.equal(pickWindowsExecutable(lines), npm + 'claude.cmd')
  })

  it('never selects the bare extensionless POSIX wrapper', () => {
    // The wrapper is not a valid Win32 executable; both spawn paths refuse it.
    const lines = [npm + 'claude']
    assert.equal(pickWindowsExecutable(lines), null)
  })

  it('returns null for empty input', () => {
    assert.equal(pickWindowsExecutable([]), null)
  })

  it('prefers .exe even when a .cmd appears earlier in PATH order', () => {
    const lines = [npm + 'tool.cmd', local + 'tool.exe']
    assert.equal(pickWindowsExecutable(lines), local + 'tool.exe')
  })
})
