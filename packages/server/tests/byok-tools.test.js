import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_TOOLS, BUILTIN_TOOL_NAMES } from '../src/byok-tools.js'

/**
 * BUILTIN_TOOLS is the array passed verbatim into the SDK's
 * `messages.stream({ tools })` call. These tests lock the schema shape
 * so a stray rename / accidental drop is caught loudly.
 */

describe('BUILTIN_TOOLS', () => {
  it('exposes the documented PR 2 v1 toolset', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name).sort()
    assert.deepEqual(names, ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'])
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
})
