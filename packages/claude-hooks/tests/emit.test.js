// #5413 Phase 4: emitter pins.
//
//   - every hook event builds an envelope that validates against the REAL
//     IngestEventSchema from @chroxy/protocol (source charset, flat data
//     bag, ts bounds) — the contract the server enforces
//   - project is sent EXPLICITLY (cwd git-root walk, .git dir AND .git
//     file, $CLAUDE_PROJECT_DIR fallback)
//   - runEmit: bearer header + body on the wire; silent no-op when the
//     daemon is down, when no secret resolves, on garbage stdin
//   - sanitizeData clamps to schema bounds instead of failing
//   - config resolution: env overrides win; config.json port; defaults
//
// All paths are temp dirs; env is passed explicitly (never process.env).

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IngestEventSchema } from '@chroxy/protocol'
import { buildEnvelope, resolveHookEvent, runEmit, sanitizeData, SOURCE } from '../src/emit.js'
import { EMITTERS } from '../src/emitters.js'
import { resolveIngestUrl, resolveIngestSecret, DEFAULT_PORT } from '../src/config.js'
import { deriveProject } from '../src/project.js'

const SECRET = 'test-hooks-secret'
const NOW = 1_750_000_000_000

function tempRepo({ gitFile = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hooks-repo-'))
  if (gitFile) {
    writeFileSync(join(root, '.git'), 'gitdir: /elsewhere/worktrees/x\n')
  } else {
    mkdirSync(join(root, '.git'))
  }
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  return root
}

describe('buildEnvelope', () => {
  const repo = tempRepo()
  const basePayload = { session_id: 'sess-abc', cwd: join(repo, 'src', 'deep') }

  for (const hookEvent of Object.keys(EMITTERS)) {
    it(`${hookEvent} envelope validates against IngestEventSchema`, () => {
      const envelope = buildEnvelope(hookEvent, basePayload, { env: {}, now: () => NOW })
      const result = IngestEventSchema.safeParse(envelope)
      assert.equal(result.success, true, JSON.stringify(result.error?.issues))
      assert.equal(envelope.source, SOURCE)
      assert.equal(envelope.sessionId, 'sess-abc')
      assert.equal(envelope.ts, NOW)
      assert.equal(envelope.project, repo.split('/').pop())
    })
  }

  it('maps each hook event to its snake_cased ingest type', () => {
    const expectations = {
      SessionStart: 'session_start',
      SessionEnd: 'session_end',
      SubagentStart: 'subagent_start',
      SubagentStop: 'subagent_stop',
      Notification: 'notification',
      PostToolUse: 'post_tool_use',
    }
    for (const [hookEvent, type] of Object.entries(expectations)) {
      assert.equal(buildEnvelope(hookEvent, {}, { env: {}, now: () => NOW }).type, type)
    }
  })

  it('carries hook-specific fields into the data bag with server-known keys', () => {
    const notif = buildEnvelope('Notification', { message: 'Needs approval', title: 'Hold up' }, { env: {}, now: () => NOW })
    assert.equal(notif.data.message, 'Needs approval')
    assert.equal(notif.data.title, 'Hold up')

    const tool = buildEnvelope('PostToolUse', { tool_name: 'Bash' }, { env: {}, now: () => NOW })
    assert.equal(tool.data.tool, 'Bash')

    const end = buildEnvelope('SessionEnd', { reason: 'logout' }, { env: {}, now: () => NOW })
    assert.equal(end.data.reason, 'logout')

    const start = buildEnvelope('SessionStart', { source: 'resume' }, { env: {}, now: () => NOW })
    assert.equal(start.data.startSource, 'resume')
  })

  it('returns null for unknown hook events', () => {
    assert.equal(buildEnvelope('PreCompact', {}, { env: {}, now: () => NOW }), null)
  })

  // #5439 GAP A: the Notification emitter must forward the matcher
  // discriminator — without it the server cannot tell idle prompts from
  // permission prompts and every "ready for input" renders as 🔐.
  it('Notification forwards notification_type as data.notificationType (#5439 GAP A)', () => {
    const idle = buildEnvelope('Notification', { notification_type: 'idle_prompt', message: 'Ready' }, { env: {}, now: () => NOW })
    assert.equal(idle.data.notificationType, 'idle_prompt')
    assert.equal(IngestEventSchema.safeParse(idle).success, true)

    const perm = buildEnvelope('Notification', { notification_type: 'permission_prompt' }, { env: {}, now: () => NOW })
    assert.equal(perm.data.notificationType, 'permission_prompt')

    const none = buildEnvelope('Notification', { message: 'hi' }, { env: {}, now: () => NOW })
    assert.equal('notificationType' in none.data, false, 'absent on payloads without notification_type')
  })

  it('omits sessionId/project when underivable and still validates', () => {
    const envelope = buildEnvelope('Notification', {}, { env: {}, now: () => NOW })
    assert.equal('sessionId' in envelope, false)
    assert.equal('project' in envelope, false)
    assert.equal(IngestEventSchema.safeParse(envelope).success, true)
  })
})

describe('deriveProject', () => {
  it('walks up to a .git directory', () => {
    const repo = tempRepo()
    assert.equal(deriveProject(join(repo, 'src', 'deep'), {}), repo.split('/').pop())
  })

  it('treats a .git FILE as a root (worktrees)', () => {
    const repo = tempRepo({ gitFile: true })
    assert.equal(deriveProject(join(repo, 'src'), {}), repo.split('/').pop())
  })

  it('falls back to $CLAUDE_PROJECT_DIR basename when cwd is missing', () => {
    assert.equal(deriveProject(null, { CLAUDE_PROJECT_DIR: '/some/path/myproject' }), 'myproject')
  })

  it('returns null with no cwd and no CLAUDE_PROJECT_DIR', () => {
    assert.equal(deriveProject(null, {}), null)
  })

  // #5439 GAP B: worktree-agent cwds belong to the PARENT project — the
  // segment before /.claude/worktrees/ — not the agent-* checkout (port of
  // extract_project_name's worktree remap).
  it('maps .claude/worktrees/agent-* cwds to the parent project (#5439 GAP B)', () => {
    const root = mkdtempSync(join(tmpdir(), 'hooks-wt-'))
    const proj = join(root, 'myproj')
    const wt = join(proj, '.claude', 'worktrees', 'agent-abc123')
    mkdirSync(join(wt, 'packages', 'server'), { recursive: true })
    // Worktree checkouts carry a .git FILE — the remap must win over the walk.
    writeFileSync(join(wt, '.git'), 'gitdir: /elsewhere/worktrees/agent-abc123\n')
    assert.equal(deriveProject(wt, {}), 'myproj')
    assert.equal(deriveProject(join(wt, 'packages', 'server'), {}), 'myproj', 'nested worktree cwd remaps too')
  })
})

describe('sanitizeData', () => {
  it('truncates strings to 4096 chars (schema per-value cap)', () => {
    const out = sanitizeData({ big: 'x'.repeat(5000) })
    assert.equal(out.big.length, 4096)
  })

  it('caps at 32 keys (schema key cap)', () => {
    const input = {}
    for (let i = 0; i < 40; i++) input[`k${i}`] = i
    assert.equal(Object.keys(sanitizeData(input)).length, 32)
  })

  it('drops nested objects/arrays/undefined, keeps flat primitives', () => {
    const out = sanitizeData({ s: 'a', n: 1, b: true, z: null, o: { nested: 1 }, a: [1], u: undefined, inf: Infinity })
    assert.deepEqual(out, { s: 'a', n: 1, b: true, z: null })
  })
})

describe('resolveHookEvent', () => {
  it('accepts hook event names and snake_cased types', () => {
    assert.equal(resolveHookEvent('SessionStart', {}), 'SessionStart')
    assert.equal(resolveHookEvent('session_start', {}), 'SessionStart')
    assert.equal(resolveHookEvent('post_tool_use', {}), 'PostToolUse')
  })

  it('falls back to the payload hook_event_name', () => {
    assert.equal(resolveHookEvent(null, { hook_event_name: 'SubagentStop' }), 'SubagentStop')
  })

  it('returns null for unknown values', () => {
    assert.equal(resolveHookEvent('TotallyMadeUp', {}), null)
    assert.equal(resolveHookEvent(null, { hook_event_name: 'Nope' }), null)
    assert.equal(resolveHookEvent(null, {}), null)
  })
})

describe('config resolution', () => {
  it('CHROXY_INGEST_URL and CHROXY_INGEST_SECRET env overrides win', () => {
    const env = { CHROXY_INGEST_URL: 'http://127.0.0.1:9999/api/events', CHROXY_INGEST_SECRET: 's3cret' }
    assert.equal(resolveIngestUrl(env), 'http://127.0.0.1:9999/api/events')
    assert.equal(resolveIngestSecret(env), 's3cret')
  })

  it('reads port from config.json and secret from ingest-secret under CHROXY_CONFIG_DIR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hooks-cfg-'))
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 4242 }))
    writeFileSync(join(dir, 'ingest-secret'), 'file-secret\n')
    const env = { CHROXY_CONFIG_DIR: dir }
    assert.equal(resolveIngestUrl(env), 'http://127.0.0.1:4242/api/events')
    assert.equal(resolveIngestSecret(env), 'file-secret')
  })

  it('falls back to the default port on missing/garbled config and null on missing secret', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hooks-cfg-'))
    writeFileSync(join(dir, 'config.json'), 'not json{{{')
    const env = { CHROXY_CONFIG_DIR: dir }
    assert.equal(resolveIngestUrl(env), `http://127.0.0.1:${DEFAULT_PORT}/api/events`)
    assert.equal(resolveIngestSecret(env), null)
  })

  it('ignores out-of-range ports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hooks-cfg-'))
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 99999 }))
    assert.equal(resolveIngestUrl({ CHROXY_CONFIG_DIR: dir }), `http://127.0.0.1:${DEFAULT_PORT}/api/events`)
  })
})

