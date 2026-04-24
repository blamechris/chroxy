import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Handler coverage contract test
 *
 * Verifies that both the mobile app and web dashboard message handlers cover
 * all ServerMessageType values from @chroxy/protocol, or explicitly declare
 * types as platform-specific.
 *
 * Uses static analysis (regex on source files) — no runtime imports needed.
 */

// ---------------------------------------------------------------------------
// Synthetic / internal message types that the server injects locally or that
// are handled as protocol-level wrappers (not in ServerMessageType enum).
// These are valid handler cases but NOT part of the protocol enum.
// ---------------------------------------------------------------------------
const SYNTHETIC_TYPES = new Set([
  'raw',               // raw terminal output (server-internal)
  'raw_background',    // background agent raw output (server-internal)
  'user_input',        // echoed user input (server-internal)
  'permission_resolved', // permission outcome (server-internal)
  'subscriptions_updated', // subscription ack (server-internal)
  'conversations_list',    // legacy alias for list response
  'search_results',        // legacy alias for search response
  'budget_resumed',        // budget resume ack (server-internal)
  'thinking_level_changed', // thinking level change ack (server-internal)
  'permission_timeout',     // app-side handler for future permission timeout event (not yet in protocol)
])

// ---------------------------------------------------------------------------
// Intentionally unhandled types — present in the protocol enum but handled
// at a different layer (connection/transport) or reserved for future use.
// Neither handler's switch/case needs to cover these.
// ---------------------------------------------------------------------------
const INTENTIONALLY_UNHANDLED = new Set([
  'encrypted',          // unwrapped at connection layer before dispatch to handleMessage
  'status',             // legacy/unused — server_status is the active equivalent
  // 'error' removed — both handlers now implement case 'error': (PR #2742)
  'session_created',    // ack handled via session_list refresh, no dedicated case needed
  'session_destroyed',  // ack handled via session_list refresh, no dedicated case needed
  'session_activity',   // server-side session activity tracking, not displayed in handlers
  'discovered_sessions', // multi-server discovery, handled at connection layer
  'rate_limited',       // rate limit signals, handled at connection layer
  'extension_message',  // extension framework, routed to extension handlers not main switch
  'skills_list',        // MVP (#2957) — no client UI yet; client-side display planned for v2 (#2958)
])

