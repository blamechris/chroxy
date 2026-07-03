/**
 * Unit tests for the Control Room GitHub webhook receiver (#5966).
 * Pure logic + handler (mock req/res) — no network, no real cluster/secret.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  verifyGithubSignature,
  normalizeGithubEvent,
  RepoEventStore,
  handleGithubWebhook,
  MAX_WEBHOOK_BYTES,
} from '../src/github-webhook.js'

const SECRET = 'whsec_test_secret'
const sign = (body, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

describe('verifyGithubSignature()', () => {
  const body = JSON.stringify({ hello: 'world' })

  it('accepts a correct sha256 signature', () => {
    assert.equal(verifyGithubSignature(body, sign(body), SECRET), true)
    assert.equal(verifyGithubSignature(Buffer.from(body), sign(body), SECRET), true)
  })

  it('rejects a signature made with the wrong secret', () => {
    assert.equal(verifyGithubSignature(body, sign(body, 'other'), SECRET), false)
  })

  it('rejects a body that does not match the signature (tamper)', () => {
    assert.equal(verifyGithubSignature(`${body} `, sign(body), SECRET), false)
  })

  it('rejects a missing / malformed / wrong-length signature without throwing', () => {
    assert.equal(verifyGithubSignature(body, undefined, SECRET), false)
    assert.equal(verifyGithubSignature(body, 'not-a-sig', SECRET), false)
    assert.equal(verifyGithubSignature(body, 'sha1=deadbeef', SECRET), false)
    assert.equal(verifyGithubSignature(body, 'sha256=abc', SECRET), false) // wrong length
  })

  it('rejects when no secret is configured', () => {
    assert.equal(verifyGithubSignature(body, sign(body), ''), false)
    assert.equal(verifyGithubSignature(body, sign(body), undefined), false)
  })
})

describe('normalizeGithubEvent()', () => {
  const NOW = { now: () => new Date('2026-06-27T00:00:00.000Z') }

  it('normalizes a push (branch, count, head summary)', () => {
    const ev = normalizeGithubEvent('push', {
      ref: 'refs/heads/main',
      commits: [{}, {}],
      head_commit: { message: 'fix: thing\n\nbody', url: 'https://gh/c' },
      repository: { full_name: 'org/repo' },
      sender: { login: 'alice' },
    }, NOW)
    assert.equal(ev.kind, 'push')
    assert.equal(ev.repo, 'org/repo')
    assert.equal(ev.actor, 'alice')
    assert.equal(ev.branch, 'main')
    assert.equal(ev.title, 'fix: thing')
    assert.equal(ev.url, 'https://gh/c')
    assert.equal(ev.summary, 'pushed 2 commits to main')
    assert.equal(ev.at, '2026-06-27T00:00:00.000Z')
  })

  it('singularizes a one-commit push', () => {
    const ev = normalizeGithubEvent('push', { ref: 'refs/heads/dev', commits: [{}], repository: { name: 'r' } })
    assert.equal(ev.summary, 'pushed 1 commit to dev')
  })

  it('normalizes a pull_request (action, number, title)', () => {
    const ev = normalizeGithubEvent('pull_request', {
      action: 'opened',
      pull_request: { number: 42, title: 'Add X', html_url: 'https://gh/pr/42' },
      repository: { full_name: 'org/repo' },
    })
    assert.equal(ev.kind, 'pull_request')
    assert.equal(ev.action, 'opened')
    assert.equal(ev.number, 42)
    assert.equal(ev.title, 'Add X')
    assert.equal(ev.url, 'https://gh/pr/42')
    assert.equal(ev.summary, 'opened PR #42')
  })

  it('normalizes an issues event + a ping', () => {
    const issue = normalizeGithubEvent('issues', { action: 'closed', issue: { number: 7, title: 'Bug' } })
    assert.equal(issue.summary, 'closed issue #7')
    const ping = normalizeGithubEvent('ping', { zen: 'Keep it simple.', repository: { full_name: 'o/r' } })
    assert.equal(ping.kind, 'ping')
    assert.equal(ping.title, 'Keep it simple.')
    assert.equal(ping.summary, 'webhook configured (ping)')
  })

  it('returns null for unsurfaced events + malformed payloads', () => {
    assert.equal(normalizeGithubEvent('star', { repository: {} }), null)
    assert.equal(normalizeGithubEvent('push', null), null)
    assert.equal(normalizeGithubEvent('push', 'nope'), null)
    assert.equal(normalizeGithubEvent('push', undefined), null)
  })

  it('tolerates adversarial field shapes without throwing', () => {
    // A hostile / garbage authentic payload must produce a value (or null), never throw.
    assert.doesNotThrow(() => normalizeGithubEvent('push', {
      ref: 12345, // not a string
      commits: 'not-an-array',
      head_commit: { message: 42 }, // not a string
      repository: ['array', 'not', 'object'],
      sender: null,
    }))
    const ev = normalizeGithubEvent('pull_request', { action: null, pull_request: { number: 'NaN' } })
    assert.equal(ev.kind, 'pull_request')
    assert.equal(ev.number, null) // a non-number "number" is coerced to null
  })
})

describe('RepoEventStore', () => {
  it('pushes + lists, newest last', () => {
    const s = new RepoEventStore()
    s.push({ kind: 'a' })
    s.push({ kind: 'b' })
    assert.equal(s.size, 2)
    assert.deepEqual(s.list().map((e) => e.kind), ['a', 'b'])
    assert.deepEqual(s.list({ limit: 1 }).map((e) => e.kind), ['b'])
  })

  it('is bounded — evicts oldest past the cap', () => {
    const s = new RepoEventStore({ cap: 3 })
    for (let i = 0; i < 5; i++) s.push({ kind: String(i) })
    assert.equal(s.size, 3)
    assert.deepEqual(s.list().map((e) => e.kind), ['2', '3', '4'])
  })
})

describe('handleGithubWebhook()', () => {
  let savedEnv
  beforeEach(() => {
    savedEnv = process.env.GITHUB_WEBHOOK_SECRET
    delete process.env.GITHUB_WEBHOOK_SECRET
  })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.GITHUB_WEBHOOK_SECRET
    else process.env.GITHUB_WEBHOOK_SECRET = savedEnv
  })

  // Mock req/res supporting the helpers the handler uses: sendOversizeResponse
  // pauses the stream + waits for res 'finish'.
  function makeReq(headers) {
    const req = new EventEmitter()
    req.headers = headers
    req.socket = { remoteAddress: '127.0.0.1' }
    req.pause = () => {}
    req.resume = () => {}
    return req
  }
  function makeRes() {
    const res = new EventEmitter()
    res.statusCode = null
    res.headers = null
    res.body = null
    res.socket = null
    res.writeHead = (status, h) => { res.statusCode = status; res.headers = h }
    res.end = (b) => { res.body = b; res.emit('finish') }
    return res
  }

  // Drive one delivery synchronously and return the captured response.
  function deliver(server, { headers = {}, body = '' } = {}) {
    const req = makeReq(headers)
    const res = makeRes()
    handleGithubWebhook(server, req, res)
    if (res.statusCode == null) {
      // listeners were registered (passed rate-limit + secret) — feed the body.
      req.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(body))
      req.emit('end')
    }
    return res
  }

  it('503 when no secret is configured (inert until set)', () => {
    const res = deliver({}, { headers: { 'x-github-event': 'push' }, body: '{}' })
    assert.equal(res.statusCode, 503)
  })

  it('401 on a missing or wrong signature (before parsing the body)', () => {
    const noSig = deliver({ _githubWebhookSecret: SECRET }, { headers: { 'x-github-event': 'push' }, body: '{"x":1}' })
    assert.equal(noSig.statusCode, 401)
    const wrong = deliver({ _githubWebhookSecret: SECRET }, {
      headers: { 'x-github-event': 'push', 'x-hub-signature-256': `sha256=${'a'.repeat(64)}` },
      body: '{"x":1}',
    })
    assert.equal(wrong.statusCode, 401)
  })

  it('202 + stores a surfaced event on a valid signed push', () => {
    const server = { _githubWebhookSecret: SECRET }
    const body = JSON.stringify({ ref: 'refs/heads/main', commits: [{}], repository: { full_name: 'o/r' }, sender: { login: 'bob' } })
    const res = deliver(server, {
      headers: { 'x-github-event': 'push', 'x-hub-signature-256': sign(body) },
      body,
    })
    assert.equal(res.statusCode, 202)
    assert.equal(JSON.parse(res.body).surfaced, true)
    assert.equal(server._repoEventStore.size, 1)
    assert.equal(server._repoEventStore.list()[0].branch, 'main')
  })

  it('202 accept-and-skip for an authentic but unsurfaced event (nothing stored)', () => {
    const server = { _githubWebhookSecret: SECRET }
    const body = JSON.stringify({ repository: { full_name: 'o/r' } })
    const res = deliver(server, {
      headers: { 'x-github-event': 'star', 'x-hub-signature-256': sign(body) },
      body,
    })
    assert.equal(res.statusCode, 202)
    assert.equal(JSON.parse(res.body).surfaced, false)
    assert.equal(server._repoEventStore, undefined)
  })

  it('#6536: broadcasts the normalized event live on a surfaced delivery', () => {
    const broadcasts = []
    const server = { _githubWebhookSecret: SECRET, _broadcastRepoEvent: (e) => broadcasts.push(e) }
    const body = JSON.stringify({ ref: 'refs/heads/main', commits: [{}], repository: { full_name: 'o/r' }, sender: { login: 'bob' } })
    deliver(server, { headers: { 'x-github-event': 'push', 'x-hub-signature-256': sign(body) }, body })
    assert.equal(broadcasts.length, 1)
    assert.equal(broadcasts[0].kind, 'push')
    assert.equal(broadcasts[0].branch, 'main')
    // the broadcast event is the SAME object that was stored (no re-shape)
    assert.equal(broadcasts[0], server._repoEventStore.list()[0])
  })

  it('#6536: does NOT broadcast on an unsurfaced event', () => {
    const broadcasts = []
    const server = { _githubWebhookSecret: SECRET, _broadcastRepoEvent: (e) => broadcasts.push(e) }
    const body = JSON.stringify({ repository: { full_name: 'o/r' } })
    deliver(server, { headers: { 'x-github-event': 'star', 'x-hub-signature-256': sign(body) }, body })
    assert.equal(broadcasts.length, 0)
  })

  it('#6536: a server without _broadcastRepoEvent still stores (broadcast is optional)', () => {
    const server = { _githubWebhookSecret: SECRET }
    const body = JSON.stringify({ ref: 'refs/heads/main', commits: [{}], repository: { full_name: 'o/r' }, sender: { login: 'bob' } })
    const res = deliver(server, { headers: { 'x-github-event': 'push', 'x-hub-signature-256': sign(body) }, body })
    assert.equal(res.statusCode, 202)
    assert.equal(server._repoEventStore.size, 1)
  })

  it('400 on a valid signature over invalid JSON', () => {
    const body = 'not json'
    const res = deliver({ _githubWebhookSecret: SECRET }, {
      headers: { 'x-github-event': 'push', 'x-hub-signature-256': sign(body) },
      body,
    })
    assert.equal(res.statusCode, 400)
  })

  it('413 on an oversized body — and STOPS consuming (no unbounded drain)', () => {
    const req = makeReq({ 'x-github-event': 'push' })
    const res = makeRes()
    handleGithubWebhook({ _githubWebhookSecret: SECRET }, req, res)
    req.emit('data', Buffer.alloc(MAX_WEBHOOK_BYTES + 1))
    assert.equal(res.statusCode, 413)
    // sendOversizeResponse removed the data listener + paused the stream — the
    // handler is no longer reading the (potentially unbounded) body off the wire.
    assert.equal(req.listenerCount('data'), 0, 'data listener removed after 413')
    // A late 'end' must not re-process or change the response.
    req.emit('end')
    assert.equal(res.statusCode, 413)
  })

  it('handles a body-stream error without throwing (guarded 400)', () => {
    const req = makeReq({ 'x-github-event': 'push' })
    const res = makeRes()
    handleGithubWebhook({ _githubWebhookSecret: SECRET }, req, res)
    // The error callback fires on a later tick, outside the dispatch try/catch —
    // it must not escape to uncaughtException.
    assert.doesNotThrow(() => req.emit('error', new Error('client reset')))
    assert.equal(res.statusCode, 400)
  })

  it('reads the secret from $GITHUB_WEBHOOK_SECRET when not set on the server', () => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET
    const body = JSON.stringify({ zen: 'hi', repository: { full_name: 'o/r' } })
    const res = deliver({}, { headers: { 'x-github-event': 'ping', 'x-hub-signature-256': sign(body) }, body })
    assert.equal(res.statusCode, 202)
  })
})
