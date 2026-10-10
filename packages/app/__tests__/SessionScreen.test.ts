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

  test('shows context occupancy information (#6769)', () => {
    // #6769: the meter reads the occupancy snapshot, not the billing usage.
    expect(src).toMatch(/contextOccupancy/)
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

  // The chat filter lives in src/screens/selectChatMessages.ts (#7201) and its
  // behaviour -- compaction markers surviving compact mode (#7186), every other
  // system event excluded, the injected compact predicate honoured (#6882) -- is
  // pinned by src/screens/__tests__/selectChatMessages.test.ts. What only this
  // file can see is the wiring: SessionScreen must hand the SHARED store-core
  // predicate to that selector and must not grow its own copy of the filter.
  //
  // There is deliberately no `m.type === 'system'` negative guard here:
  // SessionScreen.tsx legitimately contains that text (the System tab label), so
  // any such negative would fail on correct code.
  describe('SessionScreen wires the chat filter to the shared predicate (#6882, #7201)', () => {
    // Boolean assertions, not toMatch against the whole file: a failing toMatch
    // on a multi-KB source would dump all of it into the error.
    const SHARED_PREDICATE_IMPORT =
      /import\s*\{[^}]*\bisHiddenInCompactMode\b[^}]*\}\s*from\s*'@chroxy\/store-core'/
    const SELECTOR_IMPORT = /from\s*'\.\/selectChatMessages'/
    const DELEGATING_CALL =
      /selectChatMessages\(\s*allMessages\s*,\s*\{\s*chatFilterCompact\s*,\s*isHiddenInCompactMode\s*,?\s*\}\s*,?\s*\)/
    // The filter body, however it is spaced -- not the legitimate
    // `isHiddenInCompactMode` import or the shorthand property in the call above.
    const INLINE_COMPACT_FILTER = /chatFilterCompact\s*&&\s*(isHiddenInCompactMode\s*\(|\()/

    test('imports isHiddenInCompactMode from @chroxy/store-core', () => {
      expect(SHARED_PREDICATE_IMPORT.test(src)).toBe(true)
    })

    test('imports the selector', () => {
      expect(SELECTOR_IMPORT.test(src)).toBe(true)
    })

    test('hands the shared predicate to selectChatMessages', () => {
      expect(DELEGATING_CALL.test(src)).toBe(true)
    })

    test('keeps no inline copy of the compact filter', () => {
      expect(INLINE_COMPACT_FILTER.test(src)).toBe(false)
    })
  })
})
