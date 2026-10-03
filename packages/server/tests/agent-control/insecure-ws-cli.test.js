/**
 * #7969 — the real `chroxy agent-control --stdio` CLI refuses a remote `ws://`
 * target, fail-fast and legibly, unless `--allow-insecure-ws` is passed.
 *
 * The bearer token travels in the first `auth` frame, before any key exchange,
 * so over plain `ws://` to another host anyone on the path can read it, and an
 * identity pin cannot protect it (the pin is checked only after the token has
 * been sent). These tests spawn the ACTUAL CLI entrypoint (`src/cli.js`), the
 * same way an MCP host does, with stdin held open — so an exit can only be the
 * refusal, never stdin EOF.
 *
 * What is pinned here, and why each is its own assertion:
 *   - exit code is non-zero and the process exits on its own, within a bound
 *     (a hang is a different failure from a refusal, and reads as flake);
 *   - stdout is EMPTY — it carries MCP frames only, and a refusal must not
 *     look like the start of a session to the host;
 *   - stderr names BOTH ways out (`wss://`, `--allow-insecure-ws`);
 *   - stderr does NOT contain the host or the token — this module deliberately
 *     never logs the URL, and a token in a log line would defeat the point.
 *
 * NO test here resolves a name or opens a socket. The refusal paths exit
 * before any socket exists; the spawned opt-in/moot paths only list tools (the
 * daemon is dialed lazily, on the first tool CALL, which these tests never
 * make); and every in-process test that reaches `connect()` supplies a FAKE
 * WebSocket constructor through the `WebSocketImpl` test seam, which records
 * the URL it is given and fails with a sentinel the test asserts on — so the
 * production `ws` implementation is never constructed.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createAgentControlMcpServer } from '../../src/agent-control/mcp-server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cliPath = join(__dirname, '..', '..', 'src', 'cli.js')

const TOKEN = 'fixture-secret-token-7969'
const REMOTE_HOST = 'example.com'
const REMOTE_WS_URL = `ws://${REMOTE_HOST}:9`
// RFC 2606 reserves `.invalid`: it never resolves. Used only where the process
// is started but NEVER told to dial (tools/list does not connect).
const NEVER_DIALED_WS_URL = 'ws://agent-control-test.invalid:9'

function childEnv(extra = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('CHROXY_AGENT_CONTROL_')) delete env[key]
  }
  return { ...env, ...extra }
}

/**
 * Spawn the real CLI and wait for it to exit ON ITS OWN. stdin is kept open
 * (an MCP host holds it open), so a process that does not fail fast would sit
 * there and hit the bound instead of exiting.
 */
async function runCliToExit(args, env, { boundMs = 15000 } = {}) {
  const child = spawn(process.execPath, [cliPath, 'agent-control', '--stdio', ...args], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (c) => { stdout += c.toString('utf8') })
  child.stderr.on('data', (c) => { stderr += c.toString('utf8') })
  child.stdin.on('error', () => { /* the child may exit before we ever write */ })
  try {
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timedOut: true, code: null, signal: null }), boundMs)
      child.once('error', (err) => { clearTimeout(timer); resolve({ spawnError: err, code: null, signal: null }) })
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ timedOut: false, code, signal }) })
    })
    return { ...outcome, stdout, stderr }
  } finally {
    // Never leave a child behind, whatever happened above.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

function assertRefusal(result) {
  assert.equal(result.spawnError, undefined, 'the CLI must spawn')
  assert.equal(result.timedOut, false, 'the refusal must be immediate: the process should exit by itself, not hang on stdin')
  assert.equal(result.code, 1, 'a refusal exits with code 1 (set by main(), not a crash)')
  assert.equal(result.signal, null, 'a refusal is a clean exit, not a signal')
  assert.equal(result.stdout, '', 'stdout carries MCP frames only: a refusal writes nothing there')
  assert.ok(result.stderr.includes('--allow-insecure-ws'), 'stderr must name the opt-in flag')
  assert.ok(result.stderr.includes('wss://'), 'stderr must name wss:// as the other way out')
  assert.ok(/cleartext/i.test(result.stderr), 'stderr must say WHY: the token would be sent in cleartext')
  assert.ok(/key exchange/i.test(result.stderr), 'stderr must say the token is sent before any key exchange')
  assert.ok(/pin/i.test(result.stderr), 'stderr must say an identity pin cannot protect the token')
  assert.equal(result.stderr.includes(REMOTE_HOST), false, 'stderr must not contain the host')
  assert.equal(result.stderr.includes(TOKEN), false, 'stderr must not contain the token')
  assert.equal(result.stderr.trim().split('\n').length, 1, 'the refusal is ONE legible line')
}

async function startWithSdkClient(args, env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, 'agent-control', '--stdio', ...args],
    env,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'test-harness', version: '0.0.0' }, { capabilities: {} })
  let stderr = ''
  try {
    await client.connect(transport)
    transport.stderr?.on('data', (c) => { stderr += c.toString('utf8') })
  } catch (err) {
    await transport.close().catch(() => {})
    throw err
  }
  return { client, transport, readStderr: () => stderr }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return predicate()
}

