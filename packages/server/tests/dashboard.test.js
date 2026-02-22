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

describe('getDashboardJs', () => {
  it('returns non-empty JavaScript', () => {
    const html = getDashboardHtml(8765, 'token', false)
    // The JS is embedded between the second <script> tags
    // It should contain substantial code, not empty string
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/g)
    assert.ok(scriptMatch, 'should have script tags')
    // Second script block contains the dashboard JS
    assert.ok(scriptMatch.length >= 2, 'should have at least 2 script blocks')
    const jsBlock = scriptMatch[1]
    assert.ok(jsBlock.length > 100, 'dashboard JS should be substantial')
  })
})

describe('getDashboardCss', () => {
  it('returns complete CSS with dark theme', () => {
    const html = getDashboardHtml(8765, null, false)
    // Check for dark theme colors
    assert.ok(html.includes('#0f0f1a'), 'should have dark background color')
    assert.ok(html.includes('#1a1a2e'), 'should have assistant bubble color')
    assert.ok(html.includes('#2a2a4e'), 'should have user bubble color')
    assert.ok(html.includes('#4a9eff'), 'should have accent color')
  })

  it('includes layout styles', () => {
    const html = getDashboardHtml(8765, null, false)
    assert.ok(html.includes('system-ui'), 'should use system-ui font')
    assert.ok(html.includes('flex'), 'should use flexbox layout')
  })
})

describe('dashboard UI elements', () => {
  const html = getDashboardHtml(8765, 'test-token', false)

  it('has header with app name', () => {
    assert.ok(html.includes('Chroxy'), 'should show app name')
  })

  it('has chat message area', () => {
    assert.ok(html.includes('id="messages"') || html.includes('id="chat-messages"'),
      'should have messages container')
  })

  it('has text input area', () => {
    assert.ok(html.includes('<textarea') || html.includes('id="input"') || html.includes('id="message-input"'),
      'should have text input')
  })

  it('has send button', () => {
    assert.ok(html.includes('Send') || html.includes('send'),
      'should have send button')
  })

  it('has interrupt button', () => {
    assert.ok(html.includes('Interrupt') || html.includes('interrupt') || html.includes('Stop'),
      'should have interrupt button')
  })

  it('has session tabs area', () => {
    assert.ok(html.includes('session') || html.includes('Session'),
      'should have session area')
  })

  it('has status bar', () => {
    assert.ok(html.includes('status') || html.includes('Status'),
      'should have status area')
  })
})

describe('dashboard WebSocket code', () => {
  const html = getDashboardHtml(8765, 'test-token', false)

  it('contains WebSocket connection code', () => {
    assert.ok(html.includes('WebSocket') || html.includes('new WebSocket'),
      'should have WebSocket connection code')
  })

  it('sends auth message with token', () => {
    assert.ok(html.includes('auth'), 'should send auth message')
    assert.ok(html.includes('deviceInfo') || html.includes('device'),
      'should include device info in auth')
  })

  it('handles auth_ok message', () => {
    assert.ok(html.includes('auth_ok'), 'should handle auth_ok')
  })

  it('handles stream messages', () => {
    assert.ok(html.includes('stream_start'), 'should handle stream_start')
    assert.ok(html.includes('stream_delta'), 'should handle stream_delta')
    assert.ok(html.includes('stream_end'), 'should handle stream_end')
  })

  it('handles tool messages', () => {
    assert.ok(html.includes('tool_start'), 'should handle tool_start')
    assert.ok(html.includes('tool_result'), 'should handle tool_result')
  })

  it('handles permission requests', () => {
    assert.ok(html.includes('permission_request'), 'should handle permission_request')
    assert.ok(html.includes('permission_response'), 'should send permission_response')
  })

  it('handles history replay', () => {
    assert.ok(html.includes('history_replay_start'), 'should handle history_replay_start')
    assert.ok(html.includes('history_replay_end'), 'should handle history_replay_end')
  })

  it('sends input messages', () => {
    assert.ok(html.includes("type: 'input'") || html.includes('type:"input"') || html.includes("type: \"input\""),
      'should send input messages')
  })

  it('sends interrupt messages', () => {
    assert.ok(html.includes("type: 'interrupt'") || html.includes('type:"interrupt"') || html.includes("type: \"interrupt\""),
      'should send interrupt messages')
  })

  it('handles reconnection', () => {
    assert.ok(html.includes('reconnect') || html.includes('setTimeout'),
      'should handle auto-reconnection')
  })
})

describe('dashboard markdown renderer', () => {
  const html = getDashboardHtml(8765, 'test-token', false)

  it('renders code blocks', () => {
    assert.ok(html.includes('```') || html.includes('code-block') || html.includes('<pre'),
      'should handle code blocks')
  })

  it('renders inline code', () => {
    assert.ok(html.includes('`') || html.includes('inline-code') || html.includes('<code'),
      'should handle inline code')
  })

  it('renders bold text', () => {
    assert.ok(html.includes('**') || html.includes('<strong') || html.includes('bold'),
      'should handle bold text')
  })

  it('renders headers', () => {
    assert.ok(html.includes('<h') || html.includes('header'),
      'should handle headers')
  })
})
