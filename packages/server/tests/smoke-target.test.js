import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSmokeArgs, resolveSmokeTarget, PRODUCTION_FLAG } from './helpers/smoke-target.mjs'

/**
 * #8225 — smoke-test.mjs must name its target and must not reach the production
 * daemon by default.
 *
 * Every spawned case passes `--dry-run`, so even a mutant that removes a refusal
 * resolves a target and exits 0 WITHOUT connecting anywhere: the proof can go
 * red, and it can never drive a real daemon. HOME for every spawn is a temp dir.
 */
const SCRIPT = fileURLToPath(new URL('./smoke-test.mjs', import.meta.url))

describe('smoke target: argument parsing (#8225)', () => {
  it('reads --port/--token in both spelled forms', () => {
    const a = parseSmokeArgs(['--port', '9123', '--token=abc', '--headed']).args
    assert.equal(a.port, '9123')
    assert.equal(a.token, 'abc')
    assert.equal(a.headed, true)
    assert.equal(a.productionOk, false)
  })

  it('reads --url and --preview', () => {
    assert.equal(parseSmokeArgs(['--url', 'http://127.0.0.1:9000']).args.url, 'http://127.0.0.1:9000')
    assert.equal(parseSmokeArgs(['--preview=/x/preview.json']).args.preview, '/x/preview.json')
  })

  it('the production flag is the only thing that sets productionOk', () => {
    assert.equal(parseSmokeArgs([PRODUCTION_FLAG]).args.productionOk, true)
    assert.equal(parseSmokeArgs(['--port', '9000', '--headed']).args.productionOk, false)
  })

  it('rejects an unknown argument instead of ignoring it', () => {
    assert.ok(/unknown argument: --prot/.test(parseSmokeArgs(['--prot', '9000']).error))
  })

  it('rejects a value flag with no value, even when another flag follows', () => {
    assert.ok(/--port needs a value/.test(parseSmokeArgs(['--port']).error))
    assert.ok(/--token needs a value/.test(parseSmokeArgs(['--token', '--headed']).error))
  })

  it('takes SMOKE_URL / SMOKE_PORT / SMOKE_TOKEN from the environment, and a flag wins', () => {
    const env = { SMOKE_URL: 'http://127.0.0.1:9001', SMOKE_TOKEN: 'envtok' }
    const fromEnv = parseSmokeArgs([], env).args
    assert.equal(fromEnv.url, 'http://127.0.0.1:9001')
    assert.equal(fromEnv.token, 'envtok')
    // An explicit --port must not collide with SMOKE_URL, and --token beats SMOKE_TOKEN.
    const flagged = parseSmokeArgs(['--port', '9002', '--token', 'flagtok'], env).args
    assert.equal(flagged.url, null)
    assert.equal(flagged.port, '9002')
    assert.equal(flagged.token, 'flagtok')
  })

  it('--preview names the whole target: the environment is not merged into it', () => {
    const a = parseSmokeArgs(['--preview', '/x.json'], { SMOKE_URL: 'http://h:1', SMOKE_TOKEN: 't' }).args
    assert.equal(a.url, null)
    assert.equal(a.token, null)
  })
})

