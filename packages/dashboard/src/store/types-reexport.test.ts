/**
 * Type re-export regression tests.
 *
 * Pure compile-time assertions: TypeScript erases types at runtime, so these
 * tests use `satisfies` and explicit type annotations to enforce the shape
 * locks. If any of the re-exports below disappear or drift, `tsc --noEmit`
 * will fail in CI before the tests ever run.
 *
 * Why this file exists: the dashboard's `store/types.ts` re-exports a number
 * of canonical shapes from `@chroxy/store-core` (LogEntry, DiffFile,
 * GitFileStatus, …). Past dedup sweeps (#3114, #3132, #3181) repeatedly hit
 * the same failure mode — a re-export accidentally dropped during a refactor
 * means consumers fall back to a stale dashboard-local copy, the typecheck
 * still passes, and the divergence only surfaces later. These assertions
 * catch removal at the package boundary.
 */
import { describe, it, expect } from 'vitest'
import type { GitFileStatus, GitStatusResult } from './types'

describe('dashboard/store/types re-exports', () => {
  // #3181: GitFileStatus must be re-exported from store-core through
  // dashboard's `store/types`. Dropping the re-export would force consumers
  // to import from `@chroxy/store-core` directly, breaking the convention
  // established by #3114 (LogEntry) and #3132 (DiffFile etc.).
  it('GitFileStatus is re-exported with the canonical shape', () => {
    const sample: GitFileStatus = {
      path: 'src/foo.ts',
      status: 'modified',
    }
    expect(sample.path).toBe('src/foo.ts')
    expect(sample.status).toBe('modified')
  })

  it('GitFileStatus accepts every status union member', () => {
    const variants: GitFileStatus[] = [
      { path: 'a', status: 'modified' },
      { path: 'b', status: 'added' },
      { path: 'c', status: 'deleted' },
      { path: 'd', status: 'renamed' },
      { path: 'e', status: 'copied' },
      { path: 'f', status: 'unknown' },
    ]
    expect(variants).toHaveLength(6)
  })

  it('GitStatusResult.staged/unstaged accept GitFileStatus[] (#3181 dedup)', () => {
    const entry: GitFileStatus = { path: 'src/foo.ts', status: 'modified' }
    const result: GitStatusResult = {
      branch: 'main',
      staged: [entry],
      unstaged: [entry],
      untracked: ['src/bar.ts'],
      error: null,
    }
    // Compile-time: result.staged[0] is structurally GitFileStatus, so the
    // existing FileBrowserPanel access pattern (`entry.path`, `entry.status`)
    // still type-checks against the deduped shape.
    expect(result.staged[0]?.path).toBe('src/foo.ts')
    expect(result.unstaged[0]?.status).toBe('modified')
  })
})
