import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import yaml from 'js-yaml'

const root = resolve(import.meta.dirname, '../../..')
const workflow = yaml.load(readFileSync(join(root, '.github/workflows/maestro-nightly.yml'), 'utf8'))
const preflight = join(root, 'scripts/maestro-hosted-preflight.sh')
const buildInstall = join(root, 'scripts/maestro-build-install-ios.sh')
const sequentialRunner = join(root, 'packages/app/.maestro/scripts/run-all-sequential.sh')
const device = '0AD31F77-82DF-4E28-99E6-CAE0A8BB5E54'
const shellIt = process.platform === 'win32' ? it.skip : it
// Independent expectation for the canonical suite. An added, removed, or renamed
// flow must be reviewed here; the runner derives its own inventory from YAML.
const expectedInventory = [
  'connect-screen.yaml', 'manual-connect.yaml', 'lan-scan.yaml',
  'small-screen-layout.yaml', 'session-screen-connected.yaml',
  'session-view-modes.yaml', 'session-file-browser.yaml', 'session-messages.yaml',
  'chat-todolist.yaml', 'chat-websearch.yaml', 'chat-webfetch.yaml',
  'chat-tool-partial-summary.yaml', 'stream-stall-chip.yaml', 'plan-approval.yaml',
  'plan-approval-deny.yaml', 'terminal-view.yaml', 'reconnect.yaml',
  'ask-user-question.yaml', 'ask-user-question-deny.yaml',
  'ask-user-question-multi.yaml', 'ask-question-other-freeform.yaml',
  'chat-multi-question.yaml', 'key-exchange.yaml',
  'permission-disconnected-noop.yaml', 'diff-comment.yaml',
  'compaction-marker.yaml'
]

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-maestro-preflight-'))
  const developerDir = join(dir, 'Xcode_16.4.app/Contents/Developer')
  const bin = join(dir, 'bin')
  mkdirSync(join(developerDir, 'Applications/Simulator.app'), { recursive: true })
  mkdirSync(bin)
  const command = (name, body) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
  // The pause makes an early-closing `head -1` deterministic: xcodebuild writes
  // more output only after head has exited. The real hosted run died this way.
  command('xcodebuild', 'set -e; printf "Xcode %s\\n" "${XCODE_VERSION:-16.4}"; sleep 0.05; for i in $(seq 1 128); do printf "Build detail %s\\n" "$i"; done')
  command('osascript', 'echo "${SIMULATOR_ID:-com.apple.iphonesimulator}"')
  command('xcrun', 'if [ "$*" = "simctl list devices available -j" ]; then cat "$FAKE_DEVICES"; else echo "$*" >> "$FAKE_TRACE"; if [ "$1" = simctl ] && [ "$2" = shutdown ]; then sleep "${FAKE_SHUTDOWN_DELAY:-0}"; exit "${FAKE_SHUTDOWN_EXIT:-0}"; fi; if [ "$1" = simctl ] && [ "$2" = bootstatus ]; then sleep "${FAKE_BOOTSTATUS_DELAY:-0}"; exit "${FAKE_BOOTSTATUS_EXIT:-0}"; fi; fi')
  command('pkill', 'exit 0') // Keep the reset fixture from touching host Maestro processes.
  const devicesFile = join(dir, 'devices.json')
  writeFileSync(devicesFile, JSON.stringify({
    devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [
      { name: 'iPhone 16 Pro', isAvailable: true, udid: device }
    ] }
  }))
  const envFile = join(dir, 'github-env')
  const traceFile = join(dir, 'trace')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEVELOPER_DIR: developerDir,
    GITHUB_ENV: envFile, FAKE_DEVICES: devicesFile, FAKE_TRACE: traceFile }
  const run = (overrides = {}) => spawnSync('bash', [preflight], {
    env: { ...env, ...overrides }, encoding: 'utf8', timeout: 5000
  })
  return { dir, developerDir, devicesFile, envFile, traceFile, env, run }
}

