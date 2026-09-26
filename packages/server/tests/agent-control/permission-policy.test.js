/**
 * #7973 — `chroxy_respond_permission` must refuse `allow` for tools that are
 * never delegable to an external planner (`mcp_spawn`, codex
 * `request_permissions`) WHATEVER the protected-path floor's `floored`
 * verdict says (#7968's floored gate only ever narrows an ordinary prompt —
 * it says nothing about these two, which are high-authority independent of
 * any path field). Separately, command-style tools (`Bash`, codex `shell`)
 * carry an arbitrary command string the path floor cannot see through
 * (`floored:false` on a `Bash` prompt means "no path field looked
 * protected", not "this command is safe") — `allow` for one of these is
 * refused by default and only permitted when the operator opts in with
 * `--allow-command-approvals`, and even then the floored/ownership gates
 * still apply on top.
 *
 * Most cases here are LIGHTWEIGHT fixtures (no real WsServer): these are pure
 * client-side gates keyed off `_observedPermissions`/`_ownedSessions`/
 * `allowCommandApprovals`, already proven to reach the real server-side
 * resolver for the ownership/floored gates in client-guards.test.js — a real
 * socket buys nothing extra here. `_state` is set to 'ready' directly and
 * `_send` is stubbed, mirroring the "create_session serial-op correlation
 * scoping" fixtures at the bottom of that file. The CLI-flag/startup-warning
 * cases at the bottom DO spawn the real `chroxy agent-control --stdio`
 * subprocess (mirroring mcp-stdio.test.js) because those are genuinely about
 * argv parsing and process-level logging, not client-side gating logic.
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { WsServer as _WsServer } from '../../src/ws-server.js'
import { AgentControlClient, NOT_DELEGABLE_TOOLS, COMMAND_TOOLS, FLOOR_ALLOWLISTED_TOOLS } from '../../src/agent-control/client.js'
import { createAgentControlMcpServer } from '../../src/agent-control/mcp-server.js'
import {
  NOT_DELEGABLE_TOOLS as CANONICAL_NOT_DELEGABLE_TOOLS,
  COMMAND_TOOLS as CANONICAL_COMMAND_TOOLS,
  FLOOR_ALLOWLISTED_TOOLS as CANONICAL_FLOOR_ALLOWLISTED_TOOLS,
  ACCEPT_EDITS_TOOLS,
} from '../../src/permission-manager.js'
import { isFlooredTarget, PROTECTED_PATH_INPUT_FIELDS } from '../../src/permission-floor.js'
import { BUILTIN_TOOLS } from '../../src/byok-tools.js'
import { createMockSessionManager, createMockSession, createSpy } from '../test-helpers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cliPath = join(__dirname, '..', '..', 'src', 'cli.js')

class EncryptedWsServer extends _WsServer {
  constructor(opts = {}) {
    super({ localhostBypass: false, ...opts })
  }
}

async function startServerAndGetPort(server) {
  server.start('127.0.0.1')
  await once(server.httpServer, 'listening')
  return server.httpServer.address().port
}

/**
 * A client wired straight to 'ready' with `_send` stubbed to capture wire
 * sends — no socket, no handshake. `requestTimeoutMs` defaults small so a
 * call that legitimately reaches `_send` (i.e. was NOT refused) settles
 * quickly with `status: 'uncertain'` instead of waiting out the real
 * (15s) default; nothing here is testing ack correlation, which
 * client-guards.test.js already covers against a real server.
 */
function readyClient(opts = {}) {
  const client = new AgentControlClient({
    url: 'ws://127.0.0.1:1',
    token: 'fixture-token-only',
    silent: true,
    requestTimeoutMs: 30,
    ...opts,
  })
  client._state = 'ready'
  const sent = []
  client._send = (msg) => { sent.push(msg) }
  return { client, sent }
}

function observe(client, { requestId, sessionId, tool, floored }) {
  client._trackPermissionObservation({ type: 'permission_request', requestId, sessionId, tool, floored })
}

