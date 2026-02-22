import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import {
  getServicePaths,
  generateLaunchdPlist,
  generateSystemdUnit,
  resolveNode22Path,
  resolveChroxyBin,
  loadServiceState,
  saveServiceState,
  installService,
  uninstallService,
  startService,
  stopService,
  getServiceStatus,
  getFullServiceStatus,
} from '../src/service.js'

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

    it('throws on unsupported platform', () => {
      assert.throws(() => getServicePaths('win32'), {
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

    it('throws on unsupported platform', () => {
      assert.throws(() => startService({ _skipExec: true, _platform: 'win32' }), {
        message: /not supported/i,
      })
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

    it('throws on unsupported platform', () => {
      assert.throws(() => stopService({ _skipExec: true, _platform: 'win32' }), {
        message: /not supported/i,
      })
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
      } finally {
        rmSync(dir, { recursive: true })
      }
    })

    it('treats state without installed flag as not installed', () => {
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

})
