import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDashboardHtml } from '../src/dashboard.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(__dirname, '..', 'src', 'dashboard', 'dashboard.css'), 'utf8')
const dashboardJs = readFileSync(join(__dirname, '..', 'src', 'dashboard', 'dashboard-app.js'), 'utf8')

/** Helper: returns html + JS combined for tests that check JS behavior */
function getFullContent(port, token, noEncrypt) {
  return getDashboardHtml(port, token, noEncrypt) + '\n' + dashboardJs
}

/**
 * Assert that html contains the given string or matches the given regex.
 * @param {string} html - The HTML string to search
 * @param {string|RegExp} pattern - Substring or regex to match
 * @param {string} message - Assertion failure message
 */
function assertHtml(html, pattern, message) {
  if (typeof pattern === 'string') {
    assert.ok(html.includes(pattern), message)
  } else {
    assert.ok(pattern.test(html), message)
  }
}

/**
 * Assert that html does NOT contain the given string or match the given regex.
 * @param {string} html - The HTML string to search
 * @param {string|RegExp} pattern - Substring or regex that should NOT match
 * @param {string} message - Assertion failure message
 */
function assertHtmlNot(html, pattern, message) {
  if (typeof pattern === 'string') {
    assert.ok(!html.includes(pattern), message)
  } else {
    assert.ok(!pattern.test(html), message)
  }
}