describe('shared exclusion-set identity (#7973)', () => {
  it('agent-control/client.js re-exports the EXACT Set objects permission-manager.js exports — no hand-rolled second list', () => {
    assert.equal(NOT_DELEGABLE_TOOLS, CANONICAL_NOT_DELEGABLE_TOOLS, 'NOT_DELEGABLE_TOOLS must be the SAME object (import identity), not an equal-valued copy')
    assert.equal(COMMAND_TOOLS, CANONICAL_COMMAND_TOOLS, 'COMMAND_TOOLS must be the SAME object (import identity), not an equal-valued copy')
  })

  it('NOT_DELEGABLE_TOOLS contains exactly mcp_spawn and request_permissions', () => {
    assert.deepEqual([...NOT_DELEGABLE_TOOLS].sort(), ['mcp_spawn', 'request_permissions'])
  })

  // The roster is sourced from what each provider actually hands
  // handlePermission / POST /permission, not from a guess:
  //   - Bash: Claude Code (SDK, CLI, TUI, channel) and BYOK's executor;
  //   - PowerShell: Claude Code's Windows shell tool (the ONLY shell tool on a
  //     Windows host without Git Bash), checked with Bash's rules;
  //   - Monitor: Claude Code's background-script tool — its input is a bash
  //     `command`, permission-checked by the same function as Bash;
  //   - shell: codex app-server's commandExecution approval.
  // PowerShell and Monitor were missing, so a planner could approve an
  // arbitrary command without --allow-command-approvals.
  it('COMMAND_TOOLS contains exactly the command-executing tool names the providers emit (Bash, PowerShell, Monitor — Claude Code / BYOK; shell — codex app-server)', () => {
    assert.deepEqual([...COMMAND_TOOLS].sort(), ['Bash', 'Monitor', 'PowerShell', 'shell'])
  })

  it('agent-control/client.js re-exports the EXACT FLOOR_ALLOWLISTED_TOOLS object permission-manager.js exports — no hand-rolled second list (#7975, S3)', () => {
    assert.equal(FLOOR_ALLOWLISTED_TOOLS, CANONICAL_FLOOR_ALLOWLISTED_TOOLS, 'FLOOR_ALLOWLISTED_TOOLS must be the SAME object (import identity), not an equal-valued copy')
  })

  // #7975-followup (adversarial review of 71e78ba38) — FLOOR_ALLOWLISTED_TOOLS
  // must NOT be the same object as ACCEPT_EDITS_TOOLS any more. Aliasing the
  // planner's allowlist to the acceptEdits set meant a future widening of
  // acceptEdits (a bar for "fine for a human clicking accept-edits to
  // auto-approve") would silently widen what an unattended external planner
  // may approve too — a materially stronger bar. It must still be a SUBSET:
  // every tool the planner may approve should also be one acceptEdits mode
  // auto-approves for a human, so the planner is never MORE permissive than
  // the human-mediated mode it borrows the floor from.
  it('FLOOR_ALLOWLISTED_TOOLS is decoupled from ACCEPT_EDITS_TOOLS (a distinct object) but remains a strict subset of it', () => {
    assert.notEqual(FLOOR_ALLOWLISTED_TOOLS, ACCEPT_EDITS_TOOLS, 'FLOOR_ALLOWLISTED_TOOLS must be its OWN object — identity reuse lets a future ACCEPT_EDITS_TOOLS widening silently widen the planner allowlist too')
    for (const tool of FLOOR_ALLOWLISTED_TOOLS) {
      assert.ok(ACCEPT_EDITS_TOOLS.has(tool), `${tool} is planner-allowlisted but not in ACCEPT_EDITS_TOOLS — the planner must never be more permissive than acceptEdits mode`)
    }
  })

  // #7975-followup — Grep and Glob are deliberately EXCLUDED, even though
  // both are in ACCEPT_EDITS_TOOLS and both carry a `path` field the floor
  // inspects. See the dedicated "Grep/Glob excluded" describe block below for
  // the behavioral proof of why.
  it('FLOOR_ALLOWLISTED_TOOLS contains exactly the tools whose ENTIRE file-selecting input the protected-path floor inspects (Grep/Glob excluded — see below)', () => {
    assert.deepEqual([...FLOOR_ALLOWLISTED_TOOLS].sort(), ['Edit', 'NotebookEdit', 'Read', 'Write', 'apply_patch'])
  })

  // Schema-derived guard (catalogue #7424 — don't hand-list an expectation
  // that could silently drift from what it is meant to police): for every
  // planner-allowlisted tool that byok-tools.js's BUILTIN_TOOLS defines a real
  // input_schema for, every property that LOOKS like it selects a filesystem
  // target (a bare `path`, anything ending `_path`, or `glob`/`pattern`) must
  // be one of PROTECTED_PATH_INPUT_FIELDS. This is what actually catches a
  // future re-addition of Grep or Glob to the allowlist: their real schemas
  // (asserted below) carry `pattern`/`glob`, which this loop refuses to accept
  // as covered.
  it("no FLOOR_ALLOWLISTED_TOOLS member's real (byok-tools.js) schema carries a file-selecting field outside PROTECTED_PATH_INPUT_FIELDS", () => {
    const FILE_SELECTOR_HEURISTIC = /^path$|_path$|^pattern$|^glob$/
    const byName = new Map(BUILTIN_TOOLS.map((t) => [t.name, t]))
    let checked = 0
    for (const tool of FLOOR_ALLOWLISTED_TOOLS) {
      const def = byName.get(tool)
      if (!def) continue // not a byok-tools.js tool (e.g. codex apply_patch) — covered separately above
      checked += 1
      const props = Object.keys(def.input_schema?.properties || {})
      for (const prop of props) {
        if (!FILE_SELECTOR_HEURISTIC.test(prop)) continue
        assert.ok(PROTECTED_PATH_INPUT_FIELDS.includes(prop), `${tool}.${prop} looks file-selecting but is not one of PROTECTED_PATH_INPUT_FIELDS — the floor cannot see it, so ${tool} should not be planner-allowlisted`)
      }
    }
    assert.ok(checked > 0, 'premise: at least one allowlisted tool must be defined in byok-tools.js for this loop to exercise anything')
  })

  it('premise: Grep and Glob DO carry a file-selecting field outside PROTECTED_PATH_INPUT_FIELDS in their real schema (why they fail the guard above and must stay excluded)', () => {
    const byName = new Map(BUILTIN_TOOLS.map((t) => [t.name, t]))
    const grepProps = Object.keys(byName.get('Grep').input_schema.properties)
    const globProps = Object.keys(byName.get('Glob').input_schema.properties)
    assert.ok(grepProps.includes('glob') && !PROTECTED_PATH_INPUT_FIELDS.includes('glob'), 'premise: Grep.glob exists and is not floor-inspected')
    assert.ok(grepProps.includes('pattern') && !PROTECTED_PATH_INPUT_FIELDS.includes('pattern'), 'premise: Grep.pattern exists and is not floor-inspected')
    assert.ok(globProps.includes('pattern') && !PROTECTED_PATH_INPUT_FIELDS.includes('pattern'), 'premise: Glob.pattern exists and is not floor-inspected')
  })
})

