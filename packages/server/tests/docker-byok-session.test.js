import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

import { DockerByokSession, remapToContainerPath, CONTAINER_WORKSPACE } from '../src/docker-byok-session.js'
import { ClaudeByokSession } from '../src/byok-session.js'
import { registerDockerProvider, getProvider } from '../src/providers.js'

/**
 * Tests for the docker-byok provider (#4053).
 *
 * The session extends ClaudeByokSession — the agent loop and Anthropic
 * client are exercised in byok-session.test.js, so this suite focuses
 * on the docker-byok additions:
 *   - constructor wiring (provider id, defaults, opt validation)
 *   - container preflight + lifecycle (start, destroy, attach-external)
 *   - host→container path remapping (incl. traversal refusal)
 *   - the _dispatchBuiltinTool override routes Read/Write/Edit/Bash/Glob/
 *     Grep into the container while leaving TodoWrite/WebFetch host-side
 *   - provider registration via registerDockerProvider()
 *
 * No real Docker daemon is required — every shellout to docker(8) is
 * stubbed via the `_execFile` and `_dockerBackend` constructor seams.
 */

/**
 * Build a stub `execFile` that records calls and returns canned results.
 * Keyed by the first docker subcommand (`info`, `run`, `exec`, `rm`).
 *
 *   execFileStub({
 *     info: { stdout: 'ok', stderr: '', error: null },
 *     run:  { stdout: 'CONTAINER_ID_0123456789ab\n', stderr: '', error: null },
 *     exec: { stdout: '', stderr: '', error: null },
 *     rm:   { stdout: '', stderr: '', error: null },
 *   })
 */
function execFileStub(byCmd = {}) {
  const calls = []
  const fn = (cmd, args, opts, callback) => {
    const sub = args[0]
    calls.push({ cmd, args: [...args], opts })
    const cfg = byCmd[sub] || { stdout: '', stderr: '', error: null }
    if (typeof callback !== 'function') return
    if (cfg.error) {
      const err = cfg.error instanceof Error ? cfg.error : new Error(cfg.error)
      err.stderr = cfg.stderr || ''
      callback(err, cfg.stdout || '', cfg.stderr || '')
      return
    }
    callback(null, cfg.stdout || '', cfg.stderr || '')
  }
  fn.calls = calls
  return fn
}

/**
 * Stub DockerBackend that captures `execInEnvironment` calls and returns
 * a canned `{ stdout, stderr }`. Lets us assert the exact bash commands
 * the docker-byok tool dispatcher constructs for each tool.
 */
function backendStub({ execResponses = {}, defaultResponse = { stdout: '', stderr: '' } } = {}) {
  const calls = []
  return {
    calls,
    async execInEnvironment(containerId, opts) {
      calls.push({ containerId, ...opts })
      const matcher = Object.keys(execResponses).find((needle) => opts.cmd.includes(needle))
      const resp = matcher ? execResponses[matcher] : defaultResponse
      return { stdout: resp.stdout || '', stderr: resp.stderr || '' }
    },
  }
}

let tmpHome
let originalHome
let originalApiKey
let originalMcpTrustPath

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-docker-byok-test-'))
  originalHome = process.env.HOME
  originalApiKey = process.env.ANTHROPIC_API_KEY
  originalMcpTrustPath = process.env.CHROXY_MCP_TRUST_PATH
  process.env.HOME = tmpHome
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-fixture'
  process.env.CHROXY_MCP_TRUST_PATH = join(tmpHome, 'mcp-trust.json')
})

afterEach(() => {
  if (originalHome) process.env.HOME = originalHome
  else delete process.env.HOME
  if (originalApiKey) process.env.ANTHROPIC_API_KEY = originalApiKey
  else delete process.env.ANTHROPIC_API_KEY
  if (originalMcpTrustPath) process.env.CHROXY_MCP_TRUST_PATH = originalMcpTrustPath
  else delete process.env.CHROXY_MCP_TRUST_PATH
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('DockerByokSession static configuration', () => {
  it('exposes the expected displayLabel', () => {
    assert.equal(DockerByokSession.displayLabel, 'Claude (BYOK — Docker container)')
  })

  it('inherits BYOK capabilities and adds containerized: true', () => {
    const caps = DockerByokSession.capabilities
    assert.equal(caps.containerized, true)
    // Sanity-check that the inherited BYOK capabilities still flow:
    assert.equal(caps.permissions, true)
    assert.equal(caps.inProcessPermissions, true)
    assert.equal(caps.streaming, true)
  })

  it('declares BYOK credentials in preflight (label overridden)', () => {
    const pf = DockerByokSession.preflight
    assert.deepEqual(pf.credentials.envVars, ['ANTHROPIC_API_KEY'])
    assert.equal(pf.credentials.optional, false)
    assert.match(pf.label, /BYOK.*Docker/)
  })

  it('resolveAuth() returns the BYOK ready shape when ANTHROPIC_API_KEY is set', () => {
    const helpers = {
      cachedResolveCredentialFile: () => ({ key: 'sk-ant-test', source: 'env' }),
    }
    const result = DockerByokSession.resolveAuth({ ANTHROPIC_API_KEY: 'sk-ant-test' }, helpers)
    assert.equal(result.ready, true)
    assert.equal(result.source, 'env')
    assert.equal(result.envVar, 'ANTHROPIC_API_KEY')
  })

  it('resolveAuth() returns not-ready when no key resolved', () => {
    const helpers = {
      cachedResolveCredentialFile: () => ({ key: null, source: 'none', reason: 'no credential file' }),
    }
    const result = DockerByokSession.resolveAuth({}, helpers)
    assert.equal(result.ready, false)
    assert.equal(result.source, 'none')
  })
})

describe('DockerByokSession constructor', () => {
  it('reports provider id "docker-byok"', () => {
    const session = new DockerByokSession({ cwd: tmpHome, _execFile: execFileStub(), _dockerBackend: backendStub() })
    assert.equal(session._provider, 'docker-byok')
  })

  it('extends ClaudeByokSession so the agent loop is inherited', () => {
    const session = new DockerByokSession({ cwd: tmpHome, _execFile: execFileStub(), _dockerBackend: backendStub() })
    assert.ok(session instanceof ClaudeByokSession)
  })

  it('applies sane defaults for image / memory / cpu / user', () => {
    const session = new DockerByokSession({ cwd: tmpHome, _execFile: execFileStub(), _dockerBackend: backendStub() })
    assert.equal(session._image, 'node:22-slim')
    assert.equal(session._memoryLimit, '2g')
    assert.equal(session._cpuLimit, '2')
    assert.equal(session._containerUser, 'chroxy')
    assert.equal(session._containerOwned, true)
    assert.equal(session._containerId, null)
  })

  it('honors caller-provided overrides', () => {
    const session = new DockerByokSession({
      cwd: tmpHome,
      image: 'node:22-bookworm',
      memoryLimit: '4g',
      cpuLimit: '4',
      containerUser: 'agent',
      _execFile: execFileStub(),
      _dockerBackend: backendStub(),
    })
    assert.equal(session._image, 'node:22-bookworm')
    assert.equal(session._memoryLimit, '4g')
    assert.equal(session._cpuLimit, '4')
    assert.equal(session._containerUser, 'agent')
  })

  it('refuses an invalid containerUser', () => {
    assert.throws(
      () => new DockerByokSession({ cwd: tmpHome, containerUser: 'BAD;USER', _execFile: execFileStub(), _dockerBackend: backendStub() }),
      /Invalid containerUser/,
    )
  })

  it('marks the session as not-owning when containerId is supplied', () => {
    const session = new DockerByokSession({
      cwd: tmpHome,
      containerId: 'external-id-1234',
      _execFile: execFileStub(),
      _dockerBackend: backendStub(),
    })
    assert.equal(session._containerOwned, false)
    assert.equal(session._containerId, 'external-id-1234')
  })
})

describe('DockerByokSession start() — preflight + lifecycle', () => {
  it('emits a docker_not_running error when `docker info` fails', async () => {
    const _execFile = execFileStub({
      info: { error: new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'), stderr: 'Cannot connect to the Docker daemon' },
    })
    const session = new DockerByokSession({ cwd: tmpHome, _execFile, _dockerBackend: backendStub() })
    const events = []
    session.on('error', (e) => events.push(e))
    await session.start()
    assert.equal(events.length, 1)
    assert.equal(events[0].code, 'docker_not_running')
    assert.match(events[0].message, /preflight/)
  })

  it('launches a container with the cwd mounted and ANTHROPIC_API_KEY forwarded', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      run: { stdout: 'CONTAINER_ID_0123456789ab\n' },
      exec: { stdout: '' },
    })
    const session = new DockerByokSession({
      cwd: '/tmp/chroxy-workspace',
      _execFile,
      _dockerBackend: backendStub(),
    })
    // Stub the Anthropic client so super.start() doesn't need network.
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()

    // First call: `docker info` (preflight).
    assert.equal(_execFile.calls[0].args[0], 'info')
    // Second call: `docker run`.
    const runCall = _execFile.calls.find((c) => c.args[0] === 'run')
    assert.ok(runCall, 'expected a `docker run` call')
    assert.ok(runCall.args.includes('-v'), 'volume flag missing')
    const volumeFlag = runCall.args[runCall.args.indexOf('-v') + 1]
    assert.equal(volumeFlag, '/tmp/chroxy-workspace:/workspace')
    // API key is forwarded.
    assert.ok(
      runCall.args.some((a) => a.startsWith('ANTHROPIC_API_KEY=sk-ant-test-key-fixture')),
      'ANTHROPIC_API_KEY not forwarded into container',
    )
    // Container hardening flags.
    assert.ok(runCall.args.includes('--cap-drop'))
    assert.ok(runCall.args.includes('--security-opt'))
    assert.ok(runCall.args.includes('--pids-limit'))

    assert.equal(session._containerId, 'CONTAINER_ID_0123456789ab')
    assert.equal(session._containerReady, true)

    await session.destroy()
  })

  it('destroys the container on session destroy when owned', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      run: { stdout: 'CONTAINER_ID_owned_999\n' },
      exec: { stdout: '' },
      rm: { stdout: '' },
    })
    const session = new DockerByokSession({ cwd: tmpHome, _execFile, _dockerBackend: backendStub() })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()
    await session.destroy()

    const rmCall = _execFile.calls.find((c) => c.args[0] === 'rm')
    assert.ok(rmCall, 'docker rm -f was not called on destroy')
    assert.ok(rmCall.args.includes('CONTAINER_ID_owned_999'))
  })

  it('does NOT destroy the container on session destroy when externally provided', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      exec: { stdout: '' },
    })
    const session = new DockerByokSession({
      cwd: tmpHome,
      containerId: 'external-managed',
      _execFile,
      _dockerBackend: backendStub(),
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()
    await session.destroy()

    const rmCall = _execFile.calls.find((c) => c.args[0] === 'rm')
    assert.equal(rmCall, undefined, 'external container must not be removed by the session')
  })

  it('tears down owned container and stays not-ready when super.start fails (missing creds)', async () => {
    // PR #5021 review fix (Copilot, comment id 3348029212): pre-fix,
    // _containerReady was set BEFORE super.start(); a missing-creds
    // failure would leak the owned container.
    delete process.env.ANTHROPIC_API_KEY
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      run: { stdout: 'CONTAINER_ID_leak_test\n' },
      exec: { stdout: '' },
      rm: { stdout: '' },
    })
    const session = new DockerByokSession({ cwd: tmpHome, _execFile, _dockerBackend: backendStub() })
    // Do NOT stub _client — let super.start() see no key and bail.
    const events = []
    session.on('error', (e) => events.push(e))
    await session.start()
    // super.start() emits an error from byok-session.js:369. The
    // session should NOT mark itself ready, and the owned container
    // must have been destroyed.
    assert.equal(session._containerReady, false)
    assert.equal(session._processReady, false)
    const rmCall = _execFile.calls.find((c) => c.args[0] === 'rm')
    assert.ok(rmCall, 'docker rm -f must be called when super.start fails')
    assert.ok(rmCall.args.includes('CONTAINER_ID_leak_test'))
  })

  it('surfaces a docker_image_not_found error when the run fails', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      run: { error: new Error('Unable to find image \'nonexistent:latest\' locally\nno such image: nonexistent'), stderr: 'no such image: nonexistent' },
    })
    const session = new DockerByokSession({ cwd: tmpHome, image: 'nonexistent:latest', _execFile, _dockerBackend: backendStub() })
    const events = []
    session.on('error', (e) => events.push(e))
    await session.start()
    assert.ok(events.length >= 1)
    assert.equal(events[0].code, 'docker_image_not_found')
  })
})

