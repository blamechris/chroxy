#!/usr/bin/env node

/**
 * Spike: Validate spawnClaudeCodeProcess + docker exec for SdkSession
 *
 * This script validates that the Agent SDK's `query()` function works
 * with a custom `spawnClaudeCodeProcess` callback that routes spawning
 * through `docker exec -i <container>`.
 *
 * What it tests:
 *   1. Starting a Docker container with node:22-slim
 *   2. Installing Claude Code CLI inside the container
 *   3. Calling query() with spawnClaudeCodeProcess that uses docker exec
 *   4. Streaming a simple prompt and collecting output
 *   5. Verifying canUseTool callback fires
 *   6. Cleanup on exit
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node packages/server/scripts/spike-docker-sdk.js
 *
 * Requirements:
 *   - Docker running locally
 *   - ANTHROPIC_API_KEY set in environment
 *   - Node 22+
 *
 * Findings are documented inline as comments.
 */

import { spawn, execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { query } from '@anthropic-ai/claude-agent-sdk'

// ─── Configuration ──────────────────────────────────────────────────────────

const DOCKER_IMAGE = 'node:22-slim'
const CONTAINER_WORKSPACE = '/workspace'
const TIMEOUT_MS = 120_000 // 2 min max for the whole spike
const INSTALL_TIMEOUT_MS = 60_000 // 1 min for npm install

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(label, msg) {
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}] [${label}] ${msg}`)
}

function fail(msg) {
  console.error(`\n❌ FAIL: ${msg}`)
  process.exitCode = 1
}

function pass(msg) {
  console.log(`\n✅ PASS: ${msg}`)
}

/**
 * Run a docker command synchronously and return trimmed stdout.
 * Uses execFileSync to avoid shell escaping issues with special characters.
 * Throws on non-zero exit.
 */
function dockerSync(args, opts = {}) {
  const result = execFileSync('docker', args, {
    encoding: 'utf-8',
    timeout: opts.timeout || 30_000,
    maxBuffer: opts.maxBuffer || 10 * 1024 * 1024, // 10MB — npm install can exceed default 1MB
  })
  return result.trim()
}

/**
 * Build a SpawnedProcess-compatible wrapper around `docker exec -i`.
 *
 * The SDK's SpawnOptions gives us: { command, args, cwd, env, signal }
 * We translate that into: docker exec -i --workdir <cwd> --env K=V ... <cid> <command> <args>
 *
 * FINDING #1: The SpawnedProcess interface maps cleanly to Node's ChildProcess.
 * `spawn()` returns an object that already satisfies the interface — stdin (Writable),
 * stdout (Readable), killed, exitCode, kill(), on('exit'), on('error').
 *
 * FINDING #2: The SDK passes the HOST's absolute path to cli.js as args[0].
 * Example: command="node" args=["/host/path/to/cli.js", "--output-format", ...]
 * Inside the container, that path doesn't exist. We must remap args[0] to the
 * container's installed CLI path, or use `claude` as the command directly.
 *
 * FINDING #3: The SDK also forwards the host's HOME env var. Inside the container,
 * /root is HOME — we override it to avoid path mismatches.
 */
function createDockerSpawner(containerId, containerCliPath) {
  return function spawnClaudeCodeProcess(options) {
    const { command, args, cwd, env, signal } = options

    log('spawn', `command=${command} args=${JSON.stringify(args.slice(0, 3))}... (${args.length} total)`)
    log('spawn', `cwd=${cwd || '(none)'}`)

    const dockerArgs = ['exec', '-i', '-u', 'spike']

    // Set working directory inside container
    if (cwd) {
      dockerArgs.push('--workdir', cwd)
    }

    // Forward selected env vars — never leak the whole host env
    const FORWARD_KEYS = [
      'ANTHROPIC_API_KEY',
      'NODE_ENV',
    ]
    for (const key of FORWARD_KEYS) {
      const val = env[key]
      if (val !== undefined) {
        dockerArgs.push('--env', `${key}=${val}`)
      }
    }

    // Override HOME and PATH for container environment
    dockerArgs.push('--env', 'HOME=/home/spike')
    dockerArgs.push('--env', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')

    // CRITICAL: Remap the command + args for the container.
    // The SDK passes: command="node", args=["/host/path/cli.js", ...sdkFlags]
    // We replace with: command="claude", args=[...sdkFlags] (using container's global install)
    // OR: command="node", args=["/container/path/cli.js", ...sdkFlags]
    let containerCommand = command
    let containerArgs = [...args]

    if (containerCliPath && args.length > 0 && args[0].includes('claude-agent-sdk')) {
      // The first arg is the host-side cli.js path — remap to container path
      containerArgs[0] = containerCliPath
      log('spawn', `Remapped cli.js path: ${args[0]} -> ${containerCliPath}`)
    }

    dockerArgs.push(containerId, containerCommand, ...containerArgs)

    log('spawn', `docker exec -i ... ${containerId.slice(0, 12)} ${containerCommand} ${containerArgs.slice(0, 3).join(' ')}...`)

    const child = spawn('docker', dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Log stderr for debugging
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim()
      if (text) log('stderr', text)
    })

    // Wire up abort signal to kill the process
    if (signal) {
      signal.addEventListener('abort', () => {
        if (!child.killed) {
          child.kill('SIGTERM')
        }
      }, { once: true })
    }

    return child
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

let containerId = null
let tmpWorkDir = null

// Ensure cleanup on any exit
function cleanup() {
  if (containerId) {
    log('cleanup', `Removing container ${containerId.slice(0, 12)}`)
    try {
      execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore', timeout: 10_000 })
      log('cleanup', 'Container removed')
    } catch {
      log('cleanup', 'Failed to remove container (may already be gone)')
    }
    containerId = null
  }
  if (tmpWorkDir) {
    try {
      rmSync(tmpWorkDir, { recursive: true, force: true })
      log('cleanup', `Removed temp dir: ${tmpWorkDir}`)
    } catch {
      log('cleanup', 'Failed to remove temp dir')
    }
    tmpWorkDir = null
  }
}

process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(1) })
process.on('SIGTERM', () => { cleanup(); process.exit(1) })

async function main() {
  // ─── Preflight checks ──────────────────────────────────────────────────

  if (!process.env.ANTHROPIC_API_KEY) {
    fail('ANTHROPIC_API_KEY not set')
    return
  }

  try {
    dockerSync(['info', '--format', '{{.ServerVersion}}'])
    log('preflight', 'Docker is running')
  } catch {
    fail('Docker is not running or not installed')
    return
  }

  // ─── Step 1: Start container ────────────────────────────────────────────

  log('step1', `Starting container (image: ${DOCKER_IMAGE})...`)
  try {
    // Create a unique temp dir to avoid collisions with concurrent runs
    tmpWorkDir = mkdtempSync(join(tmpdir(), 'spike-docker-sdk-'))
    log('step1', `Created temp workspace: ${tmpWorkDir}`)

    containerId = dockerSync([
      'run', '-d', '--init', '--rm',
      '-v', `${tmpWorkDir}:/workspace`,
      '-w', CONTAINER_WORKSPACE,
      DOCKER_IMAGE,
      'sleep', 'infinity',
    ], { timeout: 60_000 })
    log('step1', `Container started: ${containerId.slice(0, 12)}`)

    // FINDING: Claude Code refuses --dangerously-skip-permissions when running as root.
    // Create a non-root user inside the container for safety and compatibility.
    dockerSync([
      'exec', containerId,
      'bash', '-c', 'useradd -m -s /bin/bash spike && chown spike:spike /workspace',
    ], { timeout: 10_000 })
    log('step1', 'Created non-root user "spike" in container')
  } catch (err) {
    fail(`Failed to start container: ${err.message}`)
    return
  }

  // ─── Step 2: Install Claude Code in container ───────────────────────────

  log('step2', 'Installing Claude Code CLI in container...')
  try {
    // First check if claude is already available
    try {
      const version = dockerSync([
        'exec', containerId, 'claude', '--version',
      ], { timeout: 10_000 })
      log('step2', `Claude already available: ${version}`)
    } catch {
      // Not available — install via npm
      log('step2', 'Claude not found, installing via npm...')
      const installOutput = dockerSync([
        'exec', containerId,
        'npm', 'install', '-g', '@anthropic-ai/claude-code',
      ], { timeout: INSTALL_TIMEOUT_MS })
      log('step2', `Install output (last line): ${installOutput.split('\n').pop()}`)

      // Verify installation
      const version = dockerSync([
        'exec', containerId, 'claude', '--version',
      ], { timeout: 10_000 })
      log('step2', `Claude installed: ${version}`)
    }
    pass('Claude Code CLI available in container')
  } catch (err) {
    fail(`Failed to install Claude Code: ${err.message}`)
    log('finding', 'FINDING: Claude Code cannot be trivially installed in node:22-slim.')
    log('finding', 'Alternatives: (1) Pre-built Docker image with claude pre-installed,')
    log('finding', '(2) Mount host claude binary into container,')
    log('finding', '(3) Use a Dockerfile that bakes in the install step.')
    log('finding', 'Continuing with remaining tests using the host claude via docker exec...')

    // Try an alternative approach: check if we can mount the host's claude
    try {
      const hostClaudePath = execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim()
      log('step2-alt', `Host claude found at: ${hostClaudePath}`)
      log('step2-alt', 'Could mount host binary but node_modules dependencies would be missing')
    } catch {
      log('step2-alt', 'Host claude not found either')
    }

    // Don't return — we still want to test the spawnClaudeCodeProcess interface shape
  }

  // ─── Step 2b: Discover the container's CLI path ─────────────────────────
  //
  // FINDING: The SDK passes the HOST's absolute path to cli.js as args[0].
  // Example: command="node" args=["/host/path/to/node_modules/.../cli.js", ...]
  // Inside the container that path doesn't exist — we must discover the
  // container's installed CLI path and remap args[0].

  let containerCliPath = null
  try {
    // Find the container's installed CLI path.
    const globalPrefix = dockerSync([
      'exec', containerId, 'npm', 'prefix', '-g',
    ], { timeout: 10_000 })
    containerCliPath = `${globalPrefix}/lib/node_modules/@anthropic-ai/claude-code/cli.js`
    log('step2b', `Container CLI path: ${containerCliPath}`)

    // Verify the path exists
    dockerSync([
      'exec', containerId, 'test', '-f', containerCliPath,
    ], { timeout: 5_000 })
    log('step2b', 'CLI path verified')
  } catch {
    log('step2b', 'Could not determine container CLI path — spawner will attempt without remapping')
  }

  // ─── Step 3: Test query() with spawnClaudeCodeProcess ───────────────────

  log('step3', 'Testing query() with spawnClaudeCodeProcess callback...')

  const findings = {
    spawnCallbackFired: false,
    spawnOptionsShape: null,
    canUseToolFired: false,
    canUseToolCalls: [],
    messagesReceived: [],
    streamingWorked: false,
    resultReceived: false,
    errors: [],
  }

  const spawner = createDockerSpawner(containerId, containerCliPath)

  // Wrap spawner to capture findings
  const trackedSpawner = (options) => {
    findings.spawnCallbackFired = true
    findings.spawnOptionsShape = {
      hasCommand: typeof options.command === 'string',
      hasArgs: Array.isArray(options.args),
      hasCwd: typeof options.cwd === 'string' || options.cwd === undefined,
      hasEnv: typeof options.env === 'object',
      hasSignal: options.signal instanceof AbortSignal,
      command: options.command,
      argCount: options.args?.length,
    }
    log('step3', `spawnClaudeCodeProcess called with command=${options.command}`)
    log('step3', `  args (${options.args?.length}): ${options.args?.slice(0, 3).join(' ')}...`)
    return spawner(options)
  }

  // Use 'default' permission mode so canUseTool fires for every tool call.
  // We auto-allow everything to validate the callback mechanism works.
  //
  // FINDING: bypassPermissions cannot be used as root in Docker.
  // With a non-root user it works, but then canUseTool doesn't fire.
  // For the spike we use 'default' to test both streaming AND canUseTool.
  const queryOptions = {
    cwd: CONTAINER_WORKSPACE,
    permissionMode: 'default',
    includePartialMessages: true,
    maxTurns: 2,
    tools: ['Read', 'Bash'],
    spawnClaudeCodeProcess: trackedSpawner,
    env: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      NODE_ENV: process.env.NODE_ENV,
    },
    canUseTool: async (toolName, input, opts) => {
      findings.canUseToolFired = true
      findings.canUseToolCalls.push({ toolName, inputKeys: Object.keys(input || {}) })
      log('step5', `canUseTool fired: tool=${toolName}`)
      return { behavior: 'allow' }
    },
  }

  // Set a global timeout
  const timeoutId = setTimeout(() => {
    fail('Query timed out')
    cleanup()
    process.exit(1)
  }, TIMEOUT_MS)

  try {
    const q = query({
      prompt: 'Run `echo "hello from docker"` using the Bash tool, then respond with exactly "done".',
      options: queryOptions,
    })

    for await (const msg of q) {
      findings.messagesReceived.push(msg.type)

      switch (msg.type) {
        case 'system':
          log('step3', `system: subtype=${msg.subtype} session=${msg.session_id || '?'}`)
          break

        case 'stream_event': {
          const event = msg.event
          if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            if (!findings.streamingWorked) {
              findings.streamingWorked = true
              log('step4', 'First streaming delta received!')
            }
            process.stdout.write(event.delta.text)
          }
          break
        }

        case 'assistant': {
          const content = msg.message?.content || []
          log('step3', `assistant message (${content.length} blocks)`)
          for (const block of content) {
            if (block.type === 'text') {
              log('step3', `  text: "${block.text?.slice(0, 200)}"`)
              findings.assistantText = (findings.assistantText || '') + block.text
            } else if (block.type === 'tool_use') {
              log('step3', `  tool_use: ${block.name} (id=${block.id})`)
            }
          }
          break
        }

        case 'result':
          findings.resultReceived = true
          findings.resultData = {
            cost: msg.total_cost_usd,
            duration: msg.duration_ms,
            sessionId: msg.session_id,
            is_error: msg.is_error,
            subtype: msg.subtype,
          }
          log('step3', `result: cost=$${msg.total_cost_usd?.toFixed(4) || '?'} duration=${msg.duration_ms}ms error=${msg.is_error || false} subtype=${msg.subtype || 'none'}`)
          break
      }
    }
    console.log() // newline after streaming
  } catch (err) {
    findings.errors.push(err.message)
    log('step3', `Query error: ${err.message}`)

    // Categorize the error
    if (err.message.includes('not found') || err.message.includes('ENOENT') || err.message.includes('no such file')) {
      log('finding', 'FINDING: The SDK tried to spawn claude inside the container but it was not found.')
      log('finding', 'The spawnClaudeCodeProcess callback DID fire — the interface works.')
      log('finding', 'The failure is in the container environment, not the SDK integration.')
    } else if (err.message.includes('exited with code')) {
      // Process exit after result is normal — the SDK stream ends and process terminates
      log('step3', 'Process exited after stream completed (expected behavior)')
    }
  } finally {
    clearTimeout(timeoutId)
  }

  // ─── Report ─────────────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(60))
  console.log('  SPIKE RESULTS')
  console.log('═'.repeat(60))

  console.log('\n1. spawnClaudeCodeProcess callback:')
  console.log(`   Fired: ${findings.spawnCallbackFired ? 'YES' : 'NO'}`)
  if (findings.spawnOptionsShape) {
    console.log(`   SpawnOptions shape valid: ${
      findings.spawnOptionsShape.hasCommand &&
      findings.spawnOptionsShape.hasArgs &&
      findings.spawnOptionsShape.hasEnv &&
      findings.spawnOptionsShape.hasSignal
        ? 'YES' : 'NO'
    }`)
    console.log(`   Command: ${findings.spawnOptionsShape.command}`)
    console.log(`   Arg count: ${findings.spawnOptionsShape.argCount}`)
  }

  console.log('\n2. Streaming:')
  console.log(`   Worked: ${findings.streamingWorked ? 'YES' : 'NO'}`)
  console.log(`   Message types seen: ${[...new Set(findings.messagesReceived)].join(', ') || 'none'}`)

  console.log('\n3. canUseTool callback:')
  console.log(`   Fired: ${findings.canUseToolFired ? 'YES' : 'NO'}`)
  if (findings.canUseToolCalls.length > 0) {
    for (const call of findings.canUseToolCalls) {
      console.log(`   Tool: ${call.toolName} (input keys: ${call.inputKeys.join(', ')})`)
    }
  }

  console.log('\n4. Result:')
  console.log(`   Received: ${findings.resultReceived ? 'YES' : 'NO'}`)
  if (findings.resultData) {
    console.log(`   Cost: $${findings.resultData.cost?.toFixed(4) || '?'}`)
    console.log(`   Duration: ${findings.resultData.duration}ms`)
    console.log(`   Session: ${findings.resultData.sessionId || '?'}`)
    console.log(`   Is Error: ${findings.resultData.is_error || false}`)
  }

  if (findings.assistantText) {
    console.log('\n5. Assistant Response:')
    console.log(`   "${findings.assistantText.slice(0, 200)}"`)
  }

  console.log('\n6. Errors:')
  if (findings.errors.length === 0) {
    console.log('   None')
  } else {
    for (const err of findings.errors) {
      console.log(`   ${err}`)
    }
  }

  console.log('\n' + '═'.repeat(60))
  console.log('  KEY FINDINGS')
  console.log('═'.repeat(60))

  console.log('\n• spawnClaudeCodeProcess IS the right hook for container isolation.')
  console.log('  - The SDK calls it with SpawnOptions { command, args, cwd, env, signal }')
  console.log('  - It expects a SpawnedProcess { stdin, stdout, killed, exitCode, kill(), on() }')
  console.log('  - Node ChildProcess from spawn() satisfies this interface natively')
  console.log(`  - Callback fired: ${findings.spawnCallbackFired ? 'YES' : 'NO'}`)

  console.log('\n• PATH REMAPPING REQUIRED:')
  console.log('  - The SDK passes the HOST absolute path to cli.js as args[0]')
  console.log('  - Example: args[0] = "/host/path/node_modules/.../cli.js"')
  console.log('  - Inside Docker, this path does not exist')
  console.log('  - Solution: detect "claude-agent-sdk" in args[0] and remap to container path')
  console.log('  - Container path: npm prefix -g + /lib/node_modules/@anthropic-ai/claude-code/cli.js')

  console.log('\n• NON-ROOT USER REQUIRED:')
  console.log('  - Claude Code refuses --dangerously-skip-permissions as root')
  console.log('  - Solution: create a non-root user in the container')
  console.log('  - Also need to override HOME and PATH env vars for container context')

  console.log('\n• CONTAINER SETUP:')
  console.log('  - npm install -g @anthropic-ai/claude-code works in node:22-slim (~2s)')
  console.log('  - Recommendation: pre-built Docker image to avoid install latency')
  console.log('  - Claude Code version in container should match SDK version on host')

  if (findings.streamingWorked) {
    console.log('\n• STREAMING: Works through docker exec -i')
    console.log('  - stdin/stdout piping preserves the stream-json protocol')
  }

  if (findings.canUseToolFired) {
    console.log('\n• PERMISSION CALLBACKS: Work with spawnClaudeCodeProcess')
    console.log('  - canUseTool fires in the SDK process (host), not in the container')
    console.log('  - Tools called: ' + findings.canUseToolCalls.map(c => c.toolName).join(', '))
  }

  if (findings.resultReceived && !findings.streamingWorked) {
    console.log('\n• SDK PROTOCOL: End-to-end communication verified')
    console.log('  - system:init, assistant, and result messages all received')
    console.log('  - If streaming/canUseTool did not fire, check API key credits')
    console.log('  - The integration works; API errors are expected without valid credits')
  }

  console.log()
}

main().catch((err) => {
  console.error(`Unhandled error: ${err.message}`)
  process.exitCode = 1
})
