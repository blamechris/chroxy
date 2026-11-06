import { createRoot } from 'react-dom/client'
import '../src/theme/theme.css'
import '../src/theme/global.css'
import '../src/theme/components.css'
import { SidebarPanelSlot, type SidebarPanelView } from '../src/components/SidebarPanelSlot'

// #8943: mount the REAL SidebarPanelSlot, collapsed, with the production
// styles, inside the real `.sidebar` class at fixed widths. The widths arrive
// on the query string from panel-header-layout.test.mjs (`?widths=240,320,480`)
// so the roster lives in the test. The collapsed metric is deliberately long.
// panel-header-layout.test.mjs measures the header's controls in a real
// browser; jsdom lays nothing out.
const params = new URLSearchParams(window.location.search)
const WIDTHS = (params.get('widths') ?? '').split(',').map(Number).filter(Number.isFinite)
const METRIC = params.get('metric') ?? ''
if (WIDTHS.length === 0 || METRIC === '') {
  throw new Error('panel-header-layout fixture: the test must pass ?widths=<px,px>&metric=<text>')
}

const VIEWS: SidebarPanelView[] = [
  { id: 'tokens', label: 'Tokens', render: () => null, collapsedHeaderMetric: () => METRIC },
  { id: 'mcp', label: 'MCP', render: () => null },
]
const noop = () => {}

createRoot(document.getElementById('root')!).render(
  <div>
    {WIDTHS.map(w => (
      <div key={w} data-case={String(w)} className="sidebar" style={{ width: w, marginBottom: 12 }}>
        <SidebarPanelSlot
          views={VIEWS}
          launchers={[{ id: 'control-room', label: 'Control Room', onClick: noop }]}
          selectedViewId="tokens"
          onSelectView={noop}
          collapsed
          onCollapsedChange={noop}
          height={200}
          onHeightChange={noop}
        />
      </div>
    ))}
  </div>,
)