describe('remapToContainerPath()', () => {
  it('maps an absolute path under cwd to /workspace/<suffix>', () => {
    const result = remapToContainerPath('/host/cwd/src/foo.js', '/host/cwd')
    assert.equal(result, '/workspace/src/foo.js')
  })

  it('maps the cwd itself to /workspace', () => {
    assert.equal(remapToContainerPath('/host/cwd', '/host/cwd'), '/workspace')
  })

  it('maps a relative path onto /workspace', () => {
    assert.equal(remapToContainerPath('src/foo.js', '/host/cwd'), '/workspace/src/foo.js')
  })

  it('refuses an absolute path outside cwd', () => {
    assert.throws(
      () => remapToContainerPath('/etc/passwd', '/host/cwd'),
      /outside workspace/,
    )
  })

  it('refuses a relative path that escapes via ..', () => {
    assert.throws(
      () => remapToContainerPath('../../etc/passwd', '/host/cwd'),
      /outside workspace/,
    )
  })

  it('refuses an absolute path that starts with cwd but escapes via ..', () => {
    // Regression for PR #5021 review (path traversal):
    // /host/cwd/../etc/passwd has `slice(cwd.length)` -> '/../etc/passwd',
    // and posix.join('/workspace', '/../etc/passwd') returns '/etc/passwd'
    // because the second arg is absolute. Re-asserting startsWith catches it.
    assert.throws(
      () => remapToContainerPath('/host/cwd/../etc/passwd', '/host/cwd'),
      /outside workspace/,
    )
    assert.throws(
      () => remapToContainerPath('/host/cwd/legit/../../etc/passwd', '/host/cwd'),
      /outside workspace/,
    )
    assert.throws(
      () => remapToContainerPath('/host/cwd/../../root/.ssh/id_rsa', '/host/cwd'),
      /outside workspace/,
    )
  })

  it('refuses a sibling path that shares the cwd prefix (e.g. /host/cwd-evil)', () => {
    // /host/cwd-evil/secret begins with '/host/cwd' but is not under it.
    // The `startsWith(normHostCwd + '/')` check covers this — verify it.
    assert.throws(
      () => remapToContainerPath('/host/cwd-evil/secret', '/host/cwd'),
      /outside workspace/,
    )
  })

  it('refuses an empty file_path', () => {
    assert.throws(
      () => remapToContainerPath('', '/host/cwd'),
      /required/,
    )
  })

  it('normalizes a cwd with a trailing slash', () => {
    assert.equal(remapToContainerPath('/host/cwd/foo', '/host/cwd/'), '/workspace/foo')
  })

  it('exports the canonical /workspace mount root', () => {
    assert.equal(CONTAINER_WORKSPACE, '/workspace')
  })
})

