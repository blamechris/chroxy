import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readWorkflows, stepInput, stepRun } from './helpers/workflow-reader.js'

/**
 * release.yml: the updater feed is built, re-signed and verified correctly
 * (#8906, #8917).
 *
 * The scripts have their own tests (scripts/__tests__/updater-feed.test.mjs);
 * what nothing else pins is the WIRING, which is where this class of bug lives.
 * Two layers:
 *
 *  1. ORDER (structural): Sign MSI < re-sign < write-feed < upload on Windows,
 *     write-feed < upload on macOS, merge < verify < create-release in
 *     github-release, and the `if:` guards on the steps that must only run when
 *     updater signing is on.
 *  2. BEHAVIOUR (executed): each updater step's `run:` block is extracted with
 *     the workflow reader and EXECUTED in bash against stub `cargo` / `node`
 *     commands that record their argv. A substring check cannot tell
 *     `--require-platform windows-x86_64` from a comment mentioning it, nor
 *     `exit 1` from `exit 0`; running the block can.
 *
 * `issuesFor(jobs)` returns every problem found, so the same checks that gate
 * the real workflow are shown to go RED on mutated copies of it below.
 *
 * Bash runs with `-e` (as GitHub's `shell: bash` does) and must stay runnable on
 * macOS bash 3.2 and Linux. Skipped on win32 (stub scripts are POSIX shell).
 */

const STEP_NAMES = {
  detect: 'Detect signed-version support (tauri signer)',
  sign: 'Sign MSI (Azure Trusted Signing)',
  resign: 'Re-sign MSI for the updater (after Authenticode)',
  winFeed: 'Write and verify updater feed (Windows)',
  macFeed: 'Write and verify updater feed (macOS)',
  upload: 'Upload artifact',
  merge: 'Merge Tauri updater feeds',
  verify: 'Verify merged updater feed',
  release: 'Create GitHub Release',
}

const REPO = 'octo/chroxy'
const MAC_DIR = 'packages/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos'
const WIN_REL = 'src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi'
const WIN_DIR = `packages/desktop/${WIN_REL}`

const names = (job) => job.steps.map((s) => stepInput(s, 'name'))
const at = (job, name) => names(job).indexOf(name)
const stepNamed = (job, name) => job.steps[at(job, name)]

// ---------------------------------------------------------------- stubs

const NODE_STUB = `#!/bin/bash
if [ "$1" = "-p" ]; then printf '%s\\n' "$STUB_VERSION"; exit 0; fi
{ echo "---"; for a in "$@"; do printf '%s\\n' "$a"; done; } >> "$REC"
exit "\${STUB_NODE_EXIT:-0}"
`

// Prints a clap-like --help. Like clap's \`env =\`, it echoes the CURRENT value of the
// signing variables; STUB_HELP_MODE picks where the option declaration / trap goes.
const CARGO_STUB = `#!/bin/bash
if [ "$1 $2 $3 $4" = "tauri signer sign --help" ]; then
  echo "Sign a file"
  echo "Options:"
  echo "  -p, --password <PASSWORD>"
  echo "          Set private key password when signing [env: TAURI_SIGNING_PRIVATE_KEY_PASSWORD=\${TAURI_SIGNING_PRIVATE_KEY_PASSWORD}]"
  # a value wrapped onto its own line, as a long env value can be
  if [ -n "\${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]; then echo "          \${TAURI_SIGNING_PRIVATE_KEY_PASSWORD}"; fi
  if [ "$STUB_HELP_MODE" = "mention" ]; then
    echo "          Older CLIs: pass --app-version to a newer signer."
  fi
  if [ "$STUB_HELP_MODE" = "declared" ]; then
    echo "      --app-version <APP_VERSION>"
    echo "          Bind the signature to this app version."
  fi
  echo "  -h, --help"
  exit 0
fi
{ echo "---"; for a in "$@"; do printf '%s\\n' "$a"; done; } >> "$REC"
`

