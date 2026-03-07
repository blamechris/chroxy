import fs from 'fs'
import path from 'path'

const componentsDir = path.resolve(__dirname, '../src/components')

const inputBarSrc = fs.readFileSync(
  path.join(componentsDir, 'InputBar.tsx'),
  'utf-8',
)

const chatViewSrc = fs.readFileSync(
  path.join(componentsDir, 'ChatView.tsx'),
  'utf-8',
)

const sessionOverviewSrc = fs.readFileSync(
  path.join(componentsDir, 'SessionOverview.tsx'),
  'utf-8',
)

// ---------------------------------------------------------------------------
// InputBar
// ---------------------------------------------------------------------------

describe('InputBar component', () => {
  test('imports React and forwardRef', () => {
    expect(inputBarSrc).toMatch(/import\s+React.*forwardRef/)
  })

  test('imports core RN components (TextInput, TouchableOpacity)', () => {
    expect(inputBarSrc).toMatch(/import[\s\S]*TextInput[\s\S]*from\s+['"]react-native['"]/)
    expect(inputBarSrc).toMatch(/import[\s\S]*TouchableOpacity[\s\S]*from\s+['"]react-native['"]/)
  })

  test('exports InputBar as a named export', () => {
    expect(inputBarSrc).toMatch(/export\s+(const|function)\s+InputBar/)
  })

  test('defines InputBarProps interface with required props', () => {
    expect(inputBarSrc).toMatch(/export\s+interface\s+InputBarProps/)
    expect(inputBarSrc).toMatch(/inputText:\s*string/)
    expect(inputBarSrc).toMatch(/onSend:\s*\(\)/)
    expect(inputBarSrc).toMatch(/onInterrupt:\s*\(\)/)
    expect(inputBarSrc).toMatch(/isStreaming:\s*boolean/)
  })

  test('has send button with accessibilityRole and accessibilityLabel', () => {
    expect(inputBarSrc).toMatch(/accessibilityRole="button"/)
    expect(inputBarSrc).toMatch(/accessibilityLabel="Send message"/)
  })

  test('has interrupt button with accessibility label', () => {
    expect(inputBarSrc).toMatch(/accessibilityLabel="Interrupt Claude"/)
  })

  test('has enter-mode toggle with accessibility label', () => {
    expect(inputBarSrc).toMatch(/accessibilityLabel=\{enterToSend\s*\?/)
  })

  test('has microphone button with accessibility labels', () => {
    expect(inputBarSrc).toMatch(/accessibilityLabel.*Start voice input/)
    expect(inputBarSrc).toMatch(/accessibilityLabel.*Stop voice input/)
  })

  test('has attach file button with accessibility label', () => {
    expect(inputBarSrc).toMatch(/accessibilityLabel="Attach file"/)
  })

  test('has camera button with accessibility label', () => {
    expect(inputBarSrc).toMatch(/accessibilityLabel="Take photo"/)
  })

  test('shows placeholder text for different states', () => {
    expect(inputBarSrc).toMatch(/placeholder=\{/)
    expect(inputBarSrc).toMatch(/Message Claude/)
    expect(inputBarSrc).toMatch(/Connecting to Claude/)
    expect(inputBarSrc).toMatch(/Reconnecting/)
  })

  test('supports slash command dropdown', () => {
    expect(inputBarSrc).toMatch(/slashCommands/)
    expect(inputBarSrc).toMatch(/filteredCommands/)
    expect(inputBarSrc).toMatch(/accessibilityLabel=\{`Slash command \$\{cmd\.name\}`\}/)
  })

  test('renders special terminal keys when in terminal mode', () => {
    expect(inputBarSrc).toMatch(/\['Enter',\s*'Ctrl\+C',\s*'Tab',\s*'Escape'/)
    expect(inputBarSrc).toMatch(/onKeyPress\(key\)/)
  })

  test('handles attachment strip rendering', () => {
    expect(inputBarSrc).toMatch(/attachments\.map/)
    expect(inputBarSrc).toMatch(/accessibilityLabel=\{`Remove \$\{att\.name\}`\}/)
  })

  test('uses disabled state for accessibilityState', () => {
    expect(inputBarSrc).toMatch(/accessibilityState=\{a11yDisabled\}/)
  })
})

// ---------------------------------------------------------------------------
// ChatView
// ---------------------------------------------------------------------------

describe('ChatView component', () => {
  test('imports React and hooks (useState, useRef, useEffect, useMemo)', () => {
    expect(chatViewSrc).toMatch(/import\s+React,\s*\{.*useState.*useRef.*useEffect.*useMemo/)
  })

  test('imports ScrollView, AccessibilityInfo from react-native', () => {
    expect(chatViewSrc).toMatch(/import[\s\S]*ScrollView[\s\S]*from\s+['"]react-native['"]/)
    expect(chatViewSrc).toMatch(/import[\s\S]*AccessibilityInfo[\s\S]*from\s+['"]react-native['"]/)
  })

  test('imports ChatMessage type from store', () => {
    expect(chatViewSrc).toMatch(/import\s*\{.*ChatMessage.*\}\s*from\s+['"]\.\.\/store\/connection['"]/)
  })

  test('imports child components (MessageBubble, ActivityGroup, ToolDetailModal)', () => {
    expect(chatViewSrc).toMatch(/import\s*\{.*MessageBubble.*\}/)
    expect(chatViewSrc).toMatch(/import\s*\{.*ActivityGroup.*\}/)
    expect(chatViewSrc).toMatch(/import\s*\{.*ToolDetailModal.*\}/)
  })

  test('exports ChatView as a named export', () => {
    expect(chatViewSrc).toMatch(/export\s+function\s+ChatView/)
  })

  test('defines ChatViewProps interface', () => {
    expect(chatViewSrc).toMatch(/export\s+interface\s+ChatViewProps/)
    expect(chatViewSrc).toMatch(/messages:\s*ChatMessage\[\]/)
    expect(chatViewSrc).toMatch(/claudeReady:\s*boolean/)
    expect(chatViewSrc).toMatch(/streamingMessageId:\s*string\s*\|\s*null/)
  })

  test('has scroll-to-top button with accessibility label', () => {
    expect(chatViewSrc).toMatch(/accessibilityLabel="Scroll to top of conversation"/)
  })

  test('has scroll-to-bottom button with accessibility label', () => {
    expect(chatViewSrc).toMatch(/accessibilityLabel="Scroll to bottom of conversation"/)
  })

  test('shows empty state text when no messages', () => {
    expect(chatViewSrc).toMatch(/messages\.length === 0/)
    expect(chatViewSrc).toMatch(/Connected\. Send a message to Claude!/)
    expect(chatViewSrc).toMatch(/Starting Claude Code\.\.\./)
  })

  test('groups messages using groupMessages helper', () => {
    expect(chatViewSrc).toMatch(/function\s+groupMessages/)
    expect(chatViewSrc).toMatch(/type:\s*'activity'/)
    expect(chatViewSrc).toMatch(/type:\s*'single'/)
  })

  test('listens for reduce motion accessibility setting', () => {
    expect(chatViewSrc).toMatch(/AccessibilityInfo\.addEventListener\(\s*'reduceMotionChanged'/)
    expect(chatViewSrc).toMatch(/AccessibilityInfo\.isReduceMotionEnabled/)
  })

  test('supports search highlighting via searchMatchIds and currentMatchId', () => {
    expect(chatViewSrc).toMatch(/searchQuery\?:\s*string/)
    expect(chatViewSrc).toMatch(/searchMatchIds\?:\s*Set<string>/)
    expect(chatViewSrc).toMatch(/currentMatchId\?:\s*string\s*\|\s*null/)
    expect(chatViewSrc).toMatch(/searchMatch/)
    expect(chatViewSrc).toMatch(/searchMatchCurrent/)
  })

  test('renders ImageViewer and ToolDetailModal overlays', () => {
    expect(chatViewSrc).toMatch(/<ImageViewer/)
    expect(chatViewSrc).toMatch(/<ToolDetailModal/)
  })
})

// ---------------------------------------------------------------------------
// PlanApprovalCard (inline in ChatView.tsx)
// ---------------------------------------------------------------------------

describe('PlanApprovalCard (in ChatView)', () => {
  test('defines PlanApprovalCard function component', () => {
    expect(chatViewSrc).toMatch(/function\s+PlanApprovalCard/)
  })

  test('shows "Plan Ready for Review" header text', () => {
    expect(chatViewSrc).toMatch(/Plan Ready for Review/)
  })

  test('has Approve button with accessibilityRole and label', () => {
    expect(chatViewSrc).toMatch(/accessibilityLabel="Approve plan"/)
    expect(chatViewSrc).toMatch(/accessibilityRole="button"/)
  })

  test('has Give Feedback button with accessibility label', () => {
    expect(chatViewSrc).toMatch(/accessibilityLabel="Give feedback on plan"/)
  })

  test('renders "Permissions needed" when allowedPrompts present', () => {
    expect(chatViewSrc).toMatch(/Permissions needed/)
    expect(chatViewSrc).toMatch(/allowedPrompts\.map/)
  })

  test('PlanApprovalCard is conditionally rendered when plan is pending', () => {
    expect(chatViewSrc).toMatch(/isPlanPending\s*&&\s*onApprovePlan/)
    expect(chatViewSrc).toMatch(/<PlanApprovalCard/)
  })
})

// ---------------------------------------------------------------------------
// SessionOverview
// ---------------------------------------------------------------------------

describe('SessionOverview component', () => {
  test('imports React and hooks (useEffect, useRef, useState)', () => {
    expect(sessionOverviewSrc).toMatch(/import\s+React,\s*\{.*useEffect.*useRef.*useState/)
  })

  test('imports useConnectionStore from store', () => {
    expect(sessionOverviewSrc).toMatch(/import\s*\{.*useConnectionStore.*\}\s*from\s+['"]\.\.\/store\/connection['"]/)
  })

  test('exports SessionOverview as a named export', () => {
    expect(sessionOverviewSrc).toMatch(/export\s+function\s+SessionOverview/)
  })

  test('reads multiple slices from useConnectionStore', () => {
    expect(sessionOverviewSrc).toMatch(/useConnectionStore\(.*sessions/)
    expect(sessionOverviewSrc).toMatch(/useConnectionStore\(.*activeSessionId/)
    expect(sessionOverviewSrc).toMatch(/useConnectionStore\(.*sessionStates/)
    expect(sessionOverviewSrc).toMatch(/useConnectionStore\(.*switchSession/)
    expect(sessionOverviewSrc).toMatch(/useConnectionStore\(.*destroySession/)
    expect(sessionOverviewSrc).toMatch(/useConnectionStore\(.*renameSession/)
    expect(sessionOverviewSrc).toMatch(/useConnectionStore\(.*totalCost/)
    expect(sessionOverviewSrc).toMatch(/useConnectionStore\(.*costBudget/)
  })

  test('has close button with accessibility label', () => {
    expect(sessionOverviewSrc).toMatch(/accessibilityLabel="Close session overview"/)
  })

  test('renders session header with "Sessions" title', () => {
    expect(sessionOverviewSrc).toMatch(/>Sessions</)
  })

  test('shows empty state text when no sessions', () => {
    expect(sessionOverviewSrc).toMatch(/No sessions yet/)
  })

  test('defines SessionCard sub-component with accessibility', () => {
    expect(sessionOverviewSrc).toMatch(/function\s+SessionCard/)
    expect(sessionOverviewSrc).toMatch(/accessibilityRole="button"/)
    expect(sessionOverviewSrc).toMatch(/accessibilityLabel=\{`Session \$\{session\.name\}/)
  })

  test('exports getSessionStatus helper for status classification', () => {
    expect(sessionOverviewSrc).toMatch(/export\s+function\s+getSessionStatus/)
    expect(sessionOverviewSrc).toMatch(/crashed.*permission.*attention.*agents.*busy.*idle/)
  })

  test('exports formatCost helper', () => {
    expect(sessionOverviewSrc).toMatch(/export\s+function\s+formatCost/)
  })

  test('exports getStatusColor helper', () => {
    expect(sessionOverviewSrc).toMatch(/export\s+function\s+getStatusColor/)
  })

  test('defines STATUS_LABELS for all statuses', () => {
    expect(sessionOverviewSrc).toMatch(/STATUS_LABELS/)
    expect(sessionOverviewSrc).toMatch(/Crashed/)
    expect(sessionOverviewSrc).toMatch(/Needs Approval/)
    expect(sessionOverviewSrc).toMatch(/Needs Attention/)
    expect(sessionOverviewSrc).toMatch(/Agents Running/)
    expect(sessionOverviewSrc).toMatch(/Working/)
    expect(sessionOverviewSrc).toMatch(/Idle/)
  })

  test('sorts sessions by status priority', () => {
    expect(sessionOverviewSrc).toMatch(/STATUS_PRIORITY/)
    expect(sessionOverviewSrc).toMatch(/sorted\.map/)
  })

  test('shows cost and budget in header', () => {
    expect(sessionOverviewSrc).toMatch(/totalCost/)
    expect(sessionOverviewSrc).toMatch(/costBudget/)
    expect(sessionOverviewSrc).toMatch(/formatCost\(totalCost\)/)
  })

  test('displays git branch in session card footer', () => {
    expect(sessionOverviewSrc).toMatch(/gitBranch/)
    expect(sessionOverviewSrc).toMatch(/gitText/)
  })
})
