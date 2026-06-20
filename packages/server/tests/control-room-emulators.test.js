import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  surveyEmulators,
  runEmulatorAction,
  EMULATOR_ACTIONS,
  parseAvdList,
  parseAdbDevices,
  METRO_PORT,
  MOCK_SERVER_PORT,
} from '../src/control-room/emulators.js'

/**
 * Tests for the #6137 Android emulator survey + actions (epic #5530). emulator /
 * adb + port probes are stubbed via injected seams so no real SDK / sockets are
 * touched.
 */

const NOW = () => new Date('2026-06-20T12:00:00.000Z')

describe('parseAvdList()', () => {
  it('parses AVD names, drops INFO noise, sorts + dedupes', () => {
    const out = parseAvdList('Pixel_7_API_34\nINFO | hw config\nPixel_5_API_33\nPixel_7_API_34\n')
    assert.deepEqual(out, ['Pixel_5_API_33', 'Pixel_7_API_34'])
  })
  it('returns [] on empty/garbage', () => {
    assert.deepEqual(parseAvdList(''), [])
    assert.deepEqual(parseAvdList(null), [])
  })
})

describe('parseAdbDevices()', () => {
  it('keeps only emulator-* serials in the device state', () => {
    const stdout = 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\n0A1B2C\tdevice\n'
    assert.deepEqual(parseAdbDevices(stdout), ['emulator-5554'])
  })
  it('returns [] on empty/garbage', () => {
    assert.deepEqual(parseAdbDevices(''), [])
    assert.deepEqual(parseAdbDevices(undefined), [])
  })
})

