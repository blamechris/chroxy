import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ExternalSessionEntrySchema, IngestEventSchema } from '@chroxy/protocol'
import {
  ExternalSessionRegistry,
  MAX_EXTERNAL_PROJECT_CHARS,
  MAX_EXTERNAL_SOURCE_CHARS,
  MAX_EXTERNAL_SESSION_ID_CHARS,
} from '../src/external-session-registry.js'

/**
 * #7086 — the external-sessions snapshot re-emitted a `project` its own INBOUND
 * contract would have refused.
 *
 * `IngestEventSchema` caps an explicit `project` at 256. But the server does
 * `event.project || deriveProjectFromCwd(data.cwd)`, and the derived branch is a
 * path basename — so a wire-legal 4096-char `cwd` yields a ~4096-char project.
 * The outbound `ExternalSessionEntrySchema` was uncapped, so nothing rejected it.
 *
 * The trap that made this worth fixing: capping the outbound schema alone — the
 * obvious hardening — would reject the WHOLE `external_sessions_snapshot` on one
 * over-long project, blanking mission control for every session in it. So the
 * registry clamps first; only then are the schema caps safe.
 *
 * NOTE for anyone running this from a git worktree: the CONTRACT case below
 * needs the schema change built into `@chroxy/protocol`. A worktree resolves
 * that package from the MAIN checkout, so the new `.max()` is invisible there
 * and the case fails with "true !== false" even though the code is correct.
 * Run it from the main checkout (or in CI, which has a single checkout).
 */

/** A single-component path that is wire-legal inbound (<=4096) but over-long. */
const LONG_COMPONENT = 'p'.repeat(4000)
const LONG_CWD = `/${LONG_COMPONENT}`

function entryFor(registry) {
  const [entry] = registry.getSessions()
  assert.ok(entry, 'registry produced no entry')
  return entry
}

