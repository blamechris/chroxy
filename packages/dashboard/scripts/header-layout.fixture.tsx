import React from 'react'
import { createRoot } from 'react-dom/client'
import '../src/theme/theme.css'
import '../src/theme/global.css'
import '../src/theme/components.css'
import { ChatSettingsDropdown } from '../src/components/ChatSettingsDropdown'

// #8618: mount the real header-center controls of a CODEX session, with the
// production styles, in an isolated browser page. The thinking roster is the
// codex binary's own (`supportedReasoningEfforts`, #7730), `xhigh` selected;
// the sandbox badge is present (#6901). Each case pins `.header-center` to a
// width: "roomy" is a desktop window with nothing competing for the column,
// "tight" reproduces the squeeze the issue reports at an ordinary desktop width
// (the left and right header zones leave the center column about 500px), and
// "phone" exercises the 600px media query. header-layout.test.mjs measures
// every control against every option it can show.
const CODEX_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'].map(id => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1) }))
const MODELS = [{ id: 'gpt-5.5', label: 'GPT-5.5', fullId: 'gpt-5.5' }]
const MODES = [
  { id: 'approve', label: 'Approve', description: 'Approve', supported: true, enforcement: 'unknown' as const },
  { id: 'acceptEdits', label: 'Accept Edits', description: 'Accept Edits', supported: true, enforcement: 'unknown' as const },
  { id: 'auto', label: 'Auto', description: 'Auto', supported: true, enforcement: 'unknown' as const },
]

function HeaderCase({ name, centerWidth, sandbox }: { name: string; centerWidth: number; sandbox: 'read-only' | 'workspace-write' }) {
  // The real header is `#header > .header-main` (a 3-column grid, 16px gaps,
  // 16px side padding) with `.header-center` in the middle column. The side
  // zones are stand-ins of a fixed width so the center column lands at exactly
  // `centerWidth` whatever the viewport is.
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
            availablePermissionModes={MODES}
            permissionMode="acceptEdits"
            onPermissionModeChange={() => {}}
            codexSandbox={sandbox}
            showThinkingLevel
            thinkingLevel="xhigh"
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
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<HeaderLayoutFixture />)