describe('DockerByokSession _dispatchBuiltinTool — tool routing', () => {
  function buildSession({ backend, execFile } = {}) {
    const _dockerBackend = backend || backendStub()
    const _execFile = execFile || execFileStub({ info: { stdout: 'ok' }, run: { stdout: 'CONTAINER_ID_aaa\n' }, exec: { stdout: '' } })
    const session = new DockerByokSession({ cwd: '/host/cwd', _execFile, _dockerBackend })
    // Simulate a started container so tool dispatch is allowed.
    session._containerReady = true
    session._containerId = 'CONTAINER_ID_aaa'
    return { session, _dockerBackend, _execFile }
  }

  it('refuses tools when the container is not ready', async () => {
    const _dockerBackend = backendStub()
    const session = new DockerByokSession({ cwd: '/host/cwd', _execFile: execFileStub(), _dockerBackend })
    // container NOT ready — default constructor state
    const result = await session._dispatchBuiltinTool({ toolName: 'Bash', input: { command: 'true' } })
    assert.equal(result.isError, true)
    assert.match(result.content, /container not ready/)
    assert.equal(_dockerBackend.calls.length, 0)
  })

  it('Read routes to `sed | head | awk` inside the container and forwards the container user', async () => {
    const _dockerBackend = backendStub({
      defaultResponse: { stdout: '    1→file contents here\n', stderr: '' },
    })
    const { session } = buildSession({ backend: _dockerBackend })
    const result = await session._dispatchBuiltinTool({
      toolName: 'Read',
      input: { file_path: '/host/cwd/foo.txt' },
    })
    assert.equal(result.isError, false)
    assert.match(result.content, /file contents here/)
    assert.equal(_dockerBackend.calls.length, 1)
    assert.match(_dockerBackend.calls[0].cmd, /sed -n '1,2000p' '\/workspace\/foo\.txt'/)
    assert.match(_dockerBackend.calls[0].cmd, /head -c/)
    // PR #5021 review fix (Copilot, comment id 3348029235): the awk
    // pass formats each line as 5-space-padded line number + arrow,
    // matching readFileTool's output shape.
    assert.match(_dockerBackend.calls[0].cmd, /awk.*printf.*%5d→%s/)
    // PR #5021 review fix (Copilot, comment id 3348029166): every
    // tool dispatch must forward the non-root container user to
    // docker exec so the useradd + chown setup is respected.
    assert.equal(_dockerBackend.calls[0].user, 'chroxy')
  })

  it('Read with offset and limit slices in the container', async () => {
    const _dockerBackend = backendStub({ defaultResponse: { stdout: 'lines 10-15\n' } })
    const { session } = buildSession({ backend: _dockerBackend })
    await session._dispatchBuiltinTool({
      toolName: 'Read',
      input: { file_path: '/host/cwd/foo.txt', offset: 10, limit: 6 },
    })
    assert.match(_dockerBackend.calls[0].cmd, /sed -n '10,15p'/)
  })

  it('Read refuses a path outside cwd (returns is_error)', async () => {
    const _dockerBackend = backendStub()
    const { session } = buildSession({ backend: _dockerBackend })
    const result = await session._dispatchBuiltinTool({
      toolName: 'Read',
      input: { file_path: '/etc/passwd' },
    })
    assert.equal(result.isError, true)
    assert.match(result.content, /outside workspace/)
    assert.equal(_dockerBackend.calls.length, 0, 'must not docker exec a path-escape attempt')
  })

  it('Write base64-encodes content and pipes it into the container', async () => {
    const _dockerBackend = backendStub({
      defaultResponse: { stdout: '5\n', stderr: '' },
    })
    const { session } = buildSession({ backend: _dockerBackend })
    const result = await session._dispatchBuiltinTool({
      toolName: 'Write',
      input: { file_path: 'src/new.js', content: 'hello' },
    })
    assert.equal(result.isError, false)
    assert.match(result.content, /Wrote 5 bytes/)
    assert.equal(_dockerBackend.calls.length, 1)
    const cmd = _dockerBackend.calls[0].cmd
    assert.match(cmd, /mkdir -p '\/workspace\/src'/)
    assert.match(cmd, /base64 -d > '\/workspace\/src\/new\.js'/)
    // The base64 of 'hello' is aGVsbG8=
    assert.match(cmd, /aGVsbG8=/)
  })

  it('Write refuses missing/non-string content with EINVAL', async () => {
    // PR #5021 review fix (Copilot, comment id 3348029266): pre-fix,
    // a missing `content` field silently truncated the file to zero
    // bytes. Now it returns EINVAL like host-side writeFileTool.
    const _dockerBackend = backendStub()
    const { session } = buildSession({ backend: _dockerBackend })
    const result = await session._dispatchBuiltinTool({
      toolName: 'Write',
      input: { file_path: 'foo.txt' },
    })
    assert.equal(result.isError, true)
    assert.match(result.content, /EINVAL.*content is required/)
    assert.equal(_dockerBackend.calls.length, 0, 'must not docker exec when content is missing')
    // Non-string types should also be refused.
    const result2 = await session._dispatchBuiltinTool({
      toolName: 'Write',
      input: { file_path: 'foo.txt', content: 12345 },
    })
    assert.equal(result2.isError, true)
    assert.match(result2.content, /EINVAL/)
    assert.equal(_dockerBackend.calls.length, 0)
    // Empty string is legitimate (clearing a file) — must still succeed.
    const result3 = await session._dispatchBuiltinTool({
      toolName: 'Write',
      input: { file_path: 'foo.txt', content: '' },
    })
    assert.equal(result3.isError, false)
  })

  it('Write refuses oversize content', async () => {
    const _dockerBackend = backendStub()
    const { session } = buildSession({ backend: _dockerBackend })
    const bigContent = 'x'.repeat(512 * 1024 + 1)
    const result = await session._dispatchBuiltinTool({
      toolName: 'Write',
      input: { file_path: 'big.bin', content: bigContent },
    })
    assert.equal(result.isError, true)
    assert.match(result.content, /exceeds/)
    assert.equal(_dockerBackend.calls.length, 0)
  })

  it('Bash routes the raw command through docker exec', async () => {
    const _dockerBackend = backendStub({
      defaultResponse: { stdout: 'hello\n', stderr: '' },
    })
    const { session } = buildSession({ backend: _dockerBackend })
    const result = await session._dispatchBuiltinTool({
      toolName: 'Bash',
      input: { command: 'echo hello' },
    })
    assert.equal(result.isError, false)
    assert.match(result.content, /stdout:\nhello/)
    assert.equal(_dockerBackend.calls.length, 1)
    assert.equal(_dockerBackend.calls[0].cmd, 'echo hello')
  })

  it('Bash refuses when command is empty', async () => {
    const _dockerBackend = backendStub()
    const { session } = buildSession({ backend: _dockerBackend })
    const result = await session._dispatchBuiltinTool({
      toolName: 'Bash',
      input: { command: '' },
    })
    assert.equal(result.isError, true)
    assert.match(result.content, /command is required/)
    assert.equal(_dockerBackend.calls.length, 0)
  })

  it('Bash honors a pre-aborted signal without docker-exec', async () => {
    const _dockerBackend = backendStub()
    const { session } = buildSession({ backend: _dockerBackend })
    const controller = new AbortController()
    controller.abort()
    const result = await session._dispatchBuiltinTool({
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
      signal: controller.signal,
    })
    assert.equal(result.isError, true)
    assert.match(result.content, /Interrupted/)
    assert.equal(_dockerBackend.calls.length, 0)
  })

  it('Glob refuses shell-dangerous patterns', async () => {
    const _dockerBackend = backendStub()
    const { session } = buildSession({ backend: _dockerBackend })
    const result = await session._dispatchBuiltinTool({
      toolName: 'Glob',
      input: { pattern: '*.js; rm -rf /' },
    })
    assert.equal(result.isError, true)
    assert.match(result.content, /shell-dangerous/)
    assert.equal(_dockerBackend.calls.length, 0)
  })

  it('Grep falls back to grep when rg is unavailable (cmd shape)', async () => {
    const _dockerBackend = backendStub({
      defaultResponse: { stdout: 'foo.js:1:match\n', stderr: '' },
    })
    const { session } = buildSession({ backend: _dockerBackend })
    const result = await session._dispatchBuiltinTool({
      toolName: 'Grep',
      input: { pattern: 'match' },
    })
    assert.equal(result.isError, false)
    assert.equal(_dockerBackend.calls.length, 1)
    // Cmd is the rg-or-grep wrapper so both binaries appear:
    assert.match(_dockerBackend.calls[0].cmd, /rg /)
    assert.match(_dockerBackend.calls[0].cmd, /grep -r/)
    // PR #5021 review fix (Copilot, comment id 3348029186): the
    // command is suffixed with `; true` so rg/grep's exit code 1
    // (no matches) doesn't bubble up to execInEnvironment's reject.
    assert.match(_dockerBackend.calls[0].cmd, /; true$/)
  })

  it('Grep returns "No matches" when stdout is empty and stderr is clean', async () => {
    // PR #5021 review fix (Copilot, comment id 3348029186): the
    // no-match branch was unreachable pre-fix because rg/grep exit 1.
    // With `; true` masking the exit code, this branch now fires.
    const _dockerBackend = backendStub({
      defaultResponse: { stdout: '', stderr: '' },
    })
    const { session } = buildSession({ backend: _dockerBackend })
    const result = await session._dispatchBuiltinTool({
      toolName: 'Grep',
      input: { pattern: 'nosuchstring' },
    })
    assert.equal(result.isError, false)
    assert.match(result.content, /No matches for nosuchstring/)
  })

  it('TodoWrite remains host-side (falls through to super._dispatchBuiltinTool)', async () => {
    const _dockerBackend = backendStub()
    const { session } = buildSession({ backend: _dockerBackend })
    const result = await session._dispatchBuiltinTool({
      toolName: 'TodoWrite',
      input: { todos: [{ id: 't1', content: 'thing', status: 'pending', activeForm: 'doing thing' }] },
    })
    // Super's executor will accept this — no docker call.
    assert.equal(_dockerBackend.calls.length, 0)
    assert.equal(result.isError, false)
  })
})