// An _execFile stub that routes by command/args.
function makeExec({ avds = 'Pixel_7_API_34\nPixel_5_API_33\n', adb = 'List of devices attached\n', avdName = {} } = {}) {
  return async (file, args) => {
    if (file === 'emulator' && args[0] === '-list-avds') return { stdout: avds }
    if (file === 'adb' && args[0] === 'devices') return { stdout: adb }
    if (file === 'adb' && args.includes('avd') && args.includes('name')) {
      const serial = args[1]
      return { stdout: avdName[serial] || '' }
    }
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`)
  }
}

describe('surveyEmulators()', () => {
  it('READY when an emulator is running and both ports are reachable', async () => {
    const snap = await surveyEmulators({
      _execFile: makeExec({
        adb: 'List of devices attached\nemulator-5554\tdevice\n',
        avdName: { 'emulator-5554': 'Pixel_7_API_34\nOK\n' },
      }),
      _probePort: async () => true,
      _now: NOW,
    })
    assert.equal(snap.available, true)
    // one running (Pixel_7) + one stopped (Pixel_5)
    assert.equal(snap.devices.length, 2)
    assert.equal(snap.devices[0].state, 'running')
    assert.equal(snap.devices[0].avd, 'Pixel_7_API_34')
    assert.equal(snap.devices[0].serial, 'emulator-5554')
    assert.equal(snap.readyForMaestro.ready, true)
    assert.equal(snap.readyForMaestro.runningDevice, 'Pixel_7_API_34')
    assert.deepEqual(snap.readyForMaestro.reasons, [])
  })

  it('lists AVDs as stopped when nothing is running; not ready with reasons', async () => {
    const snap = await surveyEmulators({
      _execFile: makeExec({ adb: 'List of devices attached\n' }),
      _probePort: async (port) => port === METRO_PORT, // metro up, mock down
      _now: NOW,
    })
    assert.equal(snap.available, true)
    assert.equal(snap.devices.every((d) => d.state === 'stopped'), true)
    assert.equal(snap.readyForMaestro.ready, false)
    assert.ok(snap.readyForMaestro.reasons.some((r) => /No running emulator/.test(r)))
    assert.ok(snap.readyForMaestro.reasons.some((r) => new RegExp(`${MOCK_SERVER_PORT}`).test(r)))
  })

  it('still lists AVDs when adb is missing (running set empty)', async () => {
    const snap = await surveyEmulators({
      _execFile: async (file, args) => {
        if (file === 'emulator') return { stdout: 'Pixel_7_API_34\n' }
        throw new Error('adb not found')
      },
      _probePort: async () => false,
      _now: NOW,
    })
    assert.equal(snap.available, true)
    assert.equal(snap.devices.length, 1)
    assert.equal(snap.devices[0].state, 'stopped')
  })

  it('degrades to available:false with no Android SDK (emulator missing)', async () => {
    const snap = await surveyEmulators({
      _execFile: async () => { throw new Error('spawn emulator ENOENT') },
      _probePort: async () => true,
      _now: NOW,
    })
    assert.equal(snap.available, false)
    assert.match(snap.note, /not available on this host/)
    assert.deepEqual(snap.devices, [])
    assert.equal(snap.readyForMaestro.ready, false)
  })

  it('a running emulator with an unresolvable AVD name still lists by serial', async () => {
    const snap = await surveyEmulators({
      _execFile: async (file, args) => {
        if (file === 'emulator') return { stdout: '' }
        if (file === 'adb' && args[0] === 'devices') return { stdout: 'emulator-5554\tdevice\n' }
        throw new Error('avd name failed')
      },
      _probePort: async () => true,
      _now: NOW,
    })
    assert.equal(snap.devices.length, 1)
    assert.equal(snap.devices[0].serial, 'emulator-5554')
    assert.equal(snap.devices[0].avd, null)
    assert.equal(snap.devices[0].state, 'running')
  })
})

describe('runEmulatorAction()', () => {
  it('exports the supported actions', () => {
    assert.deepEqual(EMULATOR_ACTIONS, ['boot', 'kill'])
  })

  it('boots an AVD detached and returns starting', async () => {
    const spawned = []
    let unrefd = false
    const status = await runEmulatorAction({
      action: 'boot',
      avd: 'Pixel_7_API_34',
      _spawn: (file, args, opts) => { spawned.push([file, args, opts]); return { unref: () => { unrefd = true } } },
    })
    assert.equal(status, 'starting')
    assert.deepEqual(spawned[0][0], 'emulator')
    assert.deepEqual(spawned[0][1], ['-avd', 'Pixel_7_API_34'])
    assert.equal(spawned[0][2].detached, true)
    assert.equal(unrefd, true)
  })

  it('boot adds -no-window when headless', async () => {
    const spawned = []
    await runEmulatorAction({
      action: 'boot', avd: 'Pixel_7_API_34', headless: true,
      _spawn: (file, args) => { spawned.push(args); return { unref: () => {} } },
    })
    assert.deepEqual(spawned[0], ['-avd', 'Pixel_7_API_34', '-no-window'])
  })

  it('kills a running serial and returns killed', async () => {
    const calls = []
    const status = await runEmulatorAction({
      action: 'kill', serial: 'emulator-5554',
      _execFile: async (file, args) => { calls.push([file, ...args]); return { stdout: '' } },
    })
    assert.equal(status, 'killed')
    assert.deepEqual(calls, [['adb', '-s', 'emulator-5554', 'emu', 'kill']])
  })

  it('rejects an unsupported action / missing target', async () => {
    await assert.rejects(() => runEmulatorAction({ action: 'wipe', _spawn: () => ({ unref() {} }) }), /Unsupported emulator action/)
    await assert.rejects(() => runEmulatorAction({ action: 'boot', avd: '', _spawn: () => ({ unref() {} }) }), /requires an avd/)
    await assert.rejects(() => runEmulatorAction({ action: 'kill', serial: '', _execFile: async () => ({ stdout: '' }) }), /requires a serial/)
  })

  it('propagates an adb kill failure', async () => {
    await assert.rejects(
      () => runEmulatorAction({ action: 'kill', serial: 'emulator-5554', _execFile: async () => { throw new Error('device not found') } }),
      /device not found/,
    )
  })
})
