import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_TOOLS, BUILTIN_TOOL_NAMES, TODO_STATUS_LIST, TODO_STATUSES, TASK_PERMISSION_MODE_LIST, TASK_PERMISSION_MODE_RANK } from '../src/byok-tools.js'

/**
 * BUILTIN_TOOLS is the array passed verbatim into the SDK's
 * `messages.stream({ tools })` call. These tests lock the schema shape
 * so a stray rename / accidental drop is caught loudly.
 */

describe('BUILTIN_TOOLS', () => {
  it('exposes the documented toolset (PR 2 v1 + WebFetch #4050 + TodoWrite #4051 + Task #4049)', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name).sort()
    assert.deepEqual(names, ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Task', 'TodoWrite', 'WebFetch', 'Write'])
  })

  it('every tool has a name, description, and input_schema', () => {
    for (const tool of BUILTIN_TOOLS) {
      assert.equal(typeof tool.name, 'string')
      assert.ok(tool.name.length > 0, `tool missing name`)
      assert.equal(typeof tool.description, 'string')
      assert.ok(tool.description.length > 20, `tool ${tool.name} description too short`)
      assert.equal(tool.input_schema?.type, 'object', `tool ${tool.name} input_schema.type must be object`)
      assert.ok(Array.isArray(tool.input_schema.required), `tool ${tool.name} input_schema.required missing`)
    }
  })

  it('BUILTIN_TOOL_NAMES is a Set of the same names', () => {
    assert.ok(BUILTIN_TOOL_NAMES instanceof Set)
    for (const tool of BUILTIN_TOOLS) {
      assert.ok(BUILTIN_TOOL_NAMES.has(tool.name), `${tool.name} missing from name set`)
    }
  })

  it('Read requires file_path', () => {
    const read = BUILTIN_TOOLS.find((t) => t.name === 'Read')
    assert.deepEqual(read.input_schema.required, ['file_path'])
  })

  it('Write requires file_path and content', () => {
    const write = BUILTIN_TOOLS.find((t) => t.name === 'Write')
    assert.deepEqual(write.input_schema.required.sort(), ['content', 'file_path'])
  })

  it('Edit requires file_path, old_string, new_string', () => {
    const edit = BUILTIN_TOOLS.find((t) => t.name === 'Edit')
    assert.deepEqual(edit.input_schema.required.sort(), ['file_path', 'new_string', 'old_string'])
  })

  it('Bash requires only command', () => {
    const bash = BUILTIN_TOOLS.find((t) => t.name === 'Bash')
    assert.deepEqual(bash.input_schema.required, ['command'])
  })

  it('WebFetch requires url and prompt (#4050)', () => {
    const wf = BUILTIN_TOOLS.find((t) => t.name === 'WebFetch')
    assert.ok(wf, 'WebFetch must be registered')
    assert.deepEqual(wf.input_schema.required.sort(), ['prompt', 'url'])
  })

  it('WebFetch description discloses the auto-mode bypass (#4135)', () => {
    // Pre-fix the description claimed "Always permission-gated" which
    // contradicts the auto-mode short-circuit in PermissionManager. The
    // model now sees an honest description: permission-gated except in
    // auto mode. Pinning this prevents future doc drift from
    // reintroducing the contradiction.
    const wf = BUILTIN_TOOLS.find((t) => t.name === 'WebFetch')
    assert.ok(wf, 'WebFetch must be registered')
    assert.doesNotMatch(wf.description, /always permission-gated/i,
      'description must not promise "always" gating when auto mode bypasses it')
    // Word-boundary match on "auto" so we don't accept incidental
    // substrings like "automatic" or "auto-redirect" — the pin should
    // catch references to the auto permission mode specifically.
    assert.match(wf.description, /\bauto\b/i)
    // Pin the disclosure intent so a future rewording that mentions "auto"
    // in passing but loses the bypass-disclosure doesn't silently regress.
    assert.match(wf.description, /bypass|opt(ed)? out/i,
      'description must disclose that auto mode bypasses / opts out of the prompt')
  })

  it('TodoWrite requires todos array with id/content/status per item (#4051)', () => {
    const tw = BUILTIN_TOOLS.find((t) => t.name === 'TodoWrite')
    assert.ok(tw, 'TodoWrite must be registered')
    assert.deepEqual(tw.input_schema.required, ['todos'])
    assert.equal(tw.input_schema.properties.todos.type, 'array')
    const itemReq = tw.input_schema.properties.todos.items.required.sort()
    assert.deepEqual(itemReq, ['content', 'id', 'status'])
  })

  it('TodoWrite status enum and TODO_STATUSES Set share one source of truth (review #4136)', () => {
    // Pre-fix the schema enum was a duplicate literal of the Set entries.
    // Now both derive from TODO_STATUS_LIST so they cannot drift.
    const tw = BUILTIN_TOOLS.find((t) => t.name === 'TodoWrite')
    const schemaEnum = tw.input_schema.properties.todos.items.properties.status.enum
    assert.deepEqual([...schemaEnum].sort(), [...TODO_STATUS_LIST].sort())
    for (const status of TODO_STATUS_LIST) {
      assert.ok(TODO_STATUSES.has(status), `TODO_STATUSES Set must include ${status}`)
    }
    assert.equal(TODO_STATUSES.size, TODO_STATUS_LIST.length)
  })

  it('Task requires description and prompt (#4049)', () => {
    const task = BUILTIN_TOOLS.find((t) => t.name === 'Task')
    assert.ok(task, 'Task must be registered')
    assert.deepEqual(task.input_schema.required.sort(), ['description', 'prompt'])
    // subagent_type is forward-compat but optional in v1.
    assert.equal(task.input_schema.properties.subagent_type?.type, 'string')
  })

  it('Task description discloses subagent semantics + cancellation cascade (#4049)', () => {
    // Pin the contract so a future rewording can't strip the
    // user-facing guarantees (focused scope, isolated history,
    // cancellation cascade, cost attribution).
    const task = BUILTIN_TOOLS.find((t) => t.name === 'Task')
    assert.match(task.description, /sub-?agent|subagent/i)
    assert.match(task.description, /isolated|focused|fresh/i)
    assert.match(task.description, /cancel|interrupt|abort/i)
    assert.match(task.description, /cost|token/i)
  })

  it('BUILTIN_TOOL_NAMES contains Task (#4049)', () => {
    assert.ok(BUILTIN_TOOL_NAMES.has('Task'),
      'Task must be in BUILTIN_TOOL_NAMES so the executor catches misrouted dispatches')
  })

  it('Task input_schema exposes optional `permission_mode` enum (#5017)', () => {
    const task = BUILTIN_TOOLS.find((t) => t.name === 'Task')
    const prop = task.input_schema.properties.permission_mode
    assert.ok(prop, 'permission_mode property must exist on Task input_schema')
    assert.equal(prop.type, 'string')
    assert.deepEqual([...prop.enum].sort(), [...TASK_PERMISSION_MODE_LIST].sort())
    // Must remain optional — required list is only description + prompt.
    assert.ok(!task.input_schema.required.includes('permission_mode'),
      'permission_mode must NOT be in required')
  })

  it('Task description discloses the per-launch permission_mode override + at-most-as-permissive rule (#5017)', () => {
    const task = BUILTIN_TOOLS.find((t) => t.name === 'Task')
    assert.match(task.description, /permission_mode/, 'description must name the override field')
    assert.match(task.description, /permissive|stricter|at-most/i,
      'description must disclose the at-most-as-permissive rule')
  })

  it('TASK_PERMISSION_MODE_RANK orders modes by permissiveness (#5017)', () => {
    // Lower number = more restrictive. The strict ordering pins the
    // contract that drives _executeTaskTool's validation:
    // plan < approve < acceptEdits < auto.
    assert.equal(TASK_PERMISSION_MODE_LIST.length, 4)
    assert.ok(TASK_PERMISSION_MODE_RANK.plan < TASK_PERMISSION_MODE_RANK.approve)
    assert.ok(TASK_PERMISSION_MODE_RANK.approve < TASK_PERMISSION_MODE_RANK.acceptEdits)
    assert.ok(TASK_PERMISSION_MODE_RANK.acceptEdits < TASK_PERMISSION_MODE_RANK.auto)
    // Every list entry must have a rank.
    for (const mode of TASK_PERMISSION_MODE_LIST) {
      assert.equal(typeof TASK_PERMISSION_MODE_RANK[mode], 'number',
        `${mode} must have a rank`)
    }
  })
})
