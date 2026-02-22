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

  it('sets token to empty string when not provided', () => {
    const html = getDashboardHtml(8765, null, false)
    assert.ok(html.includes('token: ""'))
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

describe('#760 — sanitizeId strips special characters', () => {
  const html = getDashboardHtml(8765, 'test-token', false)

  it('defines sanitizeId function', () => {
    assert.ok(html.includes('function sanitizeId(id)'),
      'should define sanitizeId helper')
  })

  it('sanitizeId strips non-alphanumeric/underscore/dash characters', () => {
    // The regex in sanitizeId should be: /[^a-zA-Z0-9_-]/g
    assert.ok(html.includes("[^a-zA-Z0-9_-]"),
      'should strip CSS-special characters from IDs')
  })
})

describe('#760 — querySelector calls use sanitized IDs', () => {
  const html = getDashboardHtml(8765, 'test-token', false)

  it('uses sanitizeId for data-msg-id queries', () => {
    assert.ok(html.includes('sanitizeId(msg.messageId)'),
      'should sanitize msg.messageId in querySelector')
  })

  it('uses sanitizeId for streaming msg id queries', () => {
    assert.ok(html.includes('sanitizeId(streamingMsgId)'),
      'should sanitize streamingMsgId in querySelector')
  })

  it('uses sanitizeId for data-tool-id queries', () => {
    assert.ok(html.includes('sanitizeId(toolId)'),
      'should sanitize toolId in querySelector')
  })

  it('does not use raw IDs in data-msg-id selectors', () => {
    // Ensure no unsanitized data-msg-id selectors remain
    const msgIdQueries = html.match(/querySelector\('[^']*data-msg-id[^']*'\s*\+\s*(?!sanitizeId)\w/g)
    assert.ok(!msgIdQueries, 'all data-msg-id querySelector calls should use sanitizeId')
  })

  it('does not use raw IDs in data-tool-id selectors', () => {
    const toolIdQueries = html.match(/querySelector\('[^']*data-tool-id[^']*'\s*\+\s*(?!sanitizeId)\w/g)
    assert.ok(!toolIdQueries, 'all data-tool-id querySelector calls should use sanitizeId')
  })
})

describe('#762 — javascript: URI blocking in markdown links', () => {
  const html = getDashboardHtml(8765, 'test-token', false)

  it('blocks javascript: URIs', () => {
    // The link renderer should contain a regex test for javascript:
    assert.ok(html.includes('javascript') && html.includes('test(url)'),
      'should test URLs against dangerous protocol regex')
  })

  it('uses case-insensitive regex for scheme matching', () => {
    assert.ok(html.includes('/i.test(url)'),
      'should use case-insensitive flag for URI scheme check')
  })

  it('handles whitespace before protocol in URI check', () => {
    // The regex uses \\s* to handle leading whitespace
    assert.ok(html.includes('\\s*') || html.includes('\\\\s*'),
      'should handle whitespace before protocol name')
  })

  it('blocks data: URIs', () => {
    assert.ok(html.includes('data') && html.includes('vbscript'),
      'should block data: and vbscript: URIs alongside javascript:')
  })

  it('returns plain text for blocked URIs', () => {
    // When URI is blocked, the link replacement returns just the text (no <a> tag)
    // Check that the blocked branch returns 'text' (the link label only, no <a> tag)
    const blockSection = html.match(/javascript[\s\S]*?return text;/)
    assert.ok(blockSection, 'should return plain text (no link) when URI is blocked')
  })
})

describe('#761 — plan mode UI elements', () => {
  const html = getDashboardHtml(8765, 'test-token', false)

  it('has plan mode banner element', () => {
    assert.ok(html.includes('id="plan-mode-banner"'),
      'should have plan mode banner element')
  })

  it('plan mode banner is hidden by default', () => {
    assert.ok(html.includes('id="plan-mode-banner" class="hidden"'),
      'plan mode banner should be hidden by default')
  })

  it('has plan approval card element', () => {
    assert.ok(html.includes('id="plan-approval-card"'),
      'should have plan approval card element')
  })

  it('plan approval card is hidden by default', () => {
    assert.ok(html.includes('id="plan-approval-card" class="hidden"'),
      'plan approval card should be hidden by default')
  })

  it('has plan content area', () => {
    assert.ok(html.includes('id="plan-content"'),
      'should have plan content display area')
  })

  it('has Approve button', () => {
    assert.ok(html.includes('id="plan-approve-btn"'),
      'should have plan Approve button')
    assert.ok(html.includes('Approve'),
      'Approve button should have label')
  })

  it('has Give Feedback button', () => {
    assert.ok(html.includes('id="plan-feedback-btn"'),
      'should have plan Give Feedback button')
    assert.ok(html.includes('Give Feedback'),
      'Give Feedback button should have label')
  })

  it('has plan mode banner CSS', () => {
    assert.ok(html.includes('#plan-mode-banner'),
      'should have CSS rules for plan mode banner')
  })

  it('has plan approval card CSS', () => {
    assert.ok(html.includes('#plan-approval-card'),
      'should have CSS rules for plan approval card')
  })
})

describe('#761 — plan mode message handlers', () => {
  const html = getDashboardHtml(8765, 'test-token', false)

  it('handles plan_started message', () => {
    assert.ok(html.includes('case "plan_started"'),
      'should handle plan_started WS message')
  })

  it('handles plan_ready message', () => {
    assert.ok(html.includes('case "plan_ready"'),
      'should handle plan_ready WS message')
  })

  it('tracks plan mode state', () => {
    assert.ok(html.includes('inPlanMode'),
      'should track plan mode state with inPlanMode variable')
  })

  it('shows banner on plan_started', () => {
    // plan_started handler should remove "hidden" class from banner
    const planStartedBlock = html.match(/case "plan_started"[\s\S]*?break;/)
    assert.ok(planStartedBlock, 'plan_started handler should exist')
    assert.ok(planStartedBlock[0].includes('planModeBanner') && planStartedBlock[0].includes('remove'),
      'plan_started should show the plan mode banner')
  })

  it('hides banner on plan_ready', () => {
    const planReadyBlock = html.match(/case "plan_ready"[\s\S]*?break;/)
    assert.ok(planReadyBlock, 'plan_ready handler should exist')
    assert.ok(planReadyBlock[0].includes('planModeBanner') && planReadyBlock[0].includes('add'),
      'plan_ready should hide the plan mode banner')
  })

  it('shows approval card on plan_ready', () => {
    const planReadyBlock = html.match(/case "plan_ready"[\s\S]*?break;/)
    assert.ok(planReadyBlock, 'plan_ready handler should exist')
    assert.ok(planReadyBlock[0].includes('planApprovalCard') && planReadyBlock[0].includes('remove'),
      'plan_ready should show the plan approval card')
  })
})

describe('#761 — background agent UI elements', () => {
  const html = getDashboardHtml(8765, 'test-token', false)

  it('has agent badge element in status bar', () => {
    assert.ok(html.includes('id="status-agents"'),
      'should have agent badge element')
  })

  it('agent badge is hidden by default', () => {
    assert.ok(html.includes('class="agent-badge hidden"'),
      'agent badge should be hidden by default')
  })

  it('has agent badge CSS', () => {
    assert.ok(html.includes('.agent-badge'),
      'should have CSS rules for agent badge')
  })
})

describe('#761 — background agent message handlers', () => {
  const html = getDashboardHtml(8765, 'test-token', false)

  it('handles agent_spawned message', () => {
    assert.ok(html.includes('case "agent_spawned"'),
      'should handle agent_spawned WS message')
  })

  it('handles agent_completed message', () => {
    assert.ok(html.includes('case "agent_completed"'),
      'should handle agent_completed WS message')
  })

  it('tracks agents in a Map', () => {
    assert.ok(html.includes('backgroundAgents') && html.includes('new Map'),
      'should use a Map to track background agents')
  })

  it('updates agent badge count', () => {
    assert.ok(html.includes('updateAgentBadge'),
      'should have updateAgentBadge function')
  })

  it('adds agent on spawn', () => {
    const spawnBlock = html.match(/case "agent_spawned"[\s\S]*?break;/)
    assert.ok(spawnBlock, 'agent_spawned handler should exist')
    assert.ok(spawnBlock[0].includes('backgroundAgents.set'),
      'agent_spawned should add to backgroundAgents Map')
  })

  it('removes agent on completion', () => {
    const completeBlock = html.match(/case "agent_completed"[\s\S]*?break;/)
    assert.ok(completeBlock, 'agent_completed handler should exist')
    assert.ok(completeBlock[0].includes('backgroundAgents.delete'),
      'agent_completed should remove from backgroundAgents Map')
  })

  it('shows agent count text', () => {
    assert.ok(html.includes('" agent"') || html.includes("' agent'"),
      'should display singular "agent" label')
    assert.ok(html.includes('" agents"') || html.includes("' agents'"),
      'should display plural "agents" label')
  })
})