describe('getDashboardHtml', () => {
  it('returns valid HTML document', () => {
    const html = getFullContent(8765, 'test-token', false)
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

  it('links external CSS', () => {
    const html = getDashboardHtml(8765, null, false)
    assert.ok(html.includes('<link rel="stylesheet" href="/assets/dashboard.css">'),
      'should link to external dashboard.css')
  })

  it('adds nonce attributes to inline script tags', () => {
    const html = getDashboardHtml(8765, null, false, 'abc123')
    assert.ok(html.includes('nonce="abc123"'), 'should add nonce to inline tags')
    // Config script and main JS script should both have nonce
    const nonceCount = (html.match(/nonce="abc123"/g) || []).length
    assert.ok(nonceCount >= 1, `should have at least 1 nonce attribute (config script), got ${nonceCount}`)
  })
})

describe('dashboard-app.js', () => {
  it('links external JS and file has substantial content', () => {
    const html = getDashboardHtml(8765, 'token', false)
    assert.ok(html.includes('<script src="/assets/dashboard-app.js">'),
      'should link to external dashboard-app.js')
    assert.ok(dashboardJs.length > 1000, 'dashboard JS file should be substantial')
    assert.ok(dashboardJs.includes('"use strict"'), 'should use strict mode')
  })
})

describe('dashboard.css', () => {
  it('has complete CSS with dark theme', () => {
    assert.ok(css.includes('#0f0f1a'), 'should have dark background color')
    assert.ok(css.includes('#1a1a2e'), 'should have assistant bubble color')
    assert.ok(css.includes('#2a2a4e'), 'should have user bubble color')
    assert.ok(css.includes('#4a9eff'), 'should have accent color')
  })

  it('includes layout styles', () => {
    assert.ok(css.includes('system-ui'), 'should use system-ui font')
    assert.ok(css.includes('flex'), 'should use flexbox layout')
  })
})

describe('dashboard UI elements', () => {
  const html = getFullContent(8765, 'test-token', false)

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
  const html = getFullContent(8765, 'test-token', false)

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

  it('extracts protocolVersion from auth_ok', () => {
    assertHtml(
      html,
      /case\s+["']auth_ok["'][\s\S]*protocolVersion/,
      'should reference protocolVersion within the auth_ok handler'
    )
  })

  it('logs unknown message types when server protocol version is newer', () => {
    // The default case should warn about unknown types when protocolVersion mismatch
    assertHtml(
      html,
      /default:\s*[\s\S]*console\.warn\(\s*['"]\[dashboard\] Unknown message type/,
      'default case should console.warn about unknown message types'
    )
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
  const html = getFullContent(8765, 'test-token', false)

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

describe('#762 — sanitizeId strips special characters', () => {
  const html = getFullContent(8765, 'test-token', false)

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

describe('#762 — querySelector calls use sanitized IDs', () => {
  const html = getFullContent(8765, 'test-token', false)

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
    assertHtmlNot(html, /querySelector\('[^']*data-msg-id[^']*'\s*\+\s*(?!sanitizeId)\w/g,
      'all data-msg-id querySelector calls should use sanitizeId')
  })

  it('does not use raw IDs in data-tool-id selectors', () => {
    assertHtmlNot(html, /querySelector\('[^']*data-tool-id[^']*'\s*\+\s*(?!sanitizeId)\w/g,
      'all data-tool-id querySelector calls should use sanitizeId')
  })

  it('stores sanitized IDs in data-msg-id attributes', () => {
    // Every setAttribute("data-msg-id", ...) call must use sanitizeId
    const allMsgIdSets = html.match(/setAttribute\("data-msg-id",\s*[^)]+\)/g) || []
    assert.ok(allMsgIdSets.length > 0, 'should have data-msg-id setAttribute calls')
    for (const call of allMsgIdSets) {
      assert.ok(call.includes('sanitizeId'), `setAttribute call should use sanitizeId: ${call}`)
    }
  })

  it('stores sanitized IDs in data-tool-id attributes', () => {
    // Every setAttribute("data-tool-id", ...) call must use sanitizeId
    const allToolIdSets = html.match(/setAttribute\("data-tool-id",\s*[^)]+\)/g) || []
    assert.ok(allToolIdSets.length > 0, 'should have data-tool-id setAttribute calls')
    for (const call of allToolIdSets) {
      assert.ok(call.includes('sanitizeId'), `setAttribute call should use sanitizeId: ${call}`)
    }
  })
})

describe('#760 — javascript: URI blocking in markdown links', () => {
  const html = getFullContent(8765, 'test-token', false)

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
  const html = getFullContent(8765, 'test-token', false)

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
    assert.ok(css.includes('#plan-mode-banner'),
      'should have CSS rules for plan mode banner')
  })

  it('has plan approval card CSS', () => {
    assert.ok(css.includes('#plan-approval-card'),
      'should have CSS rules for plan approval card')
  })
})

describe('#761 — plan mode message handlers', () => {
  const html = getFullContent(8765, 'test-token', false)

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

  it('hides stale approval card on plan_started', () => {
    const planStartedBlock = html.match(/case "plan_started"[\s\S]*?break;/)
    assert.ok(planStartedBlock, 'plan_started handler should exist')
    assert.ok(
      planStartedBlock[0].includes('planApprovalCard') && planStartedBlock[0].includes('add'),
      'plan_started should hide any stale plan approval card from a previous cycle'
    )
  })
})

describe('#761 — background agent UI elements', () => {
  const html = getFullContent(8765, 'test-token', false)

  it('has agent badge element in status bar', () => {
    assert.ok(html.includes('id="status-agents"'),
      'should have agent badge element')
  })

  it('agent badge is hidden by default', () => {
    assert.ok(html.includes('class="agent-badge hidden"'),
      'agent badge should be hidden by default')
  })

  it('has agent badge CSS', () => {
    assert.ok(css.includes('.agent-badge'),
      'should have CSS rules for agent badge')
  })
})

describe('#761 — background agent message handlers', () => {
  const html = getFullContent(8765, 'test-token', false)

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

describe('#733 — create session modal', () => {
  const html = getFullContent(8765, 'test-token', false)

  it('has modal overlay element', () => {
    assert.ok(html.includes('id="create-session-modal"'),
      'should have create session modal element')
  })

  it('modal is hidden by default', () => {
    assert.ok(html.includes('id="create-session-modal" class="modal-overlay hidden"'),
      'modal should be hidden by default')
  })

  it('has session name input', () => {
    assert.ok(html.includes('id="modal-session-name"'),
      'should have session name input')
    assert.ok(html.includes('placeholder="Session name"'),
      'session name input should have placeholder')
  })

  it('has CWD input', () => {
    assert.ok(html.includes('id="modal-session-cwd"'),
      'should have CWD input')
    assert.ok(html.includes('placeholder="Working directory (optional)"'),
      'CWD input should have placeholder')
  })

  it('has Create button', () => {
    assert.ok(html.includes('id="modal-create-btn"'),
      'should have Create button')
    assert.ok(html.includes('>Create<'),
      'Create button should have label')
  })

  it('has Cancel button', () => {
    assert.ok(html.includes('id="modal-cancel-btn"'),
      'should have Cancel button')
    assert.ok(html.includes('>Cancel<'),
      'Cancel button should have label')
  })

  it('has modal title "New Session"', () => {
    assert.ok(html.includes('New Session'),
      'modal should have title "New Session"')
  })

  it('has modal CSS styles', () => {
    assert.ok(css.includes('.modal-overlay'),
      'should have modal overlay CSS')
    assert.ok(css.includes('.modal-content'),
      'should have modal content CSS')
  })

  it('sends create_session message with name and cwd', () => {
    assert.ok(html.includes('type: "create_session"'),
      'should send create_session WS message')
    // Verify cwd is included in the message
    assert.ok(html.includes('msg.cwd = cwd'),
      'should include cwd in create_session message')
  })

  it('has openCreateSessionModal function', () => {
    assert.ok(html.includes('function openCreateSessionModal'),
      'should define openCreateSessionModal function')
  })

  it('has closeCreateSessionModal function', () => {
    assert.ok(html.includes('function closeCreateSessionModal'),
      'should define closeCreateSessionModal function')
  })

  it('closes modal on backdrop click', () => {
    assert.ok(html.includes('e.target === createSessionModal'),
      'should close modal when clicking backdrop')
  })
})

describe('#733 — destroy session', () => {
  const html = getFullContent(8765, 'test-token', false)

  it('has close button in session tabs', () => {
    assert.ok(html.includes('tab-close'),
      'should have tab-close class for destroy button')
  })

  it('sends destroy_session message', () => {
    assert.ok(html.includes('type: "destroy_session"'),
      'should send destroy_session WS message')
  })

  it('uses confirm dialog before destroying', () => {
    assert.ok(html.includes('window.confirm') && html.includes('Destroy session'),
      'should show confirm dialog before destroying session')
  })

  it('hides close button when only 1 session', () => {
    assert.ok(html.includes('sessions.length > 1'),
      'should check session count to decide whether to show close button')
  })

  it('has tab-close CSS styles', () => {
    assert.ok(css.includes('.session-tab .tab-close'),
      'should have CSS for tab close button')
  })
})

describe('#733 — rename session', () => {
  const html = getFullContent(8765, 'test-token', false)

  it('has double-click handler for renaming', () => {
    assert.ok(html.includes('dblclick'),
      'should have dblclick event listener for rename')
  })

  it('sends rename_session message', () => {
    assert.ok(html.includes('type: "rename_session"'),
      'should send rename_session WS message')
  })

  it('has startInlineRename function', () => {
    assert.ok(html.includes('function startInlineRename'),
      'should define startInlineRename function')
  })

  it('has inline rename input CSS', () => {
    assert.ok(css.includes('.tab-rename-input'),
      'should have CSS for inline rename input')
  })

  it('commits rename on blur', () => {
    assert.ok(html.includes('"blur", commit'),
      'should commit rename on blur event')
  })

  it('cancels rename on Escape key', () => {
    const renameSection = html.match(/startInlineRename[\s\S]*?function cancel/)
    assert.ok(renameSection, 'should have rename with cancel function')
  })
})

describe('#733 — keyboard shortcuts', () => {
  const html = getFullContent(8765, 'test-token', false)

  it('has document keydown listener', () => {
    assert.ok(html.includes('document.addEventListener("keydown"'),
      'should register document-level keydown listener')
  })

  it('handles Escape key to close modal or interrupt', () => {
    // Escape should close modal first, then interrupt
    const escapeBlock = html.match(/e\.key === "Escape"[\s\S]*?modalOpen/)
    assert.ok(escapeBlock, 'Escape handler should check modalOpen state')
  })

  it('handles Ctrl/Cmd+N for new session modal', () => {
    assert.ok(html.includes('e.key === "n"') && html.includes('e.ctrlKey || e.metaKey'),
      'should handle Ctrl/Cmd+N to open new session modal')
  })

  it('calls openCreateSessionModal on Ctrl+N', () => {
    // Find the Ctrl+N handler block
    const ctrlNBlock = html.match(/e\.key === "n"[\s\S]*?openCreateSessionModal/)
    assert.ok(ctrlNBlock, 'Ctrl/Cmd+N should call openCreateSessionModal')
  })

  it('handles Ctrl/Cmd+1-9 for session switching', () => {
    assert.ok(html.includes('e.key >= "1"') && html.includes('e.key <= "9"'),
      'should handle Ctrl/Cmd+1-9 for session switching')
  })

  it('sends switch_session on Ctrl+1-9', () => {
    // The Ctrl+1-9 handler should use sessions[idx].sessionId
    const switchBlock = html.match(/e\.key >= "1"[\s\S]*?switch_session/)
    assert.ok(switchBlock, 'Ctrl/Cmd+1-9 should send switch_session message')
  })

  it('prevents default on handled shortcuts', () => {
    assert.ok(html.includes('e.preventDefault()'),
      'should call preventDefault on handled keyboard shortcuts')
  })

  it('handles Ctrl+Enter to send in input', () => {
    const ctrlEnterBlock = html.match(/e\.key === "Enter" && \(e\.ctrlKey \|\| e\.metaKey\)/)
    assert.ok(ctrlEnterBlock, 'should handle Ctrl/Cmd+Enter to send message')
  })

  it('skips shortcuts when focused on input or textarea', () => {
    assert.ok(html.includes('tag === "INPUT" || tag === "TEXTAREA"'),
      'should guard shortcuts when active element is INPUT or TEXTAREA')
  })

  it('skips Escape interrupt when rename input is focused', () => {
    assert.ok(html.includes('tab-rename-input'),
      'Escape handler should check for active rename input')
    const escapeGuard = html.match(/tab-rename-input[\s\S]*?return/)
    assert.ok(escapeGuard, 'should return early when rename input is active during Escape')
  })
})

describe('#733 — toast notifications', () => {
  const html = getFullContent(8765, 'test-token', false)

  it('has toast container element', () => {
    assert.ok(html.includes('id="toast-container"'),
      'should have toast container element')
  })

  it('has toast CSS styles', () => {
    assert.ok(css.includes('#toast-container'),
      'should have toast container CSS')
    assert.ok(css.includes('.toast'),
      'should have toast CSS class')
  })

  it('has toast close button CSS', () => {
    assert.ok(css.includes('.toast .toast-close'),
      'should have toast close button CSS')
  })

  it('has toast animation', () => {
    assert.ok(css.includes('@keyframes toastIn'),
      'should have toast entrance animation')
  })

  it('has showToast function', () => {
    assert.ok(html.includes('function showToast'),
      'should define showToast function')
  })

  it('auto-dismisses toasts after 5 seconds', () => {
    assert.ok(html.includes('5000'),
      'should auto-dismiss toasts after 5 seconds')
  })

  it('shows toast on server_error', () => {
    const errorBlock = html.match(/case "server_error"[\s\S]*?showToast/)
    assert.ok(errorBlock, 'server_error handler should call showToast')
  })

  it('shows toast on session_error', () => {
    const sessionErrorBlock = html.match(/case "session_error"[\s\S]*?showToast/)
    assert.ok(sessionErrorBlock, 'session_error handler should call showToast')
  })

  it('toast container has aria-live polite attribute', () => {
    assert.ok(html.includes('aria-live="polite"'),
      'toast container should have aria-live="polite" for screen readers')
  })

  it('toast container has role="status"', () => {
    assert.ok(html.includes('id="toast-container" role="status"'),
      'toast container should have role="status"')
  })

  it('individual toasts have role="alert"', () => {
    const showToastBlock = html.match(/function showToast[\s\S]*?toastContainer\.appendChild/)
    assert.ok(showToastBlock, 'showToast function should exist')
    assert.ok(showToastBlock[0].includes('role", "alert"') || showToastBlock[0].includes("role\", \"alert\""),
      'individual toasts should have role="alert"')
  })

  it('toast close button has aria-label', () => {
    assert.ok(html.includes('aria-label="Close notification"'),
      'toast close button should have descriptive aria-label')
  })

  it('caps visible toasts at 5', () => {
    const showToastBlock = html.match(/function showToast[\s\S]*?toastContainer\.appendChild/)
    assert.ok(showToastBlock, 'showToast function should exist')
    assert.ok(showToastBlock[0].includes('children.length >= 5'),
      'should evict oldest toasts when count reaches 5')
    assert.ok(showToastBlock[0].includes('removeChild(toastContainer.firstChild)'),
      'should remove oldest toast (FIFO) when cap is reached')
  })
})

describe('#733 — reconnect banner', () => {
  const html = getFullContent(8765, 'test-token', false)

  it('has reconnect banner element', () => {
    assert.ok(html.includes('id="reconnect-banner"'),
      'should have reconnect banner element')
  })

  it('reconnect banner is hidden by default', () => {
    assert.ok(html.includes('id="reconnect-banner" class="hidden"'),
      'reconnect banner should be hidden by default')
  })

  it('has reconnect text span', () => {
    assert.ok(html.includes('id="reconnect-text"'),
      'should have reconnect-text span for dynamic text')
  })

  it('handles server_shutdown message', () => {
    assert.ok(html.includes('case "server_shutdown"'),
      'should handle server_shutdown WS message')
  })

  it('shows "Server restarting..." on restart', () => {
    const shutdownBlock = html.match(/case "server_shutdown"[\s\S]*?break;/)
    assert.ok(shutdownBlock, 'server_shutdown handler should exist')
    assert.ok(shutdownBlock[0].includes('Server restarting'),
      'should show "Server restarting..." text for restart reason')
  })

  it('shows "Server shutting down..." on shutdown', () => {
    const shutdownBlock = html.match(/case "server_shutdown"[\s\S]*?break;/)
    assert.ok(shutdownBlock, 'server_shutdown handler should exist')
    assert.ok(shutdownBlock[0].includes('Server shutting down'),
      'should show "Server shutting down..." for non-restart reason')
  })

  it('tracks initial connection state', () => {
    assert.ok(html.includes('hadInitialConnect'),
      'should track whether initial connection was made')
  })
})

describe('#733 — user question prompts with options', () => {
  const html = getFullContent(8765, 'test-token', false)

  it('handles user_question message', () => {
    assert.ok(html.includes('case "user_question"'),
      'should handle user_question WS message')
  })

  it('passes options to addQuestionPrompt', () => {
    assert.ok(html.includes('questionOptions'),
      'should extract options from question data')
  })

  it('renders option buttons when options are provided', () => {
    assert.ok(html.includes('q-option-btn'),
      'should render option buttons with q-option-btn class')
  })

  it('has q-options container for option buttons', () => {
    assert.ok(html.includes('q-options'),
      'should have q-options container class')
  })

  it('sends question_response when option clicked', () => {
    assert.ok(html.includes('user_question_response'),
      'should send user_question_response WS message')
  })

  it('grays out question after answering', () => {
    assert.ok(css.includes('.question-prompt.answered'),
      'should have CSS for answered state')
  })

  it('has option button CSS styles', () => {
    assert.ok(css.includes('.question-prompt .q-option-btn'),
      'should have CSS for option buttons')
  })

  it('hides options after answering', () => {
    assert.ok(css.includes('.question-prompt.answered .q-options'),
      'should hide options when answered')
  })

  it('shows answer text after submitting', () => {
    assert.ok(html.includes('q-answer-text'),
      'should have answer text element')
  })

  it('prevents duplicate option button submissions', () => {
    const optionGuard = html.match(/q-option-btn[\s\S]*?classList\.contains\("answered"\)\s*\)\s*return/)
    assert.ok(optionGuard, 'option click handler should check answered class before sending')
  })

  it('prevents duplicate text input submissions', () => {
    const textGuard = html.match(/function submitAnswer[\s\S]*?classList\.contains\("answered"\)\s*\)\s*return/)
    assert.ok(textGuard, 'submitAnswer should check answered class before sending')
  })
})

describe('#733 — status bar busy indicator', () => {
  const html = getFullContent(8765, 'test-token', false)

  it('has busy indicator element', () => {
    assert.ok(html.includes('id="status-busy"'),
      'should have busy indicator element in status bar')
  })

  it('busy indicator is hidden by default', () => {
    assert.ok(html.includes('id="status-busy" class="busy-indicator hidden"'),
      'busy indicator should be hidden by default')
  })

  it('has busy indicator CSS', () => {
    assert.ok(css.includes('.busy-indicator'),
      'should have busy-indicator CSS class')
  })

  it('has busy pulse animation', () => {
    assert.ok(css.includes('@keyframes busyPulse'),
      'should have busyPulse animation keyframes')
  })

  it('has updateBusyIndicator function', () => {
    assert.ok(html.includes('function updateBusyIndicator'),
      'should define updateBusyIndicator function')
  })

  it('updates busy indicator on agent_busy', () => {
    const busyBlock = html.match(/case "agent_busy"[\s\S]*?break;/)
    assert.ok(busyBlock, 'agent_busy handler should exist')
    assert.ok(busyBlock[0].includes('updateBusyIndicator'),
      'agent_busy should update busy indicator')
  })

  it('updates busy indicator on agent_idle', () => {
    const idleBlock = html.match(/case "agent_idle"[\s\S]*?break;/)
    assert.ok(idleBlock, 'agent_idle handler should exist')
    assert.ok(idleBlock[0].includes('updateBusyIndicator'),
      'agent_idle should update busy indicator')
  })

  it('updates busy indicator on stream_start', () => {
    const streamBlock = html.match(/case "stream_start"[\s\S]*?break;/)
    assert.ok(streamBlock, 'stream_start handler should exist')
    assert.ok(streamBlock[0].includes('updateBusyIndicator'),
      'stream_start should update busy indicator')
  })

  it('updates busy indicator on claude_ready', () => {
    const readyBlock = html.match(/case "claude_ready"[\s\S]*?break;/)
    assert.ok(readyBlock, 'claude_ready handler should exist')
    assert.ok(readyBlock[0].includes('updateBusyIndicator'),
      'claude_ready should update busy indicator')
  })
})

describe('#886 — syntax highlighting', () => {
  const html = getFullContent(8765, 'test-token', false)

  it('defines SYNTAX_COLORS map with all token types', () => {
    assert.ok(html.includes('var SYNTAX_COLORS = {'),
      'should define SYNTAX_COLORS')
    // Note: 'function' is quoted as '"function"' in JS (reserved word)
    for (const type of ['keyword', 'string', 'comment', 'number', 'operator', 'punctuation', 'type', 'property', 'plain', 'diff_add', 'diff_remove']) {
      assert.ok(html.includes(`${type}: "`),
        `SYNTAX_COLORS should include ${type}`)
    }
    // 'function' is a reserved word, so it's quoted differently in the object literal
    assert.ok(html.includes('"function": "#4a9eff"'),
      'SYNTAX_COLORS should include function token type (quoted key)')
  })

  it('uses mobile app color theme', () => {
    assert.ok(html.includes('#c4a5ff'), 'keyword color')
    assert.ok(html.includes('#4eca6a'), 'string color')
    assert.ok(html.includes('#7a7a7a'), 'comment color')
    assert.ok(html.includes('#ff9a52'), 'number color')
    assert.ok(html.includes('#a0d0ff'), 'plain color')
    assert.ok(html.includes('#ff5b5b'), 'diff_remove color')
  })

  it('defines stickyRe helper', () => {
    assert.ok(html.includes('function stickyRe(pattern)'),
      'should define stickyRe for adding sticky flag to regex')
  })

  it('defines language rule sets', () => {
    for (const lang of ['LANG_JS', 'LANG_TS', 'LANG_PY', 'LANG_BASH', 'LANG_JSON', 'LANG_DIFF', 'LANG_HTML', 'LANG_CSS', 'LANG_YAML', 'LANG_GO', 'LANG_RUST', 'LANG_JAVA', 'LANG_RUBY', 'LANG_C', 'LANG_SQL']) {
      assert.ok(html.includes(`var ${lang} = [`),
        `should define ${lang} language rules`)
    }
  })

  it('defines SYNTAX_LANGS lookup map', () => {
    assert.ok(html.includes('var SYNTAX_LANGS = {'),
      'should define SYNTAX_LANGS map')
    assert.ok(html.includes('javascript: LANG_JS'),
      'should map javascript to LANG_JS')
    assert.ok(html.includes('python: LANG_PY'),
      'should map python to LANG_PY')
  })

  it('defines SYNTAX_ALIASES for common abbreviations', () => {
    assert.ok(html.includes('var SYNTAX_ALIASES = {'),
      'should define SYNTAX_ALIASES')
    assert.ok(html.includes('js: "javascript"'), 'js → javascript alias')
    assert.ok(html.includes('ts: "typescript"'), 'ts → typescript alias')
    assert.ok(html.includes('py: "python"'), 'py → python alias')
    assert.ok(html.includes('sh: "bash"'), 'sh → bash alias')
    assert.ok(html.includes('rs: "rust"'), 'rs → rust alias')
    assert.ok(html.includes('yml: "yaml"'), 'yml → yaml alias')
  })

  it('defines getSyntaxRules function', () => {
    assert.ok(html.includes('function getSyntaxRules(lang)'),
      'should define getSyntaxRules lookup function')
  })

  it('defines tokenize function with MAX_HIGHLIGHT_LENGTH guard', () => {
    assert.ok(html.includes('function tokenize(code, lang)'),
      'should define tokenize function')
    assert.ok(html.includes('var MAX_HIGHLIGHT_LENGTH = 5000'),
      'should set MAX_HIGHLIGHT_LENGTH to 5000')
  })

  it('defines pushToken and highlightCode functions', () => {
    assert.ok(html.includes('function pushToken(tokens, text, type)'),
      'should define pushToken helper')
    assert.ok(html.includes('function highlightCode(code, lang)'),
      'should define highlightCode function')
  })

  it('highlightCode uses inline style for coloring', () => {
    assert.ok(html.includes('SYNTAX_COLORS[tokens[i].type]'),
      'highlightCode should look up color from SYNTAX_COLORS per token type')
  })

  it('uses highlightCode in renderMarkdown for code blocks', () => {
    assert.ok(html.includes('highlightCode(code, lang)'),
      'renderMarkdown should call highlightCode for fenced code blocks')
  })
})

describe('#886 — enriched session tabs', () => {
  const html = getFullContent(8765, 'test-token', false)

  it('has tab-busy-dot CSS', () => {
    assert.ok(css.includes('.tab-busy-dot'),
      'should have CSS for busy dot in session tabs')
  })

  it('renders busy dot when session is busy', () => {
    assert.ok(html.includes('s.isBusy'),
      'should check isBusy flag on session')
    const busyBlock = html.match(/s\.isBusy[\s\S]*?tab-busy-dot/)
    assert.ok(busyBlock, 'should create tab-busy-dot element when s.isBusy is true')
  })

  it('has tab-cwd CSS', () => {
    assert.ok(css.includes('.tab-cwd'),
      'should have CSS for cwd display in session tabs')
  })

  it('renders abbreviated cwd from session', () => {
    assert.ok(html.includes('s.cwd'),
      'should check cwd on session')
    // Uses platform-safe path splitting (in rendered HTML, \\\\ becomes \\)
    assert.ok(html.includes('.split(/[\\/]/)'),
      'should split cwd on both forward and back slashes')
  })

  it('shows full cwd path on hover via title attribute', () => {
    assert.ok(html.includes('cwdSpan.title = s.cwd'),
      'should set title to full cwd for hover tooltip')
  })

  it('has tab-model CSS', () => {
    assert.ok(css.includes('.tab-model'),
      'should have CSS for model badge in session tabs')
  })

  it('renders shortened model name', () => {
    assert.ok(html.includes('s.model'),
      'should check model on session')
    // Strips "claude-" prefix and version suffix
    assert.ok(html.includes('.replace(/^claude-/, "")'),
      'should strip claude- prefix from model name')
  })
})

describe('#886 — permission countdown timer', () => {
  const html = getFullContent(8765, 'test-token', false)

  it('has perm-countdown CSS', () => {
    assert.ok(css.includes('.perm-countdown'),
      'should have CSS for permission countdown')
    assert.ok(css.includes('.perm-countdown.urgent'),
      'should have CSS for urgent (red) countdown state')
    assert.ok(css.includes('.perm-countdown.expired'),
      'should have CSS for expired countdown state')
  })

  it('adds countdown element in permission prompt HTML', () => {
    assert.ok(html.includes('<div class="perm-countdown"'),
      'should include perm-countdown div element in permission prompt markup')
  })

  it('addPermissionPrompt accepts remainingMs and skipLog parameters', () => {
    assert.ok(html.includes('function addPermissionPrompt(requestId, tool, description, remainingMs, skipLog)'),
      'addPermissionPrompt should accept remainingMs and skipLog parameters')
  })

  it('handles active countdown with interval', () => {
    assert.ok(html.includes('typeof remainingMs === "number"'),
      'should check typeof remainingMs for numeric guard')
    assert.ok(html.includes('setInterval(updateCountdown, 1000)'),
      'should create 1-second interval for countdown updates')
  })

  it('shows minutes and seconds in countdown', () => {
    assert.ok(html.includes('Math.floor(remaining / 60000)'),
      'should compute minutes from remaining ms')
    assert.ok(html.includes('Math.floor((remaining % 60000) / 1000)'),
      'should compute seconds from remaining ms')
  })

  it('adds urgent class when 30 seconds or less remain', () => {
    assert.ok(html.includes('remaining <= 30000'),
      'should check for 30-second threshold')
    const urgentBlock = html.match(/remaining <= 30000[\s\S]*?urgent/)
    assert.ok(urgentBlock, 'should add urgent class at 30s threshold')
  })

  it('handles immediately expired countdown (remainingMs <= 0)', () => {
    // The else branch of `remainingMs > 0` handles zero/negative values
    // It should set "Timed out" text and add the expired class
    const expiredBlock = html.match(/} else \{[\s\S]*?Timed out[\s\S]*?expired/)
    assert.ok(expiredBlock,
      'should show "Timed out" and add expired class for zero/negative remainingMs')
  })

  it('hides countdown when remainingMs is not provided', () => {
    assert.ok(html.includes('countdownEl.style.display = "none"'),
      'should hide countdown element when no remainingMs (older servers)')
  })

  it('tracks active countdown intervals for cleanup', () => {
    assert.ok(html.includes('var activeCountdowns = []'),
      'should track active countdown intervals in an array')
    assert.ok(html.includes('activeCountdowns.push(countdownInterval)'),
      'should push new intervals to activeCountdowns')
  })

  it('clears countdown intervals on session switch', () => {
    const switchBlock = html.match(/case "session_switched"[\s\S]*?activeCountdowns = \[\]/)
    assert.ok(switchBlock, 'should clear activeCountdowns on session_switched')
    assert.ok(switchBlock[0].includes('clearInterval'),
      'should call clearInterval on each active countdown')
  })

  it('clears countdown interval when permission is answered', () => {
    const answerBlock = html.match(/clearInterval\(countdownInterval\)[\s\S]*?sendPermissionResponse/)
    assert.ok(answerBlock, 'should clear interval before sending permission response')
  })

  it('passes remainingMs from permission_request message', () => {
    assert.ok(html.includes('addPermissionPrompt(msg.requestId, msg.tool || "Unknown", msg.description || "", msg.remainingMs)'),
      'permission_request handler should pass msg.remainingMs to addPermissionPrompt')
  })
})

describe('#886 — reconnect backoff', () => {
  const html = getFullContent(8765, 'test-token', false)

  it('defines RETRY_DELAYS array', () => {
    assert.ok(html.includes('var RETRY_DELAYS = [1000, 2000, 3000, 5000, 8000]'),
      'should define escalating retry delays')
  })

  it('defines MAX_RETRIES constant', () => {
    assert.ok(html.includes('var MAX_RETRIES = 8'),
      'should allow up to 8 reconnect attempts')
  })

  it('tracks reconnect attempt count', () => {
    assert.ok(html.includes('var reconnectAttempt = 0'),
      'should track reconnect attempts starting at 0')
  })

  it('has reconnect retry button element', () => {
    assert.ok(html.includes('id="reconnect-retry-btn"'),
      'should have retry button in reconnect banner')
  })

  it('retry button is hidden by default', () => {
    assert.ok(html.includes('id="reconnect-retry-btn" class="hidden"'),
      'retry button should be hidden initially')
  })

  it('has retry button CSS', () => {
    assert.ok(css.includes('#reconnect-retry-btn'),
      'should have CSS for reconnect retry button')
  })

  it('uses escalating delay from RETRY_DELAYS', () => {
    assert.ok(html.includes('RETRY_DELAYS[Math.min(reconnectAttempt, RETRY_DELAYS.length - 1)]'),
      'should pick delay from RETRY_DELAYS clamped to array bounds')
  })

  it('shows attempt counter in reconnect text', () => {
    assert.ok(html.includes('(reconnectAttempt + 1) + "/" + MAX_RETRIES'),
      'should display attempt number / max retries')
  })

  it('shows "Connection lost." when max retries exhausted', () => {
    assert.ok(html.includes('Connection lost.'),
      'should show connection lost message after max retries')
  })

  it('shows retry button when max retries exhausted', () => {
    const exhaustedBlock = html.match(/Connection lost[\s\S]*?reconnectRetryBtn[\s\S]*?remove\("hidden"\)/)
    assert.ok(exhaustedBlock, 'should show retry button when connection lost')
  })

  it('resets reconnect attempt on successful auth', () => {
    assert.ok(html.includes('reconnectAttempt = 0'),
      'should reset reconnectAttempt to 0 on auth_ok or server restart')
  })

  it('increments reconnect attempt before each retry', () => {
    const retryBlock = html.match(/reconnectAttempt\+\+[\s\S]*?connect\(\)/)
    assert.ok(retryBlock, 'should increment reconnectAttempt then call connect()')
  })

  it('gets reconnectRetryBtn element by ID', () => {
    assert.ok(html.includes('document.getElementById("reconnect-retry-btn")'),
      'should get retry button element')
  })
})

describe('#975 — re-auth mechanism after token rotation', () => {
  const html = getFullContent(8765, 'test-token', false)

  it('stops reconnect loop on token_rotated message', () => {
    const handler = html.match(/case "token_rotated"[\s\S]*?break;/)
    assert.ok(handler, 'should handle token_rotated message')
    assert.ok(handler[0].includes('clearTimeout(reconnectTimer)'),
      'should clear reconnect timer on token rotation')
  })

  it('shows token input field for re-authentication', () => {
    assert.ok(html.includes('id="reauth-input"'),
      'should have a token input field for re-authentication')
  })

  it('has re-auth container in reconnect banner', () => {
    assert.ok(html.includes('id="reauth-container"'),
      'should have a reauth container element')
  })

  it('updates token and reconnects on re-auth submit', () => {
    assert.ok(html.includes('function submitReauth'),
      'should define submitReauth function')
  })

  it('has re-auth CSS styles', () => {
    assert.ok(css.includes('#reauth-container'),
      'should have CSS for reauth container')
    assert.ok(css.includes('#reauth-input'),
      'should have CSS for reauth input')
  })
})

describe('#891 — negative assertions for week 2 features', () => {
  const html = getFullContent(8765, 'test-token', false)

  it('syntax highlighting falls back to plain for unknown languages', () => {
    // tokenize returns plain tokens when lang has no rules (getSyntaxRules returns null)
    assertHtml(html, '!rules) return [{ text: code, type: "plain" }]',
      'tokenize should return plain tokens when language rules are not found')
  })

  it('syntax highlighting falls back to plain when lang is falsy', () => {
    assertHtml(html, '!lang || code.length > MAX_HIGHLIGHT_LENGTH) return [{ text: code, type: "plain" }]',
      'tokenize should return plain tokens when lang is falsy')
  })

  it('countdown is hidden (not just empty) when remainingMs is non-numeric', () => {
    // The else branch (no remainingMs) sets display:none, not just leaves it empty
    const hideBranch = html.match(/No remainingMs[\s\S]*?display = "none"/) ||
                        html.match(/} else \{[\s\S]*?countdownEl\.style\.display = "none"/)
    assert.ok(hideBranch,
      'countdown should be display:none when remainingMs is not a number, not just empty')
  })

  it('retry button is explicitly hidden during active backoff', () => {
    // Before starting backoff loop, retry button is hidden
    assertHtml(html, 'reconnectRetryBtn.classList.add("hidden")',
      'retry button should be hidden when backoff starts (not just on initial render)')
  })

  it('model badge is not rendered when s.model is falsy', () => {
    // The s.model check is an if guard — no badge created when falsy
    const modelGuard = html.match(/if \(s\.model\)/)
    assert.ok(modelGuard,
      'model badge rendering should be guarded by if (s.model)')
  })

  it('busy dot is not rendered when s.isBusy is false', () => {
    // The s.isBusy check is an if guard — no dot created when false
    const busyGuard = html.match(/if \(s\.isBusy\)/)
    assert.ok(busyGuard,
      'busy dot rendering should be guarded by if (s.isBusy)')
  })

  it('cwd span is not rendered when s.cwd is falsy', () => {
    const cwdGuard = html.match(/if \(s\.cwd\)/)
    assert.ok(cwdGuard,
      'cwd span rendering should be guarded by if (s.cwd)')
  })

  it('countdown interval is not created for non-numeric remainingMs', () => {
    // typeof check ensures only numbers trigger setInterval
    assertHtml(html, 'typeof remainingMs === "number"',
      'interval creation should be guarded by typeof check')
  })
})

describe('#610 — responsive CSS for mobile browsers', () => {
  const html = getFullContent(8765, 'test-token', false)

  it('has responsive media query for small screens', () => {
    assert.ok(css.includes('@media (max-width: 600px)'),
      'should have mobile-specific media query')
  })

  it('adjusts message width for small screens', () => {
    assert.ok(css.includes('max-width: 92%'),
      'should widen messages on mobile screens')
  })

  it('has viewport meta tag', () => {
    assert.ok(html.includes('name="viewport"'),
      'should have viewport meta tag for mobile rendering')
  })
})

describe('#934 — dynamic permission mode select', () => {
  const html = getFullContent(8765, 'test-token', false)

  it('includes acceptEdits in initial permission select options', () => {
    assertHtml(html, '<option value="acceptEdits">Accept Edits</option>',
      'should have acceptEdits option in permission select')
  })

  it('lists permission options in server-canonical order: approve, acceptEdits, auto, plan', () => {
    const approveIdx = html.indexOf('<option value="approve">')
    const acceptEditsIdx = html.indexOf('<option value="acceptEdits">')
    const autoIdx = html.indexOf('<option value="auto">')
    const planIdx = html.indexOf('<option value="plan">')
    assert.ok(approveIdx < acceptEditsIdx, 'approve should come before acceptEdits')
    assert.ok(acceptEditsIdx < autoIdx, 'acceptEdits should come before auto')
    assert.ok(autoIdx < planIdx, 'auto should come before plan')
  })

  it('dynamically populates permission select from available_permission_modes message', () => {
    assertHtml(html, 'case "available_permission_modes"',
      'should handle available_permission_modes WS message')
    // Should rebuild select options from msg.modes array
    assertHtml(html, 'permissionSelect.innerHTML',
      'should clear and rebuild permission select options')
  })

  it('preserves current selection when updating permission options', () => {
    assertHtml(html, 'var previousValue = permissionSelect.value',
      'should capture current selection before clearing options')
    assertHtml(html, 'permissionSelect.value = previousValue',
      'should restore captured selection after rebuilding options')
    assertHtml(html, 'permissionSelect.value = permissionMode',
      'should fall back to permissionMode state if previous value no longer available')
  })
})
