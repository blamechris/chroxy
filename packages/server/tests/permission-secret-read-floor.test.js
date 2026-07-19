import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionManager, isProtectedPathTarget, isSecretReadTarget } from '../src/permission-manager.js'

/**
 * #6803 — secret-read floor (follow-up to the #6794 write floor).
 *
 * The #6794 floor treats every path-carrying tool the same: it floored a Read
 * of a config DIR (.git/.claude/.vscode/.config/git) exactly like a write. That
 * over-prompts on benign reads. #6803 makes the floor TOOL-AWARE:
 *
 *   - READS (Read/Glob/Grep) are floored ONLY on SECRET FILES (env files + key
 *     material) — reading a config dir stays a normal, un-prompted operation.
 *   - WRITES (and any other/unknown tool) keep the FULL floor (config dirs +
 *     secret files), now also covering key material (a strict superset — no
 *     regression, additive).
 *
 * A floor only ever forces a PROMPT (never a deny); a `deny` rule still denies.
 * Paths are synthetic (string ops only), so a fixed cwd needs no on-disk dir.
 */

const silentLog = { info() {}, warn() {} }
const CWD = '/work/project'

function createManager(opts = {}) {
  return new PermissionManager({ log: silentLog, cwd: CWD, ...opts })
}

/**
 * Drive handlePermission and report whether it FLOORED (emitted a prompt) or
 * auto-decided. Resolves the pending promise/timer for a clean teardown.
 */
async function run(pm, tool, input, mode, rules) {
  if (rules) pm.setRules(rules)
  const events = []
  const onReq = (d) => events.push(d)
  pm.on('permission_request', onReq)
  const promise = pm.handlePermission(tool, input, null, mode)
  let behavior
  if (events.length > 0) {
    pm.respondToPermission(events[0].requestId, 'deny')
    behavior = (await promise).behavior
  } else {
    behavior = (await promise).behavior
  }
  pm.off('permission_request', onReq)
  return { floored: events.length === 1, behavior }
}

