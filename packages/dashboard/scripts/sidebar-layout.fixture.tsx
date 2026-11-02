import { createRoot } from 'react-dom/client'
import '../src/theme/theme.css'
import '../src/theme/global.css'
import '../src/theme/components.css'
import { Sidebar, type RepoNode } from '../src/components/Sidebar'
import { useConnectionStore } from '../src/store/connection'

// #8888: mount the REAL Sidebar, with the production styles, in the app's own
// `#app.with-sidebar` grid (so the sidebar gets the viewport height the way it
// does in the dashboard), with more than 20 sessions. sidebar-layout.test.mjs
// measures the scroll column and the tree at 1280x640 and 1280x1200.
// The test expands the Archived section itself where a case needs it. The
// `<header>` is a stand-in for the app header (grid row 6, about 56px tall).

const REPOS = ['api', 'web', 'mobile', 'infra', 'docs']
const SESSIONS_PER_REPO = 6
const repos: RepoNode[] = REPOS.map((name, r) => ({
  path: `/work/${name}`,
  name,
  source: 'auto',
  exists: true,
  activeSessions: Array.from({ length: SESSIONS_PER_REPO }, (_, i) => ({
    sessionId: `s-${r}-${i}`,
    name: `${name} session ${i + 1}`,
    isBusy: false,
  })),
  resumableSessions: [],
}))

const archivedRows = Array.from({ length: 12 }, (_, i) => ({
  archiveId: `arch-${i}`, sessionId: `sid-arch-${i}`, name: `Archived ${i + 1}`, provider: 'claude', cwd: '/work/api',
  model: null, reason: 'idle_timeout', archivedAt: Date.UTC(2026, 9, 1, 12, 0, 0), lastActivityAt: null,
  createdAt: null, historyLength: 4, bytes: 100,
}))
useConnectionStore.setState({
  archivedSessions: {
    type: 'archived_sessions_list', generatedAt: '2026-10-01T00:00:00.000Z',
    policy: { enabled: true, maxEntries: 200, maxAgeDays: 30, maxMegabytes: 256 },
    sessions: archivedRows,
  },
} as never)

const noop = () => {}

function SidebarFixture() {
  return (
    <div id="app" className="with-sidebar">
      <header style={{ height: 56, boxSizing: 'border-box' }} />
      <Sidebar
        repos={repos}
        activeSessionId="s-0-0"
        isOpen
        width={260}
        filter=""
        serverStatus="connected"
        tunnelUrl={null}
        connectedClients={[]}
        activePrimaryClientId={null}
        onFilterChange={noop}
        onSessionClick={noop}
        onResumeSession={noop}
        onNewSession={noop}
        onToggle={noop}
        onContextMenu={noop}
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<SidebarFixture />)
