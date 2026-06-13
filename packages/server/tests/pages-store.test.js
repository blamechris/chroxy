import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  PagesStore, isValidSlug, mimeForPath, DEFAULT_ENTRY, MAX_FILES_PER_PAGE,
} from '../src/pages-store.js'

function freshStore(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-pages-'))
  const store = new PagesStore({ pagesDir: dir, ...opts })
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('isValidSlug accepts base64url shapes and rejects junk/traversal', () => {
  assert.equal(isValidSlug('Xa9f8k2lmZ0qPwRtUvWxYz'), true)
  assert.equal(isValidSlug('short'), false)
  assert.equal(isValidSlug('../etc/passwd'), false)
  assert.equal(isValidSlug('has space here aaaaaaaa'), false)
  assert.equal(isValidSlug('has/slash/aaaaaaaaaaaa'), false)
  assert.equal(isValidSlug(''), false)
  assert.equal(isValidSlug(null), false)
})

test('mimeForPath maps extensions and falls back to octet-stream', () => {
  assert.equal(mimeForPath('a/index.html'), 'text/html; charset=utf-8')
  assert.equal(mimeForPath('style.css'), 'text/css; charset=utf-8')
  assert.equal(mimeForPath('logo.PNG'), 'image/png')
  assert.equal(mimeForPath('data.bin'), 'application/octet-stream')
  assert.equal(mimeForPath('noext'), 'application/octet-stream')
})

test('publishHtml → get → list → remove round-trip', () => {
  const { store, dir, cleanup } = freshStore()
  try {
    const meta = store.publishHtml({ title: 'Report', html: '<h1>hi</h1>' })
    assert.ok(isValidSlug(meta.slug))
    assert.equal(meta.title, 'Report')
    assert.equal(meta.entry, DEFAULT_ENTRY)
    assert.ok(meta.bytes > 0)
    // File on disk under the slug dir.
    assert.equal(readFileSync(join(dir, meta.slug, 'index.html'), 'utf8'), '<h1>hi</h1>')
    // get + list see it.
    assert.equal(store.get(meta.slug).title, 'Report')
    assert.equal(store.list().length, 1)
    // Manifest persisted.
    const manifest = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
    assert.ok(manifest.pages[meta.slug])
    // remove revokes + deletes the dir.
    assert.equal(store.remove(meta.slug), true)
    assert.equal(store.get(meta.slug), null)
    assert.equal(existsSync(join(dir, meta.slug)), false)
    assert.equal(store.remove(meta.slug), false) // idempotent
  } finally { cleanup() }
})

test('publish requires an index.html entry and a non-empty files array', () => {
  const { store, cleanup } = freshStore()
  try {
    assert.throws(() => store.publish({ title: 't', files: [] }), /non-empty/)
    assert.throws(() => store.publish({ title: 't', files: [{ path: 'other.html', content: 'x' }] }), /index\.html/)
  } finally { cleanup() }
})

test('publish rejects unsafe file paths (traversal / absolute / backslash)', () => {
  const { store, cleanup } = freshStore()
  try {
    for (const bad of ['../escape.html', '/abs.html', '..\\win.html', 'a/../../b.html']) {
      assert.throws(
        () => store.publish({ title: 't', files: [{ path: DEFAULT_ENTRY, content: 'ok' }, { path: bad, content: 'x' }] }),
        /Invalid page file path/,
        `expected ${bad} to be rejected`,
      )
    }
  } finally { cleanup() }
})

test('publish enforces per-page and total size caps', () => {
  const big = 'x'.repeat(1024)
  // per-page cap of 100 bytes
  const a = freshStore({ maxPageBytes: 100 })
  try {
    assert.throws(() => a.store.publishHtml({ title: 't', html: big }), /per-page cap/)
  } finally { a.cleanup() }
  // total cap of 30 bytes — first small page ok, second pushes over
  const b = freshStore({ maxTotalBytes: 30 })
  try {
    b.store.publishHtml({ title: '1', html: 'aaaaaaaaaa' }) // 10 bytes
    b.store.publishHtml({ title: '2', html: 'bbbbbbbbbb' }) // 20 total
    assert.throws(() => b.store.publishHtml({ title: '3', html: 'cccccccccccccccc' }), /total pages cap/)
  } finally { b.cleanup() }
})

test('resolveFile contains paths and defeats traversal + symlink escape', () => {
  const { store, dir, cleanup } = freshStore()
  try {
    // A secret file OUTSIDE the pages dir.
    const secret = join(dir, '..', `chroxy-secret-${process.pid}.txt`)
    writeFileSync(secret, 'TOP SECRET')

    const meta = store.publish({
      title: 't',
      files: [
        { path: DEFAULT_ENTRY, content: '<h1>page</h1>' },
        { path: 'assets/app.css', content: 'body{}' },
      ],
    })
    const slug = meta.slug

    // Entry resolves (empty rel → index.html).
    assert.ok(store.resolveFile(slug, '').endsWith(join(slug, 'index.html')))
    // Nested asset resolves.
    assert.ok(store.resolveFile(slug, 'assets/app.css').endsWith(join(slug, 'assets', 'app.css')))
    // Traversal is rejected.
    assert.equal(store.resolveFile(slug, '../index.json'), null)
    assert.equal(store.resolveFile(slug, '../../etc/hosts'), null)
    // Unknown / invalid slug.
    assert.equal(store.resolveFile('Zzzzzzzzzzzzzzzzzzzzzz', ''), null)
    assert.equal(store.resolveFile('../bad', ''), null)
    // Nonexistent file in a real page.
    assert.equal(store.resolveFile(slug, 'nope.css'), null)

    // Symlink escape: plant a symlink inside the page dir pointing OUT.
    const link = join(dir, slug, 'leak.txt')
    try {
      symlinkSync(secret, link)
      assert.equal(store.resolveFile(slug, 'leak.txt'), null, 'symlink escaping the page dir must not resolve')
    } catch (err) {
      if (err.code !== 'EPERM') throw err // some CI filesystems forbid symlink; skip if so
    }
  } finally { cleanup() }
})

test('publish rejects a file count over the per-page cap (zero-byte amplification guard)', () => {
  const { store, cleanup } = freshStore()
  try {
    // All zero-byte → passes the byte cap, but the file COUNT must be bounded.
    const files = [{ path: DEFAULT_ENTRY, content: '' }]
    for (let i = 0; i < MAX_FILES_PER_PAGE; i++) files.push({ path: `a${i}`, content: '' })
    assert.throws(() => store.publish({ title: 't', files }), /per-page cap/)
  } finally { cleanup() }
})

test('published dirs are 0700, files + manifest are 0600 (POSIX)', { skip: process.platform === 'win32' }, () => {
  const { store, dir, cleanup } = freshStore()
  try {
    const meta = store.publishHtml({ title: 't', html: '<p>x</p>' })
    assert.equal(statSync(join(dir, meta.slug)).mode & 0o777, 0o700, 'page dir 0700')
    assert.equal(statSync(join(dir, meta.slug, 'index.html')).mode & 0o777, 0o600, 'page file 0600')
    assert.equal(statSync(join(dir, 'index.json')).mode & 0o777, 0o600, 'manifest 0600')
  } finally { cleanup() }
})

test('manifest survives a fresh store instance over the same dir', () => {
  const { store, dir, cleanup } = freshStore()
  try {
    const meta = store.publishHtml({ title: 'persist', html: '<p>x</p>' })
    const reopened = new PagesStore({ pagesDir: dir })
    assert.equal(reopened.get(meta.slug).title, 'persist')
    assert.equal(reopened.list().length, 1)
  } finally { cleanup() }
})

test('minted slugs are unique and base64url', () => {
  const { store, cleanup } = freshStore()
  try {
    const slugs = new Set()
    for (let i = 0; i < 50; i++) {
      const meta = store.publishHtml({ title: `p${i}`, html: 'x' })
      assert.ok(isValidSlug(meta.slug))
      assert.equal(slugs.has(meta.slug), false)
      slugs.add(meta.slug)
    }
  } finally { cleanup() }
})