/**
 * #7975 (S3, final security review of #7854) — the allowlist's correctness is
 * verified BEHAVIORALLY against permission-floor.js's own `isFlooredTarget`,
 * not by comparing two hand-authored Sets. `isFlooredTarget` scans whichever
 * of PROTECTED_PATH_INPUT_FIELDS (`file_path`/`path`/`notebook_path`) plus
 * `changes[]` a given INPUT actually carries — it is not itself keyed by tool
 * identity beyond the read/write floor split (SECRET_READ_FLOOR_TOOLS). The
 * real reason an unlisted tool (Bash, WebFetch, an MCP tool, …) can never be
 * meaningfully floored is that its REAL input, as the owning provider actually
 * constructs it, never carries one of those fields. Each fixture below is
 * that tool's real input shape (sourced from permission-manager.js's own doc
 * comments on NOT_DELEGABLE_TOOLS/COMMAND_TOOLS/ACCEPT_EDITS_TOOLS and the
 * #7854 final-review's per-provider table), with a protected `.env` path
 * substituted into whichever field that shape carries.
 */
describe("FLOOR_ALLOWLISTED_TOOLS matches which tools isFlooredTarget can actually flag, derived from permission-floor.js's own behavior (#7975, S3)", () => {
  const cwd = '/tmp/agent-control-floor-fixture'
  const protectedPath = `${cwd}/.env`

  // Grep/Glob are deliberately NOT in this bucketed fixture map — see the
  // dedicated describe block below. Unlike every tool here, isFlooredTarget
  // CAN be made to return true for them (when the secret sits in `path`
  // itself), so they don't fit either the "always floored" or "never
  // floored" bucket this map is built to express; folding them in here would
  // either wrongly assert they're never floored (false — `path` alone can
  // trigger it) or paper over the actual gap (a benign `path` + a malicious
  // `glob`/`pattern` is what's actually excluded, not floored/not-floored by
  // any single input).
  const realisticInput = {
    Read: () => ({ file_path: protectedPath }),
    Write: () => ({ file_path: protectedPath, content: 'x' }),
    Edit: () => ({ file_path: protectedPath, old_string: 'a', new_string: 'b' }),
    NotebookEdit: () => ({ notebook_path: protectedPath, new_source: 'x' }),
    apply_patch: () => ({ changes: [{ path: protectedPath, kind: 'update', diff: '' }] }),
    Bash: () => ({ command: `cat ${protectedPath}` }),
    shell: () => ({ command: `cat ${protectedPath}` }),
    PowerShell: () => ({ command: `Get-Content ${protectedPath}` }),
    Monitor: () => ({ command: `tail -f ${protectedPath}` }),
    Task: () => ({ prompt: 'investigate', subagent_type: 'general-purpose' }),
    Agent: () => ({ prompt: 'investigate', subagent_type: 'general-purpose' }),
    WebFetch: () => ({ url: 'https://example.com' }),
    WebSearch: () => ({ query: 'chroxy' }),
    mcp_spawn: () => ({ mcpServer: { name: 'x', command: 'y', args: [], envKeys: [] } }),
    request_permissions: () => ({ justification: 'need a broader sandbox' }),
    mcp_elicitation: () => ({ message: 'confirm connector write' }),
    'mcp__github__create_issue': () => ({ owner: 'x', repo: 'y', title: 'z' }),
    SomeFutureClaudeCodeTool: () => ({ someField: 'value' }),
  }

  it('every FLOOR_ALLOWLISTED_TOOLS member IS floored by isFlooredTarget for its own realistic protected-path input', () => {
    for (const tool of FLOOR_ALLOWLISTED_TOOLS) {
      const build = realisticInput[tool]
      assert.ok(build, `no realistic-input fixture defined for allowlisted tool ${tool} — add one`)
      assert.equal(isFlooredTarget(tool, build(), cwd), true, `${tool} is allowlisted but isFlooredTarget did not flag its realistic protected input — the allowlist no longer matches what the floor inspects`)
    }
  })

  it('every OTHER known tool name (command tools, not-delegable tools, Task/Agent/WebFetch/WebSearch, mcp_elicitation, an MCP tool, a future tool) is NEVER floored by its own realistic input', () => {
    for (const [tool, build] of Object.entries(realisticInput)) {
      if (FLOOR_ALLOWLISTED_TOOLS.has(tool)) continue
      assert.equal(isFlooredTarget(tool, build(), cwd), false, `${tool} was floored by its own realistic input — if the floor can now see into this tool, it may belong on the allowlist rather than being refused not_allowlisted`)
    }
  })
})