/** A scratch repo layout with stub commands on PATH. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'release-wiring-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  for (const [name, body] of [['node', NODE_STUB], ['cargo', CARGO_STUB]]) {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  const touch = (rel, text = 'x') => {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  return { dir, bin, touch, rec: join(dir, 'rec.txt'), ghEnv: join(dir, 'github_env.txt') }
}

/** Execute a step's run block. Returns {status, stdout, stderr, calls, ghEnv}. */
function exec(step, sb, { cwd = '.', env = {} } = {}) {
  const run = stepRun(step)
  assert.ok(run, 'step has a run block')
  writeFileSync(sb.rec, '')
  writeFileSync(sb.ghEnv, '')
  const r = spawnSync('bash', ['-e', '-c', run], {
    cwd: join(sb.dir, cwd),
    encoding: 'utf8',
    timeout: 30000,
    env: {
      PATH: `${sb.bin}:/usr/bin:/bin`,
      HOME: sb.dir,
      REC: sb.rec,
      GITHUB_ENV: sb.ghEnv,
      GITHUB_REPOSITORY: REPO,
      STUB_VERSION: '1.2.3',
      ...env,
    },
  })
  const calls = readFileSync(sb.rec, 'utf8').split('---\n').filter(Boolean).map((c) => c.split('\n').filter((l) => l !== ''))
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls, ghEnv: readFileSync(sb.ghEnv, 'utf8') }
}

const hasPair = (args, flag, value) => args.some((a, i) => a === flag && args[i + 1] === value)

// ----------------------------------------------------------------- rules

