import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  writeSessionPresetOverrideToConfig,
  readControlRoomRootFromConfig,
  writeControlRoomRootToConfig,
} from '../src/config.js'
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * #6201 (Tier-2 coverage gap) — characterization tests for the three config
 * persistence helpers that had zero direct coverage:
 *   - writeSessionPresetOverrideToConfig (#repo session-preset overrides)
 *   - readControlRoomRootFromConfig / writeControlRoomRootToConfig (#5172)
 *
 * All three accept an explicit `configPath`, so every test points at a temp
 * file under os.tmpdir() — never the real ~/.chroxy/config.json (the test
 * sandbox guard in _setup.mjs would throw otherwise). These pin current
 * behaviour so the later structural cleanup can refactor safely.
 */

let tmp
let configPath

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'chroxy-config-persist-'))
  configPath = join(tmp, 'config.json')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const readJson = () => JSON.parse(readFileSync(configPath, 'utf-8'))

describe('writeSessionPresetOverrideToConfig (#6201)', () => {
  it('creates a new repos entry with the preset when none exists', () => {
    writeSessionPresetOverrideToConfig('/repo/a', { enabled: true, preamble: 'hi' }, configPath)
    const cfg = readJson()
    assert.deepEqual(cfg.repos, [{ path: '/repo/a', sessionPreset: { enabled: true, preamble: 'hi' } }])
  })

  it('updates the preset on an existing repo entry, matched by path', () => {
    writeFileSync(configPath, JSON.stringify({ repos: [{ path: '/repo/a', sessionPreset: { enabled: false } }] }))
    writeSessionPresetOverrideToConfig('/repo/a', { enabled: true }, configPath)
    const cfg = readJson()
    assert.equal(cfg.repos.length, 1)
    assert.deepEqual(cfg.repos[0], { path: '/repo/a', sessionPreset: { enabled: true } })
  })

  it('clears the preset (preset=null) by deleting the key on an existing entry', () => {
    writeFileSync(configPath, JSON.stringify({ repos: [{ path: '/repo/a', sessionPreset: { enabled: true }, name: 'A' }] }))
    writeSessionPresetOverrideToConfig('/repo/a', null, configPath)
    const cfg = readJson()
    assert.deepEqual(cfg.repos[0], { path: '/repo/a', name: 'A' })
    assert.ok(!('sessionPreset' in cfg.repos[0]))
  })

  it('no-ops (no file write) when clearing and no entry exists', () => {
    writeSessionPresetOverrideToConfig('/repo/missing', null, configPath)
    assert.equal(existsSync(configPath), false)
  })

  it('preserves other repos and top-level fields when writing', () => {
    writeFileSync(
      configPath,
      JSON.stringify({ controlRoomRoot: '/work', repos: [{ path: '/repo/other', name: 'Other' }] }),
    )
    writeSessionPresetOverrideToConfig('/repo/a', { enabled: true }, configPath)
    const cfg = readJson()
    assert.equal(cfg.controlRoomRoot, '/work')
    assert.deepEqual(cfg.repos.find((r) => r.path === '/repo/other'), { path: '/repo/other', name: 'Other' })
    assert.deepEqual(cfg.repos.find((r) => r.path === '/repo/a'), { path: '/repo/a', sessionPreset: { enabled: true } })
  })

  it('starts fresh when the existing config is corrupt JSON', () => {
    writeFileSync(configPath, '{ not valid json')
    writeSessionPresetOverrideToConfig('/repo/a', { enabled: true }, configPath)
    const cfg = readJson()
    assert.deepEqual(cfg.repos, [{ path: '/repo/a', sessionPreset: { enabled: true } }])
  })
})

describe('readControlRoomRootFromConfig (#5172)', () => {
  it('returns the configured root when present and a string', () => {
    writeFileSync(configPath, JSON.stringify({ controlRoomRoot: '/work/root' }))
    assert.equal(readControlRoomRootFromConfig(configPath), '/work/root')
  })

  it('returns undefined when the file is missing', () => {
    assert.equal(readControlRoomRootFromConfig(configPath), undefined)
  })

  it('returns undefined when controlRoomRoot is not a string', () => {
    writeFileSync(configPath, JSON.stringify({ controlRoomRoot: 42 }))
    assert.equal(readControlRoomRootFromConfig(configPath), undefined)
  })

  it('returns undefined on corrupt JSON', () => {
    writeFileSync(configPath, '{ broken')
    assert.equal(readControlRoomRootFromConfig(configPath), undefined)
  })
})

describe('writeControlRoomRootToConfig (#5172)', () => {
  it('writes the root to a fresh file', () => {
    writeControlRoomRootToConfig('/work/root', configPath)
    assert.equal(readJson().controlRoomRoot, '/work/root')
  })

  it('preserves other existing fields when setting the root', () => {
    writeFileSync(configPath, JSON.stringify({ repos: [{ path: '/repo/a' }] }))
    writeControlRoomRootToConfig('/work/root', configPath)
    const cfg = readJson()
    assert.equal(cfg.controlRoomRoot, '/work/root')
    assert.deepEqual(cfg.repos, [{ path: '/repo/a' }])
  })

  it('overwrites a previously configured root', () => {
    writeControlRoomRootToConfig('/old', configPath)
    writeControlRoomRootToConfig('/new', configPath)
    assert.equal(readJson().controlRoomRoot, '/new')
  })

  it('round-trips with readControlRoomRootFromConfig', () => {
    writeControlRoomRootToConfig('/round/trip', configPath)
    assert.equal(readControlRoomRootFromConfig(configPath), '/round/trip')
  })
})
