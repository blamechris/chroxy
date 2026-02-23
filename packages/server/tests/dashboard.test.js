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

describe('#762 — sanitizeId strips special characters', () => {
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

describe('#762 — querySelector calls use sanitized IDs', () => {
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

  it('hides stale approval card on plan_started', () => {
    const planStartedBlock = html.match(/case "plan_started"[\s\S]*?break;/)
    assert.ok(planStartedBlock, 'plan_started handler should exist')
    assert.ok(
      planStartedBlock[0].includes('planApprovalCard') && planStartedBlock[0].includes('add'),
      'plan_started should hide any stale plan approval card from a previous cycle'
    )
  })
})

describe('#774 — session_created handler', () => {
  const html = getDashboardHtml(8765, 'test-token', false)

  it('handles session_created message', () => {
    assert.ok(html.includes('case "session_created"'),
      'should handle session_created WS message')
  })

  it('calls renderSessions on session_created', () => {
    const sessionCreatedBlock = html.match(/case "session_created"[\s\S]*?break;/)
    assert.ok(sessionCreatedBlock, 'session_created handler should exist')
    assert.ok(sessionCreatedBlock[0].includes('renderSessions'),
      'session_created should re-render session tabs')
  })

  it('shows toast on session_created', () => {
    const sessionCreatedBlock = html.match(/case "session_created"[\s\S]*?break;/)
    assert.ok(sessionCreatedBlock, 'session_created handler should exist')
    assert.ok(sessionCreatedBlock[0].includes('showToast'),
      'session_created should show a toast notification')
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

describe('#733 — create session modal', () => {
  const html = getDashboardHtml(8765, 'test-token', false)

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
    assert.ok(html.includes('.modal-overlay'),
      'should have modal overlay CSS')
    assert.ok(html.includes('.modal-content'),
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
  const html = getDashboardHtml(8765, 'test-token', false)

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
    assert.ok(html.includes('.session-tab .tab-close'),
      'should have CSS for tab close button')
  })
})

describe('#733 — rename session', () => {
  const html = getDashboardHtml(8765, 'test-token', false)

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
    assert.ok(html.includes('.tab-rename-input'),
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
  const html = getDashboardHtml(8765, 'test-token', false)

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
  const html = getDashboardHtml(8765, 'test-token', false)

  it('has toast container element', () => {
    assert.ok(html.includes('id="toast-container"'),
      'should have toast container element')
  })

  it('has toast CSS styles', () => {
    assert.ok(html.includes('#toast-container'),
      'should have toast container CSS')
    assert.ok(html.includes('.toast'),
      'should have toast CSS class')
  })

  it('has toast close button CSS', () => {
    assert.ok(html.includes('.toast .toast-close'),
      'should have toast close button CSS')
  })

  it('has toast animation', () => {
    assert.ok(html.includes('@keyframes toastIn'),
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
  const html = getDashboardHtml(8765, 'test-token', false)

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
  const html = getDashboardHtml(8765, 'test-token', false)

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
    assert.ok(html.includes('.question-prompt.answered'),
      'should have CSS for answered state')
  })

  it('has option button CSS styles', () => {
    assert.ok(html.includes('.question-prompt .q-option-btn'),
      'should have CSS for option buttons')
  })

  it('hides options after answering', () => {
    assert.ok(html.includes('.question-prompt.answered .q-options'),
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
  const html = getDashboardHtml(8765, 'test-token', false)

  it('has busy indicator element', () => {
    assert.ok(html.includes('id="status-busy"'),
      'should have busy indicator element in status bar')
  })

  it('busy indicator is hidden by default', () => {
    assert.ok(html.includes('id="status-busy" class="busy-indicator hidden"'),
      'busy indicator should be hidden by default')
  })

  it('has busy indicator CSS', () => {
    assert.ok(html.includes('.busy-indicator'),
      'should have busy-indicator CSS class')
  })

  it('has busy pulse animation', () => {
    assert.ok(html.includes('@keyframes busyPulse'),
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
