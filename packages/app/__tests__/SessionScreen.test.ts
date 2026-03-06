import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/screens/SessionScreen.tsx'),
  'utf-8',
)

describe('SessionScreen component structure', () => {
  test('renders ChatView and TerminalView', () => {
    expect(src).toMatch(/import.*ChatView/)
    expect(src).toMatch(/import.*TerminalView/)
    expect(src).toMatch(/<ChatView/)
    expect(src).toMatch(/<TerminalView/)
  })

  test('renders InputBar for message input', () => {
    expect(src).toMatch(/import.*InputBar/)
    expect(src).toMatch(/<InputBar/)
  })

  test('has view mode toggle between chat and terminal', () => {
    expect(src).toMatch(/viewMode/)
    expect(src).toMatch(/setViewMode/)
  })

  test('reads messages from connection store', () => {
    expect(src).toMatch(/useConnectionStore/)
    expect(src).toMatch(/messages/)
  })

  test('supports sending input via store', () => {
    expect(src).toMatch(/sendInput/)
  })

  test('supports interrupt (stop) functionality', () => {
    expect(src).toMatch(/sendInterrupt/)
  })

  test('supports disconnect', () => {
    expect(src).toMatch(/disconnect/)
  })

  test('renders SessionPicker for multi-session', () => {
    expect(src).toMatch(/import.*SessionPicker/)
    expect(src).toMatch(/<SessionPicker/)
  })

  test('renders SettingsBar for model/permission controls', () => {
    expect(src).toMatch(/import.*SettingsBar/)
    expect(src).toMatch(/<SettingsBar/)
  })

  test('handles keyboard height for input positioning', () => {
    expect(src).toMatch(/useKeyboardHeight/)
    expect(src).toMatch(/keyboardHeight/)
  })

  test('displays connection phase state', () => {
    expect(src).toMatch(/connectionPhase/)
  })

  test('shows reconnecting banner when connection is lost', () => {
    expect(src).toMatch(/reconnecting/)
  })

  test('supports plan approval flow', () => {
    expect(src).toMatch(/isPlanPending/)
    expect(src).toMatch(/PLAN_APPROVAL_MESSAGE/)
  })

  test('shows active agents for background agent tracking', () => {
    expect(src).toMatch(/activeAgents/)
    expect(src).toMatch(/BackgroundSessionProgress/)
  })

  test('supports model switching', () => {
    expect(src).toMatch(/activeModel/)
    expect(src).toMatch(/availableModels/)
    expect(src).toMatch(/setModel/)
  })

  test('supports permission mode switching', () => {
    expect(src).toMatch(/permissionMode/)
    expect(src).toMatch(/setPermissionMode/)
    expect(src).toMatch(/sendPermissionResponse/)
  })

  test('supports file attachments', () => {
    expect(src).toMatch(/pendingAttachments/)
    expect(src).toMatch(/pickFromCamera/)
    expect(src).toMatch(/pickFromGallery/)
    expect(src).toMatch(/pickDocument/)
  })

  test('supports cached session viewing', () => {
    expect(src).toMatch(/viewingCachedSession/)
    expect(src).toMatch(/exitCachedSession/)
  })

  test('exports formatTranscript for copy/share', () => {
    expect(src).toMatch(/export function formatTranscript/)
  })

  test('shows context usage information', () => {
    expect(src).toMatch(/contextUsage/)
  })

  test('shows session cost tracking', () => {
    expect(src).toMatch(/sessionCost/)
    expect(src).toMatch(/costBudget/)
  })

  test('renders SessionNotificationBanner', () => {
    expect(src).toMatch(/import.*SessionNotificationBanner/)
    expect(src).toMatch(/<SessionNotificationBanner/)
  })

  test('renders DevPreviewBanner', () => {
    expect(src).toMatch(/import.*DevPreviewBanner/)
    expect(src).toMatch(/<DevPreviewBanner/)
  })

  test('supports create session modal', () => {
    expect(src).toMatch(/import.*CreateSessionModal/)
    expect(src).toMatch(/<CreateSessionModal/)
  })
})