describe('chroxy agent-control --stdio: refuses a remote ws:// target (#7969)', () => {
  it('--url ws://<remote> with a token in env exits non-zero, fast, with one legible stderr line and an empty stdout', async () => {
    const result = await runCliToExit(['--url', REMOTE_WS_URL], childEnv({ CHROXY_AGENT_CONTROL_TOKEN: TOKEN }))
    assertRefusal(result)
  })

  it('the equals form --url=ws://<remote> is refused the same way', async () => {
    const result = await runCliToExit([`--url=${REMOTE_WS_URL}`], childEnv({ CHROXY_AGENT_CONTROL_TOKEN: TOKEN }))
    assertRefusal(result)
  })

  it('a URL configured through CHROXY_AGENT_CONTROL_URL (no --url) is refused the same way', async () => {
    const result = await runCliToExit([], childEnv({ CHROXY_AGENT_CONTROL_URL: REMOTE_WS_URL, CHROXY_AGENT_CONTROL_TOKEN: TOKEN }))
    assertRefusal(result)
  })

  it('is refused even with no token configured (the transport refusal comes first, and is not deferred to the first tool call)', async () => {
    const result = await runCliToExit(['--url', REMOTE_WS_URL], childEnv())
    assertRefusal(result)
  })

  it('there is no environment-variable opt-in', async () => {
    const result = await runCliToExit([], childEnv({
      CHROXY_AGENT_CONTROL_URL: REMOTE_WS_URL,
      CHROXY_AGENT_CONTROL_TOKEN: TOKEN,
      CHROXY_AGENT_CONTROL_ALLOW_INSECURE_WS: '1',
      CHROXY_ALLOW_INSECURE_WS: '1',
    }))
    assertRefusal(result)
  })
})