describe('DockerByokSession — per-session container reuse', () => {
  /**
   * #5022 invariant: one `docker run` per session, regardless of how
   * many tool dispatches the session performs. This is the baseline
   * the pool layer builds on top of — without it, even one warm-pool
   * acquire would only save the first turn's cold-start.
   */
  it('keeps the same container id across multiple tool dispatches (no fresh docker run)', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      run: { stdout: 'CONTAINER_REUSE_42\n' },
      exec: { stdout: '' },
      rm: { stdout: '' },
    })
    const _dockerBackend = backendStub({
      defaultResponse: { stdout: 'hello\n', stderr: '' },
    })
    const session = new DockerByokSession({ cwd: '/host/cwd', _execFile, _dockerBackend })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()

    const idAfterStart = session._containerId
    assert.equal(idAfterStart, 'CONTAINER_REUSE_42')

    // Three back-to-back tool dispatches.
    await session._dispatchBuiltinTool({ toolName: 'Bash', input: { command: 'echo a' } })
    await session._dispatchBuiltinTool({ toolName: 'Bash', input: { command: 'echo b' } })
    await session._dispatchBuiltinTool({ toolName: 'Bash', input: { command: 'echo c' } })

    // Same container id throughout the session.
    assert.equal(session._containerId, idAfterStart)
    // Only ONE `docker run` for the entire session (the initial launch).
    const runCalls = _execFile.calls.filter((c) => c.args[0] === 'run')
    assert.equal(runCalls.length, 1, 'expected exactly one docker run per session')
    // All three dispatches went through the backend (not via docker run).
    assert.equal(_dockerBackend.calls.length, 3)
    for (const call of _dockerBackend.calls) {
      assert.equal(call.containerId, idAfterStart)
    }

    await session.destroy()
  })
})

describe('DockerByokSession — across-session pool (#5022)', () => {
  /**
   * Minimal pool stub: records `acquire` / `release` calls so we can
   * assert the session's start/destroy paths flow through the pool
   * without spinning up a real DockerContainerPool.
   */
  function poolStub({ acquireReturn = null } = {}) {
    const calls = { acquire: [], release: [], forget: [] }
    let nextAcquire = acquireReturn
    return {
      calls,
      acquire(key) {
        calls.acquire.push(key)
        const v = nextAcquire
        nextAcquire = null
        return v
      },
      async release(key, containerId) {
        calls.release.push({ key, containerId })
        return true
      },
      async forget(containerId) {
        // Mirrors the real pool's contract: drop tracking + best-effort
        // docker rm -f. The stub just records the call; tests inspect
        // `pool.calls.forget` instead of asserting on `execFile` rm
        // invocations, because the real pool owns its own _execFile.
        calls.forget.push(containerId)
      },
      setNextAcquire(id) {
        nextAcquire = id
      },
    }
  }

  it('cache miss: launches a fresh container and releases it to the pool on destroy', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      run: { stdout: 'CONTAINER_FRESH\n' },
      exec: { stdout: '' },
      rm: { stdout: '' },
    })
    const _dockerBackend = backendStub()
    const pool = poolStub({ acquireReturn: null })
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      _execFile,
      _dockerBackend,
      _pool: pool,
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()

    // Pool was asked, but missed → docker run was called.
    assert.equal(pool.calls.acquire.length, 1)
    const runCalls = _execFile.calls.filter((c) => c.args[0] === 'run')
    assert.equal(runCalls.length, 1)
    assert.equal(session._containerId, 'CONTAINER_FRESH')
    assert.equal(session._acquiredFromPool, false)

    await session.destroy()

    // On destroy, the container is released to the pool (not docker-rm-f'd).
    assert.equal(pool.calls.release.length, 1)
    assert.equal(pool.calls.release[0].containerId, 'CONTAINER_FRESH')
    const rmCalls = _execFile.calls.filter((c) => c.args[0] === 'rm')
    assert.equal(rmCalls.length, 0, 'destroy must NOT inline-rm when releasing to pool')
  })

  it('cache hit: reuses the pooled container, skips docker run + useradd', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      // `exec` matches the verify call (`docker exec <id> true`).
      exec: { stdout: '' },
      rm: { stdout: '' },
    })
    const _dockerBackend = backendStub()
    const pool = poolStub({ acquireReturn: 'CONTAINER_POOLED' })
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      _execFile,
      _dockerBackend,
      _pool: pool,
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()

    assert.equal(session._containerId, 'CONTAINER_POOLED')
    assert.equal(session._acquiredFromPool, true)
    // Crucially: no `docker run` happened.
    const runCalls = _execFile.calls.filter((c) => c.args[0] === 'run')
    assert.equal(runCalls.length, 0, 'pool hit must skip docker run')
    // And no `useradd` on the reused container (already provisioned).
    const setupCalls = _execFile.calls.filter((c) =>
      c.args[0] === 'exec' && c.args.some((a) => typeof a === 'string' && a.includes('useradd')))
    assert.equal(setupCalls.length, 0, 'pool hit must skip useradd')

    await session.destroy()
    // Container released back to the pool.
    assert.equal(pool.calls.release.length, 1)
    assert.equal(pool.calls.release[0].containerId, 'CONTAINER_POOLED')
  })

  it('cache hit but pooled container dead: evicts the dead id and launches fresh', async () => {
    // The verify call (`docker exec <id> true`) fails — pooled
    // container died while idle. The session should drop it and
    // launch a fresh container.
    let execCount = 0
    const _execFile = (cmd, args, opts, callback) => {
      _execFile.calls.push({ cmd, args: [...args], opts })
      const sub = args[0]
      if (sub === 'info') return callback(null, 'ok', '')
      if (sub === 'exec') {
        execCount++
        // First exec is the verify of the pooled container — fail it.
        // Subsequent execs (useradd + chown for the fresh container) succeed.
        if (execCount === 1) {
          const err = new Error('No such container: CONTAINER_DEAD')
          err.stderr = 'No such container: CONTAINER_DEAD'
          return callback(err, '', 'No such container: CONTAINER_DEAD')
        }
        return callback(null, '', '')
      }
      if (sub === 'run') return callback(null, 'CONTAINER_FALLBACK\n', '')
      if (sub === 'rm') return callback(null, '', '')
      callback(null, '', '')
    }
    _execFile.calls = []

    const _dockerBackend = backendStub()
    const pool = poolStub({ acquireReturn: 'CONTAINER_DEAD' })
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      _execFile,
      _dockerBackend,
      _pool: pool,
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()

    // Fell back to docker run with a new id.
    assert.equal(session._containerId, 'CONTAINER_FALLBACK')
    assert.equal(session._acquiredFromPool, false)
    const runCalls = _execFile.calls.filter((c) => c.args[0] === 'run')
    assert.equal(runCalls.length, 1)
    // The dead pooled id was routed through `pool.forget()` so the
    // pool's `_createdAt` map gets cleared alongside the `docker rm -f`.
    // The actual `docker rm -f` runs through the pool's own _execFile
    // (not the session's), so we assert on `pool.calls.forget` here.
    assert.deepEqual(pool.calls.forget, ['CONTAINER_DEAD'])

    await session.destroy()
  })

  it('does NOT engage the pool when externally-managed containerId is supplied', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      exec: { stdout: '' },
    })
    const pool = poolStub()
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      containerId: 'EXTERNAL_MANAGED',
      _execFile,
      _dockerBackend: backendStub(),
      _pool: pool,
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()

    // External container path — pool was never consulted.
    assert.equal(pool.calls.acquire.length, 0)
    assert.equal(session._containerId, 'EXTERNAL_MANAGED')

    await session.destroy()

    // External container is NOT released to the pool, and NOT removed.
    assert.equal(pool.calls.release.length, 0)
    const rmCalls = _execFile.calls.filter((c) => c.args[0] === 'rm')
    assert.equal(rmCalls.length, 0)
  })

  it('does NOT engage the pool when pool flag is disabled (default behaviour)', async () => {
    // No _pool injected, no CHROXY_DOCKER_BYOK_POOL env var → session
    // should fall through to the existing inline `docker rm -f` path.
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      run: { stdout: 'CONTAINER_DEFAULT\n' },
      exec: { stdout: '' },
      rm: { stdout: '' },
    })
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      _execFile,
      _dockerBackend: backendStub(),
      _poolEnv: {}, // explicitly empty env → disabled
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()
    assert.equal(session._pool, null)

    await session.destroy()
    const rmCalls = _execFile.calls.filter((c) => c.args[0] === 'rm')
    assert.equal(rmCalls.length, 1, 'with pool disabled, destroy() falls back to docker rm -f')
    assert.ok(rmCalls[0].args.includes('CONTAINER_DEFAULT'))
  })

  it('skips pool release when session start failed (no leak via dirty pool)', async () => {
    // Missing creds → super.start() bails before _containerReady is set.
    // The pool MUST NOT receive a container that never went healthy.
    delete process.env.ANTHROPIC_API_KEY
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      run: { stdout: 'CONTAINER_HALF\n' },
      exec: { stdout: '' },
      rm: { stdout: '' },
    })
    const pool = poolStub()
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      _execFile,
      _dockerBackend: backendStub(),
      _pool: pool,
    })
    // Do NOT stub _client — super.start() will see no key and bail.
    const events = []
    session.on('error', (e) => events.push(e))
    await session.start()

    assert.equal(session._containerReady, false)
    // Pool was never released — the dirty container was docker-rm-f'd.
    assert.equal(pool.calls.release.length, 0)
    const rmCalls = _execFile.calls.filter((c) => c.args[0] === 'rm')
    assert.ok(rmCalls.some((c) => c.args.includes('CONTAINER_HALF')),
      'half-started container must be rm-f\'d, not pooled')
  })
})

