import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { BaseSession, PROVIDER_ACTIVITY_EVENTS, NOT_PROVIDER_ACTIVITY_EVENTS } from '../src/base-session.js'
import { PROXIED_SESSION_EVENTS, BUILTIN_TRANSIENT_SESSION_EVENTS } from '../src/session-manager.js'
import { getProvider, getRegisteredProviderNames } from '../src/providers.js'

// #8574: a name in PROXIED_SESSION_EVENTS already has a forwarding listener
// (which also records history). A provider that repeats it in its static
// `customEvents` gets a second, transient listener, and every frame reaches the
// client twice. ClaudeByokSession did exactly that for tool_start/tool_result
// and DockerByokSession inherited it.
//
// The provider roster is DERIVED, never written out, from three sources:
//   1. every module ANYWHERE under `src/` (recursive) that declares a
//      `class ... extends ...Session`: each exported BaseSession subclass;
//   2. every class in the provider registry;
//   3. every exported `create*SessionClass` factory (the config-driven
//      anthropicCompatible / openaiCompatible / acp providers declare their
//      class INSIDE the factory and never export it, so 1 cannot see them).
//      Each factory is called with a minimal sample entry (no network: the
//      factories only build a class). A factory with no sample entry fails the
//      test, so a new one cannot be skipped silently.
// A new provider is covered the day it lands.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

async function discoverSessionClasses() {
  const found = new Map()
  const files = readdirSync(SRC, { recursive: true }).filter((f) => typeof f === 'string' && f.endsWith('.js'))
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

// Minimal sample entries for the factories that build a provider class at
// registration time. Keyed by the factory's export name.
const FACTORY_SAMPLES = {
  createAnthropicCompatibleSessionClass: { id: 'overlap-anthropic', baseUrl: 'http://127.0.0.1:1', defaultModel: 'm' },
  createOpenAiCompatibleSessionClass: { id: 'overlap-openai', baseUrl: 'http://127.0.0.1:1', defaultModel: 'm' },
  createAcpSessionClass: { id: 'overlap-acp', command: process.execPath },
}

async function discoverFactoryClasses() {
  const built = new Map()
  const unsampled = []
  const files = readdirSync(SRC, { recursive: true }).filter((f) => typeof f === 'string' && f.endsWith('.js'))
  for (const file of files) {
    const text = readFileSync(join(SRC, file), 'utf8')
    if (!/export\s+function\s+create\w*SessionClass\b/.test(text)) continue
    const mod = await import(pathToFileURL(join(SRC, file)).href)
    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn !== 'function' || !/^create\w*SessionClass$/.test(name)) continue
      const sample = FACTORY_SAMPLES[name]
      if (!sample) { unsampled.push(name); continue }
      built.set(name, fn({ ...sample }))
    }
  }
  return { built, unsampled }
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

  it('factory-built provider classes are discovered and none lists a proxied event', async () => {
    const { built, unsampled } = await discoverFactoryClasses()
    assert.deepEqual(unsampled, [], 'every create*SessionClass factory needs a sample entry in FACTORY_SAMPLES')
    // A refactor that renames a factory must not silently drop it from the check.
    for (const name of ['createAnthropicCompatibleSessionClass', 'createOpenAiCompatibleSessionClass', 'createAcpSessionClass']) {
      assert.ok(built.has(name), `${name} was not discovered`)
    }
    const offenders = []
    for (const [name, Cls] of built) {
      assert.ok(Cls.prototype instanceof BaseSession, `${name} must build a BaseSession subclass`)
      const overlap = overlapOf(Cls)
      if (overlap.length) offenders.push(`${name}: ${overlap.join(', ')}`)
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

// #8743: the idle-only auto-deploy holds a restart off while a session's
// provider is producing output, stamped from the events in
// PROVIDER_ACTIVITY_EVENTS. A provider's own `customEvents` are forwarded too, so
// each one must be classified like the proxied and built-in transient events
// (tests/daemon-idle.test.js covers those two lists), over the same derived
// roster of classes.
describe('#8743 — every forwarded session event is classified for the provider-activity window', () => {
  const unclassified = (Cls) => (Array.isArray(Cls.customEvents) ? Cls.customEvents : [])
    .filter((e) => PROVIDER_ACTIVITY_EVENTS.includes(e) === NOT_PROVIDER_ACTIVITY_EVENTS.includes(e))

  it('every customEvents name of every discovered, registered and factory-built class is in exactly one list', async () => {
    const classes = new Map(await discoverSessionClasses())
    for (const n of getRegisteredProviderNames()) classes.set(`registry:${n}`, getProvider(n))
    for (const [n, Cls] of (await discoverFactoryClasses()).built) classes.set(n, Cls)
    const offenders = []
    let declared = 0
    for (const [name, Cls] of classes) {
      declared += Array.isArray(Cls.customEvents) ? Cls.customEvents.length : 0
      const bad = unclassified(Cls)
      if (bad.length) offenders.push(`${name}: ${bad.join(', ')}`)
    }
    assert.ok(declared > 0, 'premise: some provider declares customEvents, or this checks nothing')
    assert.deepEqual(offenders, [], 'add each to PROVIDER_ACTIVITY_EVENTS or NOT_PROVIDER_ACTIVITY_EVENTS (base-session.js)')
  })

  it('every NOT_PROVIDER_ACTIVITY_EVENTS name is an event that is actually forwarded (no dead exclusions)', async () => {
    const forwarded = new Set([...PROXIED_SESSION_EVENTS, ...BUILTIN_TRANSIENT_SESSION_EVENTS])
    for (const Cls of (await discoverSessionClasses()).values()) {
      for (const e of Array.isArray(Cls.customEvents) ? Cls.customEvents : []) forwarded.add(e)
    }
    for (const Cls of (await discoverFactoryClasses()).built.values()) {
      for (const e of Array.isArray(Cls.customEvents) ? Cls.customEvents : []) forwarded.add(e)
    }
    assert.deepEqual(NOT_PROVIDER_ACTIVITY_EVENTS.filter((e) => !forwarded.has(e)), [])
  })

  it('the check itself detects an unclassified event (control)', () => {
    class Bad extends BaseSession {
      static get customEvents() { return ['brand_new_event', 'setup_log'] }
    }
    assert.deepEqual(unclassified(Bad), ['brand_new_event'])
  })
})
