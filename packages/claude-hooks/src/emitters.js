/**
 * One emitter per Claude Code hook (#5413 Phase 4).
 *
 * Each emitter maps its hook's stdin payload onto the IngestEventSchema
 * envelope: a snake_cased `type` plus a flat data bag (primitives only,
 * truncated to the schema's per-value cap by buildEnvelope). Keys chosen to
 * line up with what the server-side consumers already read:
 *
 *   - `data.message` / `data.title` override the notification text
 *     (event-ingest.js)
 *   - `data.tool` feeds the Discord embed's detail line
 *     (discord-webhook-sink.js `data.detail ?? data.tool`)
 *   - `data.cwd` is the server's fallback project derivation — sent for
 *     observability even though `project` is sent explicitly
 *
 * SubagentStart is registered alongside SubagentStop: Claude Code emits
 * both (claude-code-notify has counted on the pair in production), and
 * server-side counting (subagent-counter.js) needs the start edge.
 */

const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null)

function baseData(payload) {
  const data = {}
  const cwd = str(payload.cwd)
  if (cwd) data.cwd = cwd
  return data
}

export function sessionStart(payload) {
  const data = baseData(payload)
  // `source` on the payload is startup|resume|clear — renamed so it can't
  // be confused with the envelope-level `source` (the emitter identity).
  const startSource = str(payload.source)
  if (startSource) data.startSource = startSource
  return { type: 'session_start', data }
}

export function sessionEnd(payload) {
  const data = baseData(payload)
  const reason = str(payload.reason)
  if (reason) data.reason = reason
  return { type: 'session_end', data }
}

export function subagentStart(payload) {
  const data = baseData(payload)
  const agentType = str(payload.agent_type)
  if (agentType) data.agentType = agentType
  return { type: 'subagent_start', data }
}

export function subagentStop(payload) {
  const data = baseData(payload)
  const agentType = str(payload.agent_type)
  if (agentType) data.agentType = agentType
  return { type: 'subagent_stop', data }
}

export function notification(payload) {
  const data = baseData(payload)
  const message = str(payload.message)
  if (message) data.message = message
  const title = str(payload.title)
  if (title) data.title = title
  // #5439 GAP A: forward the matcher discriminator. The server maps
  // `idle_prompt` to the idle embed state (🦀 Ready for input) and
  // `permission_prompt` (or absent) to needs-approval (🔐) — dropping it
  // made every idle prompt render as a permission ping.
  const notificationType = str(payload.notification_type)
  if (notificationType) data.notificationType = notificationType
  return { type: 'notification', data }
}

export function postToolUse(payload) {
  const data = baseData(payload)
  const tool = str(payload.tool_name)
  if (tool) data.tool = tool
  return { type: 'post_tool_use', data }
}

/** Claude Code hook event name → emitter. */
export const EMITTERS = {
  SessionStart: sessionStart,
  SessionEnd: sessionEnd,
  SubagentStart: subagentStart,
  SubagentStop: subagentStop,
  Notification: notification,
  PostToolUse: postToolUse,
}

/** Ingest type (CLI arg form) → hook event name, so `emit session_start` works. */
export const HOOK_EVENT_FOR_TYPE = {
  session_start: 'SessionStart',
  session_end: 'SessionEnd',
  subagent_start: 'SubagentStart',
  subagent_stop: 'SubagentStop',
  notification: 'Notification',
  post_tool_use: 'PostToolUse',
}
