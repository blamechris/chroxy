/**
 * E2E coverage for `chroxy sessions` and `chroxy resume`.
 *
 * Covers src/cli/session-cmd.js. We never exec the real `claude` binary —
 * the "resume" tests focus on argument validation and listing.
 *
 * MEMORY WARNING: session-state.json is read from ~/.chroxy/. Every test
 * isolates HOME to prevent overwriting the real file.
 */
import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runCli, makeTempHome } from './__helpers/spawn-cli.js'

describe('chroxy sessions', () => {
  describe('with no session-state.json', () => {
    const { home, cleanup } = makeTempHome()
    after(cleanup)

    it('reports "No saved sessions found." and exits 0', async () => {
      const r = await runCli(['sessions'], { home })
      assert.equal(r.code, 0, `stderr: ${r.stderr}`)
      assert.match(r.stdout, /No saved sessions found/)
    })
  })

  describe('with an empty sessions array', () => {
    const { home, cleanup } = makeTempHome()
    after(cleanup)

    before(() => {
      const dir = join(home, '.chroxy')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'session-state.json'),
        JSON.stringify({ sessions: [], timestamp: Date.now() }),
      )
    })

    it('prints "No saved sessions."', async () => {
      const r = await runCli(['sessions'], { home })
      assert.equal(r.code, 0)
      assert.match(r.stdout, /No saved sessions\./)
    })
  })

  describe('with populated sessions', () => {
    const { home, cleanup } = makeTempHome()
    after(cleanup)

    before(() => {
      const dir = join(home, '.chroxy')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'session-state.json'),
        JSON.stringify({
          sessions: [
            {
              name: 'work',
              cwd: '/tmp/work-dir',
              conversationId: 'conv-abc-123',
            },
            {
              name: 'play',
              cwd: '/tmp/play-dir',
              sdkSessionId: 'sdk-def-456',
            },
          ],
          timestamp: Date.now(),
        }),
      )
    })

    it('lists every session name, cwd, and resume hint', async () => {
      const r = await runCli(['sessions'], { home })
      assert.equal(r.code, 0, `stderr: ${r.stderr}`)
      assert.match(r.stdout, /Saved Sessions \(2\)/)
      assert.match(r.stdout, /work/)
      assert.match(r.stdout, /play/)
      assert.match(r.stdout, /conv-abc-123/)
      assert.match(r.stdout, /sdk-def-456/)
      assert.match(r.stdout, /claude --resume/)
    })
  })

  describe('resume', () => {
    const { home, cleanup } = makeTempHome()
    after(cleanup)

    it('exits 1 with a clear error when no sessions file exists', async () => {
      const r = await runCli(['resume'], { home })
      assert.equal(r.code, 1)
      assert.match(r.stderr, /No saved sessions found/)
    })
  })
})
