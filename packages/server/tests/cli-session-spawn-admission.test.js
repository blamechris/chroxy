import { after, afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { waitFor } from './test-helpers.js'

if (typeof mock.module !== 'function') {
  describe('CLI child spawn admission (#7822)', () => {
    it('skipped: mock.module requires --experimental-test-module-mocks', (t) => {
      t.skip('re-run with --experimental-test-module-mocks')
    })
  })
} else {
  const root = mkdtempSync(join(tmpdir(), 'chroxy-cli-spawn-admission-'))
  after(() => rmSync(root, { recursive: true, force: true }))

  let resolvedBinary = process.execPath
  const realResolver = await import('../src/utils/resolve-binary.js')
  mock.module('../src/utils/resolve-binary.js', {
    namedExports: {
      ...realResolver,
      resolveBinary: () => resolvedBinary,
    },
  })
  const { CliSession } = await import('../src/cli-session.js')
  const sessions = []

  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.destroy()
  })

  function createSession() {
    const session = new CliSession({ cwd: root, skillsDir: root, repoSkillsDir: null })
    session._scheduleRespawn = () => {}
    sessions.push(session)
    return session
  }

  describe('CLI child spawn admission (#7822)', () => {
    it('keeps startup input queued when the executable fails before spawn', async () => {
      resolvedBinary = join(root, 'definitely-missing-cli')
      const session = createSession()
      const errors = []
      const admissions = []
      session.on('error', (error) => errors.push(error))
      session._pendingQueue.push({
        prompt: 'queued while starting',
        attachments: [],
        options: { onInputAdmission: (admission) => admissions.push(admission) },
      })

      session._spawnPersistentProcess([])
      assert.equal(session._processReady, false, 'spawn() return is not readiness proof')
      await waitFor(() => errors.length === 1, { label: 'missing CLI child error' })

      assert.equal(session._processReady, false)
      assert.equal(session._pendingQueue.length, 1, 'failed child must not drain startup input')
      assert.deepEqual(admissions, [], 'failed child must not claim input admission')
      await session.destroy()
    })

    it('marks ready and drains startup input after an actual child spawn', async () => {
      resolvedBinary = process.execPath
      const session = createSession()
      const admissions = []
      session.on('error', () => {})
      session._pendingQueue.push({
        prompt: 'queued while starting',
        attachments: [],
        options: { onInputAdmission: (admission) => admissions.push(admission) },
      })

      session._spawnPersistentProcess([])
      assert.equal(session._processReady, false, 'readiness waits for the child spawn event')
      await waitFor(() => session._processReady && admissions.length === 1, {
        label: 'spawned CLI child admission',
      })

      assert.equal(session._pendingQueue.length, 0)
      assert.deepEqual(admissions, [{ status: 'accepted', delivery: 'dispatch_started' }])
      await session.destroy()
    })
  })
}