describe('chroxy agent-control --stdio --allow-insecure-ws (#7969)', () => {
  it('with a remote ws:// target the server STARTS, lists tools, and carries a WARNING on stderr', async () => {
    const { client, transport, readStderr } = await startWithSdkClient(
      ['--url', NEVER_DIALED_WS_URL, '--allow-insecure-ws'],
      childEnv({ CHROXY_AGENT_CONTROL_TOKEN: TOKEN }),
    )
    try {
      const { tools } = await client.listTools()
      assert.equal(tools.length, 7, 'tools/list works: nothing here dials the remote host')
      assert.ok(await waitFor(() => /WARNING:/.test(readStderr())), 'stderr must carry a WARNING line')
      const stderr = readStderr()
      assert.ok(/WARNING:[^\n]*cleartext/i.test(stderr), 'the WARNING says the token will travel in cleartext')
      assert.equal(stderr.includes(TOKEN), false, 'stderr must not contain the token')
      assert.equal(stderr.includes('agent-control-test.invalid'), false, 'stderr must not contain the host')
      assert.equal(/has no effect/.test(stderr), false, 'the flag is live here, so it must not claim to be moot')
    } finally {
      await client.close().catch(() => {})
      await transport.close().catch(() => {})
    }
  })

  it('the same holds when the remote ws:// URL comes from CHROXY_AGENT_CONTROL_URL and only the flag is in args', async () => {
    const { client, transport, readStderr } = await startWithSdkClient(
      ['--allow-insecure-ws'],
      childEnv({ CHROXY_AGENT_CONTROL_URL: NEVER_DIALED_WS_URL, CHROXY_AGENT_CONTROL_TOKEN: TOKEN }),
    )
    try {
      const { tools } = await client.listTools()
      assert.equal(tools.length, 7)
      assert.ok(await waitFor(() => /WARNING:[^\n]*cleartext/i.test(readStderr())))
    } finally {
      await client.close().catch(() => {})
      await transport.close().catch(() => {})
    }
  })

  for (const [label, args, env] of [
    ['a wss:// target', ['--url', 'wss://agent-control-test.invalid:9', '--allow-insecure-ws'], { CHROXY_AGENT_CONTROL_TOKEN: TOKEN }],
    ['a loopback ws:// target', ['--url', 'ws://127.0.0.1:9', '--allow-insecure-ws'], { CHROXY_AGENT_CONTROL_TOKEN: TOKEN }],
    ['the local default (no URL at all)', ['--allow-insecure-ws'], {}],
  ]) {
    it(`where the flag is moot (${label}) it says so instead of WARNING`, async () => {
      const { client, transport, readStderr } = await startWithSdkClient(args, childEnv(env))
      try {
        const { tools } = await client.listTools()
        assert.equal(tools.length, 7)
        assert.ok(await waitFor(() => /has no effect/.test(readStderr())), 'stderr must carry the "has no effect" line')
        assert.equal(/WARNING:[^\n]*cleartext/i.test(readStderr()), false, 'a moot flag must not raise the cleartext WARNING')
        assert.equal(readStderr().includes(TOKEN), false)
      } finally {
        await client.close().catch(() => {})
        await transport.close().catch(() => {})
      }
    })
  }
})

