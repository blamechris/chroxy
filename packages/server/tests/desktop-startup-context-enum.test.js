import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libRs = readFileSync(join(__dirname, '../../desktop/src-tauri/src/lib.rs'), 'utf8')

describe('StartupContext enum (#2111)', () => {
  it('defines a StartupContext enum', () => {
    assert.match(libRs, /enum\s+StartupContext/, 'lib.rs should define a StartupContext enum')
  })

  it('enum has Start and Restart variants', () => {
    const enumBlock = libRs.match(/enum\s+StartupContext\s*\{([^}]+)\}/s)
    assert.ok(enumBlock, 'StartupContext enum block should exist')
    assert.match(enumBlock[1], /Start\b/, 'enum should have Start variant')
    assert.match(enumBlock[1], /Restart\b/, 'enum should have Restart variant')
  })

  it('monitor_startup takes StartupContext instead of &str', () => {
    const fnSig = libRs.match(/fn\s+monitor_startup\([^)]+\)/)
    assert.ok(fnSig, 'monitor_startup function should exist')
    assert.ok(
      !fnSig[0].includes('&str'),
      'monitor_startup should not take &str parameter'
    )
    assert.match(fnSig[0], /StartupContext/, 'monitor_startup should take StartupContext parameter')
  })

  it('does not use string comparisons for context', () => {
    // The function body should use match arms, not string equality
    const fnStart = libRs.indexOf('fn monitor_startup')
    const fnBody = libRs.slice(fnStart, fnStart + 1000)
    assert.ok(
      !fnBody.includes('context == "start"'),
      'should not compare context to "start" string'
    )
    assert.ok(
      !fnBody.includes('context == "restart"'),
      'should not compare context to "restart" string'
    )
  })

  it('call sites use enum variants instead of string literals', () => {
    const callSites = libRs.match(/monitor_startup\([^)]+\)/g) || []
    // Filter out the function definition itself
    const calls = callSites.filter(c => !c.includes('app:'))
    assert.ok(calls.length >= 2, 'should have at least 2 call sites')
    for (const call of calls) {
      assert.ok(
        !call.includes('"start"') && !call.includes('"restart"'),
        `call site should use enum variant, not string: ${call}`
      )
    }
  })
})