/**
 * #7975-followup (adversarial review of 71e78ba38) — Grep and Glob are
 * excluded from FLOOR_ALLOWLISTED_TOOLS even though ACCEPT_EDITS_TOOLS
 * carries both and the floor's SECRET_READ_FLOOR_TOOLS does inspect their
 * `path` field. This block is the RED-FIRST proof of why: a benign `path`
 * plus a malicious `glob`/`pattern` makes `isFlooredTarget` report
 * `floored: false` for an input that targets a secret file directly — the
 * exact vacuous-`false` failure #7975 was written to close, just moved from
 * "no path field at all" (an MCP tool) to "a second, uninspected path-like
 * field on an otherwise-inspected tool" (Grep/Glob).
 */
describe('Grep/Glob excluded from FLOOR_ALLOWLISTED_TOOLS: floored:false is not a complete safety signal for either (#7975-followup)', () => {
  const cwd = '/tmp/agent-control-floor-fixture-glob-grep'

  it('Grep({ path: <benign cwd>, glob: ".env" }) is reported floored:false by isFlooredTarget even though it targets a secret file by name via `glob`', () => {
    // `path` is the cwd itself — not a protected/secret path in any segment —
    // so the floor's only inspected field for Grep sees nothing. `glob`
    // (uninspected) is what actually selects `.env` as the file to search.
    const input = { pattern: '.', path: cwd, glob: '.env' }
    assert.equal(isFlooredTarget('Grep', input, cwd), false, 'isFlooredTarget must not silently clear a Grep call whose glob field targets a secret file name — this being false is the bug this test proves, not a passing safety check')
  })

  it('Glob({ path: <benign cwd>, pattern: "**/.env" }) is reported floored:false even though `pattern` is what actually selects the secret-named file', () => {
    const input = { pattern: '**/.env', path: cwd }
    assert.equal(isFlooredTarget('Glob', input, cwd), false)
  })

  it('by contrast, Grep/Glob with the secret placed directly in `path` (not via glob/pattern) IS floored — proving the floor DOES look at path, just not at the field that matters for this attack', () => {
    const protectedPath = `${cwd}/.env`
    assert.equal(isFlooredTarget('Grep', { pattern: 'x', path: protectedPath }, cwd), true)
    assert.equal(isFlooredTarget('Glob', { pattern: '*', path: protectedPath }, cwd), true)
  })

  it('neither Grep nor Glob is in FLOOR_ALLOWLISTED_TOOLS', () => {
    assert.equal(FLOOR_ALLOWLISTED_TOOLS.has('Grep'), false)
    assert.equal(FLOOR_ALLOWLISTED_TOOLS.has('Glob'), false)
  })

  for (const tool of ['Grep', 'Glob']) {
    it(`chroxy_respond_permission refuses allow for ${tool} with reason not_allowlisted, even for the benign-path/malicious-glob shape and floored:false`, async () => {
      const fixture = readyClient({ ownedSessions: new Set(['sess-a']) })
      const client = fixture.client
      try {
        observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: false })
        const result = await client.respondPermission('sess-a', 'r1', 'allow')
        assert.equal(result.status, 'rejected', JSON.stringify(result))
        assert.equal(result.reason, 'not_allowlisted')
      } finally {
        await client.close()
      }
    })
  }
})

