/**
 * Tool-output auto-collapse thresholds (chat redesign #6389, Phase 1 #6391).
 *
 * A tool result longer than {@link TOOL_OUTPUT_COLLAPSE_LINE_THRESHOLD} lines is
 * collapsed in the ToolBubble to its first {@link TOOL_OUTPUT_COLLAPSE_HEAD_LINES}
 * lines, behind a "Show N more lines" pill. Shared so the dashboard and mobile
 * ToolBubble use the identical boundary (the design spec's "auto-collapse long
 * output past a shared named threshold").
 */

/** Collapse a tool result once it exceeds this many lines. */
export const TOOL_OUTPUT_COLLAPSE_LINE_THRESHOLD = 16

/** Lines kept visible (the head) when a long tool result is collapsed. */
export const TOOL_OUTPUT_COLLAPSE_HEAD_LINES = 12