/** Pure rule over parsed release jobs: returns a list of problems (empty = correct). */
export function issuesFor(jobs) {
  const issues = []
  const job = (id) => jobs.find((j) => j.id === id)
  const win = job('desktop-windows')
  const mac = job('desktop-macos')
  const rel = job('github-release')
  for (const [id, j] of [['desktop-windows', win], ['desktop-macos', mac], ['github-release', rel]]) {
    if (!j) issues.push(`job ${id} not found`)
  }
  if (issues.length) return issues

  // ---- order
  const order = (j, label, ...stepNames) => {
    const idx = stepNames.map((n) => at(j, n))
    stepNames.forEach((n, i) => { if (idx[i] === -1) issues.push(`${label}: step "${n}" not found`) })
    if (idx.includes(-1)) return
    for (let i = 1; i < idx.length; i++) {
      if (!(idx[i - 1] < idx[i])) issues.push(`${label}: "${stepNames[i - 1]}" must come before "${stepNames[i]}"`)
    }
  }
  order(win, 'desktop-windows', STEP_NAMES.sign, STEP_NAMES.resign, STEP_NAMES.winFeed, STEP_NAMES.upload)
  order(mac, 'desktop-macos', STEP_NAMES.macFeed, STEP_NAMES.upload)
  order(rel, 'github-release', STEP_NAMES.merge, STEP_NAMES.verify, STEP_NAMES.release)
  if (issues.length) return issues

  // ---- guards
  const guard = (j, label, name, ...needles) => {
    const cond = stepInput(stepNamed(j, name), 'if') || ''
    for (const n of needles) if (!cond.includes(n)) issues.push(`${label}: "${name}" must be guarded by ${n} (got "${cond}")`)
  }
  guard(win, 'desktop-windows', STEP_NAMES.resign, "env.UPDATER_SIGN_ENABLED == 'true'", "env.SIGN_ENABLED == 'true'")
  guard(win, 'desktop-windows', STEP_NAMES.winFeed, "env.UPDATER_SIGN_ENABLED == 'true'")
  guard(mac, 'desktop-macos', STEP_NAMES.macFeed, "env.UPDATER_SIGN_ENABLED == 'true'")

  // ---- detect (both jobs)
  for (const [label, j] of [['desktop-windows', win], ['desktop-macos', mac]]) {
    if (at(j, STEP_NAMES.detect) === -1) { issues.push(`${label}: step "${STEP_NAMES.detect}" not found`); continue }
    if (at(j, STEP_NAMES.detect) > Math.min(...['Build Tauri app (MSI)', 'Build Tauri app (universal)'].map((n) => at(j, n)).filter((i) => i !== -1))) {
      issues.push(`${label}: detect step must run before the build`)
    }
    const step = stepNamed(j, STEP_NAMES.detect)
    const probe = (mode, extraEnv) => {
      const sb = sandbox()
      try {
        return exec(step, sb, { env: { STUB_HELP_MODE: mode, ...extraEnv } })
      } finally {
        rmSync(sb.dir, { recursive: true, force: true })
      }
    }
    const expect = (r, want, what) => {
      if (r.status !== 0) issues.push(`${label} detect (${what}): exited ${r.status}: ${r.stderr}`)
      else if (r.ghEnv !== `SIGNED_VERSION_SUPPORTED=${want}\n`) issues.push(`${label} detect (${what}): wrote ${JSON.stringify(r.ghEnv)}, want SIGNED_VERSION_SUPPORTED=${want}`)
    }
    expect(probe('declared', {}), 'true', 'option declared')
    expect(probe('absent', {}), 'false', 'option absent')
    expect(probe('mention', {}), 'false', 'flag only mentioned inside prose')
    // clap echoes env values: a password containing the flag must not flip the probe
    expect(probe('absent', { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'x --app-version y' }), 'false', 'flag inside a printed env value')
    expect(probe('absent', { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '--app-version' }), 'false', 'env value wrapped onto its own line')
    expect(probe('declared', { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'hunter2' }), 'true', 'option declared, password set')
  }

  // ---- Windows re-sign
  {
    const step = stepNamed(win, STEP_NAMES.resign)
    const msi = `${WIN_REL}/Chroxy_1.2.3_x64_en-US.msi`
    for (const supported of ['true', 'false']) {
      const sb = sandbox()
      try {
        sb.touch(`packages/desktop/${msi}`)
        const r = exec(step, sb, { cwd: 'packages/desktop', env: { SIGNED_VERSION_SUPPORTED: supported } })
        const want = supported === 'true' ? ['tauri', 'signer', 'sign', '--app-version', '1.2.3', msi] : ['tauri', 'signer', 'sign', msi]
        if (r.status !== 0) issues.push(`re-sign (supported=${supported}) exited ${r.status}: ${r.stderr}`)
        else if (r.calls.length !== 1 || JSON.stringify(r.calls[0]) !== JSON.stringify(want)) {
          issues.push(`re-sign (supported=${supported}) ran cargo with ${JSON.stringify(r.calls)}, want ${JSON.stringify(want)}`)
        }
      } finally {
        rmSync(sb.dir, { recursive: true, force: true })
      }
    }
    for (const [what, files] of [['two msi', ['a.msi', 'b.msi']], ['no msi', []]]) {
      const sb = sandbox()
      try {
        mkdirSync(join(sb.dir, 'packages/desktop', WIN_REL), { recursive: true })
        for (const f of files) sb.touch(`packages/desktop/${WIN_REL}/${f}`)
        const r = exec(step, sb, { cwd: 'packages/desktop', env: { SIGNED_VERSION_SUPPORTED: 'true' } })
        if (r.status === 0) issues.push(`re-sign with ${what} must fail`)
        if (r.calls.length !== 0) issues.push(`re-sign with ${what} must not call cargo`)
      } finally {
        rmSync(sb.dir, { recursive: true, force: true })
      }
    }
  }

  // ---- in-job feed steps
  const feedCases = [
    ['desktop-macos', mac, STEP_NAMES.macFeed, MAC_DIR, 'Chroxy.app.tar.gz', ['darwin-aarch64', 'darwin-x86_64']],
    ['desktop-windows', win, STEP_NAMES.winFeed, WIN_DIR, 'Chroxy_1.2.3_x64_en-US.msi', ['windows-x86_64']],
  ]
  for (const [label, j, name, dirRel, file, platforms] of feedCases) {
    const step = stepNamed(j, name)
    for (const supported of ['true', 'false']) {
      const sb = sandbox()
      try {
        sb.touch(`${dirRel}/${file}`)
        const r = exec(step, sb, { env: { SIGNED_VERSION_SUPPORTED: supported } })
        if (r.status !== 0) { issues.push(`${label} feed step (supported=${supported}) exited ${r.status}: ${r.stderr}`); continue }
        const build = r.calls.find((c) => c[0].endsWith('build-updater-feed.mjs'))
        const verify = r.calls.find((c) => c[0].endsWith('verify-updater-feed.mjs'))
        if (!build || !verify) { issues.push(`${label} feed step did not run both build-updater-feed and verify-updater-feed (${JSON.stringify(r.calls)})`); continue }
        const base = `https://github.com/${REPO}/releases/download/v1.2.3`
        if (!hasPair(build, '--version', '1.2.3')) issues.push(`${label} build step: missing --version 1.2.3`)
        if (!hasPair(build, '--base-url', base)) issues.push(`${label} build step: wrong --base-url ${JSON.stringify(build)}`)
        for (const p of platforms) {
          if (!hasPair(build, '--platform', `${p}=${dirRel}/${file}`)) issues.push(`${label} build step: missing --platform ${p}`)
        }
        if (!hasPair(verify, '--expect-url-prefix', `${base}/`)) issues.push(`${label} verify step: missing/incorrect --expect-url-prefix ${JSON.stringify(verify)}`)
        if (!hasPair(verify, '--expect-version', '1.2.3')) issues.push(`${label} verify step: missing --expect-version 1.2.3`)
        if (!hasPair(verify, '--pubkey-from', 'packages/desktop/src-tauri/tauri.conf.json')) issues.push(`${label} verify step: missing --pubkey-from`)
        const requiresSigned = verify.includes('--require-signed-version')
        if (requiresSigned !== (supported === 'true')) {
          issues.push(`${label} verify step (supported=${supported}): --require-signed-version present=${requiresSigned}`)
        }
      } finally {
        rmSync(sb.dir, { recursive: true, force: true })
      }
    }
    // exactly one payload
    for (const [what, files] of [['two payloads', [file, `other-${file}`]], ['no payload', []]]) {
      const sb = sandbox()
      try {
        mkdirSync(join(sb.dir, dirRel), { recursive: true })
        for (const f of files) sb.touch(`${dirRel}/${f}`)
        const r = exec(step, sb, { env: { SIGNED_VERSION_SUPPORTED: 'true' } })
        if (r.status === 0) issues.push(`${label} feed step with ${what} must fail`)
        if (r.calls.length !== 0) issues.push(`${label} feed step with ${what} must not call node`)
      } finally {
        rmSync(sb.dir, { recursive: true, force: true })
      }
    }
  }

  // ---- github-release verify step
  {
    const step = stepNamed(rel, STEP_NAMES.verify)
    const env = { GITHUB_REF_NAME: 'v1.2.3' }
    const run = (configured, withFeed) => {
      const sb = sandbox()
      try {
        if (withFeed) sb.touch('artifacts/updater/latest.json', '{}')
        return exec(step, sb, { env: { ...env, ...(configured === null ? {} : { UPDATER_SIGNING_CONFIGURED: configured }) } })
      } finally {
        rmSync(sb.dir, { recursive: true, force: true })
      }
    }
    const missing = run('true', false)
    if (missing.status === 0) issues.push('release verify: configured + no feed must fail')
    if (!/::error::/.test(missing.stdout + missing.stderr)) issues.push('release verify: configured + no feed must print ::error::')
    if (missing.calls.length !== 0) issues.push('release verify: configured + no feed must not run the verifier')

    const ok = run('true', true)
    if (ok.status !== 0) issues.push(`release verify: configured + feed exited ${ok.status}: ${ok.stderr}`)
    const v = ok.calls.find((c) => c[0].endsWith('verify-updater-feed.mjs'))
    if (!v) issues.push('release verify: configured + feed did not run verify-updater-feed.mjs')
    else {
      for (const k of ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64']) {
        if (!hasPair(v, '--require-platform', k)) issues.push(`release verify: missing --require-platform ${k}`)
      }
      if (!hasPair(v, '--expect-url-prefix', `https://github.com/${REPO}/releases/download/v1.2.3/`)) issues.push(`release verify: wrong --expect-url-prefix ${JSON.stringify(v)}`)
      if (!hasPair(v, '--expect-version', '1.2.3')) issues.push('release verify: missing --expect-version 1.2.3')
      if (!hasPair(v, '--feed', 'artifacts/updater/latest.json')) issues.push('release verify: wrong --feed')
      if (!hasPair(v, '--assets', 'artifacts')) issues.push('release verify: wrong --assets')
      if (!hasPair(v, '--pubkey-from', 'packages/desktop/src-tauri/tauri.conf.json')) issues.push('release verify: wrong --pubkey-from')
    }
    if (ok.calls.some((c) => c[0].endsWith('verify-updater-feed.mjs') && c.includes('--require-signed-version'))) {
      issues.push('release verify: must not require a signed version (desktop jobs already checked per CLI support)')
    }

    for (const flag of ['false', '', null]) {
      const none = run(flag, false)
      if (none.status !== 0) issues.push(`release verify: unconfigured (${JSON.stringify(flag)}) + no feed must exit 0, got ${none.status}`)
      if (!/::notice::/.test(none.stdout)) issues.push('release verify: unconfigured + no feed must print ::notice::')
      if (none.calls.length !== 0) issues.push('release verify: unconfigured + no feed must not run the verifier')
    }
    const unconf = run('false', true)
    const uv = unconf.calls.find((c) => c[0].endsWith('verify-updater-feed.mjs'))
    if (!uv) issues.push('release verify: unconfigured + feed must still verify it')
    else if (uv.includes('--require-platform') || uv.includes('--expect-url-prefix')) {
      issues.push('release verify: unconfigured + feed must not demand platforms/prefix')
    }
    if (!stepInput(step, 'name')) issues.push('release verify: step has no name')
    // the verifier's own failure must fail the step
    const sb = sandbox()
    try {
      sb.touch('artifacts/updater/latest.json', '{}')
      const failing = exec(step, sb, { env: { ...env, UPDATER_SIGNING_CONFIGURED: 'true', STUB_NODE_EXIT: '1' } })
      if (failing.status === 0) issues.push('release verify: a failing verifier must fail the step')
    } finally {
      rmSync(sb.dir, { recursive: true, force: true })
    }
  }
  return issues
}