describe('tool allowlist (#7975, S3): chroxy_respond_permission refuses allow for anything not allowlisted, regardless of floored', () => {
  let client
  afterEach(async () => { if (client) { await client.close(); client = null } })

  for (const tool of [...FLOOR_ALLOWLISTED_TOOLS]) {
    it(`allows allow for ${tool} when floored:false and the session is owned (positive control)`, async () => {
      const fixture = readyClient({ ownedSessions: new Set(['sess-a']) })
      client = fixture.client
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: false })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(fixture.sent.length, 1, `allow for allowlisted ${tool} must reach _send`)
      assert.equal(fixture.sent[0].decision, 'allow')
      assert.equal(result.status, 'uncertain')
    })
  }

  // Grep/Glob included here (#7975-followup) so they get the SAME full gate
  // coverage as every other not-allowlisted tool below (ownership-first,
  // floored:true, floored absent, allowCommandApprovals never overriding,
  // deny always permitted) — not just the dedicated bypass-proof block above.
  const NOT_ALLOWLISTED_EXAMPLES = ['mcp__github__create_issue', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'mcp_elicitation', 'SomeBrandNewClaudeCodeTool', 'Grep', 'Glob']

  for (const tool of NOT_ALLOWLISTED_EXAMPLES) {
    it(`refuses allow for ${tool} (not on the allowlist) when floored:false and the session is owned — reason not_allowlisted`, async () => {
      ;({ client } = readyClient({ ownedSessions: new Set(['sess-a']) }))
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: false })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(result.status, 'rejected', JSON.stringify(result))
      assert.equal(result.reason, 'not_allowlisted')
    })

    it(`refuses allow for ${tool} even when floored is ABSENT (not_allowlisted must win over floor_unknown too)`, async () => {
      ;({ client } = readyClient({ ownedSessions: new Set(['sess-a']) }))
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: undefined })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(result.status, 'rejected', JSON.stringify(result))
      assert.equal(result.reason, 'not_allowlisted')
    })

    it(`refuses allow for ${tool} even when floored:true`, async () => {
      ;({ client } = readyClient({ ownedSessions: new Set(['sess-a']) }))
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: true })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(result.status, 'rejected', JSON.stringify(result))
      assert.equal(result.reason, 'not_allowlisted')
    })

    it(`STILL refuses allow for ${tool} even when allowCommandApprovals:true — the flag only ever narrows COMMAND_TOOLS, never any other tool`, async () => {
      ;({ client } = readyClient({ ownedSessions: new Set(['sess-a']), allowCommandApprovals: true }))
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: false })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(result.status, 'rejected', JSON.stringify(result))
      assert.equal(result.reason, 'not_allowlisted')
    })

    it(`ownership still applies first: ${tool} in a session this process did not create is refused not_owned, not not_allowlisted`, async () => {
      ;({ client } = readyClient({})) // no ownedSessions
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: false })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(result.status, 'rejected', JSON.stringify(result))
      assert.equal(result.reason, 'not_owned')
    })

    it(`deny is still permitted for ${tool} (deny is never gated)`, async () => {
      const fixture = readyClient({ ownedSessions: new Set(['sess-a']) })
      client = fixture.client
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: false })
      const result = await client.respondPermission('sess-a', 'r1', 'deny')
      assert.equal(fixture.sent.length, 1, 'deny must reach _send — proves it was not refused')
      assert.equal(fixture.sent[0].decision, 'deny')
      void result
    })
  }
})

