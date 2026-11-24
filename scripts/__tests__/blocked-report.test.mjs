import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BLOCKED_HEADLINE, blockedReport, describeBlocked } from '../lib/blocked-report.mjs'

// #9232. No browser: the helper is pure, so every case here runs on plain node.

const URL_A = 'https://cdn.example.test/font.woff2'
const WS = 'websocket ws://127.0.0.1:1/socket'

test('nothing blocked and no failure: the case passes (undefined)', () => {
  assert.equal(blockedReport([], undefined), undefined)
})

test('nothing blocked, body failed: the very same error comes back untouched', () => {
  const original = new Error('boom')
  assert.equal(blockedReport([], original), original)
})

test('nothing blocked, a non-Error was thrown: returned as is', () => {
  assert.equal(blockedReport([], 'plain string'), 'plain string')
})

test('blocked only, body passed: still fails, naming every attempt', () => {
  const err = blockedReport([URL_A, WS], undefined)
  assert.ok(err instanceof Error, 'an Error is produced')
  assert.ok(err.message.includes(BLOCKED_HEADLINE), 'headline present')
  assert.ok(err.message.includes('2 blocked'), 'count present')
  assert.ok(err.message.includes(URL_A), 'request URL named')
  assert.ok(err.message.includes(WS), 'websocket named')
  assert.equal(err.cause, undefined)
})

test('blocked and body failed: message carries BOTH, cause is the original', () => {
  const original = new Error('locator.waitFor: Timeout 10000ms exceeded')
  const err = blockedReport([URL_A], original)
  assert.notEqual(err, original)
  assert.equal(err.cause, original)
  assert.ok(err.message.includes('Timeout 10000ms exceeded'), 'original message kept')
  assert.ok(err.message.includes(URL_A), 'blocked URL named')
  assert.deepEqual(err.blocked, [URL_A])
  assert.ok(err.message.indexOf('Timeout') < err.message.indexOf(URL_A), 'original failure comes first')
})

test('blocked and a non-Error was thrown: stringified into the message, kept as cause', () => {
  const err = blockedReport([WS], 'plain string')
  assert.ok(err.message.includes('plain string'), 'thrown value kept')
  assert.ok(err.message.includes(WS), 'websocket named')
  assert.equal(err.cause, 'plain string')
})

test('an AssertionError from the case body survives with its message and as the cause', () => {
  let original
  try { assert.deepEqual([1], [2], 'the footer renders the expected buttons') } catch (e) { original = e }
  const err = blockedReport([URL_A], original)
  assert.ok(err.message.includes('the footer renders the expected buttons'), 'assertion message kept')
  assert.equal(err.cause, original)
})

test('the blocked list is copied, so later pushes do not rewrite a reported error', () => {
  const blocked = [URL_A]
  const err = blockedReport(blocked, new Error('x'))
  blocked.push('late')
  assert.deepEqual(err.blocked, [URL_A])
})

test('describeBlocked lists one attempt per line', () => {
  assert.equal(describeBlocked([URL_A, WS]), `  - ${URL_A}\n  - ${WS}`)
})
