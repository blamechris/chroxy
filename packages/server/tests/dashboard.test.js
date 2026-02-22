import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getDashboardHtml } from '../src/dashboard.js'

describe('getDashboardHtml', () => {
  it('returns valid HTML document', () => {
    const html = getDashboardHtml(8765, 'test-token', false)
    assert.ok(html.includes('<!DOCTYPE html>'))
    assert.ok(html.includes('<title>Chroxy Dashboard</title>'))
  })

  it('embeds port in config', () => {
    const html = getDashboardHtml(9999, null, false)
    assert.ok(html.includes('port: 9999'))
  })

  it('embeds token when provided', () => {
    const html = getDashboardHtml(8765, 'my-secret-token', false)
    assert.ok(html.includes('"my-secret-token"'))
  })

  it('sets token to null when not provided', () => {
    const html = getDashboardHtml(8765, null, false)
    assert.ok(html.includes('token: null'))
  })

  it('embeds noEncrypt flag', () => {
    const html = getDashboardHtml(8765, null, true)
    assert.ok(html.includes('noEncrypt: true'))
  })

  it('includes CSS', () => {
    const html = getDashboardHtml(8765, null, false)
    assert.ok(html.includes('<style>'))
    assert.ok(html.includes('background'))
  })
})