// ---------------------------------------------------------------------------
// Platform-specific types — handled by only ONE platform by design.
// Key = message type, Value = which handler covers it.
// ---------------------------------------------------------------------------
const PLATFORM_SPECIFIC = {
  // Mobile app only
  'pair_fail': 'app',           // QR pairing is mobile-only
  'push_token_error': 'app',    // push notifications are mobile-only
  'write_file_result': 'app',   // app file editing UI
  'git_branches_result': 'app', // app git UI
  'git_stage_result': 'app',    // app git UI
  'git_unstage_result': 'app',  // app git UI
  'git_commit_result': 'app',   // app git UI

  // Dashboard only
  'log_entry': 'dashboard',          // console page is dashboard-only
  'file_list': 'dashboard',          // file explorer sidebar is dashboard-only
  'environment_created': 'dashboard', // environment panel is dashboard-only
  'environment_list': 'dashboard',    // environment panel is dashboard-only
  'environment_destroyed': 'dashboard', // environment panel is dashboard-only
  'environment_info': 'dashboard',    // environment panel is dashboard-only
  'environment_error': 'dashboard',   // environment panel is dashboard-only
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractServerMessageTypes(wsServerSrc) {
  // Extract server message types from the Server -> Client doc comment in ws-server.js
  const serverSection = wsServerSrc.match(/\* Server -> Client:\n([\s\S]*?)\n \*\n \* Encrypted envelope/)?.[1]
  assert.ok(serverSection, 'Should find Server -> Client section in ws-server.js')

  const types = [...serverSection.matchAll(/type: '(\w+)'/g)].map(m => m[1])
  assert.ok(types.length > 0, 'Should find server message types')

  // 'encrypted' is documented in the Encrypted envelope section (bidirectional)
  const result = new Set(types)
  result.add('encrypted')
  return result
}

function extractAppHandlerTypes(appSrc) {
  // App uses only case statements
  const cases = [...appSrc.matchAll(/case\s+'([a-z_]+)'/g)].map(m => m[1])
  return new Set(cases)
}

function extractDashboardHandlerTypes(dashSrc) {
  const types = new Set()

  // 1. HANDLERS map keys (e.g. `pong: handlePong,`)
  const handlersBlock = dashSrc.match(
    /const HANDLERS:\s*Record<string,\s*Handler>\s*=\s*\{([\s\S]*?)\}/,
  )
  if (handlersBlock) {
    for (const m of handlersBlock[1].matchAll(/^\s*(\w+):/gm)) {
      types.add(m[1])
    }
  }

  // 2. case statements
  for (const m of dashSrc.matchAll(/case\s+'([a-z_]+)'/g)) {
    types.add(m[1])
  }

  return types
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handler coverage contract', () => {
  // Load all source files once
  const wsServerPath = resolve(import.meta.dirname, '../../server/src/ws-server.js')
  const appHandlerPath = resolve(import.meta.dirname, '../../app/src/store/message-handler.ts')
  const dashHandlerPath = resolve(import.meta.dirname, '../../dashboard/src/store/message-handler.ts')

  const wsServerSrc = readFileSync(wsServerPath, 'utf-8')
  const appSrc = readFileSync(appHandlerPath, 'utf-8')
  const dashSrc = readFileSync(dashHandlerPath, 'utf-8')

  const allServerTypes = extractServerMessageTypes(wsServerSrc)
  const appTypes = extractAppHandlerTypes(appSrc)
  const dashTypes = extractDashboardHandlerTypes(dashSrc)

  it('every ServerMessageType is handled by at least one handler (or explicitly excluded)', () => {
    const unhandled = []

    for (const type of allServerTypes) {
      if (INTENTIONALLY_UNHANDLED.has(type)) continue

      const inApp = appTypes.has(type)
      const inDash = dashTypes.has(type)

      if (!inApp && !inDash) {
        unhandled.push(type)
      }
    }

    assert.equal(
      unhandled.length, 0,
      `The following ServerMessageType values are not handled by ANY handler:\n` +
      unhandled.map(t => `  - ${t}`).join('\n') +
      `\n\nEither add handling in app or dashboard message-handler.ts, ` +
      `add to PLATFORM_SPECIFIC if intentionally single-platform, ` +
      `or add to INTENTIONALLY_UNHANDLED with a justification comment.`,
    )
  })

  it('app handler covers all non-dashboard-specific ServerMessageTypes', () => {
    const dashOnly = new Set(
      Object.entries(PLATFORM_SPECIFIC)
        .filter(([, platform]) => platform === 'dashboard')
        .map(([type]) => type),
    )

    const missing = []
    for (const type of allServerTypes) {
      if (INTENTIONALLY_UNHANDLED.has(type)) continue
      if (dashOnly.has(type)) continue // intentionally dashboard-only
      if (!appTypes.has(type)) {
        missing.push(type)
      }
    }

    assert.equal(
      missing.length, 0,
      `App message handler is missing the following ServerMessageTypes:\n` +
      missing.map(t => `  - ${t}`).join('\n') +
      `\n\nEither handle in packages/app/src/store/message-handler.ts, ` +
      `add to PLATFORM_SPECIFIC as 'dashboard', ` +
      `or add to INTENTIONALLY_UNHANDLED with a justification comment.`,
    )
  })

  it('dashboard handler covers all non-app-specific ServerMessageTypes', () => {
    const appOnly = new Set(
      Object.entries(PLATFORM_SPECIFIC)
        .filter(([, platform]) => platform === 'app')
        .map(([type]) => type),
    )

    const missing = []
    for (const type of allServerTypes) {
      if (INTENTIONALLY_UNHANDLED.has(type)) continue
      if (appOnly.has(type)) continue // intentionally app-only
      if (!dashTypes.has(type)) {
        missing.push(type)
      }
    }

    assert.equal(
      missing.length, 0,
      `Dashboard message handler is missing the following ServerMessageTypes:\n` +
      missing.map(t => `  - ${t}`).join('\n') +
      `\n\nEither handle in packages/dashboard/src/store/message-handler.ts, ` +
      `add to PLATFORM_SPECIFIC as 'app', ` +
      `or add to INTENTIONALLY_UNHANDLED with a justification comment.`,
    )
  })

  it('PLATFORM_SPECIFIC entries are actual ServerMessageTypes', () => {
    const invalid = []
    for (const type of Object.keys(PLATFORM_SPECIFIC)) {
      if (!allServerTypes.has(type)) {
        invalid.push(type)
      }
    }

    assert.equal(
      invalid.length, 0,
      `PLATFORM_SPECIFIC contains types not in ServerMessageType:\n` +
      invalid.map(t => `  - ${t}`).join('\n') +
      `\n\nRemove stale entries from PLATFORM_SPECIFIC.`,
    )
  })

  it('PLATFORM_SPECIFIC entries are actually only handled by their declared platform', () => {
    const violations = []

    for (const [type, platform] of Object.entries(PLATFORM_SPECIFIC)) {
      const inApp = appTypes.has(type)
      const inDash = dashTypes.has(type)

      if (inApp && inDash) {
        violations.push(`${type}: declared ${platform}-only but handled by BOTH handlers`)
      } else if (platform === 'app' && !inApp) {
        violations.push(`${type}: declared app-only but NOT handled by app`)
      } else if (platform === 'dashboard' && !inDash) {
        violations.push(`${type}: declared dashboard-only but NOT handled by dashboard`)
      }
    }

    assert.equal(
      violations.length, 0,
      `PLATFORM_SPECIFIC declarations don't match actual handler coverage:\n` +
      violations.map(v => `  - ${v}`).join('\n') +
      `\n\nUpdate PLATFORM_SPECIFIC or add/remove handler cases to match.`,
    )
  })

  it('INTENTIONALLY_UNHANDLED entries are actual ServerMessageTypes', () => {
    const invalid = []
    for (const type of INTENTIONALLY_UNHANDLED) {
      if (!allServerTypes.has(type)) {
        invalid.push(type)
      }
    }

    assert.equal(
      invalid.length, 0,
      `INTENTIONALLY_UNHANDLED contains types not in ServerMessageType:\n` +
      invalid.map(t => `  - ${t}`).join('\n') +
      `\n\nRemove stale entries from INTENTIONALLY_UNHANDLED.`,
    )
  })

  it('INTENTIONALLY_UNHANDLED types are truly unhandled by both handlers', () => {
    const violations = []
    for (const type of INTENTIONALLY_UNHANDLED) {
      if (appTypes.has(type) || dashTypes.has(type)) {
        const where = [
          appTypes.has(type) && 'app',
          dashTypes.has(type) && 'dashboard',
        ].filter(Boolean).join(' and ')
        violations.push(`${type}: declared unhandled but found in ${where} handler`)
      }
    }

    assert.equal(
      violations.length, 0,
      `INTENTIONALLY_UNHANDLED entries are actually handled:\n` +
      violations.map(v => `  - ${v}`).join('\n') +
      `\n\nRemove from INTENTIONALLY_UNHANDLED and add to PLATFORM_SPECIFIC ` +
      `or remove from this set entirely if both handlers cover it.`,
    )
  })

  it('SYNTHETIC_TYPES are not in ServerMessageType', () => {
    const overlap = []
    for (const type of SYNTHETIC_TYPES) {
      if (allServerTypes.has(type)) {
        overlap.push(type)
      }
    }

    assert.equal(
      overlap.length, 0,
      `SYNTHETIC_TYPES contains types that ARE in ServerMessageType:\n` +
      overlap.map(t => `  - ${t}`).join('\n') +
      `\n\nRemove from SYNTHETIC_TYPES — these are real protocol types and should ` +
      `be tracked in the main coverage checks.`,
    )
  })

  it('handler case values that are not in ServerMessageType are accounted for in SYNTHETIC_TYPES', () => {
    // Combine all handler types
    const allHandled = new Set([...appTypes, ...dashTypes])
    const unaccounted = []

    for (const type of allHandled) {
      if (!allServerTypes.has(type) && !SYNTHETIC_TYPES.has(type)) {
        unaccounted.push(type)
      }
    }

    assert.equal(
      unaccounted.length, 0,
      `Handlers contain types not in ServerMessageType and not in SYNTHETIC_TYPES:\n` +
      unaccounted.map(t => `  - ${t}`).join('\n') +
      `\n\nEither add to ServerMessageType in @chroxy/protocol, ` +
      `or add to SYNTHETIC_TYPES in this test.`,
    )
  })
})
