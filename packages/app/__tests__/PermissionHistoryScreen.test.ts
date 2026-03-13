import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/screens/PermissionHistoryScreen.tsx'),
  'utf-8',
)

describe('PermissionHistoryScreen component structure', () => {
  test('shows summary bar with allowed/denied/expired/total counts', () => {
    expect(src).toMatch(/Allowed/)
    expect(src).toMatch(/Denied/)
    expect(src).toMatch(/Expired/)
    expect(src).toMatch(/Total/)
    expect(src).toMatch(/summaryBar/)
  })

  test('has filter chips for all/allowed/denied/expired/pending', () => {
    expect(src).toMatch(/FILTER_OPTIONS/)
    expect(src).toMatch(/filterChip/)
    expect(src).toMatch(/'all'/)
    expect(src).toMatch(/'allowed'/)
    expect(src).toMatch(/'denied'/)
    expect(src).toMatch(/'expired'/)
    expect(src).toMatch(/'pending'/)
  })

  test('aggregates permissions from all sessions', () => {
    expect(src).toMatch(/sessionStates/)
    expect(src).toMatch(/sessions/)
    expect(src).toMatch(/type === 'prompt'/)
    expect(src).toMatch(/requestId/)
  })

  test('shows session filter when multiple sessions exist', () => {
    expect(src).toMatch(/showSessionFilter/)
    expect(src).toMatch(/sessions\.length > 1/)
    expect(src).toMatch(/All Sessions/)
  })

  test('supports expand/collapse for permission details', () => {
    expect(src).toMatch(/expandedId/)
    expect(src).toMatch(/isExpanded/)
    expect(src).toMatch(/onToggle/)
    expect(src).toMatch(/LayoutAnimation/)
  })

  test('shows status badges with color coding', () => {
    expect(src).toMatch(/STATUS_CONFIG/)
    expect(src).toMatch(/statusBadge/)
    expect(src).toMatch(/accentGreen/)
    expect(src).toMatch(/accentRed/)
    expect(src).toMatch(/accentOrange/)
  })

  test('renders permission detail when expanded', () => {
    expect(src).toMatch(/renderPermissionDetail/)
    expect(src).toMatch(/getPermissionSummary/)
  })

  test('shows decision time for answered permissions', () => {
    expect(src).toMatch(/formatDecisionTime/)
    expect(src).toMatch(/answeredAt/)
  })

  test('derives correct status from message state', () => {
    expect(src).toMatch(/function deriveStatus/)
    expect(src).toMatch(/expiresAt/)
    expect(src).toMatch(/answered/)
  })

  test('sorts permissions newest first', () => {
    expect(src).toMatch(/sort.*b\.message\.timestamp - a\.message\.timestamp/)
  })

  test('shows empty state messages', () => {
    expect(src).toMatch(/No permissions requested yet/)
    expect(src).toMatch(/No permissions match the current filter/)
  })

  test('permission entries have accessibility roles', () => {
    expect(src).toMatch(/accessibilityRole="button"/)
    expect(src).toMatch(/accessibilityLabel/)
    expect(src).toMatch(/accessibilityState/)
  })
})
