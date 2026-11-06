/** Pure extraction from one COMPLETED assistant response; never called on deltas. */
export const MAX_DECLARATION_MESSAGE_CHARS = 131072
const STATES = new Set(['running', 'idle', 'blocked', 'stalled', 'done'])
const TOKENS = { '🟢': 'running', '⚪': 'idle', '🔴': 'blocked', '🟠': 'stalled' }
const compact = (value) => value.replace(/\s+/g, ' ').trim().slice(0, 280)
// Unwrap only structural labels. Payload underscores/asterisks are literal.
const plain = (value) => value.trim()
  .replace(/^(\*\*|__)(Status|Next|DECISION)\s*:\1/i, '$2:')
  .replace(/^(\*\*|__)(Status|Next|DECISION)\1\s*:/i, '$2:')

function introducesExampleOrHistory(line) {
  const text = line.replace(/^#{1,6}\s*/, '').trim()
  return /^(?:(?:for\s+)?(?:example|sample|template|format|quoted|literal)(?:\s+(?:footer|status|output|declaration|block))?\s*:)/i.test(text)
    || /^(?:here(?: is|'s)|the following is)\b.*\b(?:example|sample|quoted|literal)\b.*:\s*$/i.test(text)
    || /^(?:(?:the|this|an?)\s+|here is (?:the )?)?(?:previous|earlier|old|prior|historical|last)\s+(?:assistant\s+)?(?:response|message|output|footer|status|declaration)\b[^.!?]*:\s*$/i.test(text)
    || /^(?:previously|earlier)\s*:\s*$/i.test(text)
}

function nextDeclaration(line) {
  const match = /^Next\s*:\s*(\S+)\s*(.*)$/i.exec(line)
  if (!match) return null
  // Accept the established token spelling with or without a space after glyph.
  const token = /^(🟢|⚪|🔴|🟠)\s*(RUNNING|IDLE|BLOCKED|FAILED)\b\s*(?:[—–-]\s*)?(.*)$/i.exec(`${match[1]} ${match[2]}`)
  if (token && TOKENS[token[1]] && ({ '🟢': 'RUNNING', '⚪': 'IDLE', '🔴': 'BLOCKED', '🟠': 'FAILED' })[token[1]] === token[2].toUpperCase()) {
    return { state: TOKENS[token[1]], next: compact(token[3]) }
  }
  return { state: 'unknown', next: compact(`${match[1]} ${match[2]}`) }
}

export function extractDeclaredStatus(text) {
  if (typeof text !== 'string' || text.length > MAX_DECLARATION_MESSAGE_CHARS) return null
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let fence = null
  const eligible = lines.map((line) => {
    const boundary = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (boundary) {
      if (!fence) fence = boundary[1]
      else if (boundary[1][0] === fence[0] && boundary[1].length >= fence.length) fence = null
      return null
    }
    if (fence || /^\s*>|^(?: {4}|\t)/.test(line)) return null
    return plain(line)
  })
  let end = lines.length - 1
  while (end >= 0 && !lines[end].trim()) end--
  if (end < 0 || !eligible[end]) return null
  // Only a declaration at the tail is current. Quoted examples, explanatory
  // prose after a block, and earlier declarations cannot replace live intent.
  const next = nextDeclaration(eligible[end])
  let start = end
  while (start >= 0 && !/^Status\s*:\s*$/i.test(eligible[start] || '')) start--
  const exampleBefore = (index) => {
    let previous = index - 1
    while (previous >= 0 && !lines[previous].trim()) previous--
    return previous >= 0 && introducesExampleOrHistory(eligible[previous] || '')
  }
  if (next && start >= 0) {
    if (exampleBefore(start)) return null
    const rows = eligible.slice(start + 1, end).filter((line) => line !== '')
    // In-flight enumeration child rows may be indented Markdown bullets. They
    // aren't declarations themselves and may appear only after the 🔄 slot.
    const slots = []
    let current = -1
    for (let index = start + 1; index < end; index++) {
      if (!lines[index].trim()) continue
      const line = eligible[index]
      const slot = line && /^[-*+]\s+(✅|🔄|⛔|🔶)\s+(.+)$/.exec(line)
      if (slot) { slots.push(slot); current++ }
      else if (!(current === 1 && /^\s{2,}[-*+]\s+\S/.test(lines[index]))) return null
    }
    if (rows.length < 4 || slots.map((slot) => slot[1]).join('') !== '✅🔄⛔🔶') return null
    const decision = /^DECISION\s*:\s*(.+)$/i.exec(plain(slots[3][2]))
    if (!decision || !decision[1].trim() || !next.next) return null
    return {
      state: next.state,
      summary: compact(slots[0][2]),
      next: next.next,
      ...(!/^none$/i.test(slots[2][2]) ? { blockedOn: compact(slots[2][2]) } : {}),
      decision: compact(decision[1]),
    }
  }
  if (next) {
    if (exampleBefore(end) || !next.next) return null
    return { ...next, summary: next.next }
  }
  const marker = /^\[chroxy-status\]\s+(running|idle|blocked|stalled|done)\s*:\s*(\S.*)$/i.exec(eligible[end])
  if (!marker || exampleBefore(end)) return null
  const state = marker[1].toLowerCase()
  return STATES.has(state) ? { state, summary: compact(marker[2]) } : null
}
