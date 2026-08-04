import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  writeReposToConfig,
  writeSessionPresetOverrideToConfig,
  writeSchedulerEnabledToConfig,
  writeControlRoomRootToConfig,
} from '../src/config.js'

/**
 * #7027 — every `write*ToConfig` helper in config.js is a read-modify-write over
 * the operator's whole `~/.chroxy/config.json`. All four used to swallow a parse
 * failure (`catch { /* start fresh *\/ }`) and then write the merged object
 * anyway, so a config with a trailing comma — or one truncated by a previous
 * crash — was REPLACED WHOLESALE by a single-key object the first time anyone
 * toggled an unrelated Control Room setting. Tunnel config, providers, features
 * and permission rules, gone, with no warning.
 *
 * These tests are table-driven over EVERY writer on purpose: this repo has a
 * long history of fixing three of four adjacent sites and walking past the last
 * one, so `enumerates every write*ToConfig helper` below fails if a writer is
 * added to config.js without an entry here.
 *
 * Every case points at a temp path — never the real ~/.chroxy/config.json (the
 * sandbox guard in _setup.mjs would throw, and clobbering the operator's real
 * config is precisely what must not happen).
 */

// A realistic config the operator would be furious to lose, plus the syntax
// error that used to trigger the loss (a trailing comma after `features`).
const OPERATOR_CONFIG_WITH_TRAILING_COMMA = `{
  "port": 8765,
  "tunnel": { "mode": "named", "hostname": "chroxy.example.com" },
  "providers": { "default": "claude-tui" },
  "features": { "ide": true, "scheduler": true },
}`

const WRITERS = [
  {
    name: 'writeReposToConfig',
    write: (p) => writeReposToConfig([{ path: '/tmp/repo', name: 'repo' }], p),
    assertApplied: (cfg) => assert.deepEqual(cfg.repos, [{ path: '/tmp/repo', name: 'repo' }]),
  },
  {
    name: 'writeSessionPresetOverrideToConfig',
    write: (p) => writeSessionPresetOverrideToConfig('/repo/a', { enabled: true }, p),
    assertApplied: (cfg) => assert.deepEqual(cfg.repos, [{ path: '/repo/a', sessionPreset: { enabled: true } }]),
  },
  {
    name: 'writeSchedulerEnabledToConfig',
    write: (p) => writeSchedulerEnabledToConfig(true, p),
    assertApplied: (cfg) => assert.equal(cfg.features.scheduler, true),
  },
  {
    name: 'writeControlRoomRootToConfig',
    write: (p) => writeControlRoomRootToConfig('/work/root', p),
    assertApplied: (cfg) => assert.equal(cfg.controlRoomRoot, '/work/root'),
  },
]

let tmp
let configPath

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'chroxy-config-malformed-'))
  configPath = join(tmp, 'config.json')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const backupsOf = (p) => readdirSync(dirname(p)).filter(f => f.startsWith(`${basename(p)}.corrupt-`))

describe('#7027 write*ToConfig refuses to overwrite a malformed config', () => {
  it('enumerates every write*ToConfig helper in config.js', () => {
    // Structural guard: the fix must cover ALL the sibling writers, not most of
    // them. If a new `write*ToConfig` lands without a row in WRITERS, this fails.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'config.js'), 'utf-8')
    const found = [...src.matchAll(/^export function (write\w*ToConfig)\b/gm)].map(m => m[1]).sort()
    assert.deepEqual(found, WRITERS.map(w => w.name).sort())
  })

  for (const { name, write, assertApplied } of WRITERS) {
    describe(name, () => {
      it('THROWS and leaves the file byte-identical when the existing config is unparseable', () => {
        writeFileSync(configPath, OPERATOR_CONFIG_WITH_TRAILING_COMMA)
        const before = readFileSync(configPath, 'utf-8')

        assert.throws(() => write(configPath), /config\.json/)

        assert.equal(
          readFileSync(configPath, 'utf-8'),
          before,
          'the operator config must survive untouched — no wholesale overwrite',
        )
      })

      it('backs the unparseable config up before refusing', () => {
        writeFileSync(configPath, OPERATOR_CONFIG_WITH_TRAILING_COMMA)
        assert.throws(() => write(configPath))

        const backups = backupsOf(configPath)
        assert.equal(backups.length, 1, `expected one config.json.corrupt-* backup, got ${JSON.stringify(backups)}`)
        assert.equal(readFileSync(join(tmp, backups[0]), 'utf-8'), OPERATOR_CONFIG_WITH_TRAILING_COMMA)
      })

      it('THROWS when the config parses to something that is not a JSON object', () => {
        // Coercing these to `{}` and writing is the same wholesale replacement
        // wearing a different hat — the content is still destroyed.
        for (const bad of ['[1, 2, 3]', '"just a string"', 'null', '42']) {
          const p = join(tmp, `not-an-object-${Buffer.from(bad).toString('hex')}.json`)
          writeFileSync(p, bad)
          assert.throws(() => write(p), undefined, `expected a refusal for ${bad}`)
          assert.equal(readFileSync(p, 'utf-8'), bad, `${bad} must be left untouched`)
        }
      })

      it('still starts fresh when the config file is genuinely ABSENT (first run)', () => {
        // Positive control: the refusal must not break the legitimate
        // create-on-first-write path, including creating parent directories.
        const p = join(tmp, 'nested', 'deeper', 'config.json')
        assert.equal(existsSync(p), false)
        write(p)
        assertApplied(JSON.parse(readFileSync(p, 'utf-8')))
        assert.deepEqual(backupsOf(p), [], 'an absent file is not corrupt — nothing to back up')
      })

      it('still merges into a VALID existing config, preserving every other field', () => {
        // Positive control for the fixtures above: proves each writer really is
        // reached and really does write, so the throw cases are meaningful.
        writeFileSync(configPath, JSON.stringify({
          port: 8765,
          tunnel: { mode: 'named' },
          permissionRules: [{ tool: 'Bash', action: 'ask' }],
        }))
        write(configPath)
        const cfg = JSON.parse(readFileSync(configPath, 'utf-8'))
        assert.equal(cfg.port, 8765)
        assert.deepEqual(cfg.tunnel, { mode: 'named' })
        assert.deepEqual(cfg.permissionRules, [{ tool: 'Bash', action: 'ask' }])
        assertApplied(cfg)
      })
    })
  }
})