describe('smoke target: resolution and refusals (#8225)', () => {
  let root
  let home
  let preview
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'smoke-target-'))
    home = join(root, 'home')
    mkdirSync(join(home, '.chroxy'), { recursive: true })
    writeFileSync(join(home, '.chroxy', 'config.json'), JSON.stringify({ apiToken: 'REAL-PROD-TOKEN' }))
    preview = join(root, 'smoke.abc')
    mkdirSync(join(preview, 'config'), { recursive: true })
    writeFileSync(join(preview, 'config', 'config.json'), JSON.stringify({ apiToken: 'preview-token' }))
    writeFileSync(join(preview, 'preview.json'), JSON.stringify({ pid: 1, port: 9444, configDir: join(preview, 'config') }))
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  // userHome: null keeps the resolver from stat'ing the account's REAL ~/.chroxy here;
  // the cases that exercise that path inject a temp dir for it instead.
  const resolveFrom = (argv, env = {}, deps = {}) =>
    resolveSmokeTarget(parseSmokeArgs(argv, env).args, { home, userHome: null, env: {}, ...deps })

  it('NO target is a usage error, never a fallback to production', () => {
    const r = resolveFrom([])
    assert.equal(r.ok, false)
    assert.equal(r.kind, 'usage')
    assert.ok(/no target given/.test(r.error))
    // The real token sits readable at <home>/.chroxy: the resolver must not have picked it up.
    assert.ok(!JSON.stringify(r).includes('REAL-PROD-TOKEN'))
  })

  it('the production flag alone is still no target', () => {
    const r = resolveFrom([PRODUCTION_FLAG])
    assert.equal(r.ok, false)
    assert.equal(r.kind, 'usage')
  })

  it('a target without a token is a usage error', () => {
    const r = resolveFrom(['--port', '9123'])
    assert.equal(r.ok, false)
    assert.ok(/no API token/.test(r.error))
  })

  it('--port with --token resolves to a loopback origin', () => {
    const r = resolveFrom(['--port', '9123', '--token', 't'])
    assert.equal(r.ok, true)
    assert.equal(r.origin, 'http://127.0.0.1:9123')
    assert.equal(r.token, 't')
  })

  it('--url keeps the origin it was given', () => {
    const r = resolveFrom(['--url', 'http://10.0.0.5:9123/ignored?x=1', '--token', 't'])
    assert.equal(r.ok, true)
    assert.equal(r.origin, 'http://10.0.0.5:9123')
  })

  it('refuses port 8765 via --port, --url, the env and a preview record', () => {
    for (const [argv, env] of [
      [['--port', '8765', '--token', 't'], {}],
      [['--port', '08765', '--token', 't'], {}],
      [['--url', 'http://127.0.0.1:8765', '--token', 't'], {}],
      [['--url', 'http://localhost:8765/dashboard', '--token', 't'], {}],
      [[], { SMOKE_PORT: '8765', SMOKE_TOKEN: 't' }],
    ]) {
      const r = resolveFrom(argv, env)
      assert.equal(r.ok, false, `expected a refusal for ${JSON.stringify(argv)} ${JSON.stringify(env)}`)
      assert.equal(r.kind, 'refused')
      assert.ok(/production daemon/.test(r.error))
    }
    const rec = join(root, 'prod-port.json')
    writeFileSync(rec, JSON.stringify({ port: 8765, configDir: join(preview, 'config') }))
    const r = resolveFrom(['--preview', rec])
    assert.equal(r.ok, false)
    assert.equal(r.kind, 'refused')
  })

  it('refuses a preview whose configDir is the real ~/.chroxy, and one that symlinks to it', () => {
    const direct = join(root, 'real-dir.json')
    writeFileSync(direct, JSON.stringify({ port: 9444, configDir: join(home, '.chroxy') }))
    const r = resolveFrom(['--preview', direct])
    assert.equal(r.ok, false)
    assert.equal(r.kind, 'refused')
    assert.ok(/real/.test(r.error))
    assert.ok(!JSON.stringify(r).includes('REAL-PROD-TOKEN'))

    const link = join(root, 'looks-innocent')
    symlinkSync(join(home, '.chroxy'), link)
    const viaLink = join(root, 'via-link.json')
    writeFileSync(viaLink, JSON.stringify({ port: 9444, configDir: link }))
    const r2 = resolveFrom(['--preview', viaLink])
    assert.equal(r2.ok, false)
    assert.equal(r2.kind, 'refused')
  })

  it('refuses a configDir that is the real dir under another SPELLING (case-insensitive volumes)', () => {
    // Identity is (dev, ino), not the path text: `.CHROXY` is `.chroxy` on a
    // case-insensitive volume and realpath keeps the spelling it was given.
    const rec = join(root, 'upper.json')
    const upper = join(home, '.CHROXY')
    writeFileSync(rec, JSON.stringify({ port: 9444, configDir: upper }))
    const stat = (p) => (p === upper || p === join(home, '.chroxy') ? { dev: 7, ino: 42 } : { dev: 7, ino: 1 })
    const r = resolveFrom(['--preview', rec], {}, { stat, realpath: (p) => p })
    assert.equal(r.ok, false)
    assert.equal(r.kind, 'refused')
    // CONTROL: a directory with a different identity is not caught by the same code.
    const other = resolveFrom(['--preview', join(preview, 'preview.json')], {}, { stat, realpath: (p) => p })
    assert.equal(other.ok, true)
  })

  it('on the real filesystem, a differently-cased spelling of the real dir is refused when the volume folds case', (t) => {
    const probe = join(root, 'CasE-probe')
    mkdirSync(probe)
    if (!existsSync(join(root, 'case-probe'))) return t.skip('case-sensitive volume: the spelling cannot alias here')
    const rec = join(root, 'upper-real.json')
    writeFileSync(rec, JSON.stringify({ port: 9444, configDir: join(home, '.CHROXY') }))
    const r = resolveFrom(['--preview', rec])
    assert.equal(r.ok, false)
    assert.equal(r.kind, 'refused')
  })

  it("refuses the ACCOUNT's home .chroxy even when $HOME points elsewhere", () => {
    const acct = join(root, 'account-home')
    mkdirSync(join(acct, '.chroxy'), { recursive: true })
    writeFileSync(join(acct, '.chroxy', 'config.json'), JSON.stringify({ apiToken: 'ACCOUNT-PROD-TOKEN' }))
    const rec = join(root, 'acct.json')
    writeFileSync(rec, JSON.stringify({ port: 9444, configDir: join(acct, '.chroxy') }))
    const r = resolveFrom(['--preview', rec], {}, { userHome: acct })
    assert.equal(r.ok, false)
    assert.equal(r.kind, 'refused')
    assert.ok(!JSON.stringify(r).includes('ACCOUNT-PROD-TOKEN'))
    // CONTROL: with no userHome to compare against, that same record resolves, so the
    // refusal above came from the userInfo comparison and not from something else.
    assert.equal(resolveFrom(['--preview', rec], {}, { userHome: null }).ok, true)
    // And the flag lifts it, as it does for $HOME's.
    assert.equal(resolveFrom(['--preview', rec, PRODUCTION_FLAG], {}, { userHome: acct }).ok, true)
  })

  it('refuses a configDir equal to CHROXY_CONFIG_DIR from the environment', () => {
    const envDir = join(root, 'env-config')
    mkdirSync(envDir)
    writeFileSync(join(envDir, 'config.json'), JSON.stringify({ apiToken: 'ENV-TOKEN' }))
    const rec = join(root, 'envdir.json')
    writeFileSync(rec, JSON.stringify({ port: 9444, configDir: envDir }))
    const r = resolveFrom(['--preview', rec], {}, { env: { CHROXY_CONFIG_DIR: envDir } })
    assert.equal(r.ok, false)
    assert.equal(r.kind, 'refused')
    // CONTROL: unset (or a different dir), the same record resolves.
    assert.equal(resolveFrom(['--preview', rec], {}, { env: {} }).ok, true)
    assert.equal(resolveFrom(['--preview', rec], {}, { env: { CHROXY_CONFIG_DIR: join(root, 'else') } }).ok, true)
    assert.equal(resolveFrom(['--preview', rec, PRODUCTION_FLAG], {}, { env: { CHROXY_CONFIG_DIR: envDir } }).ok, true)
  })

  it('the production flag lifts both refusals and, only then, reads the real token', () => {
    const r = resolveFrom(['--port', '8765', '--token', 't', PRODUCTION_FLAG])
    assert.equal(r.ok, true)
    assert.equal(r.port, 8765)

    const noToken = resolveFrom(['--port', '8765', PRODUCTION_FLAG])
    assert.equal(noToken.ok, true)
    assert.equal(noToken.token, 'REAL-PROD-TOKEN')

    const rec = join(root, 'real-dir-flagged.json')
    writeFileSync(rec, JSON.stringify({ port: 9444, configDir: join(home, '.chroxy') }))
    assert.equal(resolveFrom(['--preview', rec, PRODUCTION_FLAG]).ok, true)
  })

  it('an explicit preview record resolves its port and reads the token from its own configDir', () => {
    const r = resolveFrom(['--preview', join(preview, 'preview.json')])
    assert.equal(r.ok, true)
    assert.equal(r.origin, 'http://127.0.0.1:9444')
    assert.equal(r.port, 9444)
    assert.equal(r.token, 'preview-token')
  })

  it('a preview record cannot be combined with --url/--port/--token', () => {
    for (const extra of [['--port', '9000'], ['--url', 'http://h:9'], ['--token', 'x']]) {
      const r = resolveFrom(['--preview', join(preview, 'preview.json'), ...extra])
      assert.equal(r.ok, false)
      assert.equal(r.kind, 'usage')
    }
  })

  it('a malformed preview record is a usage error, not a guess', () => {
    const cases = {
      'no-port.json': { configDir: join(preview, 'config') },
      'bad-port.json': { port: 'abc', configDir: join(preview, 'config') },
      'rel-dir.json': { port: 9444, configDir: 'config' },
      'no-config.json': { port: 9444, configDir: join(root, 'does-not-exist') },
    }
    for (const [name, body] of Object.entries(cases)) {
      const f = join(root, name)
      writeFileSync(f, JSON.stringify(body))
      const r = resolveFrom(['--preview', f])
      assert.equal(r.ok, false, name)
      assert.equal(r.kind, 'usage', name)
    }
    assert.equal(resolveFrom(['--preview', join(root, 'missing.json')]).ok, false)
  })

  it('rejects ports that are not ports', () => {
    for (const p of ['0', '65536', 'abc', '9000x', '-1']) {
      assert.equal(resolveFrom(['--port', p, '--token', 't']).ok, false, p)
    }
  })
})

