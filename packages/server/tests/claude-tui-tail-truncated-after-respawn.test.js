import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'

/**
 * #8401 — the logged PTY tail's `truncatedStart` (did the byte cap cut the start
 * of the tail, so a half escape sequence may open it?) must describe THIS spawn's
 * buffer. It was derived from `_totalOutputBytes > raw length`; `_spawnPty` empties
 * the raw buffer on a respawn but the byte total spans spawns, so after a respawn
 * a clean tail read as truncated and the scrubber dropped its leading bracket
 * text (`[3D model] preview ready` was logged as `model] preview ready`).
 *
 * These tests drive the REAL `_respawnPty` / `_spawnPty` through the
 * `_ptyModOverride` seam with a stand-in PTY, feeding output through the
 * session's own onData handler. No claude binary is spawned.
 */

const CAP = ClaudeTuiSession.PTY_TAIL_BYTES

function makeSession() {
  const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-tail-trunc-skills-'))
  const s = new ClaudeTuiSession({ cwd: tmpdir(), skillsDir, repoSkillsDir: null })
  s._waitForPrompt = async () => true
  s._sessionId = '0f8401aa-0000-4000-8000-000000000001'
  s._settingsPath = join(tmpdir(), 'fixture-settings-8401.json')
  const terms = []
  s._ptyModOverride = {
    spawn: () => {
      const term = {
        pid: 2147483500 + terms.length,
        dataHandlers: [],
        exitHandlers: [],
        write: () => {},
        kill: () => {},
        onData: (cb) => { term.dataHandlers.push(cb) },
        onExit: (cb) => { term.exitHandlers.push(cb) },
        on: () => {},
        emit: (data) => { for (const cb of term.dataHandlers) cb(data) },
      }
      terms.push(term)
      return term
    },
  }
  s.on('error', () => {})
  return {
    session: s,
    terms,
    cleanup: async () => {
      if (s._killTimer) { clearTimeout(s._killTimer); s._killTimer = null }
      try { await s.destroy() } catch { /* ignore */ }
      if (s._killTimer) { clearTimeout(s._killTimer); s._killTimer = null }
      rmSync(skillsDir, { recursive: true, force: true })
    },
  }
}

/** Kill the live PTY the way node-pty reports a death, then run the respawn. */
async function dieAndRespawn(session, terms) {
  const dead = terms[terms.length - 1]
  dead.exitHandlers[0]({ exitCode: 1 })
  clearTimeout(session._respawnTimer)
  session._respawnTimer = null
  session._respawnScheduled = false
  await session._respawnPty()
  assert.equal(terms.length >= 2, true, 'precondition: a second PTY was spawned')
}

// Longer than the cap, starting inside a CSI sequence: "...1;31m" without its ESC[.
const OVERFLOW = '1;31m' + 'x'.repeat(CAP + 200) + '\nlast line'

describe('claude-tui log tail truncatedStart across a PTY respawn (#8401)', () => {
  it('a clean tail after a respawn keeps its leading bracket text, though the first PTY overflowed the cap', async () => {
    const { session, terms, cleanup } = makeSession()
    try {
      await session._respawnPty()
      terms[0].emit(OVERFLOW)
      assert.equal(session._totalOutputBytes > CAP, true, 'precondition: the first PTY pushed the byte total past the cap')

      await dieAndRespawn(session, terms)
      terms[1].emit('[3D model] preview ready')

      assert.equal(session._outputTailText().truncatedStart, false, 'the new spawn\'s tail was not cut')
      assert.equal(session._outputTailDiagnostic(), '[3D model] preview ready')
    } finally {
      await cleanup()
    }
  })

  it('a tail the cap really cut still has its orphaned leading sequence removed, before and after a respawn', async () => {
    const { session, terms, cleanup } = makeSession()
    try {
      await session._respawnPty()
      terms[0].emit(OVERFLOW)
      assert.equal(session._outputTailText().truncatedStart, true)
      const before = session._outputTailDiagnostic()
      assert.ok(/last line$/.test(before), `first spawn tail: ${JSON.stringify(before.slice(-30))}`)

      await dieAndRespawn(session, terms)
      assert.equal(session._outputTailText().truncatedStart, false, 'the respawn emptied the tail, the flag went with it')
      // The new spawn overflows too: a cut start must be reported again.
      terms[1].emit('[2;5m' + 'y'.repeat(CAP + 50) + '\n[3D model] second spawn')
      assert.equal(session._outputTailText().truncatedStart, true)
      const after = session._outputTailDiagnostic()
      assert.ok(after.endsWith('[3D model] second spawn'), `second spawn tail: ${JSON.stringify(after.slice(-40))}`)
    } finally {
      await cleanup()
    }
  })

  it('a tail exactly at the cap is not truncated', async () => {
    const { session, terms, cleanup } = makeSession()
    try {
      await session._respawnPty()
      terms[0].emit('[3D model]' + 'z'.repeat(CAP - '[3D model]'.length))
      assert.equal(session._outputTailRaw.length, CAP)
      assert.equal(session._outputTailText().truncatedStart, false)
    } finally {
      await cleanup()
    }
  })
})