describe('not-delegable tools: mcp_spawn / request_permissions refused regardless of floored (#7973)', () => {
  let client
  afterEach(async () => { if (client) { await client.close(); client = null } })

  for (const tool of ['mcp_spawn', 'request_permissions']) {
    it(`refuses allow for ${tool} even when floored:false and the session is owned`, async () => {
      ;({ client } = readyClient({ ownedSessions: new Set(['sess-a']) }))
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: false })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(result.status, 'rejected', JSON.stringify(result))
      assert.equal(result.reason, 'not_delegable')
    })

    it(`refuses allow for ${tool} even when floored is ABSENT (would otherwise be floor_unknown — not_delegable must win regardless)`, async () => {
      ;({ client } = readyClient({ ownedSessions: new Set(['sess-a']) }))
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: undefined })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(result.status, 'rejected', JSON.stringify(result))
      assert.equal(result.reason, 'not_delegable')
    })

    it(`deny is still permitted for ${tool} (deny is never gated)`, async () => {
      const fixture = readyClient({ ownedSessions: new Set(['sess-a']) })
      client = fixture.client
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: false })
      const result = await client.respondPermission('sess-a', 'r1', 'deny')
      assert.equal(fixture.sent.length, 1, 'deny must reach _send — proves it was not refused')
      assert.equal(fixture.sent[0].decision, 'deny')
      assert.equal(result.status, 'uncertain', 'no fabricated ack arrives in this fixture — this only proves the call proceeded past every refusal gate')
    })

    it(`ownership still applies first: ${tool} in a session this process did not create is refused not_owned, not not_delegable`, async () => {
      ;({ client } = readyClient({})) // no ownedSessions
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: false })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(result.status, 'rejected', JSON.stringify(result))
      assert.equal(result.reason, 'not_owned')
    })
  }
})

describe('command-tool policy: deny-only by default, opt-in via allowCommandApprovals (#7973)', () => {
  let client
  afterEach(async () => { if (client) { await client.close(); client = null } })

  for (const tool of ['Bash', 'shell', 'PowerShell', 'Monitor']) {
    it(`refuses allow for ${tool} by default (floored:false, owned) — reason command_approval_disabled`, async () => {
      ;({ client } = readyClient({ ownedSessions: new Set(['sess-a']) }))
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: false })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(result.status, 'rejected', JSON.stringify(result))
      assert.equal(result.reason, 'command_approval_disabled')
    })

    it(`allows allow for ${tool} when allowCommandApprovals:true (floored:false, owned)`, async () => {
      const fixture = readyClient({ ownedSessions: new Set(['sess-a']), allowCommandApprovals: true })
      client = fixture.client
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: false })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(fixture.sent.length, 1, 'allow must reach _send once the flag is set and floored/ownership pass')
      assert.equal(fixture.sent[0].decision, 'allow')
      assert.equal(result.status, 'uncertain')
    })

    it(`STILL refuses ${tool} when allowCommandApprovals:true but floored:true — the flag never overrides the floor`, async () => {
      ;({ client } = readyClient({ ownedSessions: new Set(['sess-a']), allowCommandApprovals: true }))
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: true })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(result.status, 'rejected', JSON.stringify(result))
      assert.equal(result.reason, 'floored')
    })

    it(`STILL refuses ${tool} when allowCommandApprovals:true but floored is ABSENT — fail-closed, same as an ordinary tool`, async () => {
      ;({ client } = readyClient({ ownedSessions: new Set(['sess-a']), allowCommandApprovals: true }))
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: undefined })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(result.status, 'rejected', JSON.stringify(result))
      assert.equal(result.reason, 'floor_unknown')
    })

    it(`STILL refuses ${tool} when allowCommandApprovals:true but the session is not owned — the flag never overrides ownership`, async () => {
      ;({ client } = readyClient({ allowCommandApprovals: true })) // no ownedSessions
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: false })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(result.status, 'rejected', JSON.stringify(result))
      assert.equal(result.reason, 'not_owned')
    })

    it(`deny is always permitted for ${tool}, flag or not`, async () => {
      const fixture = readyClient({ ownedSessions: new Set(['sess-a']) })
      client = fixture.client
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: false })
      const result = await client.respondPermission('sess-a', 'r1', 'deny')
      assert.equal(fixture.sent.length, 1)
      assert.equal(fixture.sent[0].decision, 'deny')
      void result
    })
  }

  it('allowCommandApprovals defaults to false when not passed', () => {
    const { client: c } = readyClient({})
    assert.equal(c.allowCommandApprovals, false)
  })
})