describe('smoke-test.mjs entry point (#8225)', () => {
  let root
  let home
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'smoke-script-'))
    home = join(root, 'home')
    mkdirSync(join(home, '.chroxy'), { recursive: true })
    writeFileSync(join(home, '.chroxy', 'config.json'), JSON.stringify({ apiToken: 'REAL-PROD-TOKEN' }))
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config', 'config.json'), JSON.stringify({ apiToken: 'preview-token' }))
    writeFileSync(join(root, 'preview.json'), JSON.stringify({ port: 9444, configDir: join(root, 'config') }))
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  // Scrubbed environment with a throwaway HOME: nothing here can see the real ~/.chroxy.
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [SCRIPT, '--dry-run', ...args], {
    env: { PATH: process.env.PATH, HOME: home, ...extraEnv },
    encoding: 'utf8',
    timeout: 30000,
  })

  it('no target: exits 2 and prints usage', () => {
    const r = run([])
    assert.equal(r.status, 2, r.stderr)
    assert.ok(/Usage: node tests\/smoke-test\.mjs/.test(r.stderr))
    assert.ok(/no target given/.test(r.stderr))
    assert.ok(!/REAL-PROD-TOKEN/.test(r.stdout + r.stderr))
  })

  it('port 8765: exits 3 and says why', () => {
    const r = run(['--port', '8765', '--token', 't'])
    assert.equal(r.status, 3, r.stderr)
    assert.ok(/production daemon/.test(r.stderr))
    assert.ok(!/would target/.test(r.stdout), 'a refused run must not resolve a target')
  })

  it('a preview with the real ~/.chroxy as configDir: exits 3', () => {
    const f = join(root, 'real.json')
    writeFileSync(f, JSON.stringify({ port: 9444, configDir: join(home, '.chroxy') }))
    const r = run(['--preview', f])
    assert.equal(r.status, 3, r.stderr)
    assert.ok(!/REAL-PROD-TOKEN/.test(r.stdout + r.stderr))
  })

  it('a preview at the CHROXY_CONFIG_DIR of the calling shell: exits 3', () => {
    const f = join(root, 'envdir.json')
    writeFileSync(f, JSON.stringify({ port: 9444, configDir: join(root, 'config') }))
    const r = run(['--preview', f], { CHROXY_CONFIG_DIR: join(root, 'config') })
    assert.equal(r.status, 3, r.stderr)
    assert.ok(!/preview-token/.test(r.stdout + r.stderr))
  })

  it('an unknown argument: exits 2', () => {
    assert.equal(run(['--prot', '9000']).status, 2)
  })

  it('an explicit preview resolves and never prints the token', () => {
    const r = run(['--preview', join(root, 'preview.json')])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(/would target http:\/\/127\.0\.0\.1:9444/.test(r.stdout))
    assert.ok(!/preview-token/.test(r.stdout + r.stderr))
  })

  it('--port/--token and the SMOKE_* environment both resolve', () => {
    assert.equal(run(['--port', '9444', '--token', 't']).status, 0)
    const r = run([], { SMOKE_PORT: '9444', SMOKE_TOKEN: 't' })
    assert.equal(r.status, 0, r.stderr)
  })

  it('the production flag is honoured end to end', () => {
    const r = run(['--port', '8765', PRODUCTION_FLAG])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(/token 15 chars/.test(r.stdout))
  })

  it('source: the script no longer probes ports, spawns a daemon or reads the keychain', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    const code = src.split('\n').filter(l => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//')).join('\n')
    for (const [name, re] of [
      ['port probing', /\b(8765|3131|8080)\b/],
      ['spawning a daemon', /\bspawn\s*\(/],
      ['keychain', /find-generic-password/],
      ['~/.chroxy', /\.chroxy/],
    ]) {
      assert.ok(!re.test(code), `smoke-test.mjs must not contain ${name}`)
    }
  })
})
