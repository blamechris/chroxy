// #5683 (PR-2) — unit tests for the `chroxy publish` / `chroxy pages` CLI.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPublishCmd, runPagesListCmd, runPagesRmCmd } from '../src/cli/pages-cmd.js'

const CONN = { apiToken: 'primary-tok', httpUrl: 'https://abc.trycloudflare.com', wsUrl: 'wss://abc.trycloudflare.com' }

function mockFetch(responder) {
  const calls = []
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts })
    return responder(url, opts)
  }
  return { fetchFn, calls }
}
function jsonRes(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}
function sink() {
  const out = [], err = []
  return { out, err, write: (s) => out.push(s), writeErr: (s) => err.push(s) }
}

test('publish reads the file, POSTs to the local daemon, prints the public URL', async () => {
  const { fetchFn, calls } = mockFetch(() => jsonRes(200, { slug: 'Slug0000000000000000', path: '/p/Slug0000000000000000/', title: 'report' }))
  const s = sink()
  const res = await runPublishCmd('report.html', {}, {
    readConnectionInfo: () => CONN,
    readFile: () => '<h1>hi</h1>',
    fetchFn, write: s.write, writeErr: s.writeErr,
  })
  assert.equal(res.ok, true)
  // Hits the LOCAL daemon (loopback, default port since trycloudflare has none).
  assert.equal(calls[0].url, 'http://127.0.0.1:8765/api/pages')
  assert.equal(calls[0].opts.method, 'POST')
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer primary-tok')
  const sent = JSON.parse(calls[0].opts.body)
  assert.equal(sent.html, '<h1>hi</h1>')
  assert.equal(sent.title, 'report') // derived from filename
  // Prints the PUBLIC share URL (httpUrl base + path).
  assert.equal(res.url, 'https://abc.trycloudflare.com/p/Slug0000000000000000/')
  assert.ok(s.out.some((l) => l.includes('https://abc.trycloudflare.com/p/Slug0000000000000000/')))
})

test('publish --title overrides the derived title', async () => {
  const { fetchFn, calls } = mockFetch(() => jsonRes(200, { slug: 'X', path: '/p/X/', title: 'Custom' }))
  await runPublishCmd('foo.html', { title: 'Custom' }, {
    readConnectionInfo: () => CONN, readFile: () => '<p>x</p>', fetchFn, write: () => {}, writeErr: () => {},
  })
  assert.equal(JSON.parse(calls[0].opts.body).title, 'Custom')
})

test('publish reports when the daemon is not running', async () => {
  const s = sink()
  const res = await runPublishCmd('r.html', {}, {
    readConnectionInfo: () => null, readFile: () => '<p>x</p>', fetchFn: async () => { throw new Error('should not fetch') },
    write: s.write, writeErr: s.writeErr,
  })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'not_running')
  assert.ok(s.err.some((l) => /not running/i.test(l)))
})

test('publish surfaces a server error (e.g. 413)', async () => {
  const { fetchFn } = mockFetch(() => jsonRes(413, { error: 'body too large' }))
  const s = sink()
  const res = await runPublishCmd('r.html', {}, {
    readConnectionInfo: () => CONN, readFile: () => 'x', fetchFn, write: s.write, writeErr: s.writeErr,
  })
  assert.equal(res.ok, false)
  assert.equal(res.status, 413)
  assert.ok(s.err.some((l) => /body too large/.test(l)))
})

test('publish fails cleanly on an unreadable file (no fetch)', async () => {
  let fetched = false
  const s = sink()
  const res = await runPublishCmd('missing.html', {}, {
    readConnectionInfo: () => CONN,
    readFile: () => { throw new Error('ENOENT') },
    fetchFn: async () => { fetched = true; return jsonRes(200, {}) },
    write: s.write, writeErr: s.writeErr,
  })
  assert.equal(res.ok, false)
  assert.equal(fetched, false)
  assert.ok(s.err.some((l) => /Cannot read missing\.html/.test(l)))
})

test('pages list builds public URLs and handles the empty case', async () => {
  const { fetchFn } = mockFetch(() => jsonRes(200, { pages: [{ slug: 'AAA', title: 'one', path: '/p/AAA/' }] }))
  const s = sink()
  const res = await runPagesListCmd({}, { readConnectionInfo: () => CONN, fetchFn, write: s.write, writeErr: s.writeErr })
  assert.equal(res.ok, true)
  assert.equal(res.pages[0].url, 'https://abc.trycloudflare.com/p/AAA/')

  const empty = mockFetch(() => jsonRes(200, { pages: [] }))
  const s2 = sink()
  await runPagesListCmd({}, { readConnectionInfo: () => CONN, fetchFn: empty.fetchFn, write: s2.write, writeErr: s2.writeErr })
  assert.ok(s2.out.some((l) => /No published pages/.test(l)))
})

test('pages rm sends DELETE and reports the result', async () => {
  const { fetchFn, calls } = mockFetch(() => jsonRes(200, { removed: true }))
  const s = sink()
  const res = await runPagesRmCmd('MySlug', {}, { readConnectionInfo: () => CONN, fetchFn, write: s.write, writeErr: s.writeErr })
  assert.equal(res.ok, true)
  assert.equal(res.removed, true)
  assert.equal(calls[0].opts.method, 'DELETE')
  assert.equal(calls[0].url, 'http://127.0.0.1:8765/api/pages/MySlug')
  assert.ok(s.out.some((l) => /Removed MySlug/.test(l)))
})
