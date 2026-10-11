import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { BaseSession } from '../src/base-session.js'
import { PROXIED_SESSION_EVENTS } from '../src/session-manager.js'
import { getProvider, getRegisteredProviderNames } from '../src/providers.js'

// #8574: a name in PROXIED_SESSION_EVENTS already has a forwarding listener
// (which also records history). A provider that repeats it in its static
// `customEvents` gets a second, transient listener, and every frame reaches the
// client twice. ClaudeByokSession did exactly that for tool_start/tool_result
// and DockerByokSession inherited it.
//
// The provider roster is DERIVED, never written out: every `src/*.js` module
// that declares a `class ... extends ...Session` is imported and each exported
// BaseSession subclass is checked, plus every class in the provider registry.
// A new provider is covered the day it lands.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

async function discoverSessionClasses() {
  const found = new Map()
  const files = readdirSync(SRC).filter((f) => f.endsWith('.js'))
  for (const file of files) {
    const text = readFileSync(join(SRC, file), 'utf8')
    if (!/\bclass\s+\w+\s+extends\s+\w*Session\b/.test(text)) continue
    const mod = await import(pathToFileURL(join(SRC, file)).href)
    for (const exported of Object.values(mod)) {
      if (typeof exported === 'function' && exported.prototype instanceof BaseSession) {
        found.set(exported.name, exported)
      }
    }
  }
  return found
}

function overlapOf(Cls) {
  const declared = Cls.customEvents
  return Array.isArray(declared) ? declared.filter((e) => PROXIED_SESSION_EVENTS.includes(e)) : []
}

describe('#8574 — no provider lists a proxied event in customEvents', () => {
  it('the discovered roster is a superset of the provider registry (derivation is not vacuous)', async () => {
    const discovered = await discoverSessionClasses()
    assert.ok(discovered.size >= 8, `expected to discover the provider classes, found ${discovered.size}`)
    const fromRegistry = getRegisteredProviderNames().map((n) => getProvider(n))
    const missing = fromRegistry.filter((C) => !discovered.has(C.name)).map((C) => C.name)
    assert.deepEqual(missing, [], 'every registered provider class must be reachable by the source scan')
    // The two classes the bug lived in must be among them.
    assert.ok(discovered.has('ClaudeByokSession'))
    assert.ok(discovered.has('DockerByokSession'))
  })

  it('no session class declares a proxied event in customEvents', async () => {
    const discovered = await discoverSessionClasses()
    const offenders = []
    for (const [name, Cls] of discovered) {
      const overlap = overlapOf(Cls)
      if (overlap.length) offenders.push(`${name}: ${overlap.join(', ')}`)
    }
    assert.deepEqual(offenders, [], 'customEvents must not repeat PROXIED_SESSION_EVENTS (each frame would reach clients twice)')
  })

  it('every registered provider class passes too', () => {
    const offenders = []
    for (const n of getRegisteredProviderNames()) {
      const overlap = overlapOf(getProvider(n))
      if (overlap.length) offenders.push(`${n}: ${overlap.join(', ')}`)
    }
    assert.deepEqual(offenders, [])
  })

  it('the check itself detects an overlap (control)', () => {
    class Bad extends BaseSession {
      static get customEvents() { return ['tool_start', 'x'] }
    }
    assert.deepEqual(overlapOf(Bad), ['tool_start'])
  })
})
