import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  surveySimulators,
  parseSimctlDevices,
  friendlyRuntime,
  friendlyDeviceType,
  METRO_PORT,
  MOCK_SERVER_PORT,
} from '../src/control-room/simulators.js'

/**
 * Tests for the #6136 iOS simulator survey (epic #5530). simctl + port probes are
 * stubbed via injected seams so no real Simulator / sockets are touched.
 */

const NOW = () => new Date('2026-06-19T12:00:00.000Z')

function simctlJson(devicesByRuntime) {
  return JSON.stringify({ devices: devicesByRuntime })
}

const SAMPLE = simctlJson({
  'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [
    { udid: 'U-BOOTED', name: 'iPhone 16 Pro', state: 'Booted', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro' },
    { udid: 'U-SHUT', name: 'iPhone 15', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15' },
    { udid: 'U-UNAVAIL', name: 'Old Device', state: 'Shutdown', isAvailable: false, deviceTypeIdentifier: 'x' },
  ],
})

describe('friendlyRuntime()', () => {
  it('formats a simctl runtime key', () => {
    assert.equal(friendlyRuntime('com.apple.CoreSimulator.SimRuntime.iOS-26-1'), 'iOS 26.1')
    assert.equal(friendlyRuntime('com.apple.CoreSimulator.SimRuntime.watchOS-11-0'), 'watchOS 11.0')
    assert.equal(friendlyRuntime('weird'), 'weird')
  })
})

describe('friendlyDeviceType()', () => {
  it('humanizes a device type id', () => {
    assert.equal(friendlyDeviceType('com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro'), 'iPhone 16 Pro')
    assert.equal(friendlyDeviceType(null), null)
  })
})

describe('parseSimctlDevices()', () => {
  it('flattens, drops unavailable, sorts booted first', () => {
    const out = parseSimctlDevices(SAMPLE)
    assert.deepEqual(out.map((d) => d.udid), ['U-BOOTED', 'U-SHUT'])
    assert.equal(out[0].state, 'Booted')
    assert.equal(out[0].runtime, 'iOS 26.1')
    assert.equal(out[0].deviceType, 'iPhone 16 Pro')
  })

  it('returns [] on malformed JSON', () => {
    assert.deepEqual(parseSimctlDevices('not json'), [])
    assert.deepEqual(parseSimctlDevices('{}'), [])
  })
})

describe('surveySimulators()', () => {
  it('READY when a sim is booted and both ports are reachable', async () => {
    const snap = await surveySimulators({
      _execFile: async () => ({ stdout: SAMPLE }),
      _probePort: async () => true,
      _now: NOW,
    })
    assert.equal(snap.available, true)
    assert.equal(snap.devices.length, 2)
    assert.equal(snap.readyForMaestro.ready, true)
    assert.equal(snap.readyForMaestro.bootedSimulator, 'iPhone 16 Pro')
    assert.deepEqual(snap.readyForMaestro.reasons, [])
  })

  it('NOT ready (with reasons) when no booted sim / ports down', async () => {
    const noBoot = simctlJson({
      'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [
        { udid: 'U1', name: 'iPhone 15', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'x' },
      ],
    })
    const snap = await surveySimulators({
      _execFile: async () => ({ stdout: noBoot }),
      _probePort: async (port) => port === METRO_PORT, // metro up, mock down
      _now: NOW,
    })
    assert.equal(snap.readyForMaestro.ready, false)
    assert.equal(snap.readyForMaestro.metroReachable, true)
    assert.equal(snap.readyForMaestro.mockServerReachable, false)
    assert.ok(snap.readyForMaestro.reasons.some((r) => /No booted simulator/.test(r)))
    assert.ok(snap.readyForMaestro.reasons.some((r) => new RegExp(`${MOCK_SERVER_PORT}`).test(r)))
  })

  it('probes both Metro and mock-server ports', async () => {
    const probed = []
    await surveySimulators({
      _execFile: async () => ({ stdout: SAMPLE }),
      _probePort: async (port) => { probed.push(port); return true },
      _now: NOW,
    })
    assert.deepEqual(probed.sort((a, b) => a - b), [METRO_PORT, MOCK_SERVER_PORT])
  })

  it('degrades to available:false off macOS / no xcrun', async () => {
    const snap = await surveySimulators({
      _execFile: async () => { throw new Error('spawn xcrun ENOENT') },
      _probePort: async () => true,
      _now: NOW,
    })
    assert.equal(snap.available, false)
    assert.match(snap.note, /not available on this host/)
    assert.deepEqual(snap.devices, [])
    assert.equal(snap.readyForMaestro.ready, false)
  })

  it('survives a port-probe rejection (treats as unreachable)', async () => {
    const snap = await surveySimulators({
      _execFile: async () => ({ stdout: SAMPLE }),
      _probePort: async () => { throw new Error('probe blew up') },
      _now: NOW,
    })
    assert.equal(snap.available, true)
    assert.equal(snap.readyForMaestro.metroReachable, false)
    assert.equal(snap.readyForMaestro.mockServerReachable, false)
  })
})
