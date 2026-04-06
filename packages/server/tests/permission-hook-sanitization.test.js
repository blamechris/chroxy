import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync, spawnSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const hookPath = join(__dirname, '../hooks/permission-hook.sh')

// Sentinel file used to detect if shell injection executed during tests
const INJECTION_SENTINEL = '/tmp/chroxy-hook-injection-test'

describe('Permission hook environment sanitization (#1831)', () => {
  it('hook script validates PORT is numeric', () => {
    const source = readFileSync(hookPath, 'utf-8')
    assert.ok(
      source.includes("*[!0-9]*") && source.includes('exit 0'),
      'Hook should reject non-numeric PORT values'
    )
  })

  it('hook script validates PERM_MODE is a known value', () => {
    const source = readFileSync(hookPath, 'utf-8')
    assert.ok(
      source.includes('approve|auto|acceptEdits|plan'),
      'Hook should validate permission mode against known values'
    )
  })

  it('exits silently with non-numeric CHROXY_PORT', () => {
    const result = execSync(
      `CHROXY_PORT="evil" /bin/bash ${hookPath}`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    assert.equal(result.trim(), '', 'Should produce no output for injected PORT')
  })

  it('falls back to approve for unknown permission mode', () => {
    // With valid port but invalid mode, hook should treat as approve mode
    // and try to route to phone (which will fail since no server is running)
    const source = readFileSync(hookPath, 'utf-8')
    assert.ok(
      source.includes('*) PERM_MODE="approve"'),
      'Unknown modes should fall back to approve'
    )
  })
})

describe('Permission hook stdin-only parameter passing (#2685)', () => {
  beforeEach(() => {
    // Ensure sentinel does not exist before each test (guards against stale files
    // left by a previous test run that crashed before afterEach could clean up)
    try { rmSync(INJECTION_SENTINEL, { force: true }) } catch {}
  })

  afterEach(() => {
    // Clean up sentinel file after each injection test
    try { rmSync(INJECTION_SENTINEL, { force: true }) } catch {}
  })

  it('hook script does not use $1/$2 for tool parameters', () => {
    const source = readFileSync(hookPath, 'utf-8')
    // The script should only use $1 for positional args if at all — and no
    // tool parameter (tool_name, tool_input, file_path) should be sourced from $N
    // Parameters come from stdin JSON, never from shell positional arguments
    assert.ok(
      !source.match(/TOOL_NAME=\$[12]/) && !source.match(/TOOL_PATH=\$[12]/),
      'Hook must not source tool parameters from shell positional args ($1, $2)'
    )
  })

  it('hook script reads tool parameters from stdin, not shell arguments', () => {
    const source = readFileSync(hookPath, 'utf-8')
    // Must use stdin-reading construct (cat - or cat without args)
    assert.ok(
      source.includes('cat -') || source.includes('$(cat)'),
      'Hook must read tool parameters from stdin'
    )
  })

  it('security comment documents stdin-only requirement', () => {
    const source = readFileSync(hookPath, 'utf-8')
    assert.ok(
      source.includes('stdin') && source.includes('$1'),
      'Hook should document that tool parameters arrive via stdin, not $1/$2'
    )
  })

  it('shell metacharacters in tool_name field do not execute commands', () => {
    // Craft a JSON payload where tool_name contains a backtick command injection
    // In acceptEdits mode, TOOL_NAME is extracted and used in a case statement
    // If injection worked, the sentinel file would be created
    const maliciousJson = JSON.stringify({
      tool_name: `\`touch ${INJECTION_SENTINEL}\``,
      tool_input: { command: 'echo hello' },
      session_id: 'test',
    })

    const result = spawnSync('/bin/bash', [hookPath], {
      input: maliciousJson,
      encoding: 'utf-8',
      timeout: 5000,
      env: {
        ...process.env,
        CHROXY_PORT: '9999',
        CHROXY_PERMISSION_MODE: 'acceptEdits',
        // No CHROXY_HOOK_SECRET — curl will fail, which is fine
      },
    })

    assert.ok(
      !existsSync(INJECTION_SENTINEL),
      'Shell injection via tool_name must not execute (sentinel file must not exist)'
    )
  })

  it('shell metacharacters in $() form in tool_name do not execute commands', () => {
    const maliciousJson = JSON.stringify({
      tool_name: `$(touch ${INJECTION_SENTINEL})`,
      tool_input: { file_path: '/etc/passwd' },
      session_id: 'test',
    })

    const result = spawnSync('/bin/bash', [hookPath], {
      input: maliciousJson,
      encoding: 'utf-8',
      timeout: 5000,
      env: {
        ...process.env,
        CHROXY_PORT: '9999',
        CHROXY_PERMISSION_MODE: 'acceptEdits',
      },
    })

    assert.ok(
      !existsSync(INJECTION_SENTINEL),
      'Shell injection via $() in tool_name must not execute'
    )
  })

  it('shell metacharacters in tool_input fields do not execute via stdin passthrough', () => {
    // In approve/default mode, $REQUEST (full stdin JSON) is passed to curl -d "$REQUEST".
    // The double-quoting prevents shell expansion. Curl will fail (no server running on
    // port 9999) but the hook must not execute any commands embedded in the JSON before
    // or during the curl call. Verify by checking that the sentinel is not created.
    const maliciousJson = JSON.stringify({
      tool_name: 'Bash',
      tool_input: {
        command: `touch ${INJECTION_SENTINEL}; echo injected`,
        // A crafted path with backtick injection
        file_path: `\`touch ${INJECTION_SENTINEL}\``,
      },
      session_id: 'test',
    })

    // Run in approve mode (the default) — this exercises REQUEST=$(cat -) and the curl call
    const result = spawnSync('/bin/bash', [hookPath], {
      input: maliciousJson,
      encoding: 'utf-8',
      timeout: 5000,
      env: {
        ...process.env,
        CHROXY_PORT: '9999',
        // No CHROXY_PERMISSION_MODE — defaults to approve, reads stdin and calls curl
        // No CHROXY_HOOK_SECRET — curl will fail (connection refused), which is expected
      },
    })

    assert.ok(
      !existsSync(INJECTION_SENTINEL),
      'Shell injection via tool_input in stdin must not execute in approve mode'
    )
  })
})

describe('Permission mode audit logging (#1831)', () => {
  it('settings-handlers logs previous mode on permission change', () => {
    const source = readFileSync(
      join(__dirname, '../src/handlers/settings-handlers.js'),
      'utf-8'
    )
    assert.ok(
      source.includes('previousMode') && source.includes('toISOString'),
      'Permission mode changes should log previous mode and timestamp'
    )
  })
})