describe('runEmit', () => {
  let server
  let baseUrl
  const received = []

  before(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        received.push({ url: req.url, auth: req.headers['authorization'], body })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    baseUrl = `http://127.0.0.1:${server.address().port}/api/events`
  })

  after(() => server.close())

  const envFor = () => ({ CHROXY_INGEST_URL: baseUrl, CHROXY_INGEST_SECRET: SECRET })

  it('POSTs a schema-valid envelope with the bearer secret', async () => {
    const repo = tempRepo()
    const payload = { hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: repo, source: 'startup' }
    const result = await runEmit({
      hookEventArg: 'session_start',
      stdinText: JSON.stringify(payload),
      env: envFor(),
      now: () => NOW,
    })
    assert.deepEqual(result, { sent: true })
    const req = received.at(-1)
    assert.equal(req.auth, `Bearer ${SECRET}`)
    const sent = JSON.parse(req.body)
    assert.equal(IngestEventSchema.safeParse(sent).success, true)
    assert.equal(sent.type, 'session_start')
    assert.equal(sent.sessionId, 'sess-1')
    assert.equal(sent.project, repo.split('/').pop())
    assert.equal(sent.data.startSource, 'startup')
  })

  it('resolves the hook event from stdin when no arg is given', async () => {
    const result = await runEmit({
      stdinText: JSON.stringify({ hook_event_name: 'SubagentStop', session_id: 's2' }),
      env: envFor(),
      now: () => NOW,
    })
    assert.deepEqual(result, { sent: true })
    assert.equal(JSON.parse(received.at(-1).body).type, 'subagent_stop')
  })

  it('still emits on garbage stdin (envelope without payload fields)', async () => {
    const result = await runEmit({
      hookEventArg: 'notification',
      stdinText: 'this is not json',
      env: envFor(),
      now: () => NOW,
    })
    assert.deepEqual(result, { sent: true })
    const sent = JSON.parse(received.at(-1).body)
    assert.equal(sent.type, 'notification')
    assert.equal(IngestEventSchema.safeParse(sent).success, true)
  })

  it('is a silent no-op when no secret resolves (no network call)', async () => {
    const countBefore = received.length
    const result = await runEmit({
      hookEventArg: 'session_end',
      stdinText: '{}',
      env: { CHROXY_INGEST_URL: baseUrl, CHROXY_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'hooks-nosecret-')) },
      now: () => NOW,
    })
    assert.deepEqual(result, { sent: false, reason: 'no_secret' })
    assert.equal(received.length, countBefore)
  })

  it('fails silent (no throw) when the daemon is down', async () => {
    const result = await runEmit({
      hookEventArg: 'session_start',
      stdinText: '{}',
      env: { CHROXY_INGEST_URL: 'http://127.0.0.1:1/api/events', CHROXY_INGEST_SECRET: SECRET },
      now: () => NOW,
      timeoutMs: 200,
    })
    assert.equal(result.sent, false)
  })

  it('reports non-2xx responses without throwing', async () => {
    const deny = createServer((req, res) => { res.writeHead(401); res.end() })
    deny.listen(0, '127.0.0.1')
    await once(deny, 'listening')
    try {
      const result = await runEmit({
        hookEventArg: 'session_start',
        stdinText: '{}',
        env: { CHROXY_INGEST_URL: `http://127.0.0.1:${deny.address().port}/api/events`, CHROXY_INGEST_SECRET: 'wrong' },
        now: () => NOW,
      })
      assert.deepEqual(result, { sent: false, reason: 'http_401' })
    } finally {
      deny.close()
    }
  })

  it('returns unknown_event for unmapped hooks without touching the network', async () => {
    const countBefore = received.length
    const result = await runEmit({ hookEventArg: 'PreCompact', stdinText: '{}', env: envFor(), now: () => NOW })
    assert.deepEqual(result, { sent: false, reason: 'unknown_event' })
    assert.equal(received.length, countBefore)
  })

  // #5439 GAP B — non-project session filtering (port of claude-notify.sh's
  // tmp / home / worktree cwd filter). Suppressed events never touch the
  // network; worktree cwds still pass SUBAGENT events through (their counts
  // belong to the parent project).
  describe('non-project cwd suppression (#5439 GAP B)', () => {
    it('suppresses events from /tmp cwds', async () => {
      const tmpCwd = mkdtempSync('/tmp/hooks-tmpfilter-')
      const countBefore = received.length
      const result = await runEmit({
        hookEventArg: 'session_start',
        stdinText: JSON.stringify({ cwd: tmpCwd, session_id: 's-tmp' }),
        env: envFor(),
        now: () => NOW,
      })
      assert.deepEqual(result, { sent: false, reason: 'non_project_cwd' })
      assert.equal(received.length, countBefore, 'no network call for a /tmp session')
    })

    it('suppresses events from the home directory root (basename = username, not a project)', async () => {
      const home = mkdtempSync(join(tmpdir(), 'hooks-home-'))
      const countBefore = received.length
      const result = await runEmit({
        hookEventArg: 'notification',
        stdinText: JSON.stringify({ cwd: home }),
        env: { ...envFor(), HOME: home },
        now: () => NOW,
      })
      assert.deepEqual(result, { sent: false, reason: 'non_project_cwd' })
      assert.equal(received.length, countBefore)
    })

    it('does NOT suppress a project under the home directory', async () => {
      const home = mkdtempSync(join(tmpdir(), 'hooks-home-'))
      const proj = join(home, 'realproject')
      mkdirSync(join(proj, '.git'), { recursive: true })
      const result = await runEmit({
        hookEventArg: 'session_start',
        stdinText: JSON.stringify({ cwd: proj, session_id: 's-proj' }),
        env: { ...envFor(), HOME: home },
        now: () => NOW,
      })
      assert.deepEqual(result, { sent: true })
      assert.equal(JSON.parse(received.at(-1).body).project, 'realproject')
    })

    it('suppresses non-subagent events from worktree cwds, but lets subagent events through remapped to the parent', async () => {
      const root = mkdtempSync(join(tmpdir(), 'hooks-wtfilter-'))
      const wt = join(root, 'parentproj', '.claude', 'worktrees', 'agent-xyz')
      mkdirSync(wt, { recursive: true })

      const countBefore = received.length
      const start = await runEmit({
        hookEventArg: 'session_start',
        stdinText: JSON.stringify({ cwd: wt, session_id: 's-wt' }),
        env: envFor(),
        now: () => NOW,
      })
      assert.deepEqual(start, { sent: false, reason: 'non_project_cwd' })
      assert.equal(received.length, countBefore, 'worktree SessionStart suppressed')

      const stop = await runEmit({
        hookEventArg: 'subagent_stop',
        stdinText: JSON.stringify({ cwd: wt, session_id: 's-wt' }),
        env: envFor(),
        now: () => NOW,
      })
      assert.deepEqual(stop, { sent: true }, 'worktree SubagentStop reaches the counting code')
      const sent = JSON.parse(received.at(-1).body)
      assert.equal(sent.type, 'subagent_stop')
      assert.equal(sent.project, 'parentproj', 'subagent counts belong to the parent project')
    })

    it('CHROXY_HOOKS_SKIP_CWD_FILTER=1 bypasses the filter (test/debug escape hatch)', async () => {
      const tmpCwd = mkdtempSync('/tmp/hooks-tmpfilter-')
      const result = await runEmit({
        hookEventArg: 'session_start',
        stdinText: JSON.stringify({ cwd: tmpCwd, session_id: 's-bypass' }),
        env: { ...envFor(), CHROXY_HOOKS_SKIP_CWD_FILTER: '1' },
        now: () => NOW,
      })
      assert.deepEqual(result, { sent: true })
    })
  })
})