describe('#7086 external-session project/name wire cap', () => {
  it('PREMISE: the inbound schema refuses the very value the derived branch produces', () => {
    // Without this, the whole fix is arguing with a contract that does not exist.
    // The 4096-char `cwd` is accepted; the same string as `project` is not.
    const asCwd = IngestEventSchema.safeParse({
      source: 'claude-hooks', type: 'session_start', sessionId: 's1',
      ts: Date.now(), data: { cwd: LONG_CWD },
    })
    assert.equal(asCwd.success, true, 'a 4001-char cwd is wire-legal inbound')

    const asProject = IngestEventSchema.safeParse({
      source: 'claude-hooks', type: 'session_start', sessionId: 's1',
      project: LONG_COMPONENT, ts: Date.now(), data: {},
    })
    assert.equal(asProject.success, false, 'the same string as `project` is refused inbound')
  })

  it('clamps an over-long project to the inbound cap', () => {
    const r = new ExternalSessionRegistry()
    r.record('session_start', 'claude-hooks', 's1', { project: LONG_COMPONENT, cwd: LONG_CWD })
    const entry = entryFor(r)
    assert.equal(entry.project.length, MAX_EXTERNAL_PROJECT_CHARS)
    assert.equal(entry.name.length, MAX_EXTERNAL_PROJECT_CHARS)
  })

  it('clamps a name derived from a long cwd basename, with no project at all', () => {
    // The basename fallback is a SEPARATE branch from `project`; clamping only
    // `project` at record() would leave this one unbounded.
    const r = new ExternalSessionRegistry()
    r.record('session_start', 'claude-hooks', 's2', { project: null, cwd: LONG_CWD })
    const entry = entryFor(r)
    assert.equal(entry.project, null, 'no project was supplied')
    assert.equal(entry.name.length, MAX_EXTERNAL_PROJECT_CHARS, 'name came from the cwd basename')
  })

  it('CONTROL: an ordinary project and name pass through byte-for-byte', () => {
    // Without this, every assertion above would still pass if the clamp
    // truncated indiscriminately.
    const r = new ExternalSessionRegistry()
    r.record('session_start', 'claude-hooks', 's3', { project: 'chroxy', cwd: '/Users/x/Projects/chroxy' })
    const entry = entryFor(r)
    assert.equal(entry.project, 'chroxy')
    assert.equal(entry.name, 'chroxy')
    assert.equal(entry.cwd, '/Users/x/Projects/chroxy')
  })

  it('CONTROL: a project of exactly the cap is untouched (boundary is inclusive)', () => {
    const exact = 'q'.repeat(MAX_EXTERNAL_PROJECT_CHARS)
    const r = new ExternalSessionRegistry()
    r.record('session_start', 'claude-hooks', 's4', { project: exact, cwd: null })
    assert.equal(entryFor(r).project, exact)
  })

  it('CONTRACT: the pre-clamp value is wire-ILLEGAL and the emitted one is legal', () => {
    // The two halves matter together. The first proves the new `.max(256)` is
    // real (a cap that rejected nothing would make the clamp untestable); the
    // second proves the registry is what keeps the snapshot parseable.
    const r = new ExternalSessionRegistry()
    r.record('session_start', 'claude-hooks', 's5', { project: LONG_COMPONENT, cwd: LONG_CWD })
    const entry = entryFor(r)

    const unclamped = { ...entry, project: LONG_COMPONENT, name: LONG_COMPONENT }
    assert.equal(
      ExternalSessionEntrySchema.safeParse(unclamped).success, false,
      'the value the server used to emit must now be refused by the wire schema',
    )
    assert.equal(
      ExternalSessionEntrySchema.safeParse(entry).success, true,
      'what the registry actually emits must be wire-legal',
    )
  })

  it('a long cwd stays intact — it is capped at 4096 inbound, not 256', () => {
    // Guards against over-clamping: `cwd` has its own, larger bound. Truncating
    // it to 256 would corrupt a legitimate path.
    const r = new ExternalSessionRegistry()
    r.record('session_start', 'claude-hooks', 's6', { project: 'chroxy', cwd: LONG_CWD })
    const entry = entryFor(r)
    assert.equal(entry.cwd, LONG_CWD, 'cwd must not be clamped to the project cap')
    assert.equal(ExternalSessionEntrySchema.safeParse(entry).success, true)
  })

  it('a caller that bypasses ingest validation still yields a wire-legal entry', () => {
    // The outbound `.max()` on `source`/`sessionId` is load-bearing: one
    // over-long value rejects the WHOLE snapshot array. Those fields arrive
    // pre-validated today, but that is a caller-side invariant this module
    // cannot enforce — so the emitted copy is clamped rather than trusted.
    const r = new ExternalSessionRegistry()
    r.record('session_start', 's'.repeat(300), 'i'.repeat(900), { project: 'chroxy', cwd: null })
    const entry = entryFor(r)
    assert.equal(entry.source.length, MAX_EXTERNAL_SOURCE_CHARS)
    assert.equal(entry.sessionId.length, MAX_EXTERNAL_SESSION_ID_CHARS)
    assert.equal(
      ExternalSessionEntrySchema.safeParse(entry).success, true,
      'an unvalidated caller must not be able to blank the snapshot',
    )
  })

  it('CONTROL: ordinary source/sessionId are not rewritten, and identity is preserved', () => {
    // Guards the clamp above from being indiscriminate, and pins that clamping
    // the EMITTED copy does not disturb the internal (source, sessionId) key —
    // two sessions differing only past the cap must stay distinct entries.
    const r = new ExternalSessionRegistry()
    r.record('session_start', 'claude-hooks', 'abc123', { project: 'chroxy', cwd: null })
    const entry = entryFor(r)
    assert.equal(entry.source, 'claude-hooks')
    assert.equal(entry.sessionId, 'abc123')

    const long = 'i'.repeat(MAX_EXTERNAL_SESSION_ID_CHARS)
    r.record('session_start', 'claude-hooks', `${long}A`, { project: 'a', cwd: null })
    r.record('session_start', 'claude-hooks', `${long}B`, { project: 'b', cwd: null })
    assert.equal(r.size, 3, 'ids differing only past the cap remain distinct entries')
  })

  it('the memory the registry retains is bounded, not just the emitted copy', () => {
    // Clamping at getSessions() alone would leave up to EXTERNAL_SESSION_MAX_ENTRIES
    // over-long projects resident; the key space is attacker-influenced.
    const r = new ExternalSessionRegistry()
    r.record('session_start', 'claude-hooks', 's7', { project: LONG_COMPONENT, cwd: null })
    const stored = r._entries.values().next().value
    assert.equal(stored.project.length, MAX_EXTERNAL_PROJECT_CHARS, 'stored, not merely emitted')
  })
})
