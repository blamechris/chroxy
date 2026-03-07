/**
 * SplitPane — resizable split view for showing chat and terminal simultaneously.
 *
 * Uses react-resizable-panels for drag-to-resize with keyboard accessibility.
 * Supports horizontal (left/right) and vertical (top/bottom) layouts.
 */
import { Group, Panel, Separator } from 'react-resizable-panels'

export type SplitDirection = 'horizontal' | 'vertical'

interface SplitPaneProps {
  direction: SplitDirection
  /** Content for the first pane (chat) */
  first: React.ReactNode
  /** Content for the second pane (terminal) */
  second: React.ReactNode
  /** Called when user double-clicks the divider to reset */
  onReset?: () => void
}

export function SplitPane({ direction, first, second, onReset }: SplitPaneProps) {
  return (
    <Group
      orientation={direction}
      className={`split-pane split-${direction}`}
    >
      <Panel defaultSize={50} minSize={20}>
        <div className="split-panel-content">{first}</div>
      </Panel>
      <Separator
        className="split-resize-handle"
        onDoubleClick={onReset}
      />
      <Panel defaultSize={50} minSize={20}>
        <div className="split-panel-content">{second}</div>
      </Panel>
    </Group>
  )
}