describe('secret-read floor (#6803)', () => {
  let pm
  beforeEach(() => { pm = createManager() })
  afterEach(() => { pm.destroy() })

  // -- AC: a Read of a secret under a broad `allow Read` is NOT auto-approved --

  describe('READS of secret files are floored (fall through to a prompt)', () => {
    const secretReads = [
      '.env',
      '.env.local',
      '.env.production',
      '.ssh/id_rsa',
      'id_ed25519',
      'certs/server.pem',
      'keys/app.key',
      'keystore.p12',
      'cert.pfx',
      '.npmrc',
      '.pgpass',
      '.netrc',
    ]
    for (const file_path of secretReads) {
      it(`allow Read + Read ${file_path} → prompt`, async () => {
        const r = await run(pm, 'Read', { file_path }, 'approve', [{ tool: 'Read', decision: 'allow' }])
        assert.equal(r.floored, true, `${file_path} read must prompt, not auto-approve`)
      })
    }

    it('auto mode + Read .env → prompt (floor beats bypass)', async () => {
      const r = await run(pm, 'Read', { file_path: '.env' }, 'auto')
      assert.equal(r.floored, true)
    })

    it('acceptEdits + Read .env.production → prompt', async () => {
      const r = await run(pm, 'Read', { file_path: '.env.production' }, 'acceptEdits')
      assert.equal(r.floored, true)
    })

    it('Grep / Glob of a secret file are floored too', async () => {
      const g = await run(pm, 'Grep', { path: '.env' }, 'approve', [{ tool: 'Grep', decision: 'allow' }])
      assert.equal(g.floored, true)
      const pm2 = createManager()
      try {
        const gl = await run(pm2, 'Glob', { path: 'secrets/id_rsa' }, 'approve', [{ tool: 'Glob', decision: 'allow' }])
        assert.equal(gl.floored, true)
      } finally { pm2.destroy() }
    })
  })

  // -- PR #6873 review: credential-DENSE config files must floor for READS --

  describe('READS of credential config files are floored (PR #6873 review)', () => {
    const credentialReads = [
      '.git/config',                 // PAT-embedded remote URL
      '.git/credentials',            // git plaintext store
      '.config/git/config',          // XDG git config
      '.config/git/credentials',     // XDG git store
      '.claude/settings.json',       // may hold ANTHROPIC_API_KEY / env
      '.claude/settings.local.json',
      'sub/dir/.git/config',         // any depth
    ]
    for (const file_path of credentialReads) {
      it(`allow Read + Read ${file_path} → prompt`, async () => {
        const r = await run(pm, 'Read', { file_path }, 'approve', [{ tool: 'Read', decision: 'allow' }])
        assert.equal(r.floored, true, `${file_path} read must prompt (credential leak risk), not auto-approve`)
      })
    }

    it('auto/bypass mode + Read .git/config → prompt (floor beats bypass)', async () => {
      const r = await run(pm, 'Read', { file_path: '.git/config' }, 'auto')
      assert.equal(r.floored, true)
    })

    it('case-insensitive: Read .GIT/config and .Claude/Settings.Local.json → prompt', async () => {
      const a = await run(pm, 'Read', { file_path: '.GIT/config' }, 'approve', [{ tool: 'Read', decision: 'allow' }])
      assert.equal(a.floored, true)
      const pm2 = createManager()
      try {
        const b = await run(pm2, 'Read', { file_path: '.Claude/Settings.Local.json' }, 'approve', [{ tool: 'Read', decision: 'allow' }])
        assert.equal(b.floored, true)
      } finally { pm2.destroy() }
    })
  })

  // -- The key #6803 change: READS of config DIRS are NOT floored --

  describe('READS of NON-credential config-dir files stay auto-approved', () => {
    const benignReads = [
      '.git/HEAD',              // not a credential file
      '.git/refs/heads/main',
      '.vscode/settings.json',  // secret-free per the issue's intent
      '.claude/skills/foo.md',  // a runtime skill, not settings
      '.claude/agents/x.md',
      'src/foo.js',
      'docs/readme.md',
    ]
    for (const file_path of benignReads) {
      it(`allow Read + Read ${file_path} → auto-approved`, async () => {
        const r = await run(pm, 'Read', { file_path }, 'approve', [{ tool: 'Read', decision: 'allow' }])
        assert.equal(r.floored, false, `${file_path} read must NOT prompt`)
        assert.equal(r.behavior, 'allow')
      })
    }

    it('auto mode + Read .git/HEAD → auto-approved (no prompt)', async () => {
      const r = await run(pm, 'Read', { file_path: '.git/HEAD' }, 'auto')
      assert.equal(r.floored, false)
      assert.equal(r.behavior, 'allow')
    })
  })

  // -- WRITES keep the FULL floor (config dirs + secrets, incl. key material) --

  describe('WRITES keep the full floor (superset — no regression)', () => {
    const flooredWrites = [
      '.git/config',
      '.claude/settings.local.json',
      '.vscode/settings.json',
      '.config/git/config',
      '.env',
      '.env.local',
      'id_rsa',
      'certs/server.pem',
    ]
    for (const file_path of flooredWrites) {
      it(`allow Write + Write ${file_path} → prompt`, async () => {
        const r = await run(pm, 'Write', { file_path }, 'approve', [{ tool: 'Write', decision: 'allow' }])
        assert.equal(r.floored, true, `${file_path} write must prompt`)
      })
    }

    it('allow Write + Write src/foo.js → auto-approved (benign)', async () => {
      const r = await run(pm, 'Write', { file_path: 'src/foo.js' }, 'approve', [{ tool: 'Write', decision: 'allow' }])
      assert.equal(r.floored, false)
      assert.equal(r.behavior, 'allow')
    })
  })

  // -- deny rules still deny (the floor never widens access) --

  it('a deny Read rule on a secret still denies without a prompt', async () => {
    const events = []
    pm.on('permission_request', (d) => events.push(d))
    pm.setRules([{ tool: 'Read', decision: 'deny' }])
    const result = await pm.handlePermission('Read', { file_path: '.env' }, null, 'approve')
    assert.equal(result.behavior, 'deny')
    assert.equal(events.length, 0, 'a deny rule short-circuits without a prompt')
  })
})

// -- The exported pure matchers, exercised directly --

