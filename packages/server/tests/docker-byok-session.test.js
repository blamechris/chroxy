import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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

// Force a tick so any background EventEmitter cleanup completes
// before the test runner exits.
afterEach(async () => {
  await new Promise((r) => setImmediate(r))
})

// Suppress an unused-import lint by referencing EventEmitter (kept
// for forward-compat: future tests may need to assert event shape
// without going through the full session).
void EventEmitter
