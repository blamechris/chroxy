import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { warnIfConfiguredCwdRefused } from '../src/server-cli.js'

/**
 * Issue 8303 — a blank cwd on Create inherits `config.cwd` with no
 * validateCwdAllowed, so an operator whose configured cwd explicit Create would
 * refuse got no hint. The daemon now logs ONE warning at startup, naming the
 * reason. Temp dirs and the homeOverride pattern only: no real ~/.ssh.
 */
describe('startup warning for a configured cwd that fails validateCwdAllowed (issue 8303)', () => {
  let base
  let fakeHome
  let outside
  const warnings = []
  const log = { warn: (m) => warnings.push(m) }

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-test-8303-cli-')))
    fakeHome = join(base, 'home')
    outside = join(base, 'outside')
    mkdirSync(fakeHome)
    mkdirSync(join(fakeHome, 'proj'))
    mkdirSync(join(fakeHome, '.ssh'))
    mkdirSync(outside)
    warnings.length = 0
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('warns once, naming the directory and the reason, when config.cwd is outside the allowed area', () => {
    const refused = warnIfConfiguredCwdRefused({ cwd: outside, homeOverride: fakeHome }, log)
    assert.equal(refused, true)
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].includes(outside), 'names the configured cwd')
    assert.ok(/within your home directory/.test(warnings[0]), 'names the validateCwdAllowed reason')
  })

  it('warns when config.cwd is a credential directory', () => {
    warnIfConfiguredCwdRefused({ cwd: join(fakeHome, '.ssh'), homeOverride: fakeHome }, log)
    assert.equal(warnings.length, 1)
    assert.ok(/credential/.test(warnings[0]))
  })

  it('warns when config.cwd is outside the configured workspace roots', () => {
    warnIfConfiguredCwdRefused({ cwd: join(fakeHome, 'proj'), homeOverride: fakeHome, workspaceRoots: [outside] }, log)
    assert.equal(warnings.length, 1)
    assert.ok(/workspace root/.test(warnings[0]))
  })

  it('is silent when config.cwd passes validateCwdAllowed', () => {
    const refused = warnIfConfiguredCwdRefused({ cwd: join(fakeHome, 'proj'), homeOverride: fakeHome }, log)
    assert.equal(refused, false)
    assert.deepEqual(warnings, [])
  })

  it('is silent when no cwd is configured (the default falls back inside home)', () => {
    assert.equal(warnIfConfiguredCwdRefused({ homeOverride: fakeHome }, log), false)
    assert.deepEqual(warnings, [])
  })

  it('is wired into startCliServer (the helper alone would never warn at boot)', () => {
    const src = readFileSync(new URL('../src/server-cli.js', import.meta.url), 'utf8')
    const startAt = src.indexOf('export async function startCliServer')
    assert.ok(startAt > 0, 'startCliServer must exist')
    assert.ok(/\bwarnIfConfiguredCwdRefused\(config, log\)/.test(src.slice(startAt)),
      'startCliServer must call warnIfConfiguredCwdRefused(config, log)')
  })
})