// -------------------------------------------------------------- the tests

describe('release.yml updater feed wiring (#8906, #8917)', { skip: process.platform === 'win32' }, () => {
  let jobs
  let yml
  before(async () => {
    const release = (await readWorkflows()).find((w) => w.name === 'release.yml')
    assert.ok(release, 'release.yml should exist')
    jobs = release.jobs
    yml = release.text
  })

  it('is wired correctly: order, guards, and every executed step behaves', () => {
    assert.deepEqual(issuesFor(jobs), [])
  })

  it('does not put the signing secrets in the github-release verify step env', () => {
    const step = stepNamed(jobs.find((j) => j.id === 'github-release'), STEP_NAMES.verify)
    const stepText = step.join('\n')
    assert.ok(!/secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD\s*\}\}/.test(stepText), 'password secret must not be passed as a value')
    assert.ok(!/TAURI_KEY|TAURI_PWD/.test(stepText))
    assert.ok(/UPDATER_SIGNING_CONFIGURED: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY != '' && secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD != '' \}\}/.test(stepText))
  })

  const issuesAfter = async (mutate) => {
    const dir = mkdtempSync(join(tmpdir(), 'release-wiring-wf-'))
    try {
      const out = mutate(yml)
      assert.notEqual(out, yml, 'mutation must change the workflow')
      writeFileSync(join(dir, 'release.yml'), out)
      const wf = (await readWorkflows(pathToFileURL(`${dir}/`))).find((w) => w.name === 'release.yml')
      return issuesFor(wf.jobs)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // Replace the FIRST occurrence of `from` that lies after `after` (a marker in the text).
  const replaceAfter = (text, after, from, to) => {
    const base = text.indexOf(after)
    assert.notEqual(base, -1, `marker ${after} present`)
    const i = text.indexOf(from, base)
    assert.notEqual(i, -1, `${from} present after marker`)
    return text.slice(0, i) + to + text.slice(i + from.length)
  }
  const inVerifyStep = (text, from, to) => replaceAfter(text, `- name: ${STEP_NAMES.verify}`, from, to)
  const inResign = (text, from, to) => replaceAfter(text, `- name: ${STEP_NAMES.resign}`, from, to)
  const inDetect = (text, from, to) => replaceAfter(text, `- name: ${STEP_NAMES.detect}`, from, to)

  // Move block `a` after block `b` (both whole steps, b after a, within one job).
  const swapSteps = (text, nameA, nameB) => {
    const lines = text.split('\n')
    const startOf = (n, from = 0) => {
      const i = lines.slice(from).findIndex((l) => l.includes(`- name: ${n}`))
      return i === -1 ? -1 : i + from
    }
    const a = startOf(nameA)
    const b = a === -1 ? -1 : startOf(nameB, a + 1)
    assert.ok(a !== -1 && b !== -1, 'steps to swap exist in order')
    const nextStep = (from) => {
      const indent = /^(\s*)/.exec(lines[from])[1].length
      for (let i = from + 1; i < lines.length; i++) {
        const m = /^(\s*)- /.exec(lines[i])
        if (m && m[1].length === indent) return i
        if (/^ {0,2}\S/.test(lines[i])) return i
      }
      return lines.length
    }
    const aEnd = nextStep(a)
    const bEnd = nextStep(b)
    return [...lines.slice(0, a), ...lines.slice(b, bEnd), ...lines.slice(aEnd, b), ...lines.slice(a, aEnd), ...lines.slice(bEnd)].join('\n')
  }

  // [label, mutate(text), regex that at least one reported issue must match]
  const MUTATIONS = [
    ['drops --require-platform windows-x86_64 from the release verify', (t) => inVerifyStep(t, '              --require-platform windows-x86_64\n', ''), /--require-platform windows-x86_64/],
    ['missing-feed branch exits 0', (t) => inVerifyStep(t, 'exit 1', 'exit 0'), /configured \+ no feed must fail/],
    ['release verify signing test replaced by false', (t) => inVerifyStep(t, '[ "$UPDATER_SIGNING_CONFIGURED" = "true" ]', 'false'), /configured \+ no feed must fail/],
    ['re-sign step guard replaced by if: false', (t) => inResign(t, "if: env.UPDATER_SIGN_ENABLED == 'true' && env.SIGN_ENABLED == 'true'", 'if: false'), /must be guarded by/],
    ['--app-version removed from the re-sign', (t) => inResign(t, 'SIGN_ARGS+=(--app-version "$VERSION")', ': keep'), /re-sign \(supported=true\)/],
    ['detect marks support false even when declared', (t) => inDetect(t, '--app-version|--app-version\\ *|--app-version=*) SUPPORTED=true', '--app-version|--app-version\\ *|--app-version=*) SUPPORTED=false'), /option declared/],
    ['detect matches the flag anywhere in the help', (t) => inDetect(t, '--app-version|--app-version\\ *|--app-version=*)', '*--app-version*)'), /flag only mentioned inside prose/],
    ['detect probe no longer unsets the signing variables', (t) => inDetect(t, 'unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD TAURI_SIGNING_PRIVATE_KEY_PATH; ', ''), /wrapped onto its own line/],
    ['github-release prefix points at /download/main/', (t) => inVerifyStep(t, 'releases/download/${GITHUB_REF_NAME}/', 'releases/download/main/'), /wrong --expect-url-prefix/],
    ['verifier invoked through echo instead of node', (t) => inVerifyStep(t, 'node scripts/verify-updater-feed.mjs', 'echo scripts/verify-updater-feed.mjs'), /did not run verify-updater-feed/],
    ['release verify drops --expect-version', (t) => inVerifyStep(t, '            --expect-version "${GITHUB_REF_NAME#v}" \\\n', ''), /missing --expect-version/],
    ['Windows feed step requires a signed version unconditionally', (t) => replaceAfter(t, `- name: ${STEP_NAMES.winFeed}`, 'if [ "${SIGNED_VERSION_SUPPORTED:-false}" = "true" ]; then', 'if true; then'), /--require-signed-version present=true/],
    ['macOS feed step drops the url prefix', (t) => replaceAfter(t, `- name: ${STEP_NAMES.macFeed}`, '            --expect-url-prefix "${BASE_URL}/" \\\n', ''), /desktop-macos verify step: missing\/incorrect --expect-url-prefix/],
    ['updater re-sign moved before Sign MSI', (t) => swapSteps(t, STEP_NAMES.sign, STEP_NAMES.resign), /must come before/],
    ['feed written after the artifact upload', (t) => swapSteps(t, STEP_NAMES.winFeed, STEP_NAMES.upload), /must come before/],
    ['release created before the merged feed is verified', (t) => swapSteps(t, STEP_NAMES.verify, STEP_NAMES.release), /must come before/],
    ['verify step renamed away', (t) => t.replace(`- name: ${STEP_NAMES.resign}`, '- name: Something else'), /not found/],
  ]

  for (const [label, mutate, expected] of MUTATIONS) {
    it(`goes red when: ${label}`, async () => {
      const issues = await issuesAfter(mutate)
      assert.ok(issues.length > 0, 'mutation was not detected')
      assert.ok(issues.some((i) => expected.test(i)), `expected an issue matching ${expected}, got:\n${issues.join('\n')}`)
    })
  }
})
