import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_TOOLS, BUILTIN_TOOL_NAMES, TODO_STATUS_LIST, TODO_STATUSES } from '../src/byok-tools.js'

/**
 * BUILTIN_TOOLS is the array passed verbatim into the SDK's
 * `messages.stream({ tools })` call. These tests lock the schema shape
 * so a stray rename / accidental drop is caught loudly.
 */

describe('BUILTIN_TOOLS', () => {
  it('exposes the documented toolset (PR 2 v1 + WebFetch #4050 + TodoWrite #4051)', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name).sort()
    assert.deepEqual(names, ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'TodoWrite', 'WebFetch', 'Write'])
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
    assert.equal(/always permission-gated/i.test(wf.description), false,
      'description must not promise "always" gating when auto mode bypasses it')
    assert.match(wf.description, /auto/i)
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
})
