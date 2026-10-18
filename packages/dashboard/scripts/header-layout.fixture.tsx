import { createRoot } from 'react-dom/client'
import '../src/theme/theme.css'
import '../src/theme/global.css'
import '../src/theme/components.css'
import { formatThinkingLevelLabel } from '@chroxy/protocol'
import { ChatSettingsDropdown } from '../src/components/ChatSettingsDropdown'

// #8618: mount the real header-center controls of a CODEX session, with the
// production styles, in an isolated browser page. The thinking roster is the
// codex binary's own (`supportedReasoningEfforts`, #7730) and arrives on the
// query string from header-layout.test.mjs (`?levels=a,b,c&selected=c`): a
// hand-written roster belongs in a test, and scripts/lint-thinking-level-roster.sh
// keeps one out of every other source file, this fixture included. The sandbox
// badge is present (#6901). Each case pins `.header-center` to a width: "roomy"
// is a desktop window with nothing competing for the column, "tight" reproduces
// the squeeze the issue reports at an ordinary desktop width (the left and
// right header zones leave the center column about 500px), and "phone"
// exercises the 600px media query. The test measures every control against
// every option it can show.
const params = new URLSearchParams(window.location.search)
const LEVEL_IDS = (params.get('levels') ?? '').split(',').filter(Boolean)
const SELECTED_LEVEL = params.get('selected') ?? ''
if (LEVEL_IDS.length === 0 || !LEVEL_IDS.includes(SELECTED_LEVEL)) {
  throw new Error('header-layout fixture: the test must pass ?levels=<ids>&selected=<id>')
}
const CODEX_LEVELS = LEVEL_IDS.map(id => ({ id, label: formatThinkingLevelLabel(id) }))
const MODELS = [{ id: 'gpt-5.5', label: 'GPT-5.5', fullId: 'gpt-5.5' }]
const MODES = [
  { id: 'approve', label: 'Approve', description: 'Approve', supported: true, enforcement: 'unknown' as const },
  { id: 'acceptEdits', label: 'Accept Edits', description: 'Accept Edits', supported: true, enforcement: 'unknown' as const },
  { id: 'auto', label: 'Auto', description: 'Auto', supported: true, enforcement: 'unknown' as const },
]

// The default configuration's permission roster, as ws-history sends it to the
// dashboard when the daemon has no `allowAutoPermissionMode` and the provider
// has no plan mode: Auto is advertised as supported (the dropdown then renders
// it "(disabled on this server)" from the gate) and Plan is "(unavailable)".
// Labels the value can never show must not widen the control.
const GATE_OFF_MODES = [
  ...MODES,
  { id: 'plan', label: 'Plan (unavailable)', description: 'Unavailable', supported: false, enforcement: 'unsupported' as const },
]

function HeaderCase({ name, centerWidth, sandbox, gateOff = false }: { name: string; centerWidth: number; sandbox: 'read-only' | 'workspace-write' | null; gateOff?: boolean }) {
  // The real header is `#header > .header-main` (a 3-column grid, 16px gaps,
  // 16px side padding; 12px padding under the 600px media query, so the
  // "phone" case's column comes out 8px wider than named) with `.header-center`
  // in the middle column. The side zones are stand-ins of a fixed width so the
  // center column lands at about `centerWidth` whatever the viewport is; the
  // test measures the column's real box, never this number.
  return (
    <div data-case={name} id="header" style={{ width: centerWidth + 2 * 16 + 2 * 16 + 2 * 40, boxSizing: 'border-box' }}>
      <div className="header-main">
        <div className="header-left" style={{ width: 40 }} />
        <div className="header-center">
          <ChatSettingsDropdown
            availableModels={MODELS}
            activeModel="gpt-5.5"
            defaultModelId="gpt-5.5"
            onModelChange={() => {}}
            providerLabel="Codex"
            availablePermissionModes={gateOff ? GATE_OFF_MODES : MODES}
            permissionMode="acceptEdits"
            onPermissionModeChange={() => {}}
            autoPermissionModeAllowed={gateOff ? false : undefined}
            codexSandbox={sandbox}
            showThinkingLevel
            thinkingLevel={SELECTED_LEVEL}
            thinkingLevels={CODEX_LEVELS}
            onThinkingLevelChange={() => {}}
          />
        </div>
        <div className="header-right" style={{ width: 40 }} />
      </div>
    </div>
  )
}

function HeaderLayoutFixture() {
  return (
    <main style={{ display: 'flex', flexDirection: 'column', gap: 24, alignItems: 'flex-start' }}>
      <HeaderCase name="roomy" centerWidth={900} sandbox="read-only" />
      <HeaderCase name="tight" centerWidth={500} sandbox="workspace-write" />
      <HeaderCase name="phone" centerWidth={330} sandbox="workspace-write" />
      {/* No badge: the shape every non-codex session renders (model button,
          permission, thinking). With nothing shrinkable in the row, this is
          where a wrapper that refuses to shrink would first show as a control
          cut at the column edge. */}
      <HeaderCase name="no-badge" centerWidth={500} sandbox={null} />
      {/* The default configuration on a codex session: the permission roster
          carries "Auto (disabled on this server)" and "Plan (unavailable)",
          labels the value never shows. The control must size to "Accept
          Edits", not to them, or the five controls no longer fit the tight
          column. */}
      <HeaderCase name="gate-off" centerWidth={500} sandbox="workspace-write" gateOff />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<HeaderLayoutFixture />)
