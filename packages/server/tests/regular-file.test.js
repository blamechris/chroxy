import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRegularFileHead } from '../src/utils/regular-file.js'
import { scanConversations, clearScanCache } from '../src/conversation-scanner.js'
import { searchConversations } from '../src/conversation-search.js'

const POSIX = process.platform !== 'win32'

// Reject if the promise has not settled in `ms`: a blocking open of a FIFO would
// otherwise hold the test (and a threadpool thread) until a writer showed up.
function within(ms, promise, label) {
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle in ${ms}ms`)), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

describe('regular-file open', { skip: !POSIX && 'needs mkfifo' }, () => {
  let dir
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-regfile-'))
    writeFileSync(join(dir, 'plain.txt'), 'hello world')
    execFileSync('mkfifo', [join(dir, 'pipe.jsonl')])
    symlinkSync(join(dir, 'plain.txt'), join(dir, 'link.txt'))
  })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  it('reads a regular file, up to the cap', async () => {
    const { text, size } = await readRegularFileHead(join(dir, 'plain.txt'), 5)
    assert.equal(text, 'hello')
    assert.equal(size, 11)
  })

  it('follows a symlink to a regular file', async () => {
    const { text } = await readRegularFileHead(join(dir, 'link.txt'), 100)
    assert.equal(text, 'hello world')
  })

  it('refuses a FIFO promptly instead of waiting for a writer', () => {
    // In a child process with a hard timeout: if the open blocked, the child
    // would hang (and, in-process, so would the threadpool thread), so a broken
    // guard fails here quickly and legibly instead of wedging the run.
    const mod = new URL('../src/utils/regular-file.js', import.meta.url).href
    const code = `import(${JSON.stringify(mod)}).then(async (m) => { try { await m.openRegularFile(${JSON.stringify(join(dir, 'pipe.jsonl'))}); console.log('OPENED') } catch (e) { console.log(e.code) } })`
    const r = spawnSync(process.execPath, ['-e', code], { timeout: 4000, encoding: 'utf8' })
    assert.equal(r.error, undefined, `the open did not return: ${r.error?.message}`)
    assert.equal(r.stdout.trim(), 'ENOTREG')
  })

  it('a project directory holding a FIFO does not stall a scan or a search', async () => {
    const projects = join(dir, 'projects')
    const proj = join(projects, '-tmp-demo')
    execFileSync('mkdir', ['-p', proj])
    const line = JSON.stringify({ type: 'user', cwd: '/tmp/demo', message: { content: 'needle in a haystack of text '.repeat(6) } }) + '\n'
    writeFileSync(join(proj, '11111111-1111-4111-8111-111111111111.jsonl'), line)
    execFileSync('mkfifo', [join(proj, '22222222-2222-4222-8222-222222222222.jsonl')])
    clearScanCache()
    const found = await within(3000, scanConversations({ projectsDirs: [projects] }), 'scan')
    assert.deepEqual(found.map((c) => c.conversationId), ['11111111-1111-4111-8111-111111111111'])
    // `projectsDir` (singular) is what search reads; a plural key would silently
    // search the real home and prove nothing.
    const hits = await within(3000, searchConversations('needle', { projectsDir: projects }), 'search')
    assert.deepEqual(hits.map((h) => h.conversationId), ['11111111-1111-4111-8111-111111111111'], 'the planted hit is found, and the FIFO does not stall it')
  })

  it('a file swapped for a FIFO between listing and open is refused without waiting (contained read)', () => {
    // The swap happens through the helper's own scheduling seam: after the
    // directory was listed, before the open. In a child with a hard timeout, so a
    // blocking open fails here quickly.
    const mod = new URL('../src/utils/regular-file.js', import.meta.url).href
    const target = join(dir, 'swapme.jsonl')
    writeFileSync(target, 'x'.repeat(200))
    const code = `
      const fs = require('node:fs'); const cp = require('node:child_process');
      import(${JSON.stringify(mod)}).then(async (m) => {
        const out = await m.readContainedBytes(${JSON.stringify(target)}, ${JSON.stringify(dir)}, 1024, {
          deps: { beforeOpen: () => { fs.unlinkSync(${JSON.stringify(target)}); cp.execFileSync('mkfifo', [${JSON.stringify(target)}]) } },
        })
        console.log(out === null ? 'REFUSED' : 'READ')
      })`
    const r = spawnSync(process.execPath, ['--input-type=commonjs', '-e', code], { timeout: 4000, encoding: 'utf8' })
    assert.equal(r.error, undefined, `the read did not return: ${r.error?.message}`)
    assert.equal(r.stdout.trim(), 'REFUSED')
  })
})