describe('chroxy agent-control --stdio: no refusal where the transport is not insecure (#7969)', () => {
  for (const [label, args] of [
    ['wss:// to a remote host', ['--url', 'wss://agent-control-test.invalid:9']],
    ['ws:// to loopback', ['--url', 'ws://127.0.0.1:9']],
    ['ws:// to localhost', ['--url', 'ws://localhost:9']],
  ]) {
    it(`${label} starts without the flag and without any WARNING or "no effect" line`, async () => {
      const { client, transport, readStderr } = await startWithSdkClient(args, childEnv({ CHROXY_AGENT_CONTROL_TOKEN: TOKEN }))
      try {
        const { tools } = await client.listTools()
        assert.equal(tools.length, 7)
        assert.ok(await waitFor(() => /ready \(/.test(readStderr())), 'the server reports ready')
        assert.equal(/WARNING:[^\n]*cleartext/i.test(readStderr()), false)
        assert.equal(/has no effect/.test(readStderr()), false)
      } finally {
        await client.close().catch(() => {})
        await transport.close().catch(() => {})
      }
    })
  }
})

// A boolean flag takes no value, but Commander tolerates a stray positional
// word by default, so `--allow-insecure-ws false` used to parse as the flag
// being SET: the operator wrote "false" and got cleartext. The command now
// rejects excess arguments. Each case below uses a target the transport gate
// would NOT refuse on its own (wss:// or the local default), so a pass can only
// mean the stray word was rejected — never that the refusal fired instead.
describe('chroxy agent-control --stdio: a stray value after a boolean flag is an error (#7969)', () => {
  const STRAY_CASES = [
    ['--allow-insecure-ws false', ['--url', 'wss://agent-control-test.invalid:9', '--allow-insecure-ws', 'false']],
    ['--allow-insecure-ws 0', ['--url', 'wss://agent-control-test.invalid:9', '--allow-insecure-ws', '0']],
    ['--allow-insecure-ws false with a remote ws:// target (the case that used to enable cleartext)', ['--url', 'ws://agent-control-test.invalid:9', '--allow-insecure-ws', 'false']],
    ['--allow-command-approvals false', ['--url', 'wss://agent-control-test.invalid:9', '--allow-command-approvals', 'false']],
    ['--allow-command-approvals false against the local default', ['--allow-command-approvals', 'false']],
  ]

  for (const [label, args] of STRAY_CASES) {
    it(`${label} exits 1 with a legible stderr line, empty stdout, and no ready/WARNING`, async () => {
      const result = await runCliToExit(args, childEnv({ CHROXY_AGENT_CONTROL_TOKEN: TOKEN }))
      assert.equal(result.spawnError, undefined, 'the CLI must spawn')
      assert.equal(result.timedOut, false, 'the rejection must be immediate: the process should exit by itself')
      assert.equal(result.signal, null)
      assert.equal(result.code, 1)
      assert.equal(result.stdout, '', 'stdout carries MCP frames only')
      assert.ok(result.stderr.includes("too many arguments for 'agent-control'"), `stderr must say why, got: ${result.stderr.slice(0, 200)}`)
      assert.equal(result.stderr.includes('ready'), false, 'the server must not have started')
      assert.equal(result.stderr.includes('WARNING'), false, 'no WARNING: the flag must not have been taken as set')
      assert.equal(result.stderr.includes(TOKEN), false)
    })
  }

  it('control: the bare flags still work', async () => {
    const { client, transport, readStderr } = await startWithSdkClient(
      ['--url', NEVER_DIALED_WS_URL, '--allow-insecure-ws', '--allow-command-approvals'],
      childEnv({ CHROXY_AGENT_CONTROL_TOKEN: TOKEN }),
    )
    try {
      const { tools } = await client.listTools()
      assert.equal(tools.length, 7)
      assert.ok(await waitFor(() => /ready \(/.test(readStderr())), 'the server reports ready')
      assert.ok(/WARNING: --allow-insecure-ws is ENABLED/.test(readStderr()))
      assert.ok(/WARNING: --allow-command-approvals is ENABLED/.test(readStderr()))
    } finally {
      await client.close().catch(() => {})
      await transport.close().catch(() => {})
    }
  })
})

// main() computes `allowInsecureWs` itself for its startup check AND must hand
// it to `createAgentControlMcpServer`, or the flag is accepted, the WARNING
// prints, and the first tool call is refused anyway: a dead opt-in. Only a real
// first tool call through the real CLI can see that hand-off.
//
// The target is a REMOTE ws:// URL carrying a fragment. The `ws` library throws
// a SyntaxError on a fragment synchronously, inside the WebSocket constructor,
// before any name resolution or socket — so this reaches past the gate and
// fails with ONE exact, network-free, OS-independent message. The preferred
// shape (a real loopback listener reached through a remote-classified literal
// such as `ws://[::ffff:127.0.0.1]:<port>` or `ws://0.0.0.0:<port>`) was
// measured: both connect on macOS and in a Linux container, but `0.0.0.0` is
// not connectable on Windows and the IPv4-mapped form is unverified there, and
// the Windows server-test job runs this directory — so it was not adopted.
describe('chroxy agent-control --stdio: main() hands --allow-insecure-ws to the connect path (#7969)', () => {
  const FRAGMENT_WS_URL = 'ws://agent-control-test.invalid:9/#ws-throws-on-a-fragment-before-any-io'
  const WS_FRAGMENT_ERROR = 'The URL contains a fragment identifier'

  it('with the flag, the first tool call gets past the gate and fails with the ws library\'s exact message — not insecure_remote_ws', async () => {
    const { client, transport } = await startWithSdkClient(
      ['--url', FRAGMENT_WS_URL, '--allow-insecure-ws'],
      childEnv({ CHROXY_AGENT_CONTROL_TOKEN: TOKEN }),
    )
    try {
      const result = await client.callTool({ name: 'chroxy_list_sessions', arguments: {} })
      assert.equal(result.isError, true)
      assert.deepEqual(result.structuredContent, { error: WS_FRAGMENT_ERROR })
    } finally {
      await client.close().catch(() => {})
      await transport.close().catch(() => {})
    }
  })

  it('without the flag, the same URL exits 1 with the refusal and never starts', async () => {
    const result = await runCliToExit(['--url', FRAGMENT_WS_URL], childEnv({ CHROXY_AGENT_CONTROL_TOKEN: TOKEN }))
    assertRefusal(result)
  })
})

// A target that fails validation for a reason OTHER than the transport rule is
// not one the flag is moot for — it is one whose relevance is unknown until the
// URL is fixed. Say nothing about the flag, and let the lazy path report the
// real problem on the first tool call, exactly as it always did.
describe('chroxy agent-control --stdio --allow-insecure-ws with a URL that fails for another reason (#7969)', () => {
  const OTHER_FAILURES = [
    ['not a URL', 'not a url', 'invalid_url'],
    ['a non-ws scheme', 'http://agent-control-test.invalid:9', 'invalid_url_scheme'],
    ['embedded credentials', 'ws://user:hunter2@agent-control-test.invalid:9', 'url_contains_credentials'],
  ]

  for (const [label, url, code] of OTHER_FAILURES) {
    it(`${label}: starts, says nothing about the flag, and the first tool call reports ${code}`, async () => {
      const { client, transport, readStderr } = await startWithSdkClient(
        ['--url', url, '--allow-insecure-ws'],
        childEnv({ CHROXY_AGENT_CONTROL_TOKEN: TOKEN }),
      )
      try {
        const { tools } = await client.listTools()
        assert.equal(tools.length, 7, 'the process still starts')
        assert.ok(await waitFor(() => /ready \(/.test(readStderr())), 'the server reports ready')
        assert.equal(/has no effect/.test(readStderr()), false, 'must not claim the flag is moot for a URL it has not been judged against')
        assert.equal(/WARNING:[^\n]*cleartext/i.test(readStderr()), false, 'must not claim cleartext transport is in play')
        assert.equal(readStderr().includes('hunter2'), false, 'stderr must not echo URL credentials')

        const result = await client.callTool({ name: 'chroxy_list_sessions', arguments: {} })
        assert.equal(result.isError, true)
        assert.equal(result.structuredContent.code, code, 'the lazy path still reports the real problem, on the first call')
      } finally {
        await client.close().catch(() => {})
        await transport.close().catch(() => {})
      }
    })
  }
})

// A controlled transport for the in-process tests. `WebSocketImpl` is the
// test seam `createAgentControlMcpServer` forwards to `AgentControlClient`
// (never reachable from argv or the environment). The fake records every URL it
// is constructed with and then fails DETERMINISTICALLY with a sentinel, so a
// test can assert on the one outcome it expects — never "some error other than
// X" — and nothing resolves a name or opens a socket.
const FAKE_WS_SENTINEL_CODE = 'FAKE_WS_SENTINEL_7969'
const FAKE_WS_SENTINEL_MESSAGE = 'fake transport failure (sentinel 7969)'

function makeFakeWebSocket() {
  const constructedWith = []
  class FakeWebSocket extends EventEmitter {
    constructor(url) {
      super()
      constructedWith.push(url)
      // Emitted on a later tick, after the client has attached its listeners
      // (connect() wires 'message'/'close'/'error' and _waitForOpen's
      // once('error') synchronously after construction).
      setImmediate(() => {
        this.emit('error', Object.assign(new Error(FAKE_WS_SENTINEL_MESSAGE), { code: FAKE_WS_SENTINEL_CODE }))
      })
    }

    close() { /* nothing was ever opened */ }
  }
  return { FakeWebSocket, constructedWith }
}

function isSentinelFailure(err) {
  assert.equal(err.code, FAKE_WS_SENTINEL_CODE, `expected the fake transport's sentinel, got ${err.code}: ${err.message}`)
  assert.equal(err.message, FAKE_WS_SENTINEL_MESSAGE)
  return true
}

describe('createAgentControlMcpServer: the lazy path enforces the same rule (#7969)', () => {
  it('without the opt-in, the first connect rejects with insecure_remote_ws, names both ways out, and never constructs a transport', async () => {
    const { FakeWebSocket, constructedWith } = makeFakeWebSocket()
    const { clientManager } = createAgentControlMcpServer({ url: REMOTE_WS_URL, token: TOKEN, WebSocketImpl: FakeWebSocket })
    try {
      await assert.rejects(
        () => clientManager.get(),
        (err) => {
          assert.equal(err.code, 'insecure_remote_ws')
          assert.ok(err.message.includes('--allow-insecure-ws'))
          assert.ok(err.message.includes('wss://'))
          assert.ok(/cleartext/i.test(err.message))
          assert.equal(err.message.includes(REMOTE_HOST), false, 'the message must not contain the host')
          assert.equal(err.message.includes(TOKEN), false, 'the message must not contain the token')
          return true
        },
      )
      assert.deepEqual(constructedWith, [], 'a refused target must never reach the transport')
    } finally {
      await clientManager.close()
    }
  })

  it('allowInsecureWs: true is threaded to the connect path — the transport is constructed exactly once with the URL, and the failure is the fake\'s sentinel', async () => {
    const url = NEVER_DIALED_WS_URL
    const refused = makeFakeWebSocket()
    const admitted = makeFakeWebSocket()
    const withoutOptIn = createAgentControlMcpServer({ url, token: TOKEN, WebSocketImpl: refused.FakeWebSocket })
    const withOptIn = createAgentControlMcpServer({ url, token: TOKEN, allowInsecureWs: true, WebSocketImpl: admitted.FakeWebSocket })
    try {
      await assert.rejects(() => withoutOptIn.clientManager.get(), (err) => err.code === 'insecure_remote_ws')
      assert.deepEqual(refused.constructedWith, [], 'without the opt-in the transport is never constructed')

      await assert.rejects(() => withOptIn.clientManager.get(), isSentinelFailure)
      assert.deepEqual(admitted.constructedWith, [url], 'with the opt-in the transport is constructed exactly once, with the URL as given')
    } finally {
      await withoutOptIn.clientManager.close()
      await withOptIn.clientManager.close()
    }
  })

  it('a truthy non-boolean allowInsecureWs does not opt in, and never constructs a transport', async () => {
    for (const truthy of ['false', 1]) {
      const { FakeWebSocket, constructedWith } = makeFakeWebSocket()
      const { clientManager } = createAgentControlMcpServer({ url: NEVER_DIALED_WS_URL, token: TOKEN, allowInsecureWs: truthy, WebSocketImpl: FakeWebSocket })
      try {
        await assert.rejects(() => clientManager.get(), (err) => err.code === 'insecure_remote_ws')
        assert.deepEqual(constructedWith, [], `allowInsecureWs: ${JSON.stringify(truthy)}`)
      } finally {
        await clientManager.close()
      }
    }
  })

  it('positive control: wss:// and loopback ws:// reach the transport WITHOUT the opt-in (the gate is not denying everything)', async () => {
    for (const url of ['wss://agent-control-test.invalid:9', 'ws://127.0.0.1:9', 'ws://localhost:9']) {
      const { FakeWebSocket, constructedWith } = makeFakeWebSocket()
      const { clientManager } = createAgentControlMcpServer({ url, token: TOKEN, WebSocketImpl: FakeWebSocket })
      try {
        await assert.rejects(() => clientManager.get(), isSentinelFailure)
        assert.deepEqual(constructedWith, [url], url)
      } finally {
        await clientManager.close()
      }
    }
  })
})
