// #5683 — integration tests for the public `/p/<slug>` Chroxy Pages route.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHttpHandler } from '../src/http-routes.js'
import { PagesStore } from '../src/pages-store.js'

let dir, store, httpServer, base

// A minimal mock WsServer: only the fields the /p/ route + early routes touch.
function mockServer() {
  return {
    apiToken: 'tok',
    authRequired: true,
    serverMode: 'multi',
    pagesStore: store,
    _pagesRateLimiter: null, // disabled for these functional tests
    _validateBearerAuth() { return false }, // authed routes always reject here
  }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'chroxy-pages-serve-'))
  store = new PagesStore({ pagesDir: dir })
  httpServer = createServer(createHttpHandler(mockServer()))
  httpServer.listen(0, '127.0.0.1')
  await once(httpServer, 'listening')
  base = `http://127.0.0.1:${httpServer.address().port}`
})

after(() => {
  httpServer?.close()
  rmSync(dir, { recursive: true, force: true })
})

test('serves a published page with the static-only security headers and no auth', async () => {
  const meta = store.publish({
    title: 'Report',
    files: [
      { path: 'index.html', content: '<!doctype html><h1>Report</h1>' },
      { path: 'style.css', content: 'h1{color:red}' },
    ],
  })
  // No Authorization header — the slug is the capability.
  const res = await fetch(`${base}/p/${meta.slug}/`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)
  const csp = res.headers.get('content-security-policy')
  assert.match(csp, /script-src 'none'/)
  assert.match(csp, /connect-src 'none'/)
  assert.match(csp, /sandbox/)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('x-frame-options'), 'DENY')
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin')
  assert.match(await res.text(), /<h1>Report<\/h1>/)

  // Asset served with correct MIME + same headers.
  const css = await fetch(`${base}/p/${meta.slug}/style.css`)
  assert.equal(css.status, 200)
  assert.match(css.headers.get('content-type'), /text\/css/)
  assert.match(css.headers.get('content-security-policy'), /script-src 'none'/)
})

test('redirects /p/<slug> (no trailing slash) to /p/<slug>/', async () => {
  const meta = store.publishHtml({ title: 't', html: '<p>x</p>' })
  const res = await fetch(`${base}/p/${meta.slug}`, { redirect: 'manual' })
  assert.equal(res.status, 301)
  assert.equal(res.headers.get('location'), `/p/${meta.slug}/`)
})

test('404s unknown, malformed, and traversal slugs/paths', async () => {
  // Unknown but well-formed slug.
  let res = await fetch(`${base}/p/Zzzzzzzzzzzzzzzzzzzzzz/`)
  assert.equal(res.status, 404)
  // Malformed slug (too short / bad charset).
  res = await fetch(`${base}/p/short/`)
  assert.equal(res.status, 404)
  // Path traversal in the asset segment of a real page.
  const meta = store.publishHtml({ title: 't', html: '<p>x</p>' })
  res = await fetch(`${base}/p/${meta.slug}/..%2f..%2findex.json`)
  assert.equal(res.status, 404)
  // 404 responses still carry the security headers.
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/)
})

test('the pages route does not require (or consult) bearer auth', async () => {
  // _validateBearerAuth always returns false in the mock; a 200 here proves the
  // route never reached the auth gate.
  const meta = store.publishHtml({ title: 'public', html: '<p>open</p>' })
  const res = await fetch(`${base}/p/${meta.slug}/`)
  assert.equal(res.status, 200)
})

test('serve-side size ceiling: a file grown past the cap is not served (404)', async () => {
  // Defence-in-depth: even if a file bypasses the publish-time cap, serve must
  // refuse it rather than read it unbounded.
  const d = mkdtempSync(join(tmpdir(), 'chroxy-pages-cap-'))
  const smallStore = new PagesStore({ pagesDir: d, maxPageBytes: 50 })
  const meta = smallStore.publishHtml({ title: 't', html: 'small' }) // within cap
  writeFileSync(join(d, meta.slug, 'index.html'), 'x'.repeat(500)) // grow past cap
  const srv = createServer(createHttpHandler({ ...mockServer(), pagesStore: smallStore }))
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  const b = `http://127.0.0.1:${srv.address().port}`
  try {
    const res = await fetch(`${b}/p/${meta.slug}/`)
    assert.equal(res.status, 404)
  } finally {
    srv.close()
    rmSync(d, { recursive: true, force: true })
  }
})