describe('isSecretReadTarget vs isProtectedPathTarget (#6803)', () => {
  const cwd = '/work/project'

  // Secret files: floored by BOTH the read floor and the write floor.
  const secretFiles = [
    { file_path: '.env' },
    { file_path: '.env.local' },
    { file_path: 'a/b/.env.production' },
    { file_path: '.ssh/id_rsa' },
    { file_path: 'id_dsa' },
    { file_path: 'id_ecdsa' },
    { file_path: 'id_ed25519' },
    { file_path: 'certs/server.pem' },
    { file_path: 'app.key' },
    { file_path: 'store.p12' },
    { file_path: 'client.pfx' },
    { file_path: '.npmrc' },
    { file_path: '.pgpass' },
    { file_path: '.netrc' },
    { file_path: '.ENV' },            // case-insensitive
    { file_path: 'ID_RSA' },
    { file_path: 'CERT.PEM' },
    { path: '.env' },                 // any path field
    { notebook_path: 'secret.pem' },
    { changes: [{ path: 'src/ok.js', kind: 'update', diff: 'd' }, { path: '.env', kind: 'update', diff: 'd' }] },
  ]
  for (const input of secretFiles) {
    it(`isSecretReadTarget floors ${JSON.stringify(input)}`, () => {
      assert.equal(isSecretReadTarget(input, cwd), true)
      // A secret is a subset of the full floor, so the write floor floors it too.
      assert.equal(isProtectedPathTarget(input, cwd), true)
    })
  }

  // Credential config files: floored by BOTH floors (PR #6873 review).
  const credentialConfig = [
    { file_path: '.git/config' },
    { file_path: '.git/credentials' },
    { file_path: 'sub/.git/config' },
    { file_path: '.config/git/config' },
    { file_path: '.config/git/credentials' },
    { file_path: '.claude/settings.json' },
    { file_path: '.claude/settings.local.json' },
    { file_path: '.GIT/config' },                    // case-insensitive
    { path: '.git/config' },                          // any path field
    { changes: [{ path: 'src/ok.js', kind: 'update', diff: 'd' }, { path: '.git/config', kind: 'update', diff: 'd' }] },
  ]
  for (const input of credentialConfig) {
    it(`credential config ${JSON.stringify(input)}: both floors catch it`, () => {
      assert.equal(isSecretReadTarget(input, cwd), true, 'read floor must catch credential config files')
      assert.equal(isProtectedPathTarget(input, cwd), true, 'write floor must catch them too')
    })
  }

  // NON-credential config-dir files: floored by the WRITE floor ONLY.
  const configDirs = [
    { file_path: '.git/HEAD' },
    { file_path: 'sub/.git/HEAD' },
    { file_path: '.claude/skills/foo.md' },
    { file_path: '.claude/agents/x.md' },
    { file_path: '.vscode/settings.json' },
    { file_path: '.config/git/attributes' },   // not config/credentials
  ]
  for (const input of configDirs) {
    it(`config dir ${JSON.stringify(input)}: write floor yes, read floor no`, () => {
      assert.equal(isProtectedPathTarget(input, cwd), true, 'write floor must catch config dirs')
      assert.equal(isSecretReadTarget(input, cwd), false, 'read floor must NOT catch a non-credential config file')
    })
  }

  // Neither floor touches these.
  const benign = [
    { file_path: 'src/foo.js' },
    { file_path: 'foo.env' },          // trailing .env is not a .env file
    { file_path: '.environment/x' },   // .env* must be exactly .env or .env.
    { file_path: '.github/workflows/ci.yml' },
    { file_path: 'notes.pemx' },       // must END with .pem
    { file_path: 'keyboard.md' },      // must END with .key
    { command: 'ls' },                 // no path field
    {},
    null,
  ]
  for (const input of benign) {
    it(`neither floor touches ${JSON.stringify(input)}`, () => {
      assert.equal(isSecretReadTarget(input, cwd), false)
      assert.equal(isProtectedPathTarget(input, cwd), false)
    })
  }

  it('a .env under a cwd that itself contains .env-like prefix still resolves relative to cwd', () => {
    assert.equal(isSecretReadTarget({ file_path: '.env' }, '/a/b'), true)
    assert.equal(isSecretReadTarget({ file_path: 'src/a.js' }, '/a/b'), false)
  })
})
