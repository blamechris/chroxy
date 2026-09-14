import React from 'react'
import { createRoot } from 'react-dom/client'
import '../src/theme/theme.css'
import '../src/theme/global.css'
import '../src/theme/components.css'
import { ToolBubble } from '../src/components/ToolBubble'
import { ToolGroup } from '../src/components/ToolGroup'
import { ChatExpandContext } from '../src/components/chatExpandRegistry'

// Mount the real components and production styles in an isolated browser page.
function ToolLayoutFixture() {
  const token = 'x'.repeat(300)
  const text = `description: ${'a long output line with spaces '.repeat(30)}\n/path/${token}`
  const column = { display: 'flex', flexDirection: 'column' as const, width: '100%' }
  return (
    <ChatExpandContext.Provider value={{ get: () => true, set: () => {} }}>
      <main style={column}>
        <section data-case="short-result" style={column}>
          <ToolBubble toolName="Shell" toolUseId="short" input={token} result={text} isTail />
        </section>
        <section data-case="long-preview" style={column}>
          <ToolBubble toolName="Shell" toolUseId="long" result={`${text}\n${'more output\n'.repeat(24)}`} isTail />
        </section>
        <section data-case="running-input" style={column}>
          <ToolBubble toolName="Shell" toolUseId="running" inputPartial={`{"command":"${token}`} isTail />
        </section>
        <section data-case="grouped-control" style={column}>
          <ToolGroup isActive messages={[{ id: 'grouped', type: 'tool_use', content: '', timestamp: 0, tool: 'Shell', toolInput: token, toolResult: text }]} />
        </section>
      </main>
    </ChatExpandContext.Provider>
  )
}

createRoot(document.getElementById('root')!).render(<ToolLayoutFixture />)
