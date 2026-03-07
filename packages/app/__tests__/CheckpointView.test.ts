import fs from 'fs'
import path from 'path'

const componentSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/components/CheckpointView.tsx'),
  'utf-8',
)

const sessionScreenSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/screens/SessionScreen.tsx'),
  'utf-8',
)

describe('CheckpointView component structure', () => {
  test('imports useConnectionStore and Checkpoint type', () => {
    expect(componentSrc).toMatch(/import.*useConnectionStore/)
    expect(componentSrc).toMatch(/import.*Checkpoint/)
  })

  test('uses checkpoint store actions', () => {
    expect(componentSrc).toMatch(/createCheckpoint/)
    expect(componentSrc).toMatch(/listCheckpoints/)
    expect(componentSrc).toMatch(/deleteCheckpoint/)
    expect(componentSrc).toMatch(/restoreCheckpoint/)
  })

  test('reads checkpoints from store', () => {
    expect(componentSrc).toMatch(/useConnectionStore.*checkpoints/)
  })

  test('renders as a Modal', () => {
    expect(componentSrc).toMatch(/<Modal/)
    expect(componentSrc).toMatch(/visible/)
    expect(componentSrc).toMatch(/onRequestClose/)
  })

  test('sorts checkpoints in reverse chronological order', () => {
    expect(componentSrc).toMatch(/sort.*createdAt/)
  })

  test('renders timeline items with dot and line', () => {
    expect(componentSrc).toMatch(/timelineDot/)
    expect(componentSrc).toMatch(/timelineLine/)
    expect(componentSrc).toMatch(/timelineTrack/)
  })

  test('displays checkpoint metadata', () => {
    expect(componentSrc).toMatch(/checkpoint\.name/)
    expect(componentSrc).toMatch(/checkpoint\.description/)
    expect(componentSrc).toMatch(/checkpoint\.messageCount/)
    expect(componentSrc).toMatch(/checkpoint\.hasGitSnapshot/)
  })

  test('has create checkpoint UI', () => {
    expect(componentSrc).toMatch(/Create Checkpoint/)
    expect(componentSrc).toMatch(/showCreateInput/)
    expect(componentSrc).toMatch(/handleCreate/)
  })

  test('has delete confirmation via Alert', () => {
    expect(componentSrc).toMatch(/Alert\.alert/)
    expect(componentSrc).toMatch(/Delete Checkpoint/)
  })

  test('has restore confirmation via Alert', () => {
    expect(componentSrc).toMatch(/Restore Checkpoint/)
  })

  test('shows empty state when no checkpoints', () => {
    expect(componentSrc).toMatch(/No checkpoints yet/)
  })

  test('fetches checkpoints on modal open', () => {
    expect(componentSrc).toMatch(/useEffect/)
    expect(componentSrc).toMatch(/listCheckpoints/)
  })

  test('uses FlatList for checkpoint list', () => {
    expect(componentSrc).toMatch(/<FlatList/)
    expect(componentSrc).toMatch(/keyExtractor/)
    expect(componentSrc).toMatch(/renderItem/)
  })
})

describe('SessionScreen checkpoint integration', () => {
  test('imports CheckpointView', () => {
    expect(sessionScreenSrc).toMatch(/import.*CheckpointView/)
  })

  test('renders CheckpointView component', () => {
    expect(sessionScreenSrc).toMatch(/<CheckpointView/)
  })

  test('has checkpoint toggle state', () => {
    expect(sessionScreenSrc).toMatch(/showCheckpoints/)
    expect(sessionScreenSrc).toMatch(/setShowCheckpoints/)
  })

  test('has checkpoint button in toolbar', () => {
    expect(sessionScreenSrc).toMatch(/View checkpoints/)
  })
})
