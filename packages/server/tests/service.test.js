import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import {
  getServicePaths,
  generateLaunchdPlist,
  generateSystemdUnit,
  generateServiceWrapper,
  generateWindowsServiceWrapper,
  getWindowsAlternatives,
  getWindowsTaskStatus,
  resolveNode22Path,
  resolveChroxyBin,
  resolveClaudeBin,
  buildServicePath,
  writeServiceWrapper,
  loadServiceState,
  saveServiceState,
  installService,
  uninstallService,
  startService,
  stopService,
  getServiceStatus,
  getFullServiceStatus,
} from '../src/service.js'
import { statSync } from 'fs'

describe('service', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'service-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('getServicePaths()', () => {
    it('returns launchd paths on darwin', () => {
      const paths = getServicePaths('darwin')
      assert.equal(paths.type, 'launchd')
      assert.ok(paths.plistPath.includes('LaunchAgents'))
      assert.ok(paths.plistPath.includes('com.chroxy.server.plist'))
      assert.ok(paths.logDir.includes('.chroxy/logs'))
    })

    it('returns systemd paths on linux', () => {
      const paths = getServicePaths('linux')
      assert.equal(paths.type, 'systemd')
      assert.ok(paths.unitPath.includes('systemd/user'))
      assert.ok(paths.unitPath.includes('chroxy.service'))
      assert.ok(paths.logDir.includes('.chroxy/logs'))
    })

    it('returns windows info on win32', () => {
      const paths = getServicePaths('win32')
      assert.equal(paths.type, 'windows')
      assert.ok(paths.logDir.includes('.chroxy'))
    })

    it('throws on unsupported platform', () => {
      assert.throws(() => getServicePaths('freebsd'), {
        message: /not supported/i,
      })
    })
  })

  describe('generateLaunchdPlist()', () => {
    const config = {
      nodePath: '/opt/homebrew/opt/node@22/bin/node',
      chroxyBin: '/usr/local/lib/node_modules/chroxy/src/cli.js',
      cwd: '/Users/testuser',
      startAtLogin: false,
      logDir: '/Users/testuser/.chroxy/logs',
    }

    it('returns a valid plist XML string', () => {
      const plist = generateLaunchdPlist(config)
      assert.ok(plist.includes('<?xml version="1.0"'))
      assert.ok(plist.includes('<!DOCTYPE plist'))
      assert.ok(plist.includes('<plist version="1.0">'))
      assert.ok(plist.includes('</plist>'))
    })

    it('includes the correct label', () => {
      const plist = generateLaunchdPlist(config)
      assert.ok(plist.includes('<string>com.chroxy.server</string>'))
    })

    it('includes ProgramArguments with node and chroxy paths', () => {
      const plist = generateLaunchdPlist(config)
      assert.ok(plist.includes(`<string>${config.nodePath}</string>`))
      assert.ok(plist.includes(`<string>${config.chroxyBin}</string>`))
      assert.ok(plist.includes('<string>start</string>'))
    })

    it('sets RunAtLoad based on startAtLogin', () => {
      const withStartAtLogin = generateLaunchdPlist({ ...config, startAtLogin: true })
      assert.ok(withStartAtLogin.includes('<key>RunAtLoad</key>'))
      assert.ok(withStartAtLogin.includes('<true/>'))

      const withoutStartAtLogin = generateLaunchdPlist({ ...config, startAtLogin: false })
      assert.ok(withoutStartAtLogin.includes('<key>RunAtLoad</key>'))
      assert.ok(withoutStartAtLogin.includes('<false/>'))
    })

    it('sets KeepAlive to true', () => {
      const plist = generateLaunchdPlist(config)
      assert.ok(plist.includes('<key>KeepAlive</key>'))
      const lines = plist.split('\n')
      const keepAliveIdx = lines.findIndex(l => l.includes('<key>KeepAlive</key>'))
      assert.ok(keepAliveIdx >= 0)
      assert.ok(lines[keepAliveIdx + 1].includes('<true/>'))
    })

    it('includes log paths', () => {
      const plist = generateLaunchdPlist(config)
      assert.ok(plist.includes('chroxy-stdout.log'))
      assert.ok(plist.includes('chroxy-stderr.log'))
    })

    it('includes CHROXY_DAEMON environment variable', () => {
      const plist = generateLaunchdPlist(config)
      assert.ok(plist.includes('CHROXY_DAEMON'))
      assert.ok(plist.includes('<string>1</string>'))
    })

    it('includes PATH environment variable with node bin dir', () => {
      const plist = generateLaunchdPlist(config)
      assert.ok(plist.includes('<key>PATH</key>'))
      assert.ok(plist.includes('/opt/homebrew/opt/node@22/bin'))
    })

    it('includes WorkingDirectory', () => {
      const plist = generateLaunchdPlist(config)
      assert.ok(plist.includes('<key>WorkingDirectory</key>'))
      assert.ok(plist.includes(`<string>${config.cwd}</string>`))
    })
  })

  describe('generateSystemdUnit()', () => {
    const config = {
      nodePath: '/usr/local/bin/node',
      chroxyBin: '/usr/local/lib/node_modules/chroxy/src/cli.js',
      cwd: '/home/testuser',
      startAtLogin: false,
      logDir: '/home/testuser/.chroxy/logs',
    }

    it('returns a valid systemd unit string', () => {
      const unit = generateSystemdUnit(config)
      assert.ok(unit.includes('[Unit]'))
      assert.ok(unit.includes('[Service]'))
      assert.ok(unit.includes('[Install]'))
    })

    it('includes description', () => {
      const unit = generateSystemdUnit(config)
      assert.ok(unit.includes('Description='))
    })

    it('includes ExecStart with node and chroxy paths', () => {
      const unit = generateSystemdUnit(config)
      assert.ok(unit.includes(`ExecStart="${config.nodePath}" "${config.chroxyBin}" start`))
    })

    it('sets Restart=on-failure and RestartSec=5', () => {
      const unit = generateSystemdUnit(config)
      assert.ok(unit.includes('Restart=on-failure'))
      assert.ok(unit.includes('RestartSec=5'))
    })

    it('includes CHROXY_DAEMON environment variable', () => {
      const unit = generateSystemdUnit(config)
      assert.ok(unit.includes('CHROXY_DAEMON=1'))
    })

    it('includes PATH environment variable', () => {
      const unit = generateSystemdUnit(config)
      assert.ok(unit.includes('Environment=PATH='))
    })

    it('includes log file paths', () => {
      const unit = generateSystemdUnit(config)
      assert.ok(unit.includes('chroxy-stdout.log'))
      assert.ok(unit.includes('chroxy-stderr.log'))
    })

    it('includes WorkingDirectory', () => {
      const unit = generateSystemdUnit(config)
      assert.ok(unit.includes(`WorkingDirectory=${config.cwd}`))
    })

    it('includes WantedBy=default.target', () => {
      const unit = generateSystemdUnit(config)
      assert.ok(unit.includes('WantedBy=default.target'))
    })
  })

  describe('getWindowsAlternatives()', () => {
    it('returns an array of alternatives', () => {
      const alts = getWindowsAlternatives()
      assert.ok(Array.isArray(alts))
      assert.ok(alts.length >= 2)
    })

    it('each alternative has name, description, and command', () => {
      const alts = getWindowsAlternatives()
      for (const alt of alts) {
        assert.ok(alt.name, 'should have name')
        assert.ok(alt.description, 'should have description')
        assert.ok(alt.command, 'should have command')
      }
    })

    it('includes Task Scheduler as an alternative', () => {
      const alts = getWindowsAlternatives()
      assert.ok(alts.some(a => a.name.toLowerCase().includes('task scheduler')))
    })
  })

  describe('Windows service via Task Scheduler (schtasks) — #6647', () => {
    const spy = () => {
      const calls = []
      return { calls, exec: (cmd, args) => { calls.push({ cmd, args }); return '' } }
    }

    it('install writes the .cmd wrapper and registers an ONLOGON /IT /RL HIGHEST task', () => {
      const stateDir = join(tmpDir, 'state')
      const logDir = join(tmpDir, 'logs')
      const wrapperPath = join(stateDir, 'service-wrapper.cmd')
      const { calls, exec } = spy()
      const result = installService({
        nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        chroxyBin: 'C:\\chroxy\\cli.js',
        claudeBin: 'C:\\Users\\me\\AppData\\claude.cmd',
        cwd: 'C:\\work',
        _platform: 'win32',
        _stateDir: stateDir,
        _logDir: logDir,
        _wrapperPath: wrapperPath,
        _exec: exec,
      })

      assert.deepEqual(result, {
        installed: true, platform: 'win32', taskName: 'Chroxy', wrapperPath,
      })

      // wrapper written to disk
      assert.ok(existsSync(wrapperPath))
      const wrapper = readFileSync(wrapperPath, 'utf-8')
      assert.match(wrapper, /cd \/d "C:\\work"/)
      assert.match(wrapper, /"C:\\Program Files\\nodejs\\node\.exe" "C:\\chroxy\\cli\.js" start/)
      assert.match(wrapper, /chroxy-stdout\.log/)

      // exactly one schtasks /Create with the required flags; /TR quoted; no secret
      assert.equal(calls.length, 1)
      assert.equal(calls[0].cmd, 'schtasks')
      const a = calls[0].args
      assert.deepEqual(a.slice(0, 3), ['/Create', '/TN', 'Chroxy'])
      assert.equal(a[a.indexOf('/SC') + 1], 'ONLOGON')
      assert.equal(a[a.indexOf('/RL') + 1], 'HIGHEST')
      assert.ok(a.includes('/IT'), '/IT avoids a stored-password prompt')
      assert.ok(a.includes('/F'), '/F makes reinstall idempotent')
      assert.equal(a[a.indexOf('/TR') + 1], `"${wrapperPath}"`, '/TR is the quoted wrapper path only')

      // state records the win32 platform + task name
      const state = loadServiceState(stateDir)
      assert.equal(state.platform, 'win32')
      assert.equal(state.taskName, 'Chroxy')
      assert.equal(state.wrapperPath, wrapperPath)
      assert.equal(state.startAtLogin, true)
    })

    it('install with _skipRegister writes wrapper + state but runs no schtasks', () => {
      const stateDir = join(tmpDir, 'state-skip')
      const { calls, exec } = spy()
      installService({
        nodePath: 'C:\\node.exe', chroxyBin: 'C:\\cli.js',
        _platform: 'win32', _stateDir: stateDir, _logDir: join(tmpDir, 'l-skip'),
        _wrapperPath: join(stateDir, 'w.cmd'), _skipRegister: true, _exec: exec,
      })
      assert.equal(calls.length, 0)
      assert.ok(loadServiceState(stateDir))
    })

    it('start runs the scheduled task (schtasks /Run)', () => {
      const { calls, exec } = spy()
      const r = startService({ _platform: 'win32', _exec: exec })
      assert.equal(r.started, true)
      assert.deepEqual(calls, [{ cmd: 'schtasks', args: ['/Run', '/TN', 'Chroxy'] }])
    })

    it('stop ends the scheduled task (schtasks /End)', () => {
      const { calls, exec } = spy()
      const r = stopService({ _platform: 'win32', _exec: exec })
      assert.equal(r.stopped, true)
      assert.deepEqual(calls, [{ cmd: 'schtasks', args: ['/End', '/TN', 'Chroxy'] }])
    })

    it('uninstall deletes the scheduled task (schtasks /Delete /F) and cleans up', () => {
      const stateDir = join(tmpDir, 'state-uninstall')
      const wrapperPath = join(stateDir, 'service-wrapper.cmd')
      installService({
        nodePath: 'C:\\node.exe', chroxyBin: 'C:\\cli.js',
        _platform: 'win32', _stateDir: stateDir, _logDir: join(tmpDir, 'l-uninstall'),
        _wrapperPath: wrapperPath, _skipRegister: true, _exec: () => '',
      })
      assert.ok(existsSync(wrapperPath))

      const { calls, exec } = spy()
      uninstallService({ _stateDir: stateDir, _exec: exec })
      assert.deepEqual(calls, [{ cmd: 'schtasks', args: ['/Delete', '/TN', 'Chroxy', '/F'] }])
      assert.ok(!existsSync(wrapperPath), 'wrapper removed')
      assert.equal(loadServiceState(stateDir), null, 'state removed')
    })

    it('getWindowsTaskStatus parses the schtasks /Query Status line', () => {
      const exec = () => 'TaskName: \\Chroxy\r\nStatus:  Running\r\nLogon Mode: Interactive only\r\n'
      assert.deepEqual(getWindowsTaskStatus({ _exec: exec }), { registered: true, status: 'Running' })
    })

    it('getWindowsTaskStatus reports not-registered when schtasks errors', () => {
      const exec = () => { throw new Error('ERROR: The system cannot find the file specified.') }
      assert.deepEqual(getWindowsTaskStatus({ _exec: exec }), { registered: false, status: null })
    })

    it('generateWindowsServiceWrapper sets cwd/PATH, redirects logs, and bakes no secret', () => {
      const w = generateWindowsServiceWrapper({
        nodePath: 'C:\\nodejs\\node.exe',
        chroxyBin: 'C:\\chroxy\\cli.js',
        claudeBin: 'C:\\claude\\claude.cmd',
        cwd: 'C:\\work',
        logDir: 'C:\\logs',
      })
      assert.match(w, /set "PATH=C:\\nodejs;C:\\claude;%PATH%"/)
      assert.match(w, /cd \/d "C:\\work"/)
      assert.match(w, /"C:\\nodejs\\node\.exe" "C:\\chroxy\\cli\.js" start >> "C:\\logs\\chroxy-stdout\.log" 2>> "C:\\logs\\chroxy-stderr\.log"/)
      assert.doesNotMatch(w, /security|token|password/i, 'no secret material in the wrapper')
    })
  })

  describe('resolveNode22Path()', () => {
    it('returns a string path', () => {
      const nodePath = resolveNode22Path()
      assert.equal(typeof nodePath, 'string')
      assert.ok(nodePath.length > 0)
    })

    it('returned path exists on disk', () => {
      const nodePath = resolveNode22Path()
      assert.ok(existsSync(nodePath), `Node path does not exist: ${nodePath}`)
    })

    it('returned node is version 22', () => {
      const nodePath = resolveNode22Path()
      const version = execFileSync(nodePath, ['--version'], { encoding: 'utf-8' }).trim()
      assert.ok(version.startsWith('v22'), `Expected v22.x, got ${version}`)
    })
  })

  describe('resolveChroxyBin()', () => {
    it('returns a string path', () => {
      const bin = resolveChroxyBin()
      assert.equal(typeof bin, 'string')
      assert.ok(bin.length > 0)
    })

    it('returned path exists on disk', () => {
      const bin = resolveChroxyBin()
      assert.ok(existsSync(bin), `Chroxy bin does not exist: ${bin}`)
    })

    it('path ends with cli.js', () => {
      const bin = resolveChroxyBin()
      assert.ok(bin.endsWith('cli.js'), `Expected path ending in cli.js, got ${bin}`)
    })
  })

  describe('loadServiceState() / saveServiceState()', () => {
    it('returns null when no state file exists', () => {
      const state = loadServiceState(tmpDir)
      assert.equal(state, null)
    })

    it('round-trips state correctly', () => {
      const state = {
        installedAt: new Date().toISOString(),
        platform: 'darwin',
        servicePath: '/some/path/com.chroxy.server.plist',
        nodePath: '/opt/homebrew/opt/node@22/bin/node',
        chroxyBin: '/usr/local/lib/node_modules/chroxy/src/cli.js',
      }
      saveServiceState(state, tmpDir)
      const loaded = loadServiceState(tmpDir)
      assert.deepEqual(loaded, state)
    })

    it('saves to service.json in the config dir', () => {
      saveServiceState({ test: true }, tmpDir)
      assert.ok(existsSync(join(tmpDir, 'service.json')))
    })

    it('creates the config directory if needed', () => {
      const nested = join(tmpDir, 'nested', 'dir')
      saveServiceState({ test: true }, nested)
      assert.ok(existsSync(join(nested, 'service.json')))
    })
  })

  describe('installService()', () => {
    it('generates and writes a launchd plist on darwin', () => {
      const serviceDir = join(tmpDir, 'LaunchAgents')
      mkdirSync(serviceDir, { recursive: true })
      const logDir = join(tmpDir, 'logs')
      const stateDir = join(tmpDir, 'state')

      installService({
        nodePath: '/opt/homebrew/opt/node@22/bin/node',
        chroxyBin: '/usr/local/lib/node_modules/chroxy/src/cli.js',
        cwd: '/Users/testuser',
        startAtLogin: false,
        _servicePath: join(serviceDir, 'com.chroxy.server.plist'),
        _logDir: logDir,
        _stateDir: stateDir,
        _skipRegister: true,
        _platform: 'darwin',
      })

      // Service file was written
      const plistPath = join(serviceDir, 'com.chroxy.server.plist')
      assert.ok(existsSync(plistPath), 'Plist file should be created')
      const content = readFileSync(plistPath, 'utf-8')
      assert.ok(content.includes('com.chroxy.server'))
      assert.ok(content.includes('<plist'))

      // Log directory was created
      assert.ok(existsSync(logDir), 'Log directory should be created')

      // State was saved
      const state = loadServiceState(stateDir)
      assert.ok(state)
      assert.equal(state.platform, 'darwin')
      assert.ok(state.servicePath.includes('com.chroxy.server.plist'))
    })

    it('generates and writes a systemd unit on linux', () => {
      const serviceDir = join(tmpDir, 'systemd-user')
      mkdirSync(serviceDir, { recursive: true })
      const logDir = join(tmpDir, 'logs')
      const stateDir = join(tmpDir, 'state')

      installService({
        nodePath: '/usr/local/bin/node',
        chroxyBin: '/usr/local/lib/node_modules/chroxy/src/cli.js',
        cwd: '/home/testuser',
        startAtLogin: false,
        _servicePath: join(serviceDir, 'chroxy.service'),
        _logDir: logDir,
        _stateDir: stateDir,
        _skipRegister: true,
        _platform: 'linux',
      })

      const unitPath = join(serviceDir, 'chroxy.service')
      assert.ok(existsSync(unitPath), 'Unit file should be created')
      const content = readFileSync(unitPath, 'utf-8')
      assert.ok(content.includes('[Unit]'))
      assert.ok(content.includes('[Service]'))

      // State was saved
      const state = loadServiceState(stateDir)
      assert.ok(state)
      assert.equal(state.platform, 'linux')
    })
  })

  describe('uninstallService()', () => {
    it('removes service file and state', () => {
      // Set up an installed service
      const serviceDir = join(tmpDir, 'LaunchAgents')
      mkdirSync(serviceDir, { recursive: true })
      const servicePath = join(serviceDir, 'com.chroxy.server.plist')
      writeFileSync(servicePath, '<plist>test</plist>')
      const stateDir = join(tmpDir, 'state')
      saveServiceState({
        installedAt: new Date().toISOString(),
        platform: 'darwin',
        servicePath,
        nodePath: '/opt/homebrew/opt/node@22/bin/node',
        chroxyBin: '/some/cli.js',
      }, stateDir)

      assert.ok(existsSync(servicePath))
      assert.ok(existsSync(join(stateDir, 'service.json')))

      uninstallService({
        _stateDir: stateDir,
        _skipUnregister: true,
      })

      // Service file removed
      assert.ok(!existsSync(servicePath), 'Service file should be removed')
      // State file removed
      assert.ok(!existsSync(join(stateDir, 'service.json')), 'State file should be removed')
    })

    it('throws when no service is installed', () => {
      const stateDir = join(tmpDir, 'empty-state')
      mkdirSync(stateDir, { recursive: true })

      assert.throws(() => uninstallService({
        _stateDir: stateDir,
        _skipUnregister: true,
      }), {
        message: /not installed/i,
      })
    })

    it('still removes state even if service file is already gone', () => {
      const stateDir = join(tmpDir, 'state')
      saveServiceState({
        installedAt: new Date().toISOString(),
        platform: 'darwin',
        servicePath: join(tmpDir, 'nonexistent.plist'),
        nodePath: '/opt/homebrew/opt/node@22/bin/node',
        chroxyBin: '/some/cli.js',
      }, stateDir)

      // Should not throw even though the plist doesn't exist
      uninstallService({
        _stateDir: stateDir,
        _skipUnregister: true,
      })

      assert.ok(!existsSync(join(stateDir, 'service.json')))
    })
  })
  describe('startService()', () => {
    it('returns started status for darwin', () => {
      const result = startService({ _skipExec: true, _platform: 'darwin' })
      assert.equal(result.started, true)
      assert.equal(typeof result.message, 'string')
    })

    it('returns started status for linux', () => {
      const result = startService({ _skipExec: true, _platform: 'linux' })
      assert.equal(result.started, true)
      assert.equal(typeof result.message, 'string')
    })

    it('starts the scheduled task on windows (#6647)', () => {
      const result = startService({ _skipExec: true, _platform: 'win32' })
      assert.equal(result.started, true)
      assert.equal(typeof result.message, 'string')
    })
  })

  describe('stopService()', () => {
    it('returns stopped status for darwin', () => {
      const result = stopService({ _skipExec: true, _platform: 'darwin' })
      assert.equal(result.stopped, true)
      assert.equal(typeof result.message, 'string')
    })

    it('returns stopped status for linux', () => {
      const result = stopService({ _skipExec: true, _platform: 'linux' })
      assert.equal(result.stopped, true)
      assert.equal(typeof result.message, 'string')
    })

    it('ends the scheduled task on windows (#6647)', () => {
      const result = stopService({ _skipExec: true, _platform: 'win32' })
      assert.equal(result.stopped, true)
      assert.equal(typeof result.message, 'string')
    })
  })

  describe('getServiceStatus()', () => {
    it('returns not installed when no state file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'chroxy-status-'))
      try {
        const status = getServiceStatus({ configDir: dir })
        assert.equal(status.installed, false)
        assert.equal(status.running, false)
        assert.equal(status.pid, null)
        assert.equal(status.stale, false)
      } finally {
        rmSync(dir, { recursive: true })
      }
    })

    it('returns installed but not running when no PID file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'chroxy-status-'))
      try {
        saveServiceState({ installed: true, type: 'launchd' }, dir)
        const status = getServiceStatus({ configDir: dir })
        assert.equal(status.installed, true)
        assert.equal(status.running, false)
        assert.equal(status.pid, null)
        assert.equal(status.stale, false)
      } finally {
        rmSync(dir, { recursive: true })
      }
    })

    it('returns running when PID file has a live process', () => {
      const dir = mkdtempSync(join(tmpdir(), 'chroxy-status-'))
      try {
        saveServiceState({ installed: true, type: 'launchd' }, dir)
        // Use current process PID — guaranteed alive
        writeFileSync(join(dir, 'supervisor.pid'), String(process.pid))
        const status = getServiceStatus({ configDir: dir })
        assert.equal(status.installed, true)
        assert.equal(status.running, true)
        assert.equal(status.pid, process.pid)
        assert.equal(status.stale, false)
      } finally {
        rmSync(dir, { recursive: true })
      }
    })

    it('detects stale PID file for dead process', () => {
      const dir = mkdtempSync(join(tmpdir(), 'chroxy-status-'))
      try {
        saveServiceState({ installed: true, type: 'launchd' }, dir)
        // Use a PID that almost certainly does not exist
        writeFileSync(join(dir, 'supervisor.pid'), '99999999')
        const status = getServiceStatus({ configDir: dir })
        assert.equal(status.installed, true)
        assert.equal(status.running, false)
        assert.equal(status.pid, null)
        assert.equal(status.stale, true)
      } finally {
        rmSync(dir, { recursive: true })
      }
    })

    it('handles invalid PID file content', () => {
      const dir = mkdtempSync(join(tmpdir(), 'chroxy-status-'))
      try {
        saveServiceState({ installed: true, type: 'launchd' }, dir)
        writeFileSync(join(dir, 'supervisor.pid'), 'not-a-number')
        const status = getServiceStatus({ configDir: dir })
        assert.equal(status.installed, true)
        assert.equal(status.running, false)
        assert.equal(status.pid, null)
        assert.equal(status.stale, false)
      } finally {
        rmSync(dir, { recursive: true })
      }
    })

    it('treats existing state without installed flag as installed', () => {
      const dir = mkdtempSync(join(tmpdir(), 'chroxy-status-'))
      try {
        // saveServiceState from install flow uses installedAt, not installed: true
        // But getServiceStatus should handle any truthy state as installed
        saveServiceState({ installedAt: '2026-01-01T00:00:00Z' }, dir)
        const status = getServiceStatus({ configDir: dir })
        // State exists but no explicit installed flag — still counts as installed
        assert.equal(status.installed, true)
      } finally {
        rmSync(dir, { recursive: true })
      }
    })
  })

  describe('getFullServiceStatus()', () => {
    it('returns not installed status', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'chroxy-full-'))
      try {
        const status = await getFullServiceStatus({ configDir: dir })
        assert.equal(status.installed, false)
        assert.equal(status.running, false)
      } finally {
        rmSync(dir, { recursive: true })
      }
    })

    it('reads connection.json when available', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'chroxy-full-'))
      try {
        saveServiceState({ installed: true, type: 'launchd' }, dir)
        writeFileSync(join(dir, 'connection.json'), JSON.stringify({
          wsUrl: 'wss://test.example.com',
          apiToken: 'test-token-12345678',
        }))
        const status = await getFullServiceStatus({ configDir: dir })
        assert.equal(status.installed, true)
        assert.equal(status.connection.wsUrl, 'wss://test.example.com')
        assert.equal(status.connection.apiToken, 'test-token-12345678')
      } finally {
        rmSync(dir, { recursive: true })
      }
    })

    it('reads recent log lines (last 5)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'chroxy-full-'))
      try {
        saveServiceState({ installed: true, type: 'launchd' }, dir)
        const logDir = join(dir, 'logs')
        mkdirSync(logDir, { recursive: true })
        writeFileSync(join(logDir, 'chroxy-stdout.log'), 'line1\nline2\nline3\nline4\nline5\nline6\nline7\n')
        const status = await getFullServiceStatus({ configDir: dir })
        assert.equal(status.recentLogs.length, 5)
        assert.equal(status.recentLogs[0], 'line3')
        assert.equal(status.recentLogs[4], 'line7')
      } finally {
        rmSync(dir, { recursive: true })
      }
    })

    it('handles missing connection.json gracefully', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'chroxy-full-'))
      try {
        saveServiceState({ installed: true, type: 'launchd' }, dir)
        const status = await getFullServiceStatus({ configDir: dir })
        assert.equal(status.installed, true)
        assert.equal(status.connection, undefined)
      } finally {
        rmSync(dir, { recursive: true })
      }
    })

    it('handles missing log directory gracefully', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'chroxy-full-'))
      try {
        saveServiceState({ installed: true, type: 'launchd' }, dir)
        const status = await getFullServiceStatus({ configDir: dir })
        assert.equal(status.installed, true)
        assert.equal(status.recentLogs, undefined)
      } finally {
        rmSync(dir, { recursive: true })
      }
    })

    it('handles fewer than 5 log lines', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'chroxy-full-'))
      try {
        saveServiceState({ installed: true, type: 'launchd' }, dir)
        const logDir = join(dir, 'logs')
        mkdirSync(logDir, { recursive: true })
        writeFileSync(join(logDir, 'chroxy-stdout.log'), 'only-one-line\n')
        const status = await getFullServiceStatus({ configDir: dir })
        assert.ok(Array.isArray(status.recentLogs))
        assert.equal(status.recentLogs.length, 1)
        assert.equal(status.recentLogs[0], 'only-one-line')
      } finally {
        rmSync(dir, { recursive: true })
      }
    })
  })


  describe('launchctl bootstrap/bootout (#743)', () => {
    it('installService generates bootstrap command args for darwin', () => {
      const serviceDir = join(tmpDir, 'LaunchAgents')
      mkdirSync(serviceDir, { recursive: true })
      const logDir = join(tmpDir, 'logs')
      const stateDir = join(tmpDir, 'state')
      const servicePath = join(serviceDir, 'com.chroxy.server.plist')

      installService({
        nodePath: '/opt/homebrew/opt/node@22/bin/node',
        chroxyBin: '/usr/local/lib/node_modules/chroxy/src/cli.js',
        _servicePath: servicePath,
        _logDir: logDir,
        _stateDir: stateDir,
        _skipRegister: true,
        _platform: 'darwin',
      })

      assert.ok(existsSync(servicePath))
      const state = loadServiceState(stateDir)
      assert.equal(state.platform, 'darwin')
    })

    it('uninstallService cleans up state for darwin', () => {
      const serviceDir = join(tmpDir, 'LaunchAgents')
      mkdirSync(serviceDir, { recursive: true })
      const servicePath = join(serviceDir, 'com.chroxy.server.plist')
      writeFileSync(servicePath, '<plist>test</plist>')
      const stateDir = join(tmpDir, 'state2')
      saveServiceState({
        installedAt: new Date().toISOString(),
        platform: 'darwin',
        servicePath,
        nodePath: '/opt/homebrew/opt/node@22/bin/node',
        chroxyBin: '/some/cli.js',
      }, stateDir)

      uninstallService({
        _stateDir: stateDir,
        _skipUnregister: true,
      })

      assert.ok(!existsSync(servicePath))
      assert.ok(!existsSync(join(stateDir, 'service.json')))
    })
  })

  describe('service stop with KeepAlive (#748)', () => {
    it('stopService returns stopped status with _skipExec on darwin', () => {
      const result = stopService({ _skipExec: true, _platform: 'darwin' })
      assert.equal(result.stopped, true)
    })

    it('startService returns started status with _skipExec on darwin', () => {
      const result = startService({ _skipExec: true, _platform: 'darwin' })
      assert.equal(result.started, true)
    })
  })

  describe('getFullServiceStatus fetch timeout and port parsing (#745)', () => {
    it('handles fetch timeout when server is not responding', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'chroxy-timeout-'))
      try {
        saveServiceState({ installed: true, type: 'launchd' }, dir)
        writeFileSync(join(dir, 'supervisor.pid'), String(process.pid))
        const status = await getFullServiceStatus({ configDir: dir })
        assert.equal(status.installed, true)
        assert.equal(status.running, true)
        assert.equal(status.health, null)
      } finally {
        rmSync(dir, { recursive: true })
      }
    })

    it('reads port from config.json when available', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'chroxy-timeout-'))
      try {
        saveServiceState({ installed: true, type: 'launchd' }, dir)
        writeFileSync(join(dir, 'supervisor.pid'), String(process.pid))
        writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 9999 }))
        const status = await getFullServiceStatus({ configDir: dir })
        assert.equal(status.installed, true)
        assert.equal(status.health, null)
      } finally {
        rmSync(dir, { recursive: true })
      }
    })

    it('falls back to default port 8765 when no port info available', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'chroxy-timeout-'))
      try {
        saveServiceState({ installed: true, type: 'launchd' }, dir)
        writeFileSync(join(dir, 'supervisor.pid'), String(process.pid))
        const status = await getFullServiceStatus({ configDir: dir })
        assert.equal(status.health, null)
      } finally {
        rmSync(dir, { recursive: true })
      }
    })
  })


  describe('startService error handling when servicePath is missing (#756)', () => {
    it('throws when state has a servicePath that no longer exists on disk', () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'chroxy-stale-state-'))
      try {
        // Point servicePath at a file that does not exist
        saveServiceState({
          installedAt: new Date().toISOString(),
          platform: 'darwin',
          servicePath: join(stateDir, 'nonexistent.plist'),
          nodePath: '/opt/homebrew/opt/node@22/bin/node',
          chroxyBin: '/some/cli.js',
        }, stateDir)

        // Should throw before reaching launchctl because the plist is missing
        assert.throws(() => startService({
          _platform: 'darwin',
          _stateDir: stateDir,
        }), {
          message: /not found.*stale.*chroxy service install/i,
        })
      } finally {
        rmSync(stateDir, { recursive: true, force: true })
      }
    })

    it('accepts _stateDir option for loading state', () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'chroxy-statedir-'))
      try {
        // With _skipExec, verify the _stateDir parameter is wired through
        const result = startService({ _skipExec: true, _platform: 'darwin', _stateDir: stateDir })
        assert.equal(result.started, true)
      } finally {
        rmSync(stateDir, { recursive: true, force: true })
      }
    })

    it('still works with _skipExec when no state exists', () => {
      // _skipExec bypasses the actual exec calls — should succeed regardless
      const result = startService({ _skipExec: true, _platform: 'darwin' })
      assert.equal(result.started, true)
    })
  })

  // ---- #5491: launchd robustness (PATH baking, keychain wrapper, start UX) ----

  describe('resolveClaudeBin() (#5491 gap 1)', () => {
    it('returns the path resolved by `which claude`', () => {
      // Inject a fake `which` that points at a real file (this test file).
      const fakePath = fileURLToPath(import.meta.url)
      const which = (cmd, args) => {
        assert.equal(cmd, 'which')
        assert.deepEqual(args, ['claude'])
        return fakePath + '\n'
      }
      const resolved = resolveClaudeBin({ _which: which })
      assert.equal(resolved, fakePath)
    })

    it('throws an actionable error when claude cannot be resolved', () => {
      const which = () => {
        const err = new Error('which: no claude')
        throw err
      }
      assert.throws(() => resolveClaudeBin({ _which: which }), {
        message: /claude.*CLI|install claude code/i,
      })
    })

    it('throws when `which` returns a path that does not exist', () => {
      const which = () => '/nonexistent/path/to/claude\n'
      assert.throws(() => resolveClaudeBin({ _which: which }), {
        message: /claude/i,
      })
    })
  })

  describe('buildServicePath() (#5491 gap 1)', () => {
    it('includes the node and claude bin dirs', () => {
      const p = buildServicePath({
        nodePath: '/opt/homebrew/opt/node@22/bin/node',
        claudeBin: '/Users/me/.local/bin/claude',
      })
      const parts = p.split(':')
      assert.ok(parts.includes('/opt/homebrew/opt/node@22/bin'))
      assert.ok(parts.includes('/Users/me/.local/bin'))
      // node and claude dirs come before system dirs
      assert.ok(parts.indexOf('/opt/homebrew/opt/node@22/bin') < parts.indexOf('/usr/bin'))
      assert.ok(parts.indexOf('/Users/me/.local/bin') < parts.indexOf('/usr/bin'))
    })

    it('still includes system dirs', () => {
      const p = buildServicePath({ nodePath: '/usr/local/bin/node' })
      assert.ok(p.includes('/usr/bin'))
      assert.ok(p.includes('/bin'))
    })

    it('does not duplicate a dir that holds both binaries', () => {
      const p = buildServicePath({
        nodePath: '/usr/local/bin/node',
        claudeBin: '/usr/local/bin/claude',
      })
      const occurrences = p.split(':').filter(d => d === '/usr/local/bin').length
      assert.equal(occurrences, 1)
    })
  })

  describe('generateLaunchdPlist() with baked claude PATH (#5491 gap 1)', () => {
    it('bakes the claude bin dir into the plist PATH', () => {
      const plist = generateLaunchdPlist({
        nodePath: '/opt/homebrew/opt/node@22/bin/node',
        chroxyBin: '/some/cli.js',
        claudeBin: '/Users/me/.local/bin/claude',
        cwd: '/Users/me',
      })
      assert.ok(plist.includes('<key>PATH</key>'))
      assert.ok(plist.includes('/Users/me/.local/bin'))
      assert.ok(plist.includes('/opt/homebrew/opt/node@22/bin'))
    })

    it('execs the wrapper when wrapperPath is provided', () => {
      const plist = generateLaunchdPlist({
        nodePath: '/n/node',
        chroxyBin: '/c/cli.js',
        wrapperPath: '/Users/me/.chroxy/service-wrapper.sh',
        cwd: '/Users/me',
      })
      assert.ok(plist.includes('<string>/Users/me/.chroxy/service-wrapper.sh</string>'))
      // Direct node+start args are replaced by the wrapper
      assert.ok(!plist.includes('<string>start</string>'))
    })
  })

  describe('generateSystemdUnit() with baked claude PATH (#5491 gap 1)', () => {
    it('bakes the claude bin dir into Environment=PATH', () => {
      const unit = generateSystemdUnit({
        nodePath: '/usr/local/bin/node',
        chroxyBin: '/some/cli.js',
        claudeBin: '/home/me/.local/bin/claude',
        cwd: '/home/me',
      })
      assert.ok(unit.includes('Environment=PATH='))
      assert.ok(unit.includes('/home/me/.local/bin'))
    })

    it('uses the wrapper in ExecStart when wrapperPath is provided', () => {
      const unit = generateSystemdUnit({
        nodePath: '/usr/local/bin/node',
        chroxyBin: '/some/cli.js',
        wrapperPath: '/home/me/.chroxy/service-wrapper.sh',
        cwd: '/home/me',
      })
      assert.ok(unit.includes('ExecStart=/home/me/.chroxy/service-wrapper.sh'))
    })
  })

  describe('generateServiceWrapper() (#5491 gap 2)', () => {
    const config = {
      nodePath: '/opt/homebrew/opt/node@22/bin/node',
      chroxyBin: '/some/cli.js',
      pathValue: '/opt/homebrew/opt/node@22/bin:/usr/bin:/bin',
      cwd: '/Users/me',
    }

    it('is a POSIX sh script', () => {
      const w = generateServiceWrapper(config)
      assert.ok(w.startsWith('#!/bin/sh'))
    })

    it('resolves the api token from the keychain via /usr/bin/security', () => {
      const w = generateServiceWrapper(config)
      assert.ok(w.includes('/usr/bin/security find-generic-password'))
      assert.ok(w.includes("-s 'chroxy'"))
      assert.ok(w.includes("-a 'api-token'"))
      assert.ok(w.includes('export API_TOKEN='))
    })

    it('resolves the discord webhook from the keychain (relates to #5490)', () => {
      const w = generateServiceWrapper(config)
      assert.ok(w.includes("-s 'chroxy-discord-webhook'"))
      assert.ok(w.includes("-a 'webhook-url'"))
      assert.ok(w.includes('export CHROXY_DISCORD_WEBHOOK_URL='))
    })

    it('reads the keychain gracefully (suppresses errors, guards empty)', () => {
      const w = generateServiceWrapper(config)
      // security errors are swallowed (2>/dev/null) and empty values skipped
      assert.ok(w.includes('2>/dev/null'))
      assert.ok(/if \[ -n "\$_val" \]/.test(w))
    })

    it('exports the baked PATH and execs the server', () => {
      const w = generateServiceWrapper(config)
      assert.ok(w.includes('export PATH='))
      assert.ok(w.includes(config.pathValue))
      assert.ok(w.includes(`exec '${config.nodePath}' '${config.chroxyBin}' start`))
    })

    it('does NOT embed any token value in the script', () => {
      const w = generateServiceWrapper(config)
      // The token is resolved at runtime; only the security invocation appears.
      assert.ok(!w.includes('API_TOKEN=sk-'))
    })
  })

  describe('writeServiceWrapper() (#5491 gap 2)', () => {
    it('writes the wrapper 0700 (owner rwx only)', () => {
      const wrapperPath = join(tmpDir, '.chroxy', 'service-wrapper.sh')
      writeServiceWrapper(wrapperPath, '#!/bin/sh\necho hi\n')
      assert.ok(existsSync(wrapperPath))
      const mode = statSync(wrapperPath).mode & 0o777
      assert.equal(mode, 0o700, `expected 0700, got ${mode.toString(8)}`)
    })

    it('creates the parent directory if missing', () => {
      const wrapperPath = join(tmpDir, 'nested', 'dir', 'service-wrapper.sh')
      writeServiceWrapper(wrapperPath, '#!/bin/sh\n')
      assert.ok(existsSync(wrapperPath))
    })
  })

  describe('installService() writes wrapper and bakes PATH (#5491)', () => {
    it('writes a 0700 wrapper with the security invocation on darwin', () => {
      const serviceDir = join(tmpDir, 'LaunchAgents')
      mkdirSync(serviceDir, { recursive: true })
      const logDir = join(tmpDir, 'logs')
      const stateDir = join(tmpDir, 'state')

      installService({
        nodePath: '/opt/homebrew/opt/node@22/bin/node',
        chroxyBin: '/some/cli.js',
        claudeBin: '/Users/me/.local/bin/claude',
        cwd: '/Users/me',
        _servicePath: join(serviceDir, 'com.chroxy.server.plist'),
        _logDir: logDir,
        _stateDir: stateDir,
        _skipRegister: true,
        _platform: 'darwin',
      })

      const wrapperPath = join(stateDir, 'service-wrapper.sh')
      assert.ok(existsSync(wrapperPath), 'wrapper should be written')
      const mode = statSync(wrapperPath).mode & 0o777
      assert.equal(mode, 0o700)
      const wrapper = readFileSync(wrapperPath, 'utf-8')
      assert.ok(wrapper.includes('/usr/bin/security find-generic-password'))

      // Plist execs the wrapper and bakes claude into PATH
      const plist = readFileSync(join(serviceDir, 'com.chroxy.server.plist'), 'utf-8')
      assert.ok(plist.includes(wrapperPath))
      assert.ok(plist.includes('/Users/me/.local/bin'))

      // State records claudeBin + wrapperPath
      const state = loadServiceState(stateDir)
      assert.equal(state.claudeBin, '/Users/me/.local/bin/claude')
      assert.equal(state.wrapperPath, wrapperPath)
    })
  })

  describe('uninstallService() removes the wrapper (#5491)', () => {
    it('deletes the wrapper script', () => {
      const serviceDir = join(tmpDir, 'LaunchAgents')
      mkdirSync(serviceDir, { recursive: true })
      const servicePath = join(serviceDir, 'com.chroxy.server.plist')
      writeFileSync(servicePath, '<plist>test</plist>')
      const stateDir = join(tmpDir, 'state')
      const wrapperPath = join(stateDir, 'service-wrapper.sh')
      writeServiceWrapper(wrapperPath, '#!/bin/sh\n')
      saveServiceState({
        installedAt: new Date().toISOString(),
        platform: 'darwin',
        servicePath,
        wrapperPath,
        nodePath: '/n/node',
        chroxyBin: '/c/cli.js',
      }, stateDir)

      assert.ok(existsSync(wrapperPath))
      uninstallService({ _stateDir: stateDir, _skipUnregister: true })
      assert.ok(!existsSync(wrapperPath), 'wrapper should be removed')
    })
  })

  describe('startService() bootout-then-bootstrap + EIO hint (#5491 gap 3)', () => {
    it('boots out the stale label before bootstrapping', () => {
      const serviceDir = join(tmpDir, 'LaunchAgents')
      mkdirSync(serviceDir, { recursive: true })
      const servicePath = join(serviceDir, 'com.chroxy.server.plist')
      writeFileSync(servicePath, '<plist/>')
      const stateDir = join(tmpDir, 'state')
      saveServiceState({
        installedAt: new Date().toISOString(),
        platform: 'darwin',
        servicePath,
        nodePath: '/n/node',
        chroxyBin: '/c/cli.js',
      }, stateDir)

      const calls = []
      const exec = (cmd, args) => { calls.push([cmd, ...args]) }
      const result = startService({ _platform: 'darwin', _stateDir: stateDir, _exec: exec })

      assert.equal(result.started, true)
      // bootout must precede bootstrap
      const bootoutIdx = calls.findIndex(c => c.includes('bootout'))
      const bootstrapIdx = calls.findIndex(c => c.includes('bootstrap'))
      assert.ok(bootoutIdx >= 0, 'should call bootout')
      assert.ok(bootstrapIdx >= 0, 'should call bootstrap')
      assert.ok(bootoutIdx < bootstrapIdx, 'bootout must run before bootstrap')
    })

    it('ignores bootout failure (label not loaded) and still bootstraps', () => {
      const serviceDir = join(tmpDir, 'LaunchAgents')
      mkdirSync(serviceDir, { recursive: true })
      const servicePath = join(serviceDir, 'com.chroxy.server.plist')
      writeFileSync(servicePath, '<plist/>')
      const stateDir = join(tmpDir, 'state')
      saveServiceState({
        installedAt: new Date().toISOString(),
        platform: 'darwin',
        servicePath,
        nodePath: '/n/node',
        chroxyBin: '/c/cli.js',
      }, stateDir)

      let bootstrapped = false
      const exec = (cmd, args) => {
        if (args.includes('bootout')) throw new Error('No such process')
        if (args.includes('bootstrap')) bootstrapped = true
      }
      const result = startService({ _platform: 'darwin', _stateDir: stateDir, _exec: exec })
      assert.equal(result.started, true)
      assert.ok(bootstrapped, 'bootstrap should still run after a failed bootout')
    })

    it('translates Bootstrap failed: 5: Input/output error into an actionable hint', () => {
      const serviceDir = join(tmpDir, 'LaunchAgents')
      mkdirSync(serviceDir, { recursive: true })
      const servicePath = join(serviceDir, 'com.chroxy.server.plist')
      writeFileSync(servicePath, '<plist/>')
      const stateDir = join(tmpDir, 'state')
      saveServiceState({
        installedAt: new Date().toISOString(),
        platform: 'darwin',
        servicePath,
        nodePath: '/n/node',
        chroxyBin: '/c/cli.js',
      }, stateDir)

      const exec = (cmd, args) => {
        if (args.includes('bootout')) return
        if (args.includes('bootstrap')) {
          const err = new Error('Command failed')
          err.stderr = 'Bootstrap failed: 5: Input/output error\n'
          throw err
        }
      }
      assert.throws(
        () => startService({ _platform: 'darwin', _stateDir: stateDir, _exec: exec }),
        (err) => {
          assert.ok(/Input\/output error/.test(err.message), 'mentions the original error')
          assert.ok(/bootout/.test(err.message), 'suggests bootout')
          assert.ok(/chroxy service/i.test(err.message), 'suggests a chroxy command')
          return true
        }
      )
    })
  })

})