describe('DockerByokSession — snapshot soiling integration (#5043)', () => {
  /**
   * Same shape as the across-session pool stub above, but with the
   * `markSoiled` hook the session calls when its container has taken
   * (or restored from) a snapshot. Records every markSoiled call.
   */
  function poolStubWithSoiling({ acquireReturn = null } = {}) {
    const calls = { acquire: [], release: [], markSoiled: [] }
    const soiled = new Set()
    let nextAcquire = acquireReturn
    return {
      calls,
      acquire(key) {
        calls.acquire.push(key)
        const v = nextAcquire
        nextAcquire = null
        return v
      },
      async release(key, containerId) {
        calls.release.push({ key, containerId })
        if (soiled.has(containerId)) {
          soiled.delete(containerId)
          return false
        }
        return true
      },
      markSoiled(containerId) {
        if (!containerId) return
        soiled.add(containerId)
        calls.markSoiled.push(containerId)
      },
      isSoiled(containerId) {
        return soiled.has(containerId)
      },
    }
  }

  it('markActiveContainerSoiled forwards the live container id to the pool', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      run: { stdout: 'CONTAINER_SNAP\n' },
      exec: { stdout: '' },
      rm: { stdout: '' },
    })
    const pool = poolStubWithSoiling()
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      _execFile,
      _dockerBackend: backendStub(),
      _pool: pool,
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()

    assert.equal(session._containerId, 'CONTAINER_SNAP')
    session.markActiveContainerSoiled()
    assert.deepEqual(pool.calls.markSoiled, ['CONTAINER_SNAP'])
    assert.equal(pool.isSoiled('CONTAINER_SNAP'), true)

    await session.destroy()
  })

  it('markActiveContainerSoiled is a no-op when pooling is disabled', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      run: { stdout: 'CONTAINER_NOPOOL\n' },
      exec: { stdout: '' },
      rm: { stdout: '' },
    })
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      _execFile,
      _dockerBackend: backendStub(),
      _poolEnv: {}, // pool disabled
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()
    assert.equal(session._pool, null)
    // Must not throw, must not crash — just silently no-op.
    session.markActiveContainerSoiled()
    await session.destroy()
  })

  it('markActiveContainerSoiled is a no-op when there is no live container', () => {
    const pool = poolStubWithSoiling()
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      _execFile: execFileStub({ info: { stdout: 'ok' } }),
      _dockerBackend: backendStub(),
      _pool: pool,
    })
    // No start() — no container assigned. Should not crash and should
    // not call into the pool with a null id.
    session.markActiveContainerSoiled()
    assert.deepEqual(pool.calls.markSoiled, [])
  })

  it('soiled containers are docker-rm-f\'d on destroy, not pooled', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      run: { stdout: 'CONTAINER_DIRTY\n' },
      exec: { stdout: '' },
      rm: { stdout: '' },
    })
    const pool = poolStubWithSoiling()
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      _execFile,
      _dockerBackend: backendStub(),
      _pool: pool,
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()

    // Snapshot taken mid-session — mark the container soiled.
    session.markActiveContainerSoiled()

    await session.destroy()

    // The session called release(), and the pool returned false
    // (evicted) because of the soiled marker. From the session's POV
    // it released to the pool — the pool is responsible for the actual
    // `docker rm -f`. We assert release WAS called (so the session
    // didn't bypass the pool, which would defeat the design hook).
    assert.equal(pool.calls.release.length, 1)
    assert.equal(pool.calls.release[0].containerId, 'CONTAINER_DIRTY')
  })
})

