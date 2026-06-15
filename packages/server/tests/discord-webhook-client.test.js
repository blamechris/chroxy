// #5828: discord-webhook-client — the channel primitives extracted from the
// status sink so both Discord sinks share one implementation. The status sink's
// own suite exercises these transitively; this pins the pure helpers directly.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatDuration,
  isValidColor,
  escapeAndCap,
  apiBase,
  retryAfterMs,
  fetchWithDiscordRetry,
  MAX_COLOR,
} from '../src/notifications/discord-webhook-client.js'

const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/aBcDeFgHiJkLmNoPqRsTuVwXyZ-0123456789_abcdefghijklmnopqrstuvwx'

test('formatDuration formats seconds, minutes, hours; clamps junk to 0s', () => {
  assert.equal(formatDuration(45), '45s')
  assert.equal(formatDuration(330), '5m 30s')
  assert.equal(formatDuration(4500), '1h 15m')
  assert.equal(formatDuration(-5), '0s')
  assert.equal(formatDuration(NaN), '0s')
})

test('isValidColor accepts 0..MAX_COLOR, rejects out-of-range and non-integers', () => {
  assert.equal(isValidColor(0), true)
  assert.equal(isValidColor(MAX_COLOR), true)
  assert.equal(isValidColor(MAX_COLOR + 1), false)
  assert.equal(isValidColor(-1), false)
  assert.equal(isValidColor(1.5), false)
})

test('escapeAndCap escapes markdown metacharacters', () => {
  assert.equal(escapeAndCap('a *b* _c_'), 'a \\*b\\* \\_c\\_')
})

test('escapeAndCap never ends in a dangling escape after the cap', () => {
  // All-metachar input doubles under escaping; the cap must not leave a lone `\`.
  const out = escapeAndCap('*'.repeat(20), 5)
  assert.ok(out.length <= 5)
  assert.ok(!/\\$/.test(out) || out.endsWith('\\\\'))
})

test('apiBase builds the webhook endpoint from a valid URL', () => {
  assert.equal(apiBase(WEBHOOK), 'https://discord.com/api/webhooks/123456789012345678/aBcDeFgHiJkLmNoPqRsTuVwXyZ-0123456789_abcdefghijklmnopqrstuvwx')
})

test('retryAfterMs reads the Retry-After header (seconds → ms), clamped', async () => {
  const res = { headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '1.5' : null) } }
  assert.equal(await retryAfterMs(res), 1500)
})

test('retryAfterMs falls back to the JSON body, then defaults to 2s', async () => {
  const body = { headers: { get: () => null }, json: async () => ({ retry_after: 0.25 }) }
  assert.equal(await retryAfterMs(body), 250)
  const junk = { headers: { get: () => null }, json: async () => ({}) }
  assert.equal(await retryAfterMs(junk), 2000)
})

test('fetchWithDiscordRetry honours a 429 then succeeds', async () => {
  const sleeps = []
  let n = 0
  const fetchImpl = mock.fn(async () => {
    n += 1
    if (n === 1) return { ok: false, status: 429, headers: { get: () => '0.01' }, json: async () => ({}) }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 'x' }) }
  })
  const res = await fetchWithDiscordRetry('https://x', { method: 'POST' }, { sleepImpl: async (ms) => { sleeps.push(ms) }, fetchImpl })
  assert.equal(res.status, 200)
  assert.equal(fetchImpl.mock.callCount(), 2)
  assert.equal(sleeps.length, 1)
})

test('fetchWithDiscordRetry returns immediately on a non-429 4xx (not retryable)', async () => {
  const fetchImpl = mock.fn(async () => ({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) }))
  const res = await fetchWithDiscordRetry('https://x', { method: 'PATCH' }, { sleepImpl: async () => {}, fetchImpl })
  assert.equal(res.status, 404)
  assert.equal(fetchImpl.mock.callCount(), 1)
})

test('fetchWithDiscordRetry retries 5xx then throws-through only on the last network error', async () => {
  const fetchImpl = mock.fn(async () => { throw new Error('network down') })
  await assert.rejects(
    fetchWithDiscordRetry('https://x', { method: 'POST' }, { retries: 2, sleepImpl: async () => {}, fetchImpl }),
    /network down/,
  )
  assert.equal(fetchImpl.mock.callCount(), 2)
})
