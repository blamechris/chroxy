/**
 * #7002 — write fidelity of the MCP config mutation path.
 *
 * Two distinct gaps in the first write path into `~/.claude.json`
 * (`writeClaudeConfigAtomic`, added by #6998/#6974):
 *
 *  1. SYMLINK DESTRUCTION. `writeFileSync(tmp)` → `renameSync(tmp, filePath)`
 *     replaces the SYMLINK at `filePath` with a regular file. A dotfiles-repo
 *     arrangement (`~/.claude.json` → `~/dotfiles/claude.json`) silently loses
 *     its link and the real file stops receiving updates. The write must land on
 *     the link TARGET, atomically, with the link intact — and must refuse rather
 *     than guess when the link does not resolve to a plain user-owned file.
 *
 *  2. PRESERVED MODE + NEW SECRETS. The writer deliberately preserves the
 *     destination's mode instead of forcing 0600. When that mode is
 *     group/world-readable AND the entry being added carries `env`/`headers`
 *     (which routinely hold API tokens), Chroxy is the party introducing secret
 *     material into a widely-readable file, so it must say so loudly.
 *
 * Every test writes to a mkdtemp path — never the real `~/.claude.json`.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addMcpServerToConfig,
  describeConfigModeSecretWarning,
  removeMcpServerFromConfig,
  writeClaudeConfigAtomic,
} from '../src/byok-mcp-config.js'

let dir
let homeDir
let dotfilesDir
let linkPath
let targetPath

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chroxy-mcp-symlink-'))
  homeDir = join(dir, 'home')
  dotfilesDir = join(dir, 'dotfiles')
  mkdirSync(homeDir)
  mkdirSync(dotfilesDir)
  linkPath = join(homeDir, '.claude.json')
  targetPath = join(dotfilesDir, 'claude.json')
})

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
})

const sidecars = (d) => readdirSync(d).filter((f) => f.includes('.chroxy.') && f.endsWith('.tmp'))

const linkedConfig = (obj, { mode = 0o600 } = {}) => {
  writeFileSync(targetPath, JSON.stringify(obj, null, 2), { mode })
  chmodSync(targetPath, mode)
  symlinkSync(targetPath, linkPath)
}

describe('#7002 symlinked config: the write follows the link', () => {
  it('add writes THROUGH the symlink and leaves the link in place', () => {
    linkedConfig({ numStartups: 4, mcpServers: { keep: { command: 'k' } } })

    const res = addMcpServerToConfig({ name: 'repo-memory', config: { command: 'node' }, configPath: linkPath })
    assert.equal(res.ok, true, res.error)

    const link = lstatSync(linkPath)
    assert.equal(link.isSymbolicLink(), true, 'the user’s dotfiles symlink must survive the write')
    assert.equal(readlinkSync(linkPath), targetPath, 'the link still points at the same target')

    const persisted = JSON.parse(readFileSync(targetPath, 'utf8'))
    assert.ok(persisted.mcpServers['repo-memory'], 'the entry landed in the link TARGET')
    assert.ok(persisted.mcpServers.keep, 'unrelated keys survive')
    assert.equal(persisted.numStartups, 4)

    assert.deepEqual(sidecars(homeDir), [], 'no sidecar left beside the link')
    assert.deepEqual(sidecars(dotfilesDir), [], 'no sidecar left beside the target')
  })

  it('remove writes THROUGH the symlink and leaves the link in place', () => {
    linkedConfig({ mcpServers: { gone: { command: 'g' }, keep: { command: 'k' } } })

    const res = removeMcpServerFromConfig({ name: 'gone', configPath: linkPath })
    assert.equal(res.ok, true, res.error)
    assert.equal(res.found, true)

    assert.equal(lstatSync(linkPath).isSymbolicLink(), true, 'remove must not replace the link either')
    const persisted = JSON.parse(readFileSync(targetPath, 'utf8'))
    assert.equal(persisted.mcpServers.gone, undefined)
    assert.ok(persisted.mcpServers.keep)
    assert.deepEqual(sidecars(dotfilesDir), [])
  })

  it('preserves the TARGET’s mode, not a fresh-file default', () => {
    linkedConfig({ mcpServers: {} }, { mode: 0o640 })
    addMcpServerToConfig({ name: 'srv', config: { command: 'node' }, configPath: linkPath })
    assert.equal(statSync(targetPath).mode & 0o777, 0o640)
  })

  it('a chain of symlinks resolves to the final regular file', () => {
    const middle = join(dir, 'middle.json')
    writeFileSync(targetPath, JSON.stringify({ mcpServers: {} }, null, 2), { mode: 0o600 })
    symlinkSync(targetPath, middle)
    symlinkSync(middle, linkPath)

    const res = addMcpServerToConfig({ name: 'srv', config: { command: 'node' }, configPath: linkPath })
    assert.equal(res.ok, true, res.error)
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true)
    assert.equal(lstatSync(middle).isSymbolicLink(), true)
    assert.ok(JSON.parse(readFileSync(targetPath, 'utf8')).mcpServers.srv)
  })

  it('refuses a DANGLING symlink instead of materializing a regular file over it', () => {
    symlinkSync(join(dotfilesDir, 'missing.json'), linkPath)

    assert.throws(
      () => writeClaudeConfigAtomic(linkPath, { mcpServers: {} }, { mode: null }),
      /symlink/i,
      'a link we cannot resolve must be refused, loudly',
    )
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true, 'the dangling link is left exactly as found')
    assert.deepEqual(sidecars(homeDir), [])
  })

  it('refuses a symlink pointing at a DIRECTORY', () => {
    symlinkSync(dotfilesDir, linkPath)
    assert.throws(
      () => writeClaudeConfigAtomic(linkPath, { mcpServers: {} }, { mode: null }),
      /symlink/i,
    )
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true)
  })

  it('a plain (non-symlink) path is written exactly as before', () => {
    const plain = join(homeDir, 'plain.json')
    writeFileSync(plain, JSON.stringify({ mcpServers: {} }, null, 2), { mode: 0o600 })
    writeClaudeConfigAtomic(plain, { mcpServers: { s: { command: 'node' } } }, { mode: 0o600 })
    assert.equal(lstatSync(plain).isSymbolicLink(), false)
    assert.ok(JSON.parse(readFileSync(plain, 'utf8')).mcpServers.s)
    assert.equal(statSync(plain).mode & 0o777, 0o600)
    assert.deepEqual(sidecars(homeDir), [])
  })

  it('a MISSING path is still created (first write), no symlink handling needed', () => {
    const fresh = join(homeDir, 'fresh.json')
    writeClaudeConfigAtomic(fresh, { mcpServers: {} }, { mode: null })
    assert.equal(existsSync(fresh), true)
    assert.equal(statSync(fresh).mode & 0o777, 0o600)
  })
})

describe('#7002 group/world-readable config + newly written secrets', () => {
  it('warns when the preserved mode is group-readable and the entry carries env', () => {
    const warning = describeConfigModeSecretWarning({
      filePath: '/home/u/.claude.json',
      mode: 0o644,
      entry: { command: 'node', args: [], env: { API_TOKEN: 'sk-secret' } },
    })
    assert.ok(warning, 'a 0644 config receiving env must warn')
    assert.match(warning, /\/home\/u\/\.claude\.json/)
    assert.match(warning, /644/)
    assert.match(warning, /env/)
    assert.ok(!warning.includes('sk-secret'), 'the warning must never echo the secret value')
  })

  it('warns for headers on a remote server entry', () => {
    const warning = describeConfigModeSecretWarning({
      filePath: '/home/u/.claude.json',
      mode: 0o604,
      entry: { url: 'https://x/y', headers: { Authorization: 'Bearer t' } },
    })
    assert.ok(warning)
    assert.match(warning, /headers/)
    assert.ok(!warning.includes('Bearer t'))
  })

  it('stays quiet for an owner-only mode', () => {
    assert.equal(describeConfigModeSecretWarning({
      filePath: '/home/u/.claude.json',
      mode: 0o600,
      entry: { command: 'node', env: { API_TOKEN: 't' } },
    }), null)
  })

  it('stays quiet when the entry carries no secret-bearing field', () => {
    assert.equal(describeConfigModeSecretWarning({
      filePath: '/home/u/.claude.json',
      mode: 0o644,
      entry: { command: 'node', args: ['x'], env: {} },
    }), null)
  })

  it('stays quiet for a file WE created (mode null → 0600)', () => {
    assert.equal(describeConfigModeSecretWarning({
      filePath: '/home/u/.claude.json',
      mode: null,
      entry: { command: 'node', env: { API_TOKEN: 't' } },
    }), null)
  })

  it('addMcpServerToConfig returns the warning on a 0644 config carrying env', () => {
    const plain = join(homeDir, '.claude.json')
    writeFileSync(plain, JSON.stringify({ mcpServers: {} }, null, 2), { mode: 0o644 })
    chmodSync(plain, 0o644)

    const res = addMcpServerToConfig({
      name: 'srv',
      config: { command: 'node', env: { API_TOKEN: 'sk-secret' } },
      configPath: plain,
    })
    assert.equal(res.ok, true, res.error)
    assert.ok(res.warning, 'the mode/secrets warning must reach the caller')
    assert.match(res.warning, /644/)
    assert.ok(!res.warning.includes('sk-secret'))
    // The warning is advisory only — we still do NOT re-permission the user's file.
    assert.equal(statSync(plain).mode & 0o777, 0o644)
  })

  it('addMcpServerToConfig omits the warning for an owner-only config', () => {
    const plain = join(homeDir, '.claude.json')
    writeFileSync(plain, JSON.stringify({ mcpServers: {} }, null, 2), { mode: 0o600 })
    chmodSync(plain, 0o600)
    const res = addMcpServerToConfig({
      name: 'srv',
      config: { command: 'node', env: { API_TOKEN: 'sk-secret' } },
      configPath: plain,
    })
    assert.equal(res.ok, true, res.error)
    assert.equal(res.warning, undefined)
  })
})
