// #5683 (PR-2) — tests for the POST/GET/DELETE /api/pages publish API.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHttpHandler } from '../src/http-routes.js'
import { PagesStore } from '../src/pages-store.js'

let dir, store, httpServer, base

function mockServer() {
  return {
    apiToken: 'tok',
    serverMode: 'multi',
    pagesStore: store,
    _pagesRateLimiter: null,
    _validateBearerAuth() { return false },
    // Primary-token gate: only the literal primary token 'tok' passes; 'bound'
    // models a pairing-bound token (rejected as insufficient class).
    _validatePrimaryBearerAuth(req, res) {
      const h = req.headers['authorization'] || ''
      const tok = h.startsWith('Bearer ') ? h.slice(7) : null
      if (tok === 'tok') return true
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: tok === 'bound' ? 'primary_token_required' : 'unauthorized' }))
      return false
    },
  }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'chroxy-pages-api-'))
  store = new PagesStore({ pagesDir: dir, maxPageBytes: 2 * 1024 * 1024 })
  httpServer = createServer(createHttpHandler(mockServer()))
  httpServer.listen(0, '127.0.0.1')
  await once(httpServer, 'listening')
  base = `http://127.0.0.1:${httpServer.address().port}`
})

after(() => {
  httpServer?.close()
  rmSync(dir, { recursive: true, force: true })
})

const auth = (tok = 'tok') => ({ Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' })

test('POST /api/pages publishes and the page is then served at its slug', async () => {
  const res = await fetch(`${base}/api/pages`, {
    method: 'POST', headers: auth(), body: JSON.stringify({ title: 'Report', html: '<h1>R</h1>' }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.match(body.slug, /^[A-Za-z0-9_-]{16,64}$/)
  assert.equal(body.path, `/p/${body.slug}/`)
  assert.equal(body.title, 'Report')
  // The freshly published page serves over the public route.
  const page = await fetch(`${base}/p/${body.slug}/`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<h1>R<\/h1>/)
})

test('POST accepts a multi-file payload', async () => {
  const res = await fetch(`${base}/api/pages`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ title: 'multi', files: [{ path: 'index.html', content: '<p>i</p>' }, { path: 'a.css', content: 'p{}' }] }),
  })
  assert.equal(res.status, 200)
  const { slug } = await res.json()
  const css = await fetch(`${base}/p/${slug}/a.css`)
  assert.equal(css.status, 200)
  assert.match(css.headers.get('content-type'), /text\/css/)
})

test('POST requires the primary token (no auth → 403, bound → 403)', async () => {
  const noauth = await fetch(`${base}/api/pages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(noauth.status, 403)
  const bound = await fetch(`${base}/api/pages`, { method: 'POST', headers: auth('bound'), body: JSON.stringify({ html: 'x' }) })
  assert.equal(bound.status, 403)
  assert.equal((await bound.json()).error, 'primary_token_required')
})

test('POST 400s on missing html/files, invalid JSON, and non-object body', async () => {
  const noContent = await fetch(`${base}/api/pages`, { method: 'POST', headers: auth(), body: JSON.stringify({ title: 't' }) })
  assert.equal(noContent.status, 400)
  const badJson = await fetch(`${base}/api/pages`, { method: 'POST', headers: auth(), body: '{not json' })
  assert.equal(badJson.status, 400)
  const arr = await fetch(`${base}/api/pages`, { method: 'POST', headers: auth(), body: '[]' })
  assert.equal(arr.status, 400)
})

test('POST 413s on an oversized body', async () => {
  const huge = 'x'.repeat(3 * 1024 * 1024) // > maxPageBytes (2MB) + 1MB slack
  const res = await fetch(`${base}/api/pages`, { method: 'POST', headers: auth(), body: JSON.stringify({ html: huge }) })
  assert.equal(res.status, 413)
})

test('GET /api/pages lists published pages with their public paths', async () => {
  const res = await fetch(`${base}/api/pages`, { headers: auth() })
  assert.equal(res.status, 200)
  const { pages } = await res.json()
  assert.ok(Array.isArray(pages))
  assert.ok(pages.length >= 1)
  assert.ok(pages.every((p) => p.path === `/p/${p.slug}/`))
})

test('DELETE /api/pages/<slug> revokes the page (then the slug 404s)', async () => {
  const pub = await (await fetch(`${base}/api/pages`, { method: 'POST', headers: auth(), body: JSON.stringify({ html: '<p>bye</p>' }) })).json()
  const del = await fetch(`${base}/api/pages/${pub.slug}`, { method: 'DELETE', headers: auth() })
  assert.equal(del.status, 200)
  assert.equal((await del.json()).removed, true)
  const gone = await fetch(`${base}/p/${pub.slug}/`)
  assert.equal(gone.status, 404)
  // Deleting an unknown slug → 404 { removed: false }.
  const missing = await fetch(`${base}/api/pages/Zzzzzzzzzzzzzzzzzzzzzz`, { method: 'DELETE', headers: auth() })
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).removed, false)
})

test('GET + DELETE also require the primary token', async () => {
  assert.equal((await fetch(`${base}/api/pages`, { headers: auth('bound') })).status, 403)
  assert.equal((await fetch(`${base}/api/pages/whatever`, { method: 'DELETE' })).status, 403)
})