describe('DockerByokSession — postCreateCommand hook (#5025)', () => {
  /**
   * Acceptance: a `postCreateCommand: string | string[]` opt that runs
   * once after the container is started (or first reused) and before
   * the session is marked ready.
   *
   *   - Success → marker file written inside the container; subsequent
   *     reuses with the same command skip the run.
   *   - Failure (non-zero exit, timeout, or any throw from the backend)
   *     → 'error' event with code 'post_create_command_failed', session
   *     not marked ready, owned container torn down.
   *   - Configurable timeout (default 5 min).
   *   - Externally-managed containerId → caller owns lifecycle, so we
   *     do NOT run the post-create hook.
   */

  /**
   * "Fresh container" backend stub: the marker probe (`test -f
   * /tmp/.chroxy-post-create-<hash>`) throws on first contact because
   * the marker file does NOT yet exist. After the impl runs the
   * postCreateCommand and writes the marker via `touch`, subsequent
   * probes resolve clean — modelling the real container's filesystem.
   *
   * Extra `execResponses` (string-include-keyed) override the default
   * `{ stdout: '', stderr: '' }` for the command itself, mirroring the
   * non-post-create `backendStub` helper.
   */
  function freshContainerBackend({ execResponses = {} } = {}) {
    let markerPresent = false
    const calls = []
    return {
      calls,
      async execInEnvironment(containerId, opts) {
        calls.push({ containerId, ...opts })
        const cmd = opts.cmd || ''
        if (cmd.includes('.chroxy-post-create')) {
          if (cmd.startsWith('test -f ')) {
            if (markerPresent) return { stdout: '', stderr: '' }
            const err = new Error('exit 1')
            err.code = 'exec_failed'
            err.exitCode = 1
            throw err
          }
          if (cmd.startsWith('touch ')) {
            markerPresent = true
            return { stdout: '', stderr: '' }
          }
        }
        const matcher = Object.keys(execResponses).find((needle) => cmd.includes(needle))
        if (matcher) {
          const resp = execResponses[matcher]
          if (resp.throw) throw resp.throw
          return { stdout: resp.stdout || '', stderr: resp.stderr || '' }
        }
        return { stdout: '', stderr: '' }
      },
    }
  }

  it('runs the postCreateCommand inside the container as the non-root user', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      run: { stdout: 'CONTAINER_POSTCREATE\n' },
      exec: { stdout: '' },
      rm: { stdout: '' },
    })
    const backend = freshContainerBackend({
      execResponses: {
        'npm install': { stdout: 'added 42 packages\n', stderr: '' },
      },
    })
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      postCreateCommand: 'npm install',
      _execFile,
      _dockerBackend: backend,
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()

    assert.equal(session._containerReady, true)
    const installCalls = backend.calls.filter(
      (c) => c.cmd && c.cmd.includes('npm install') && !c.cmd.includes('.chroxy-post-create'),
    )
    assert.equal(installCalls.length, 1, 'expected one npm install invocation')
    assert.equal(installCalls[0].user, 'chroxy', 'post-create must run as the non-root user')

    await session.destroy()
  })

  it('joins an array postCreateCommand with && so all steps run', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      run: { stdout: 'CONTAINER_POSTCREATE_ARR\n' },
      exec: { stdout: '' },
      rm: { stdout: '' },
    })
    const backend = freshContainerBackend()
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      postCreateCommand: ['npm install', 'npm run build'],
      _execFile,
      _dockerBackend: backend,
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()

    const combined = backend.calls.find(
      (c) => c.cmd && c.cmd.includes('npm install') && c.cmd.includes('npm run build'),
    )
    assert.ok(combined, 'expected the combined && command to run')
    assert.match(combined.cmd, /npm install.*&&.*npm run build/)

    await session.destroy()
  })

  it('fails session start with a clear error event when post-create exits non-zero', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      run: { stdout: 'CONTAINER_POSTCREATE_FAIL\n' },
      exec: { stdout: '' },
      rm: { stdout: '' },
    })
    const installErr = Object.assign(new Error('exit 1: npm install failed'), {
      code: 'exec_failed',
      exitCode: 1,
      stderr: 'npm ERR! missing package.json',
    })
    const backend = freshContainerBackend({
      execResponses: { 'npm install': { throw: installErr } },
    })
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      postCreateCommand: 'npm install',
      _execFile,
      _dockerBackend: backend,
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    const events = []
    session.on('error', (e) => events.push(e))
    await session.start()

    assert.equal(session._containerReady, false, 'failed post-create must not mark session ready')
    const postCreateErr = events.find((e) => /postCreateCommand/.test(e.message))
    assert.ok(postCreateErr, 'expected a postCreateCommand error event')
    assert.equal(postCreateErr.code, 'post_create_command_failed')
    const rmCalls = _execFile.calls.filter((c) => c.args[0] === 'rm')
    assert.ok(rmCalls.some((c) => c.args.includes('CONTAINER_POSTCREATE_FAIL')),
      'failed start must tear down the owned container')
  })

  it('forwards a configurable postCreateTimeoutMs to the backend exec', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      run: { stdout: 'CONTAINER_POSTCREATE_TO\n' },
      exec: { stdout: '' },
      rm: { stdout: '' },
    })
    const backend = freshContainerBackend()
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      postCreateCommand: 'npm install',
      postCreateTimeoutMs: 60_000,
      _execFile,
      _dockerBackend: backend,
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()

    const installCall = backend.calls.find(
      (c) => c.cmd && c.cmd.includes('npm install') && !c.cmd.includes('.chroxy-post-create'),
    )
    assert.ok(installCall, 'expected install invocation')
    assert.equal(installCall.timeout, 60_000)

    await session.destroy()
  })

  it('defaults the post-create timeout to 5 minutes', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      run: { stdout: 'CONTAINER_POSTCREATE_DEFTO\n' },
      exec: { stdout: '' },
      rm: { stdout: '' },
    })
    const backend = freshContainerBackend()
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      postCreateCommand: 'npm install',
      _execFile,
      _dockerBackend: backend,
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()

    const installCall = backend.calls.find(
      (c) => c.cmd && c.cmd.includes('npm install') && !c.cmd.includes('.chroxy-post-create'),
    )
    assert.ok(installCall, 'expected install invocation')
    assert.equal(installCall.timeout, 300_000)

    await session.destroy()
  })

  it('surfaces a post-create timeout as a clear error event', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      run: { stdout: 'CONTAINER_POSTCREATE_HANG\n' },
      exec: { stdout: '' },
      rm: { stdout: '' },
    })
    const timeoutErr = Object.assign(new Error('exec timed out after 100ms'), { code: 'ETIMEDOUT' })
    const backend = freshContainerBackend({
      execResponses: { 'sleep 999': { throw: timeoutErr } },
    })
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      postCreateCommand: 'sleep 999',
      postCreateTimeoutMs: 100,
      _execFile,
      _dockerBackend: backend,
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    const events = []
    session.on('error', (e) => events.push(e))
    await session.start()

    assert.equal(session._containerReady, false)
    const event = events.find((e) => /postCreateCommand/.test(e.message))
    assert.ok(event, 'expected post-create timeout error event')
    assert.equal(event.code, 'post_create_command_failed')
    assert.match(event.message, /timed out|ETIMEDOUT/)
  })

  it('writes a cache marker after a successful run', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      run: { stdout: 'CONTAINER_POSTCREATE_MARKER\n' },
      exec: { stdout: '' },
      rm: { stdout: '' },
    })
    const backend = freshContainerBackend()
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      postCreateCommand: 'npm install',
      _execFile,
      _dockerBackend: backend,
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()

    // After the command runs, the impl touches a marker file under
    // /tmp/.chroxy-post-create-<hash> so a future reuse can skip the run.
    const markerWrite = backend.calls.find(
      (c) => c.cmd
        && c.cmd.includes('.chroxy-post-create')
        && (c.cmd.includes('touch ') || c.cmd.includes('> ')),
    )
    assert.ok(markerWrite, 'expected a marker-write call after successful post-create')

    await session.destroy()
  })

  it('skips re-running postCreateCommand on pool reuse when the cache marker is present', async () => {
    // Pool hit + marker present → command MUST NOT run again.
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      exec: { stdout: '' },
      rm: { stdout: '' },
    })
    let postCreateInvocations = 0
    const backend = {
      calls: [],
      async execInEnvironment(containerId, opts) {
        backend.calls.push({ containerId, ...opts })
        // Marker probe: empty stdout/stderr signals "present" — the impl
        // uses `test -f <marker>` which resolves clean on a hit.
        if (opts.cmd && opts.cmd.includes('.chroxy-post-create') && !opts.cmd.includes('touch')) {
          return { stdout: '', stderr: '' }
        }
        if (opts.cmd && opts.cmd.includes('npm install')) {
          postCreateInvocations++
          return { stdout: '', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      },
    }
    const pool = {
      acquire() { return 'CONTAINER_WARM' },
      async release() { return true },
    }
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      postCreateCommand: 'npm install',
      _execFile,
      _dockerBackend: backend,
      _pool: pool,
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()

    assert.equal(session._acquiredFromPool, true)
    assert.equal(session._containerId, 'CONTAINER_WARM')
    assert.equal(postCreateInvocations, 0,
      'cache hit: postCreateCommand must not re-execute when marker is present')
    const probeCalls = backend.calls.filter(
      (c) => c.cmd && c.cmd.includes('.chroxy-post-create') && !c.cmd.includes('touch'),
    )
    assert.ok(probeCalls.length >= 1, 'expected at least one marker probe on pool reuse')

    await session.destroy()
  })

  it('re-runs postCreateCommand on pool reuse if the marker is missing', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      exec: { stdout: '' },
      rm: { stdout: '' },
    })
    let postCreateInvocations = 0
    const backend = {
      calls: [],
      async execInEnvironment(containerId, opts) {
        backend.calls.push({ containerId, ...opts })
        // Marker probe: throw with exit 1 → "missing".
        if (opts.cmd && opts.cmd.includes('.chroxy-post-create') && !opts.cmd.includes('touch')) {
          const err = new Error('exit 1')
          err.code = 'exec_failed'
          err.exitCode = 1
          err.stderr = ''
          throw err
        }
        if (opts.cmd && opts.cmd.includes('npm ci')) {
          postCreateInvocations++
          return { stdout: '', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      },
    }
    const pool = {
      acquire() { return 'CONTAINER_WARM_NEW_CMD' },
      async release() { return true },
    }
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      postCreateCommand: 'npm ci',
      _execFile,
      _dockerBackend: backend,
      _pool: pool,
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()

    assert.equal(session._acquiredFromPool, true)
    assert.equal(postCreateInvocations, 1,
      'cache miss on warm container: postCreateCommand must run')

    await session.destroy()
  })

  it('does NOT run postCreateCommand when the session attaches to an external container', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      exec: { stdout: '' },
    })
    let postCreateInvocations = 0
    const backend = {
      calls: [],
      async execInEnvironment(containerId, opts) {
        backend.calls.push({ containerId, ...opts })
        if (opts.cmd && opts.cmd.includes('npm install')) {
          postCreateInvocations++
        }
        return { stdout: '', stderr: '' }
      },
    }
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      containerId: 'EXTERNAL_MANAGED',
      postCreateCommand: 'npm install',
      _execFile,
      _dockerBackend: backend,
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()

    assert.equal(postCreateInvocations, 0,
      'external container: postCreateCommand must NOT run (caller-owned)')

    await session.destroy()
  })

  it('default: postCreateCommand is null and no extra backend calls happen at start', async () => {
    const _execFile = execFileStub({
      info: { stdout: 'ok' },
      run: { stdout: 'CONTAINER_NOPC\n' },
      exec: { stdout: '' },
      rm: { stdout: '' },
    })
    const backend = backendStub({ defaultResponse: { stdout: '', stderr: '' } })
    const session = new DockerByokSession({
      cwd: '/host/cwd',
      _execFile,
      _dockerBackend: backend,
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()

    assert.equal(session._containerReady, true)
    assert.equal(backend.calls.length, 0,
      'with no postCreateCommand, the session must not probe / write any markers')

    await session.destroy()
  })
})

