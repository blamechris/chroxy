import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runShellApproveCmd, runShellListCmd, runShellDenyCmd } from '../src/cli/shell-cmd.js'

// #6277 — the `chroxy shell` CLI. Deps (connection/approval info + fetch + out/err)
// are injected so no real daemon is needed.

function deps({ conn = { apiToken: 'tok' }, approval = { port: 51515 }, fetchImpl } = {}) {
  const out = []
  const err = []
  return {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readConnectionInfo: () => conn,
    readShellApprovalInfo: () => approval,
    fetchFn: fetchImpl,
    _out: out,
    _err: err,
  }
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

describe('chroxy shell CLI (#6277)', () => {
  it('approve hits the approval port with the primary token and reports success', async () => {
    let calledUrl = null
    let calledAuth = null
    const d = deps({
      fetchImpl: async (url, opts) => { calledUrl = url; calledAuth = opts.headers.Authorization; return jsonResponse(200, { ok: true, sessionId: 'sess-9' }) },
    })
    const r = await runShellApproveCmd('abc123', {}, d)
    assert.equal(r.ok, true)
    assert.match(calledUrl, /^http:\/\/127\.0\.0\.1:51515\/api\/shell\/approve\?id=abc123$/)
    assert.equal(calledAuth, 'Bearer tok')
    assert.ok(d._out.some((l) => /Approved/.test(l) && /sess-9/.test(l)))
  })

  it('deny posts to the deny route', async () => {
    let calledUrl = null
    const d = deps({ fetchImpl: async (url) => { calledUrl = url; return jsonResponse(200, { ok: true }) } })
    const r = await runShellDenyCmd('xy', {}, d)
    assert.equal(r.ok, true)
    assert.match(calledUrl, /\/api\/shell\/deny\?id=xy$/)
    assert.ok(d._out.some((l) => /Declined/.test(l)))
  })

  it('list prints the pending approvals', async () => {
    const d = deps({ fetchImpl: async () => jsonResponse(200, { pending: [{ approvalId: 'id1', cwd: '/work', deviceName: 'Mac' }] }) })
    const r = await runShellListCmd({}, d)
    assert.equal(r.ok, true)
    assert.ok(d._out.some((l) => /id1/.test(l) && /\/work/.test(l)))
  })

  it('reports a friendly error when the daemon is not running', async () => {
    const d = deps({ conn: null, fetchImpl: async () => jsonResponse(200, {}) })
    const r = await runShellApproveCmd('abc', {}, d)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'not_running')
    assert.ok(d._err.some((l) => /not running/i.test(l)))
  })

  it('reports when approval is not enabled (no approval listener)', async () => {
    const d = deps({ approval: null, fetchImpl: async () => jsonResponse(200, {}) })
    const r = await runShellApproveCmd('abc', {}, d)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'approval_disabled')
    assert.ok(d._err.some((l) => /not enabled/i.test(l)))
  })

  it('maps a 404 to a clear "no pending approval" message', async () => {
    const d = deps({ fetchImpl: async () => jsonResponse(404, { error: 'not_found' }) })
    const r = await runShellApproveCmd('gone', {}, d)
    assert.equal(r.ok, false)
    assert.equal(r.status, 404)
    assert.ok(d._err.some((l) => /no pending approval/i.test(l)))
  })

  it('requires an id', async () => {
    const d = deps({ fetchImpl: async () => jsonResponse(200, {}) })
    const r = await runShellApproveCmd('', {}, d)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'bad_args')
  })
})
