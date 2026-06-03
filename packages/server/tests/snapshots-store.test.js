import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSnapshots, deleteSnapshot, getSnapshotsDir } from '../src/snapshots-store.js'

describe('snapshots-store', () => {
  let workDir
  let snapDir

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'chroxy-snap-'))
    snapDir = join(workDir, 'snapshots')
  })

  afterEach(() => {
    if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
  })

  function writeSidecar(slug, payload) {
    mkdirSync(snapDir, { recursive: true })
    writeFileSync(join(snapDir, `${slug}.json`), JSON.stringify(payload), 'utf-8')
  }

  describe('getSnapshotsDir', () => {
    it('honors CHROXY_CONFIG_DIR override', () => {
      const prev = process.env.CHROXY_CONFIG_DIR
      try {
        process.env.CHROXY_CONFIG_DIR = '/tmp/chroxy-test-config-x'
        assert.equal(getSnapshotsDir(), '/tmp/chroxy-test-config-x/snapshots')
      } finally {
        if (prev === undefined) delete process.env.CHROXY_CONFIG_DIR
        else process.env.CHROXY_CONFIG_DIR = prev
      }
    })
  })

  describe('listSnapshots', () => {
    it('returns [] when directory does not exist', () => {
      assert.deepEqual(listSnapshots({ dir: join(workDir, 'nope') }), [])
    })

    it('parses sidecars and returns expected shape', () => {
      writeSidecar('snap-abc123-1700000000000', {
        tag: 'chroxy-byok-snap:abc123-1700000000000',
        name: 'feature-a',
        createdAt: '2023-11-14T00:53:20.000Z',
        sourceCwd: '/Users/dev/proj',
        sourceImage: 'node:22-slim',
        sourceSessionId: 'sess-1',
      })
      const list = listSnapshots({ dir: snapDir })
      assert.equal(list.length, 1)
      const s = list[0]
      assert.equal(s.tag, 'chroxy-byok-snap:abc123-1700000000000')
      assert.equal(s.name, 'feature-a')
      assert.equal(s.createdAt, '2023-11-14T00:53:20.000Z')
      assert.equal(s.sourceCwd, '/Users/dev/proj')
      assert.equal(s.sourceImage, 'node:22-slim')
      assert.equal(s.sourceSessionId, 'sess-1')
      assert.equal(s.slug, 'snap-abc123-1700000000000')
    })

    it('sorts newest first by createdAt', () => {
      writeSidecar('a', { tag: 'chroxy-byok-snap:a', createdAt: '2023-01-01T00:00:00Z' })
      writeSidecar('b', { tag: 'chroxy-byok-snap:b', createdAt: '2024-06-01T00:00:00Z' })
      writeSidecar('c', { tag: 'chroxy-byok-snap:c', createdAt: '2023-06-01T00:00:00Z' })
      const list = listSnapshots({ dir: snapDir })
      assert.deepEqual(list.map(s => s.slug), ['b', 'c', 'a'])
    })

    it('skips malformed JSON sidecars without failing', () => {
      mkdirSync(snapDir, { recursive: true })
      writeFileSync(join(snapDir, 'broken.json'), '{ not valid json', 'utf-8')
      writeSidecar('good', { tag: 'chroxy-byok-snap:good', createdAt: '2024-01-01T00:00:00Z' })
      const list = listSnapshots({ dir: snapDir })
      assert.equal(list.length, 1)
      assert.equal(list[0].slug, 'good')
    })

    it('skips sidecars missing the required tag field', () => {
      writeSidecar('notag', { name: 'orphan', createdAt: '2024-01-01T00:00:00Z' })
      writeSidecar('good', { tag: 'chroxy-byok-snap:good' })
      const list = listSnapshots({ dir: snapDir })
      assert.equal(list.length, 1)
      assert.equal(list[0].slug, 'good')
    })

    it('ignores non-.json files and subdirectories', () => {
      mkdirSync(join(snapDir, 'sub'), { recursive: true })
      writeFileSync(join(snapDir, 'note.txt'), 'hi', 'utf-8')
      writeSidecar('good', { tag: 'chroxy-byok-snap:good' })
      const list = listSnapshots({ dir: snapDir })
      assert.equal(list.length, 1)
      assert.equal(list[0].slug, 'good')
    })

    it('defaults missing string fields to empty string', () => {
      writeSidecar('minimal', { tag: 'chroxy-byok-snap:minimal' })
      const list = listSnapshots({ dir: snapDir })
      assert.equal(list.length, 1)
      assert.equal(list[0].name, '')
      assert.equal(list[0].createdAt, '')
      assert.equal(list[0].sourceCwd, '')
      assert.equal(list[0].sourceImage, '')
      assert.equal(list[0].sourceSessionId, null)
    })
  })

  describe('deleteSnapshot', () => {
    it('rejects slugs with path traversal characters', async () => {
      const removed = []
      const result = await deleteSnapshot('../etc/passwd', {
        removeImage: async (tag) => { removed.push(tag) },
        dir: snapDir,
      })
      assert.equal(result.ok, false)
      assert.equal(result.status, 400)
      assert.deepEqual(removed, [])
    })

    it('rejects empty slug', async () => {
      const result = await deleteSnapshot('', { removeImage: async () => {}, dir: snapDir })
      assert.equal(result.ok, false)
      assert.equal(result.status, 400)
    })

    it('returns 404 when the sidecar does not exist', async () => {
      const result = await deleteSnapshot('missing', { removeImage: async () => {}, dir: snapDir })
      assert.equal(result.ok, false)
      assert.equal(result.status, 404)
    })

    it('removes the docker image and unlinks the sidecar', async () => {
      writeSidecar('snap-1', { tag: 'chroxy-byok-snap:abc-1', createdAt: '2024-01-01T00:00:00Z' })
      const removed = []
      const result = await deleteSnapshot('snap-1', {
        removeImage: async (tag) => { removed.push(tag) },
        dir: snapDir,
      })
      assert.equal(result.ok, true)
      assert.equal(result.tag, 'chroxy-byok-snap:abc-1')
      assert.equal(result.imageRemoved, true)
      assert.deepEqual(removed, ['chroxy-byok-snap:abc-1'])
      assert.equal(existsSync(join(snapDir, 'snap-1.json')), false)
    })

    it('still drops the sidecar when docker rmi rejects (best-effort)', async () => {
      writeSidecar('snap-2', { tag: 'chroxy-byok-snap:abc-2' })
      const result = await deleteSnapshot('snap-2', {
        removeImage: async () => { throw new Error('image already gone') },
        dir: snapDir,
      })
      assert.equal(result.ok, true)
      assert.equal(result.imageRemoved, false)
      assert.equal(existsSync(join(snapDir, 'snap-2.json')), false)
    })

    it('throws when removeImage callback is missing', async () => {
      writeSidecar('snap-3', { tag: 'chroxy-byok-snap:abc-3' })
      await assert.rejects(
        () => deleteSnapshot('snap-3', { dir: snapDir }),
        /removeImage callback required/,
      )
    })
  })
})
