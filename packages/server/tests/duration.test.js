import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseDuration } from '../src/duration.js'

describe('parseDuration', () => {
  it('parses hours', () => {
    assert.equal(parseDuration('2h'), 2 * 60 * 60 * 1000)
  })

  it('parses minutes', () => {
    assert.equal(parseDuration('30m'), 30 * 60 * 1000)
  })

  it('parses seconds', () => {
    assert.equal(parseDuration('90s'), 90 * 1000)
  })

  it('parses days', () => {
    assert.equal(parseDuration('1d'), 24 * 60 * 60 * 1000)
  })

  it('parses combined durations', () => {
    assert.equal(parseDuration('1h30m'), (60 + 30) * 60 * 1000)
    assert.equal(parseDuration('2h30m15s'), ((2 * 60 + 30) * 60 + 15) * 1000)
    assert.equal(parseDuration('1d12h'), (24 + 12) * 60 * 60 * 1000)
  })

  it('treats pure numbers as seconds', () => {
    assert.equal(parseDuration('60'), 60 * 1000)
    assert.equal(parseDuration('3600'), 3600 * 1000)
  })

  it('returns null for invalid input', () => {
    assert.equal(parseDuration(''), null)
    assert.equal(parseDuration(null), null)
    assert.equal(parseDuration(undefined), null)
    assert.equal(parseDuration('abc'), null)
    assert.equal(parseDuration('0h0m'), null)
  })

  it('rejects all zero durations', () => {
    assert.equal(parseDuration('0'), null)
    assert.equal(parseDuration('0s'), null)
    assert.equal(parseDuration('0h'), null)
    assert.equal(parseDuration('0d0h0m0s'), null)
  })

  it('trims whitespace', () => {
    assert.equal(parseDuration('  2h  '), 2 * 60 * 60 * 1000)
  })

  it('is case insensitive', () => {
    assert.equal(parseDuration('2H'), 2 * 60 * 60 * 1000)
    assert.equal(parseDuration('30M'), 30 * 60 * 1000)
  })
})
