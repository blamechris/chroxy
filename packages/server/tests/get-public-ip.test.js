import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePublicIp } from '../src/get-public-ip.js'

function fakeFetch(impl) {
  return async (url, opts) => impl(url, opts)
}

test('returns the trimmed IPv4 on a 200 with a bare IP body', async () => {
  const ip = await resolvePublicIp({ fetchImpl: fakeFetch(async () => ({ ok: true, text: async () => '  203.0.113.7\n' })) })
  assert.equal(ip, '203.0.113.7')
})

test('returns null on a non-200', async () => {
  const ip = await resolvePublicIp({ fetchImpl: fakeFetch(async () => ({ ok: false, text: async () => '203.0.113.7' })) })
  assert.equal(ip, null)
})

test('returns null when the body is not a plausible IPv4 (captive portal / HTML)', async () => {
  const ip = await resolvePublicIp({ fetchImpl: fakeFetch(async () => ({ ok: true, text: async () => '<html>nope</html>' })) })
  assert.equal(ip, null)
})

test('rejects out-of-range octets (999.999.999.999) — 0-255 only', async () => {
  const ip = await resolvePublicIp({ fetchImpl: fakeFetch(async () => ({ ok: true, text: async () => '999.999.999.999' })) })
  assert.equal(ip, null)
})

test('accepts boundary octets (255.0.1.255)', async () => {
  const ip = await resolvePublicIp({ fetchImpl: fakeFetch(async () => ({ ok: true, text: async () => '255.0.1.255' })) })
  assert.equal(ip, '255.0.1.255')
})

test('is fail-open: a throwing fetch resolves to null, never rejects', async () => {
  const ip = await resolvePublicIp({ fetchImpl: fakeFetch(async () => { throw new Error('network down') }) })
  assert.equal(ip, null)
})

test('returns null on an abort (timeout)', async () => {
  // Resolve immediately with a timeout of 0 so the abort path is exercised; the
  // fetch impl honours the abort signal by rejecting like real fetch.
  const ip = await resolvePublicIp({
    timeoutMs: 0,
    fetchImpl: (url, { signal }) =>
      new Promise((_resolve, reject) => {
        if (signal.aborted) return reject(new Error('aborted'))
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
  })
  assert.equal(ip, null)
})

test('passes a configurable url through to fetch', async () => {
  let seen = null
  await resolvePublicIp({
    url: 'https://example.test/ip',
    fetchImpl: fakeFetch(async (url) => { seen = url; return { ok: true, text: async () => '1.2.3.4' } }),
  })
  assert.equal(seen, 'https://example.test/ip')
})