describe('read-only mode refuses chroxy_respond_permission regardless of allowCommandApprovals (#7973)', () => {
  it('read-only + allowCommandApprovals:true still hard-refuses the mutation tool before any connection I/O', async () => {
    let calls = 0
    const manager = { get: async () => { calls++; throw Object.assign(new Error('fixture connection attempted'), { code: 'CONNECT_ATTEMPTED' }) } }
    const { mcp } = createAgentControlMcpServer({ readOnly: true, allowCommandApprovals: true, clientManager: manager })
    const sdk = new Client({ name: 'fixture', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await mcp.connect(serverTransport)
      await sdk.connect(clientTransport)
      const result = await sdk.callTool({ name: 'chroxy_respond_permission', arguments: { sessionId: 's', requestId: 'r', decision: 'allow' } })
      assert.equal(result.structuredContent.code, 'READ_ONLY_MODE')
      assert.equal(calls, 0, 'read-only must refuse before any connection I/O, flag or not')
    } finally {
      await sdk.close()
      await mcp.close()
    }
  })
})

describe('CLI: --allow-command-approvals end to end (real subprocess, #7973)', () => {
  let server
  let port
  let sessionsMap
  let manager
  let nextId

  // Ownership (`_ownedSessions`) is per-MCP-process and populated only by
  // actually calling `chroxy_create_session` — unlike the lightweight fixtures
  // above, a real CLI subprocess has no seam to pre-inject ownership, so
  // `manager.createSession` is mocked here (same shape as client-guards.test.js's
  // "createSession positive fixture" test) and every test below creates its own
  // session first, then drives a permission_request/respond_permission round
  // trip against THAT session id.
  before(async () => {
    const homeCwd = homedir()
    const created = createMockSessionManager([])
    sessionsMap = created.sessionsMap
    manager = created.manager
    nextId = 0
    manager.createSession = createSpy((opts) => {
      nextId += 1
      const id = `sess-cli-${nextId}`
      const mockSession = createMockSession()
      mockSession.cwd = opts.cwd || homeCwd
      sessionsMap.set(id, { session: mockSession, name: opts.name || 'New', cwd: opts.cwd || homeCwd, type: 'cli', isBusy: false })
      return id
    })
    manager.listSessions = () => [...sessionsMap.entries()].map(([sessionId, entry]) => ({
      sessionId, name: entry.name, cwd: entry.cwd, type: entry.type, isBusy: entry.isBusy, model: entry.session.model,
    }))
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    port = await startServerAndGetPort(server)
  })

  after(() => { if (server) server.close() })

  async function connectSdkClient(extraArgs = [], spawnOpts = {}) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, 'agent-control', '--stdio', '--url', `ws://127.0.0.1:${port}`, ...extraArgs],
      env: { ...process.env, CHROXY_AGENT_CONTROL_TOKEN: 'fixture-token-only' },
      stderr: 'pipe',
      ...spawnOpts,
    })
    const client = new Client({ name: 'test-harness', version: '0.0.0' }, { capabilities: {} })
    await client.connect(transport)
    return { client, transport }
  }

  async function readStderrUntil(transport, predicate, timeoutMs = 3000) {
    const stream = transport.stderr
    let buf = ''
    return new Promise((resolve, reject) => {
      const onData = (chunk) => {
        buf += chunk.toString('utf8')
        if (predicate(buf)) { cleanup(); resolve(buf) }
      }
      const timer = setTimeout(() => { cleanup(); reject(new Error(`stderr predicate not satisfied within ${timeoutMs}ms; captured: ${buf}`)) }, timeoutMs)
      function cleanup() { clearTimeout(timer); stream.off('data', onData) }
      stream.on('data', onData)
    })
  }

  it('absent by default: a Bash permission_request is refused command_approval_disabled, the provider never sees it, and no startup warning is printed', async () => {
    const { client, transport } = await connectSdkClient()
    try {
      // Assert the command-approval warning specifically never appears in
      // stderr, alongside the real refusal below.
      let stderrSoFar = ''
      const onData = (chunk) => { stderrSoFar += chunk.toString('utf8') }
      transport.stderr.on('data', onData)

      const createdResult = await client.callTool({ name: 'chroxy_create_session', arguments: { name: 'fixture-default', cwd: homedir() } })
      const sessionId = createdResult.structuredContent.sessionId
      const calls = []
      sessionsMap.get(sessionId).session.respondToPermission = (requestId, decision) => {
        calls.push([requestId, decision])
        return true
      }

      const first = await client.callTool({ name: 'chroxy_get_events', arguments: { sessionId } })
      const cursor = first.structuredContent.cursor
      const waitingPromise = client.callTool({ name: 'chroxy_get_events', arguments: { sessionId, cursor, waitMs: 1000 } })
      manager.emit('session_event', { sessionId, event: 'permission_request', data: { requestId: 'bash-pending-default', tool: 'Bash', input: { command: 'ls' }, remainingMs: 5000, floored: false } })
      const seen = await waitingPromise
      assert.ok(JSON.stringify(seen.structuredContent).includes('bash-pending-default'))

      const result = await client.callTool({
        name: 'chroxy_respond_permission',
        arguments: { sessionId, requestId: 'bash-pending-default', decision: 'allow' },
      })
      assert.equal(result.structuredContent.reason, 'command_approval_disabled', JSON.stringify(result.structuredContent))
      assert.equal(calls.length, 0, 'the provider must never see an allow decision for a command tool without the flag')

      transport.stderr.off('data', onData)
      assert.ok(!/allow-command-approvals/i.test(stderrSoFar), `no command-approval warning expected without the flag; captured: ${stderrSoFar}`)
    } finally {
      await transport.close().catch(() => {})
    }
  })

  it('present: --allow-command-approvals logs a startup warning and lets chroxy_respond_permission allow a Bash prompt through to the provider', async () => {
    const { client, transport } = await connectSdkClient(['--allow-command-approvals'])
    try {
      await readStderrUntil(transport, (buf) => /allow-command-approvals/i.test(buf))

      const createdResult = await client.callTool({ name: 'chroxy_create_session', arguments: { name: 'fixture-flagged', cwd: homedir() } })
      const sessionId = createdResult.structuredContent.sessionId
      const calls = []
      sessionsMap.get(sessionId).session.respondToPermission = (requestId, decision) => {
        calls.push([requestId, decision])
        manager.emit('session_event', { sessionId, event: 'permission_resolved', data: { requestId, decision, reason: 'user' } })
        return true
      }

      const first = await client.callTool({ name: 'chroxy_get_events', arguments: { sessionId } })
      const cursor = first.structuredContent.cursor
      const waitingPromise = client.callTool({ name: 'chroxy_get_events', arguments: { sessionId, cursor, waitMs: 1000 } })
      manager.emit('session_event', { sessionId, event: 'permission_request', data: { requestId: 'bash-pending', tool: 'Bash', input: { command: 'ls' }, remainingMs: 5000, floored: false } })
      const seen = await waitingPromise
      assert.ok(JSON.stringify(seen.structuredContent).includes('bash-pending'))

      const answered = await client.callTool({ name: 'chroxy_respond_permission', arguments: { sessionId, requestId: 'bash-pending', decision: 'allow' } })
      assert.equal(answered.structuredContent.status, 'resolved', JSON.stringify(answered.structuredContent))
      assert.deepEqual(calls, [['bash-pending', 'allow']], 'the flag must let an allow decision reach the provider for a command tool')
    } finally {
      await transport.close().catch(() => {})
    }
  })
})