function runnerFixture({ reset = false } = {}) {
  const f = fixture()
  const javaHome = join(f.dir, 'jdk')
  const trace = join(f.dir, 'maestro-trace')
  mkdirSync(join(javaHome, 'bin'), { recursive: true })
  writeFileSync(join(javaHome, 'bin/java'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(f.dir, 'bin/maestro'),
    '#!/bin/bash\nprintf "%s\\n" "$*" >> "$FAKE_MAESTRO_TRACE"\nif [ "${FAKE_MAESTRO_FIRST_FAIL:-0}" = 1 ] && [ "$(wc -l < "$FAKE_MAESTRO_TRACE")" -eq 1 ]; then exit 1; fi\nexit "${FAKE_MAESTRO_EXIT:-0}"\n',
    { mode: 0o755 })
  const env = { ...f.env, JAVA_HOME: javaHome, FAKE_MAESTRO_TRACE: trace,
    SIM_RESET_PHASE_TIMEOUT: '1', SIM_BOOTSTATUS_TIMEOUT: '1' }
  const run = (args, overrides = {}) => spawnSync('bash', [sequentialRunner,
    '--device', device, '--no-mock', ...(reset ? [] : ['--no-reset']), '--retries', '0', '--timeout', '2', ...args],
  { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30000 })
  return { ...f, trace, run }
}

function buildInstallFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-maestro-build-'))
  const bin = join(dir, 'bin')
  const project = join(dir, 'app')
  const runnerTemp = join(dir, 'runner-temp')
  const installed = join(dir, 'installed.app')
  const trace = join(dir, 'trace')
  mkdirSync(bin)
  mkdirSync(project)
  mkdirSync(runnerTemp)
  mkdirSync(installed)
  const command = (name, body) => writeFileSync(join(bin, name), `#!/bin/bash\nset -e\n${body}\n`, { mode: 0o755 })
  command('npx', `echo "npx|$*" >> "$FAKE_TRACE"
if [ "$FAKE_FAIL_STEP" = prebuild ]; then exit 23; fi
if [ "$FAKE_FAIL_STEP" != workspace ]; then mkdir -p "$FAKE_PROJECT/ios/Chroxy.xcworkspace"; fi`)
  command('xcodebuild', `echo "xcodebuild|$*|RCT_NO_LAUNCH_PACKAGER=$RCT_NO_LAUNCH_PACKAGER" >> "$FAKE_TRACE"
if [ "$FAKE_FAIL_STEP" = build ]; then exit 24; fi
if [ "$FAKE_FAIL_STEP" != product ]; then
  mkdir -p "$RUNNER_TEMP/chroxy-maestro-derived-data/Build/Products/Debug-iphonesimulator/Chroxy.app"
  touch "$RUNNER_TEMP/chroxy-maestro-derived-data/Build/Products/Debug-iphonesimulator/Chroxy.app/Info.plist"
fi`)
  command('plutil', `echo "plutil|$*" >> "$FAKE_TRACE"
if [ "$FAKE_FAIL_STEP" = plist ]; then exit 25; fi
if [ "$FAKE_FAIL_STEP" = identity ]; then echo com.example.other; else echo com.blamechris.chroxy; fi`)
  command('xcrun', `echo "xcrun|$*" >> "$FAKE_TRACE"
if [ "$2" = install ]; then
  if [ "$FAKE_FAIL_STEP" = install ]; then exit 26; fi
elif [ "$2" = get_app_container ]; then
  if [ "$FAKE_FAIL_STEP" = container ]; then exit 27; fi
  if [ "$FAKE_FAIL_STEP" = missing-container ]; then echo "$FAKE_PROJECT/missing.app"; else echo "$FAKE_INSTALLED"; fi
else
  exit 28
fi`)
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`,
    DEVICE: device, RUNNER_TEMP: runnerTemp, FAKE_TRACE: trace,
    FAKE_PROJECT: project, FAKE_INSTALLED: installed }
  const run = (failStep) => spawnSync('bash', [buildInstall, project], {
    env: { ...env, FAKE_FAIL_STEP: failStep || '' }, encoding: 'utf8', timeout: 5000
  })
  return { dir, trace, run }
}

function tracedFlows(trace) {
  return readFileSync(trace, 'utf8').trim().split('\n').map(line => line.match(/([^/ ]+\.yaml)$/)?.[1])
}

function assertCompletePartition(shards) {
  const flattened = shards.flat()
  const duplicates = flattened.filter((name, index) => flattened.indexOf(name) !== index)
  const missing = expectedInventory.filter(name => !flattened.includes(name))
  const unexpected = flattened.filter(name => !expectedInventory.includes(name))
  assert.deepEqual({ missing, duplicates, unexpected },
    { missing: [], duplicates: [], unexpected: [] }, 'shards must cover the independent inventory exactly once')
}

function flow(path) {
  return yaml.loadAll(readFileSync(join(root, 'packages/app/.maestro', path), 'utf8'))[1]
}

// Exercise the actual shared command order against the native states captured
// by the failed run: late Expo sheet, slow bundle download, and no readiness.
function simulateDevClient(commands, events, destination) {
  const labels = {
    loading: ['Loading from Metro...'], downloading: ['Downloading 100%...'],
    promptCurly: ['Open in “Chroxy”?', 'Cancel', 'Open'],
    promptStraight: ['Open in "Chroxy"?', 'Cancel', 'Open'],
    intro: ['Continue'], menu: ['Reload'], onboarding: ['Welcome to Chroxy', 'Skip'],
    connect: ['Connect to Chroxy'], chat: ['Chat'], connecting: ['Connecting', 'Cancel']
  }
  let state = events[0].state
  let time = events[0].at
  let next = 1
  const matches = selector => {
    const text = typeof selector === 'string' ? selector : selector.text
    return labels[state].some(label => new RegExp(text).test(label))
  }
  const execute = steps => {
    for (const step of steps) {
      if (step.extendedWaitUntil) {
        const { visible, timeout } = step.extendedWaitUntil
        const deadline = time + timeout
        while (!matches(visible)) {
          if (state === 'promptCurly' || state === 'promptStraight') {
            throw new Error('readiness timed out: iOS link confirmation still open')
          }
          if (next >= events.length || events[next].at > deadline) throw new Error('readiness timed out')
          time = events[next].at
          state = events[next++].state
        }
      } else if (step.runFlow) {
        if (!step.runFlow.when || matches(step.runFlow.when.visible)) execute(step.runFlow.commands)
      } else if (step.tapOn) {
        if (step.tapOn.text === '^Open$' &&
          (state === 'promptCurly' || state === 'promptStraight')) state = 'loading'
        else if (step.tapOn.text === '^Continue$' && state === 'intro') state = 'menu'
        else if (step.tapOn.text === '^Skip$' && state === 'onboarding') state = destination
        else if (step.tapOn.text === '^Cancel$' && state === 'connecting') state = 'connect'
        else if (step.tapOn.point === '93%,43%' && state === 'menu') state = destination
        else throw new Error(`tap would miss or hit the app: ${JSON.stringify(step.tapOn)}`)
      }
    }
  }
  execute(commands)
  return state
}

describe('Maestro nightly hosted runner (#7113)', () => {
  shellIt('builds and installs the Debug simulator app without launching it', () => {
    const f = buildInstallFixture()
    try {
      const result = f.run()
      assert.equal(result.status, 0, result.stderr)
      const commands = readFileSync(f.trace, 'utf8').trim().split('\n')
      assert.equal(commands.length, 5)
      assert.equal(commands[0], 'npx|expo prebuild --platform ios')
      assert.ok(commands[1].startsWith('xcodebuild|-workspace '))
      assert.ok(commands[1].includes(' -scheme Chroxy -configuration Debug '))
      assert.ok(commands[1].includes(` -destination id=${device} `))
      assert.ok(commands[1].includes(' -derivedDataPath '))
      assert.ok(commands[1].endsWith(' build|RCT_NO_LAUNCH_PACKAGER=true'))
      assert.ok(commands[2].startsWith('plutil|-extract CFBundleIdentifier raw -o - '))
      assert.ok(commands[3].startsWith(`xcrun|simctl install ${device} `))
      assert.equal(commands[4], `xcrun|simctl get_app_container ${device} com.blamechris.chroxy app`)
      assert.ok(!commands.some(line => line.startsWith('xcrun|simctl openurl ') ||
        line.startsWith('xcrun|simctl launch ')), 'the helper must not launch the app')
      assert.match(result.stdout, /Installed com\.blamechris\.chroxy/)
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })

  shellIt('stops before install on preparation, build, product, or identity failures', () => {
    for (const failedStep of ['prebuild', 'workspace', 'build', 'product', 'plist', 'identity']) {
      const f = buildInstallFixture()
      try {
        const result = f.run(failedStep)
        assert.notEqual(result.status, 0, `${failedStep} must fail the helper`)
        assert.equal(result.signal, null, `${failedStep} must exit promptly, not time out`)
        const commands = readFileSync(f.trace, 'utf8').trim().split('\n')
        assert.ok(!commands.some(line => line.startsWith('xcrun|')),
          `${failedStep} must not install an unverified app`)
        if (failedStep === 'prebuild') assert.equal(result.status, 23)
        if (failedStep === 'build') assert.equal(result.status, 24)
        if (failedStep === 'plist') assert.equal(result.status, 25)
      } finally {
        rmSync(f.dir, { recursive: true, force: true })
      }
    }
  })

  shellIt('fails when installation or installed-container verification fails', () => {
    for (const failedStep of ['install', 'container', 'missing-container']) {
      const f = buildInstallFixture()
      try {
        const result = f.run(failedStep)
        assert.notEqual(result.status, 0, `${failedStep} must fail the helper`)
        assert.equal(result.signal, null, `${failedStep} must exit promptly, not time out`)
        const commands = readFileSync(f.trace, 'utf8').trim().split('\n')
        assert.ok(commands.some(line => line.startsWith('xcrun|simctl install ')))
        assert.ok(!commands.some(line => line.startsWith('xcrun|simctl openurl ') ||
          line.startsWith('xcrun|simctl launch ')),
          'no failure path may launch the app')
      } finally {
        rmSync(f.dir, { recursive: true, force: true })
      }
    }
  })

  it('wires the scheduled and dispatch suite to a pinned, preflighted hosted image', () => {
    assert.ok(workflow.on.schedule?.length > 0, 'nightly schedule must exist')
    assert.ok(workflow.on.workflow_dispatch !== undefined, 'manual proof run must remain available')
    assert.equal(workflow.jobs.maestro['runs-on'], 'macos-15')
    assert.equal(workflow.jobs.maestro['timeout-minutes'], 90)
    assert.equal(workflow.jobs.maestro.strategy['fail-fast'], false)
    assert.equal(workflow.jobs.maestro.strategy.matrix.shard,
      "${{ fromJSON((inputs.flow || 'all') == 'all' && '[0,1]' || '[0]') }}")
    assert.equal(workflow.env.DEVELOPER_DIR, '/Applications/Xcode_16.4.app/Contents/Developer')
    const steps = workflow.jobs.maestro.steps
    const index = name => steps.findIndex(step => step.name === name)
    const preflightStep = steps[index('Preflight Xcode and boot simulator')]
    assert.equal(preflightStep?.run, 'bash scripts/maestro-hosted-preflight.sh')
    assert.ok(index('Preflight Xcode and boot simulator') < index('Install dependencies'))
    assert.ok(index('Install dependencies') < index('Build + install the dev client'))
    assert.equal(steps[index('Build + install the dev client')].run,
      'bash scripts/maestro-build-install-ios.sh packages/app')
    assert.ok(index('Build + install the dev client') < index('Start Metro (background)'))
    assert.ok(index('Start Metro (background)') < index('Warm the iOS Metro bundle'))
    assert.ok(index('Warm the iOS Metro bundle') < index('Run Maestro suite'))
    assert.ok(steps[index('Start Metro (background)')].run.includes('npx expo start --localhost'), 'simulator and warmup must share the verified loopback Metro origin')
    assert.equal(steps[index('Warm the iOS Metro bundle')].run, 'node scripts/maestro-warm-metro.mjs')
    assert.ok(steps[index('Start Metro (background)')].run.includes('exit 1'), 'Metro listening failure must stop the job')
    assert.ok(index('Build + install the dev client') < index('Run Maestro suite'))
    assert.ok(steps[index('Run Maestro suite')].run.includes('run-all-sequential.sh'))
    const dispatch = workflow.on.workflow_dispatch.inputs.flow
    assert.equal(dispatch.default, 'all', 'scheduled and ordinary dispatch runs must keep the full suite')
    assert.deepEqual(dispatch.options, ['all', 'connect-screen.yaml', 'permission-disconnected-noop.yaml'])
    const inventory = yaml.loadAll(readFileSync(join(root, 'packages/app/.maestro/run-all.yaml'), 'utf8'))[1]
      .map(command => command.runFlow)
    assert.ok(inventory.includes('connect-screen.yaml'), 'diagnostic choice must name an inventoried flow')
    assert.ok(inventory.includes('permission-disconnected-noop.yaml'), 'disconnected diagnostic must name an inventoried flow')
    assert.ok(steps[index('Run Maestro suite')].run.includes('--shard-index "${{ strategy.job-index }}" --shard-count "${{ strategy.job-total }}" --max-failures 1'))
    assert.ok(steps[index('Run Maestro suite')].run.includes('--flow connect-screen.yaml'))
    assert.ok(steps[index('Run Maestro suite')].run.includes('--flow permission-disconnected-noop.yaml'))
  })

  it('uploads only this run\'s bounded diagnostics on failure or cancellation', () => {
    const steps = workflow.jobs.maestro.steps
    const run = steps.find(step => step.name === 'Run Maestro suite')
    const upload = steps.find(step => step.name === 'Upload this run\'s Maestro diagnostics')
    assert.equal(run.env.MAESTRO_ARTIFACT_DIR, '${{ runner.temp }}/maestro-diagnostics')
    assert.equal(upload.if, 'failure() || cancelled()')
    assert.equal(upload.with.name, 'maestro-diagnostics-${{ strategy.job-index }}-of-${{ strategy.job-total }}')
    assert.equal(upload.with.path.trim(), [
      '${{ runner.temp }}/maestro-diagnostics/',
      '${{ runner.temp }}/metro.log'
    ].join('\n'))
    assert.equal(upload.with['retention-days'], 7)
    assert.equal(upload.with['if-no-files-found'], 'warn')
  })

  it('bounds the hosted iOS driver startup allowance to the Maestro suite step', () => {
    const job = workflow.jobs.maestro
    const suite = job.steps.find(step => step.name === 'Run Maestro suite')
    assert.equal(suite.env.MAESTRO_DRIVER_STARTUP_TIMEOUT, '180000',
      'the hosted XCTest startup observed just beyond 120s needs Maestro\'s 180s allowance')
    assert.equal(workflow.env.MAESTRO_DRIVER_STARTUP_TIMEOUT, undefined)
    assert.equal(job.env?.MAESTRO_DRIVER_STARTUP_TIMEOUT, undefined)
    for (const step of job.steps.filter(step => step !== suite)) {
      assert.equal(step.env?.MAESTRO_DRIVER_STARTUP_TIMEOUT, undefined,
        `${step.name ?? step.uses} must not inherit the suite startup allowance`)
    }
  })

  it('keeps the disconnected no-op proof before release and handles terminal recovery afterward', () => {
    const commands = flow('permission-disconnected-noop.yaml')
    const tap = commands.findIndex(command => command.tapOn?.id === 'approval-button-approve')
    const release = commands.findIndex(command => command.runScript === 'scripts/release-reconnect-hold.js')
    const connected = commands.findIndex(command => command.extendedWaitUntil?.visible?.text === 'Message Claude...')
    assert.ok(tap >= 0 && tap < release && release < connected)
    assert.equal(commands[tap + 1]?.assertVisible?.id, 'prompt-disconnected-hint',
      'the no-op assertion must immediately follow the disabled tap')
    assert.ok(commands.slice(tap + 1, release).some(command =>
      command.assertVisible?.id === 'approval-button-approve' && command.assertVisible.enabled === false),
    'the option must stay disabled until the hold is released')
    const recovery = commands.slice(release + 1, connected)
    assert.ok(recovery.some(command =>
      command.runFlow?.when?.visible === 'Connection Failed' &&
      command.runFlow.commands?.some(step => step.tapOn === '^Retry$')),
    'the native terminal alert must offer a recovery path after release')
    assert.ok(recovery.some(command =>
      command.runFlow?.when?.visible?.id === 'server-down-reconnect' &&
      command.runFlow.commands?.some(step => step.tapOn?.id === 'server-down-reconnect')),
    'the terminal banner must offer a recovery path after release')
    assert.ok(commands.slice(connected + 1).some(command =>
      command.assertVisible?.id === 'approval-button-approve' && command.assertVisible.enabled === true),
    'the prompt must be answerable once connected')
  })

  it('opens the same Metro dev-client link in connect and session setup', () => {
    const connect = flow('setup/ensure-connect-screen.yaml')
    const session = flow('setup/ensure-session-screen.yaml')
    const encrypted = flow('key-exchange.yaml')
    assert.equal(connect[0], 'stopApp')
    assert.equal(connect[1].setPermissions.permissions.all, 'allow')
    assert.equal(connect[2].openLink, session.find(step => step.openLink).openLink)
    assert.equal(connect[2].openLink, encrypted.find(step => step.openLink).openLink)
    assert.equal(session[0], 'clearState')
    assert.equal(encrypted[0], 'clearState')
    assert.equal(session[1].setPermissions.permissions.all, 'allow')
    assert.equal(encrypted[1].setPermissions.permissions.all, 'allow')
    assert.equal(connect[3].runFlow, 'await-dev-client.yaml')
    assert.equal(session[3].runFlow, 'await-dev-client.yaml')
    assert.equal(encrypted[3].runFlow, 'setup/await-dev-client.yaml')
    assert.equal(session[4].extendedWaitUntil.visible.text, 'Connect to Chroxy|Chat')
    assert.equal(encrypted[4].extendedWaitUntil.visible.text, 'Connect to Chroxy|Chat')
    assert.equal(connect.at(-1).extendedWaitUntil.visible, 'Connect to Chroxy')
  })

  it('waits for late native readiness before dismissing the dev menu', () => {
    const commands = flow('setup/await-dev-client.yaml')
    const lateIntro = [{ at: 0, state: 'loading' }, { at: 40, state: 'intro' }]
    const slowDownload = [{ at: 0, state: 'downloading' }, { at: 38, state: 'connect' }]
    assert.equal(simulateDevClient(commands, lateIntro, 'chat'), 'chat')
    assert.equal(simulateDevClient(commands, slowDownload, 'connect'), 'connect')
    assert.equal(simulateDevClient(commands, [{ at: 0, state: 'onboarding' }], 'connect'), 'connect')
    const firstLink = [{ at: 0, state: 'promptCurly' }, { at: 45, state: 'intro' }]
    const lateLink = [{ at: 0, state: 'loading' }, { at: 35, state: 'promptStraight' },
      { at: 65, state: 'intro' }]
    assert.equal(simulateDevClient(commands, firstLink, 'connect'), 'connect')
    assert.equal(simulateDevClient(commands, lateLink, 'chat'), 'chat')
    assert.equal(simulateDevClient([
      ...commands, ...flow('setup/ensure-connect-screen.yaml').slice(4)
    ], [{ at: 0, state: 'connecting' }], 'connect'), 'connect')
    assert.throws(() => simulateDevClient(commands, [{ at: 0, state: 'loading' }], 'chat'), /readiness timed out/)
    assert.throws(() => simulateDevClient(commands.slice(1),
      [{ at: 0, state: 'loading' }, { at: 40, state: 'promptCurly' }], 'chat'),
    /readiness timed out/)
    assert.throws(() => simulateDevClient(commands.filter(step =>
      step.runFlow?.when?.visible?.text !== '^Open in [“"]Chroxy[”"]\\?$'),
    [{ at: 0, state: 'promptCurly' }], 'chat'), /readiness timed out/)
    assert.throws(() => simulateDevClient([
      { ...commands[0], extendedWaitUntil: { ...commands[0].extendedWaitUntil, timeout: 20 } },
      ...commands.slice(1)
    ], slowDownload, 'connect'), /readiness timed out/)
    assert.throws(() => simulateDevClient(commands.filter(step =>
      step.runFlow?.when?.visible?.text !== '^Continue$'), lateIntro, 'chat'), /readiness timed out/)
  })

  shellIt('runs only an inventoried diagnostic flow and rejects path aliases', () => {
    const f = runnerFixture()
    try {
      const one = f.run(['--flow', 'connect-screen.yaml', '--max-failures', '1'])
      assert.equal(one.status, 0, one.stderr)
      const calls = readFileSync(f.trace, 'utf8').trim().split('\n')
      assert.equal(calls.length, 1)
      assert.ok(calls[0].endsWith('/connect-screen.yaml'))
      rmSync(f.trace)
      const disconnected = f.run(['--flow', 'permission-disconnected-noop.yaml', '--max-failures', '1'])
      assert.equal(disconnected.status, 0, disconnected.stderr)
      const selected = readFileSync(f.trace, 'utf8').trim().split('\n')
      assert.equal(selected.length, 1)
      assert.ok(selected[0].endsWith('/permission-disconnected-noop.yaml'))
      rmSync(f.trace)
      const invalid = f.run(['--flow', '../connect-screen.yaml'])
      assert.equal(invalid.status, 2)
      assert.ok(invalid.stderr.includes('--flow must name a flow in run-all.yaml'))
      assert.equal(existsSync(f.trace), false, 'invalid flow must not start Maestro')
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  shellIt('executes the canonical inventory exactly once across real runner shards', () => {
    const inventoried = yaml.loadAll(readFileSync(join(root, 'packages/app/.maestro/run-all.yaml'), 'utf8'))[1]
      .map(command => command.runFlow)
    assert.deepEqual(inventoried, expectedInventory)
    const f = runnerFixture()
    try {
      const local = f.run([])
      assert.equal(local.status, 0, local.stderr || local.stdout)
      assert.deepEqual(tracedFlows(f.trace), expectedInventory,
        'the local default must still execute the complete canonical inventory')
      rmSync(f.trace)
      for (const count of [2, 3]) {
        const shards = []
        for (let index = 0; index < count; index++) {
          const result = f.run(['--shard-index', String(index), '--shard-count', String(count), '--max-failures', '1'])
          assert.equal(result.status, 0, result.stderr || result.stdout)
          const selected = tracedFlows(f.trace)
          assert.ok(result.stdout.includes(`Inventory: ${expectedInventory.length} flows`))
          assert.ok(result.stdout.includes(`Selection: ${selected.length} flows; shard ${index}/${count}`))
          assert.ok(result.stdout.includes(`All ${selected.length} selected flows passed (shard ${index}/${count} of ${expectedInventory.length} inventoried).`))
          shards.push(selected)
          rmSync(f.trace)
        }
        assertCompletePartition(shards)
        for (let index = 0; index < count; index++) {
          assert.deepEqual(shards[index], expectedInventory.filter((_, position) => position % count === index),
            `shard ${index}/${count} must preserve canonical relative order`)
        }
      }
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  shellIt('rejects invalid or empty shard selection before starting Maestro', () => {
    const f = runnerFixture()
    try {
      for (const [args, diagnostic] of [
        [['--shard-index', '0'], 'must be supplied together'],
        [['--shard-count', '2'], 'must be supplied together'],
        [['--shard-index', '0', '--shard-count', '0'], 'positive decimal integer'],
        [['--shard-index', '-1', '--shard-count', '2'], 'non-negative decimal integer'],
        [['--shard-index', '01', '--shard-count', '2'], 'non-negative decimal integer'],
        [['--shard-index', '2', '--shard-count', '2'], 'less than --shard-count'],
        [['--shard-index', '0', '--shard-count', '27'], 'empty shard'],
        [['--flow', 'connect-screen.yaml', '--shard-index', '0', '--shard-count', '2'], 'cannot be combined']
      ]) {
        const result = f.run(args)
        assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`)
        assert.ok(result.stderr.includes(diagnostic), `${args.join(' ')}: ${result.stderr}`)
        assert.equal(existsSync(f.trace), false, `${args.join(' ')} must not invoke Maestro`)
      }
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  shellIt('stops each failed shard after one failed flow and names the unrun remainder', () => {
    const f = runnerFixture()
    try {
      const result = f.run(['--shard-index', '1', '--shard-count', '2', '--max-failures', '1'],
        { FAKE_MAESTRO_EXIT: '1' })
      assert.equal(result.status, 1, result.stderr)
      assert.deepEqual(tracedFlows(f.trace), ['manual-connect.yaml'])
      assert.ok(result.stdout.includes('Stopping after 1 failed flows; remaining inventory not run.'))
      assert.ok(result.stdout.includes('1 attempted of 13 selected; 12 not run; 26 inventoried; shard 1/2'))
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  shellIt('routes both Maestro output streams into a distinct current-run attempt', () => {
    const f = runnerFixture()
    try {
      const runnerTemp = join(f.dir, 'runner-temp')
      const output = join(runnerTemp, 'maestro-diagnostics')
      const result = f.run(['--flow', 'connect-screen.yaml'], {
        RUNNER_TEMP: runnerTemp, MAESTRO_ARTIFACT_DIR: output
      })
      assert.equal(result.status, 0, result.stderr)
      const attempt = join(output, 'flow-1-attempt-1')
      assert.equal(existsSync(attempt), true)
      const call = readFileSync(f.trace, 'utf8')
      assert.ok(call.includes(`--test-output-dir=${attempt}`))
      assert.ok(call.includes(`--debug-output=${attempt}`))
      assert.equal(call.trim().split('\n').length, 1)

      rmSync(f.trace)
      const broad = f.run(['--flow', 'connect-screen.yaml'], {
        RUNNER_TEMP: runnerTemp, MAESTRO_ARTIFACT_DIR: join(f.dir, '.maestro/tests')
      })
      assert.equal(broad.status, 2)
      assert.ok(broad.stderr.includes('must be this run\'s RUNNER_TEMP/maestro-diagnostics'))
      assert.equal(existsSync(f.trace), false, 'broad path must not start Maestro')
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  shellIt('stops a failing inventory after three flows and reports the unrun remainder', () => {
    const f = runnerFixture()
    try {
      const result = f.run(['--max-failures', '3'], { FAKE_MAESTRO_EXIT: '1' })
      assert.equal(result.status, 1, result.stderr)
      assert.equal(readFileSync(f.trace, 'utf8').trim().split('\n').length, 3)
      assert.ok(result.stdout.includes('Stopping after 3 failed flows; remaining inventory not run.'))
      assert.ok(result.stdout.includes('3 attempted of'))
      assert.ok(result.stdout.includes('not run; 26 inventoried; shard 0/1)'))
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  shellIt('resets only when another attempt or flow will run', () => {
    const f = runnerFixture({ reset: true })
    try {
      const finalFailure = f.run(['--flow', 'connect-screen.yaml', '--max-failures', '1'], {
        FAKE_MAESTRO_EXIT: '1'
      })
      assert.equal(finalFailure.status, 1, finalFailure.stderr)
      assert.equal(existsSync(f.traceFile), false, 'final failure must not reset a simulator no flow will use')
      rmSync(f.trace)

      const recovered = f.run(['--flow', 'connect-screen.yaml', '--retries', '1'], {
        FAKE_MAESTRO_FIRST_FAIL: '1'
      })
      assert.equal(recovered.status, 0, recovered.stderr)
      assert.ok(recovered.stdout.includes('reset bootstatus finished'))
      assert.equal(readFileSync(f.traceFile, 'utf8'), [
        `simctl shutdown ${device}`, `simctl boot ${device}`, `simctl bootstatus ${device} -b`, ''
      ].join('\n'))
      assert.equal(readFileSync(f.trace, 'utf8').trim().split('\n').length, 2)
      rmSync(f.trace)
      rmSync(f.traceFile)

      const nextFlow = f.run(['--max-failures', '2'], { FAKE_MAESTRO_EXIT: '1' })
      assert.equal(nextFlow.status, 1, nextFlow.stderr)
      assert.equal(readFileSync(f.trace, 'utf8').trim().split('\n').length, 2)
      assert.equal(readFileSync(f.traceFile, 'utf8').trim().split('\n').length, 3,
        'reset must run between failed flows, but not after the stop threshold')
      rmSync(f.trace)
      rmSync(f.traceFile)

      const alreadyShutdown = f.run(['--flow', 'connect-screen.yaml', '--retries', '1'], {
        FAKE_MAESTRO_FIRST_FAIL: '1', FAKE_SHUTDOWN_EXIT: '1'
      })
      assert.equal(alreadyShutdown.status, 0, alreadyShutdown.stderr)
      assert.ok(alreadyShutdown.stderr.includes('boot and bootstatus will verify recovery'))
      assert.equal(readFileSync(f.traceFile, 'utf8').trim().split('\n').length, 3)
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  shellIt('reports a stalled or unhealthy simulator reset and stops before retry', () => {
    const f = runnerFixture({ reset: true })
    try {
      const timedOut = f.run(['--flow', 'connect-screen.yaml', '--retries', '1'], {
        FAKE_MAESTRO_FIRST_FAIL: '1', FAKE_BOOTSTATUS_DELAY: '3'
      })
      assert.equal(timedOut.status, 1, timedOut.stderr)
      assert.ok(timedOut.stdout.includes('reset bootstatus started (limit 1s)'))
      assert.ok(timedOut.stderr.includes('reset bootstatus failed (exit 124)'))
      assert.equal(readFileSync(f.trace, 'utf8').trim().split('\n').length, 1)
      rmSync(f.trace)
      rmSync(f.traceFile)

      const shutdownTimeout = f.run(['--flow', 'connect-screen.yaml', '--retries', '1'], {
        FAKE_MAESTRO_FIRST_FAIL: '1', FAKE_SHUTDOWN_DELAY: '3'
      })
      assert.equal(shutdownTimeout.status, 1, shutdownTimeout.stderr)
      assert.ok(shutdownTimeout.stderr.includes('reset shutdown failed (exit 124)'))
      assert.equal(readFileSync(f.traceFile, 'utf8').trim().split('\n').length, 1,
        'a timed-out shutdown must not try to boot')
      rmSync(f.trace)
      rmSync(f.traceFile)

      const unhealthy = f.run(['--flow', 'connect-screen.yaml', '--retries', '1'], {
        FAKE_MAESTRO_FIRST_FAIL: '1', FAKE_BOOTSTATUS_EXIT: '5'
      })
      assert.equal(unhealthy.status, 1, unhealthy.stderr)
      assert.ok(unhealthy.stderr.includes('reset bootstatus failed (exit 5)'))
      assert.equal(readFileSync(f.trace, 'utf8').trim().split('\n').length, 1)
      rmSync(f.trace)

      const unbounded = f.run(['--flow', 'connect-screen.yaml'], { SIM_BOOTSTATUS_TIMEOUT: '9999' })
      assert.equal(unbounded.status, 2)
      assert.ok(unbounded.stderr.includes('reset timeouts must be 1-300 seconds'))
      assert.equal(existsSync(f.trace), false, 'bad reset ceiling must not start Maestro')
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  shellIt('captures all xcodebuild output before parsing its first line', () => {
    const f = fixture()
    try {
      const oldPipeline = spawnSync('bash', ['-c', 'set -o pipefail; xcodebuild -version | head -1'], {
        env: f.env, encoding: 'utf8', timeout: 5000
      })
      assert.notEqual(oldPipeline.status, 0, 'fixture must reproduce the early-close failure')
      assert.equal(oldPipeline.stdout, 'Xcode 16.4\n')
      const repaired = f.run()
      assert.equal(repaired.status, 0, repaired.stderr)
      assert.ok(repaired.stdout.includes('Using Xcode 16.4 and iPhone 16 Pro'))
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  shellIt('exports the exact iOS 18.5 simulator and boots it before a build', () => {
    const f = fixture()
    try {
      const result = f.run()
      assert.equal(result.status, 0, result.stderr)
      assert.equal(readFileSync(f.envFile, 'utf8'), `DEVICE=${device}\n`)
      assert.equal(readFileSync(f.traceFile, 'utf8'), `simctl boot ${device}\nsimctl bootstatus ${device} -b\n`)
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  shellIt('rejects a different Xcode version before selecting a simulator', () => {
    const f = fixture()
    try {
      const result = f.run({ XCODE_VERSION: '27.0' })
      assert.equal(result.status, 1, result.stderr)
      assert.ok(result.stderr.includes('Expected Xcode 16.4, found Xcode 27.0'))
      assert.equal(existsSync(f.envFile), false, 'must not export a simulator on mismatch')
      assert.equal(existsSync(f.traceFile), false, 'must not call simctl on mismatch')
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  shellIt('fails before boot when Simulator.app or Expo LaunchServices lookup is missing', () => {
    const f = fixture()
    try {
      rmSync(join(f.developerDir, 'Applications/Simulator.app'), { recursive: true })
      const missingApp = f.run()
      assert.notEqual(missingApp.status, 0)
      assert.ok(missingApp.stderr.includes('Simulator.app is missing'))
      mkdirSync(join(f.developerDir, 'Applications/Simulator.app'))
      const missingLookup = f.run({ SIMULATOR_ID: 'com.apple.devicehub' })
      assert.notEqual(missingLookup.status, 0)
      assert.ok(missingLookup.stderr.includes('Expo cannot resolve Simulator.app'))
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })

  shellIt('fails when the selected iOS runtime has no available iPhone 16 Pro', () => {
    const f = fixture()
    try {
      writeFileSync(f.devicesFile, JSON.stringify({ devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [{ name: 'iPhone 16 Pro', isAvailable: false, udid: device }]
      } }))
      const result = f.run()
      assert.notEqual(result.status, 0)
      assert.ok(result.stderr.includes('No available iPhone 16 Pro with iOS 18.5'))
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })
})