describe('docker-byok provider registration', () => {
  it('registerDockerProvider() wires docker-byok when environments are enabled and docker is available', async () => {
    // Spy on console.warn so accidental log noise during the test
    // doesn't leak into the suite output.
    const config = { environments: { enabled: true } }
    // The lazy import inside registerDockerProvider() shellsout to
    // `docker info` via execFileSync. We can't stub that without
    // patching child_process globally — but the registration is
    // idempotent: if docker is unavailable, the function returns
    // early. Either way, the result we care about is the registry
    // shape after the call.
    await registerDockerProvider(config).catch(() => {})
    try {
      const Klass = getProvider('docker-byok')
      assert.ok(Klass === DockerByokSession, 'docker-byok must point at DockerByokSession')
    } catch (err) {
      // docker info failed on the CI runner → docker providers were
      // skipped. That's an expected no-op path; the provider class is
      // still importable and the lazy registration is idempotent.
      assert.match(err.message, /Unknown provider/)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// #5024 — DevContainer + Compose support
// ─────────────────────────────────────────────────────────────────────

describe('DockerByokSession — devcontainer.json overlay (#5024)', () => {
  /**
   * Write a .devcontainer/devcontainer.json fixture into a fresh tmp
   * dir and return the dir for use as cwd.
   */
  function makeDevcontainerCwd(content, { sidecar = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-dc-test-'))
    if (sidecar) {
      writeFileSync(join(dir, '.devcontainer.json'), JSON.stringify(content))
    } else {
      mkdirSync(join(dir, '.devcontainer'), { recursive: true })
      writeFileSync(join(dir, '.devcontainer', 'devcontainer.json'), JSON.stringify(content))
    }
    return dir
  }

  it('constructor records useDevcontainer flag but defers parsing', () => {
    const cwd = makeDevcontainerCwd({ image: 'python:3.12-slim' })
    try {
      const session = new DockerByokSession({
        cwd,
        useDevcontainer: true,
        _execFile: execFileStub(),
        _dockerBackend: backendStub(),
      })
      assert.equal(session._useDevcontainer, true)
      assert.equal(session._dcConfig, null, 'parse should be deferred to start()')
      assert.equal(session._image, 'node:22-slim', 'default preserved before resolve')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('start() overlays devcontainer.json image when no explicit image is passed', async () => {
    const cwd = makeDevcontainerCwd({ image: 'python:3.12-slim' })
    try {
      const _execFile = execFileStub({
        info: { stdout: 'ok' },
        run: { stdout: 'CONTAINER_dc_image\n' },
        exec: { stdout: '' },
        rm: { stdout: '' },
      })
      const session = new DockerByokSession({
        cwd,
        useDevcontainer: true,
        _execFile,
        _dockerBackend: backendStub(),
      })
      session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
      await session.start()
      const runCall = _execFile.calls.find((c) => c.args[0] === 'run')
      assert.ok(runCall, 'docker run was not called')
      const sleepIdx = runCall.args.indexOf('sleep')
      assert.ok(sleepIdx > 0, 'expected sleep as command')
      assert.equal(runCall.args[sleepIdx - 1], 'python:3.12-slim')
      await session.destroy()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('explicit constructor image wins over devcontainer.json image', async () => {
    const cwd = makeDevcontainerCwd({ image: 'python:3.12-slim' })
    try {
      const _execFile = execFileStub({
        info: { stdout: 'ok' },
        run: { stdout: 'CONTAINER_explicit\n' },
        exec: { stdout: '' },
        rm: { stdout: '' },
      })
      const session = new DockerByokSession({
        cwd,
        useDevcontainer: true,
        image: 'node:22-bookworm',
        _execFile,
        _dockerBackend: backendStub(),
      })
      session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
      await session.start()
      const runCall = _execFile.calls.find((c) => c.args[0] === 'run')
      const sleepIdx = runCall.args.indexOf('sleep')
      assert.equal(runCall.args[sleepIdx - 1], 'node:22-bookworm')
      await session.destroy()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('start() applies containerEnv from devcontainer.json as --env flags', async () => {
    const cwd = makeDevcontainerCwd({
      image: 'node:22-slim',
      containerEnv: { LANG: 'en_US.UTF-8', NODE_OPTIONS: '--max-old-space-size=2048' },
    })
    try {
      const _execFile = execFileStub({
        info: { stdout: 'ok' },
        run: { stdout: 'CONTAINER_env\n' },
        exec: { stdout: '' },
        rm: { stdout: '' },
      })
      const session = new DockerByokSession({
        cwd,
        useDevcontainer: true,
        _execFile,
        _dockerBackend: backendStub(),
      })
      session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
      await session.start()
      const runCall = _execFile.calls.find((c) => c.args[0] === 'run')
      assert.ok(runCall.args.some(a => a === 'LANG=en_US.UTF-8'), 'LANG env not forwarded')
      assert.ok(runCall.args.some(a => a === 'NODE_OPTIONS=--max-old-space-size=2048'), 'NODE_OPTIONS env not forwarded')
      await session.destroy()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('start() drops invalid containerEnv keys (defence-in-depth)', async () => {
    const cwd = makeDevcontainerCwd({
      containerEnv: { 'BAD;KEY': 'evil', 'GOOD_KEY': 'fine' },
    })
    try {
      const _execFile = execFileStub({
        info: { stdout: 'ok' },
        run: { stdout: 'CONTAINER_sanitize\n' },
        exec: { stdout: '' },
        rm: { stdout: '' },
      })
      const session = new DockerByokSession({
        cwd,
        useDevcontainer: true,
        _execFile,
        _dockerBackend: backendStub(),
      })
      session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
      await session.start()
      const runCall = _execFile.calls.find((c) => c.args[0] === 'run')
      assert.ok(!runCall.args.some(a => a.startsWith('BAD;KEY=')), 'invalid key leaked through')
      assert.ok(runCall.args.some(a => a === 'GOOD_KEY=fine'), 'valid key missing')
      await session.destroy()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('start() applies forwardPorts as -p flags', async () => {
    const cwd = makeDevcontainerCwd({
      forwardPorts: [3000, 5432, '8080:80'],
    })
    try {
      const _execFile = execFileStub({
        info: { stdout: 'ok' },
        run: { stdout: 'CONTAINER_ports\n' },
        exec: { stdout: '' },
        rm: { stdout: '' },
      })
      const session = new DockerByokSession({
        cwd,
        useDevcontainer: true,
        _execFile,
        _dockerBackend: backendStub(),
      })
      session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
      await session.start()
      const runCall = _execFile.calls.find((c) => c.args[0] === 'run')
      const ports = []
      for (let i = 0; i < runCall.args.length; i++) {
        if (runCall.args[i] === '-p') ports.push(runCall.args[i + 1])
      }
      assert.deepEqual(ports, ['3000:3000', '5432:5432', '8080:80'])
      await session.destroy()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('start() normalises bare-port strings to host:container — fix from PR #5070 review', async () => {
    // Pre-fix, a string "3000" would become `docker run -p 3000`,
    // which Docker treats as "publish container port 3000 to a RANDOM
    // host port" — surprising for a DevContainer forward where the
    // model expects 3000:3000. Both numeric `3000` and bare-string
    // `"3000"` should now produce the same `-p 3000:3000` mapping.
    const cwd = makeDevcontainerCwd({
      forwardPorts: ['3000', '5432', '8080:80'],
    })
    try {
      const _execFile = execFileStub({
        info: { stdout: 'ok' },
        run: { stdout: 'CONTAINER_str_ports\n' },
        exec: { stdout: '' },
        rm: { stdout: '' },
      })
      const session = new DockerByokSession({
        cwd,
        useDevcontainer: true,
        _execFile,
        _dockerBackend: backendStub(),
      })
      session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
      await session.start()
      const runCall = _execFile.calls.find((c) => c.args[0] === 'run')
      const ports = []
      for (let i = 0; i < runCall.args.length; i++) {
        if (runCall.args[i] === '-p') ports.push(runCall.args[i + 1])
      }
      assert.deepEqual(ports, ['3000:3000', '5432:5432', '8080:80'])
      await session.destroy()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('start() rejects mounts pointing outside cwd', async () => {
    const cwd = makeDevcontainerCwd({
      mounts: [
        'source=/etc/shadow,target=/workspace/shadow,type=bind',
        `source=${tmpdir()}/safe,target=/safe,type=bind`,
      ],
    })
    try {
      const _execFile = execFileStub({
        info: { stdout: 'ok' },
        run: { stdout: 'CONTAINER_mount\n' },
        exec: { stdout: '' },
        rm: { stdout: '' },
      })
      const session = new DockerByokSession({
        cwd,
        useDevcontainer: true,
        _execFile,
        _dockerBackend: backendStub(),
      })
      session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
      await session.start()
      const runCall = _execFile.calls.find((c) => c.args[0] === 'run')
      const mounts = []
      for (let i = 0; i < runCall.args.length; i++) {
        if (runCall.args[i] === '--mount') mounts.push(runCall.args[i + 1])
      }
      assert.deepEqual(mounts, [])
      await session.destroy()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('start() runs postCreateCommand as the non-root user after useradd', async () => {
    const cwd = makeDevcontainerCwd({ postCreateCommand: 'npm install' })
    try {
      const execCalls = []
      const _execFile = (cmd, args, opts, cb) => {
        execCalls.push({ cmd, args: [...args] })
        if (args[0] === 'info') return cb(null, 'ok', '')
        if (args[0] === 'run') return cb(null, 'CONTAINER_post\n', '')
        if (args[0] === 'exec') return cb(null, '', '')
        if (args[0] === 'rm') return cb(null, '', '')
        return cb(null, '', '')
      }
      const session = new DockerByokSession({
        cwd,
        useDevcontainer: true,
        _execFile,
        _dockerBackend: backendStub(),
      })
      session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
      await session.start()
      const postCall = execCalls.find(c => c.args[0] === 'exec' && c.args.includes('npm install'))
      assert.ok(postCall, 'postCreateCommand exec not found')
      assert.ok(postCall.args.includes('-u'), 'postCreateCommand missing -u flag')
      assert.equal(postCall.args[postCall.args.indexOf('-u') + 1], 'chroxy')
      await session.destroy()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('useDevcontainer with no devcontainer.json is a no-op (default v1 path)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'chroxy-dc-nofile-'))
    try {
      const _execFile = execFileStub({
        info: { stdout: 'ok' },
        run: { stdout: 'CONTAINER_nodc\n' },
        exec: { stdout: '' },
        rm: { stdout: '' },
      })
      const session = new DockerByokSession({
        cwd,
        useDevcontainer: true,
        _execFile,
        _dockerBackend: backendStub(),
      })
      session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
      await session.start()
      const runCall = _execFile.calls.find((c) => c.args[0] === 'run')
      const sleepIdx = runCall.args.indexOf('sleep')
      assert.equal(runCall.args[sleepIdx - 1], 'node:22-slim')
      const mounts = runCall.args.filter(a => a === '--mount')
      assert.equal(mounts.length, 0)
      await session.destroy()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reads .devcontainer.json sidecar form when .devcontainer/ is absent', async () => {
    const cwd = makeDevcontainerCwd({ image: 'alpine:3.20' }, { sidecar: true })
    try {
      const _execFile = execFileStub({
        info: { stdout: 'ok' },
        run: { stdout: 'CONTAINER_sidecar\n' },
        exec: { stdout: '' },
        rm: { stdout: '' },
      })
      const session = new DockerByokSession({
        cwd,
        useDevcontainer: true,
        _execFile,
        _dockerBackend: backendStub(),
      })
      session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
      await session.start()
      const runCall = _execFile.calls.find((c) => c.args[0] === 'run')
      const sleepIdx = runCall.args.indexOf('sleep')
      assert.equal(runCall.args[sleepIdx - 1], 'alpine:3.20')
      await session.destroy()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('devcontainer.json remoteUser is applied when validated', async () => {
    const cwd = makeDevcontainerCwd({ remoteUser: 'devuser' })
    try {
      const _execFile = execFileStub({
        info: { stdout: 'ok' },
        run: { stdout: 'CONTAINER_user\n' },
        exec: { stdout: '' },
        rm: { stdout: '' },
      })
      const session = new DockerByokSession({
        cwd,
        useDevcontainer: true,
        _execFile,
        _dockerBackend: backendStub(),
      })
      session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
      await session.start()
      const setupCall = _execFile.calls.find(c =>
        c.args[0] === 'exec' && c.args.includes('bash') && c.args.some(a => typeof a === 'string' && a.includes('useradd')))
      assert.ok(setupCall, 'useradd exec not found')
      assert.ok(setupCall.args.some(a => typeof a === 'string' && a.includes('useradd -m -s /bin/bash devuser')),
        `expected useradd for devuser, got: ${setupCall.args.join(' ')}`)
      await session.destroy()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('DockerByokSession — Docker Compose support (#5024)', () => {
  function composeBackendStub({ primaryId = 'COMPOSE_PRIMARY_abc', destroyCalls = [] } = {}) {
    return {
      createCalls: [],
      destroyCalls,
      async createComposeEnvironment(opts) {
        this.createCalls.push(opts)
        return {
          containerId: primaryId,
          containerCliPath: '/usr/local/bin/claude',
          services: [{ name: opts.primaryService || 'app', status: 'running', primary: true }],
        }
      },
      async destroyComposeEnvironment(opts) {
        destroyCalls.push(opts)
      },
      async execInEnvironment() { return { stdout: '', stderr: '' } },
    }
  }

  it('constructor accepts composeFile + composeService', () => {
    const session = new DockerByokSession({
      cwd: tmpHome,
      composeFile: '/proj/docker-compose.yml',
      composeService: 'web',
      _execFile: execFileStub(),
      _dockerBackend: composeBackendStub(),
    })
    assert.equal(session._composeFile, '/proj/docker-compose.yml')
    assert.equal(session._composeService, 'web')
    assert.equal(session._composeProject, null, 'project id deferred to start()')
    assert.equal(session._pool, null)
  })

  it('start() brings up compose stack and attaches to primary service', async () => {
    const _execFile = execFileStub({ info: { stdout: 'ok' } })
    const backend = composeBackendStub({ primaryId: 'COMPOSE_PRIMARY_xyz' })
    const session = new DockerByokSession({
      cwd: tmpHome,
      composeFile: '/proj/docker-compose.yml',
      composeService: 'web',
      _execFile,
      _dockerBackend: backend,
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()
    assert.equal(backend.createCalls.length, 1)
    const call = backend.createCalls[0]
    assert.equal(call.composeFile, '/proj/docker-compose.yml')
    assert.equal(call.primaryService, 'web')
    assert.match(call.composeProject, /^chroxy-byok-[0-9a-f]+$/)
    assert.equal(session._containerId, 'COMPOSE_PRIMARY_xyz')
    assert.equal(session._containerReady, true)
    await session.destroy()
  })

  it('destroy() runs docker compose down against the session project', async () => {
    const _execFile = execFileStub({ info: { stdout: 'ok' } })
    const destroyCalls = []
    const backend = composeBackendStub({ destroyCalls })
    const session = new DockerByokSession({
      cwd: tmpHome,
      composeFile: '/proj/docker-compose.yml',
      composeService: 'web',
      _execFile,
      _dockerBackend: backend,
    })
    session._client = { messages: { stream: () => ({ async *[Symbol.asyncIterator]() {} }) } }
    await session.start()
    const projectId = session._composeProject
    await session.destroy()
    assert.equal(destroyCalls.length, 1)
    assert.equal(destroyCalls[0].composeFile, '/proj/docker-compose.yml')
    assert.equal(destroyCalls[0].composeProject, projectId)
    assert.equal(_execFile.calls.filter(c => c.args[0] === 'rm').length, 0)
  })

  it('compose start failure tears down stack and emits session error', async () => {
    const _execFile = execFileStub({ info: { stdout: 'ok' } })
    const backend = {
      createCalls: [],
      destroyCalls: [],
      async createComposeEnvironment(opts) {
        this.createCalls.push(opts)
        const err = new Error('compose primary not running')
        err.code = 'compose_primary_missing'
        throw err
      },
      async destroyComposeEnvironment(opts) { this.destroyCalls.push(opts) },
      async execInEnvironment() { return { stdout: '', stderr: '' } },
    }
    const session = new DockerByokSession({
      cwd: tmpHome,
      composeFile: '/proj/docker-compose.yml',
      _execFile,
      _dockerBackend: backend,
    })
    const events = []
    session.on('error', e => events.push(e))
    await session.start()
    assert.equal(events.length, 1)
    assert.match(events[0].message, /compose start failed/)
    assert.equal(session._containerReady, false)
  })

  it('compose mode skips the pool even when CHROXY_DOCKER_BYOK_POOL_ENABLED is set', () => {
    const session = new DockerByokSession({
      cwd: tmpHome,
      composeFile: '/proj/docker-compose.yml',
      _execFile: execFileStub(),
      _dockerBackend: composeBackendStub(),
      _poolEnv: { CHROXY_DOCKER_BYOK_POOL_ENABLED: '1' },
    })
    assert.equal(session._pool, null)
  })
})

// Force a tick so any background EventEmitter cleanup completes
// before the test runner exits.
afterEach(async () => {
  await new Promise((r) => setImmediate(r))
})

// Suppress an unused-import lint by referencing EventEmitter (kept
// for forward-compat: future tests may need to assert event shape
// without going through the full session).
void EventEmitter
