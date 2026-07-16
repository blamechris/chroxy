/**
 * Committee decision contract (engine foundations, epic #6691, step E-1) — the
 * highest-risk piece. Models end each committee turn with a fenced JSON block
 * (```chroxy-decision); this module extracts and validates it. Fail-closed:
 * absence of a valid block is NEVER an approval — extractDecision throws, and
 * the engine's policy (repair re-prompt → architect salvage → escalate) decides
 * what to do. It never guesses a verdict.
 *
 * Pure — no I/O, no clock, no session. zod (server package ^4.3.6) validates
 * per-kind; unknown keys are stripped, not fatal.
 */

import { z } from 'zod'

export const DECISION_KINDS = [
  'epic_plan', 'plan_of_attack', 'poa_review', 'work_result', 'result_review', 'synthesis',
]

const VERDICT = z.enum(['approve', 'revise', 'redelegate', 'escalate'])

// Per-kind schemas. `kind` is a z.literal discriminator; unknown keys stripped.
const SubtaskSpec = z.object({
  title: z.string().min(1).max(300),
  goal: z.string().min(1).max(8000),
  role: z.enum(['audit', 'implement']),
  dependsOn: z.array(z.string().max(128)).max(50).optional(),
  successCriteria: z.string().max(4000).optional(),
  filesHint: z.array(z.string().max(1024)).max(200).optional(),
})

export const DECISION_SCHEMAS = {
  epic_plan: z.object({
    kind: z.literal('epic_plan'),
    summary: z.string().max(8000).optional(),
    subtasks: z.array(SubtaskSpec).min(1).max(100),
  }),
  plan_of_attack: z.object({
    kind: z.literal('plan_of_attack'),
    plan: z.string().min(1).max(20000),
    summary: z.string().min(1).max(4000),
  }),
  poa_review: z.object({
    kind: z.literal('poa_review'),
    verdict: VERDICT,
    feedback: z.string().max(8000).optional(),
  }),
  work_result: z.object({
    kind: z.literal('work_result'),
    summary: z.string().min(1).max(20000),
    filesChanged: z.array(z.string().max(1024)).max(500).optional(),
    notes: z.string().max(8000).optional(),
  }),
  result_review: z.object({
    kind: z.literal('result_review'),
    verdict: VERDICT,
    feedback: z.string().max(8000).optional(),
  }),
  synthesis: z.object({
    kind: z.literal('synthesis'),
    reportMarkdown: z.string().min(1).max(200000),
    summary: z.string().max(8000).optional(),
  }),
}

export class DecisionParseError extends Error {
  constructor(stage, detail) {
    super(`decision parse failed at ${stage}: ${detail}`)
    this.name = 'DecisionParseError'
    this.code = 'DECISION_PARSE_ERROR'
    this.stage = stage // 'no_block' | 'parse' | 'kind' | 'schema'
    this.detail = detail
  }
}

const TAIL_SCAN_LIMIT = 32 * 1024

function findFencedBlocks(text) {
  // ```tag\n ... ``` — capture tag + body. Tolerates a trailing space after the
  // tag and CRLF. Non-greedy body so adjacent fences don't merge.
  const re = /```([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g
  const blocks = []
  let m
  while ((m = re.exec(text)) !== null) blocks.push({ tag: m[1].toLowerCase(), body: m[2].trim() })
  return blocks
}

// Last balanced {...} object in the final TAIL_SCAN_LIMIT chars, string-aware so
// braces inside JSON strings don't confuse the depth count.
function braceScanFromTail(text) {
  const tail = text.length > TAIL_SCAN_LIMIT ? text.slice(text.length - TAIL_SCAN_LIMIT) : text
  const end = tail.lastIndexOf('}')
  if (end === -1) return null
  let depth = 0
  let inStr = false
  for (let i = end; i >= 0; i--) {
    const ch = tail[i]
    if (inStr) {
      // walking backwards: a quote closes the string unless it's escaped. We
      // approximate escape handling by checking the preceding backslash run.
      if (ch === '"') {
        let bs = 0
        let j = i - 1
        while (j >= 0 && tail[j] === '\\') { bs++; j-- }
        if (bs % 2 === 0) inStr = false
      }
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '}') depth++
    else if (ch === '{') {
      depth--
      if (depth === 0) return tail.slice(i, end + 1)
    }
  }
  return null
}

/** Pick the decision block text from model output, scanning from the end. */
function extractBlockText(text) {
  const blocks = findFencedBlocks(text)
  const byTag = (tag) => {
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].tag === tag) return blocks[i].body
    return null
  }
  return (
    byTag('chroxy-decision')
    || byTag('json')
    || (blocks.length ? blocks[blocks.length - 1].body : null)
    || braceScanFromTail(text)
  )
}

// Strip //, /* */ comments and trailing commas that are OUTSIDE JSON strings,
// so a `//` (e.g. a URL) or a `, }` inside a string value is never mangled.
// Smart quotes are normalized everywhere (they only ever appear as a typo for
// real quotes, and a smart quote inside a value is still not valid JSON).
function stripNoise(s) {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      out += ch
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; out += ch; continue }
    // line comment
    if (ch === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; i--; continue }
    // block comment
    if (ch === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue }
    // trailing comma: a comma followed (after whitespace) by } or ]
    if (ch === ',') {
      let j = i + 1
      while (j < s.length && /\s/.test(s[j])) j++
      if (s[j] === '}' || s[j] === ']') continue // drop the comma
    }
    out += ch
  }
  return out
}

function tolerantParse(raw) {
  try { return JSON.parse(raw) } catch { /* fall through to tolerant pass */ }
  const normalized = raw.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  return JSON.parse(stripNoise(normalized)) // may throw — caller wraps
}

function zodErrorSummary(error) {
  return error.issues
    .slice(0, 8)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ')
}

/**
 * Extract + validate the committee decision of `expectedKind` from model text.
 * @returns {{ decision: object, warnings: string[] }}
 * @throws {DecisionParseError}
 */
export function extractDecision(text, expectedKind) {
  const schema = DECISION_SCHEMAS[expectedKind]
  if (!schema) throw new DecisionParseError('kind', `unknown expectedKind '${expectedKind}'`)
  const warnings = []
  const raw = typeof text === 'string' ? extractBlockText(text) : null
  if (raw == null || raw.length === 0) {
    throw new DecisionParseError('no_block', 'no fenced chroxy-decision block, json block, or JSON object found')
  }

  let obj
  try {
    obj = tolerantParse(raw)
  } catch (err) {
    throw new DecisionParseError('parse', (err && err.message) || 'invalid JSON')
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new DecisionParseError('parse', 'decision is not a JSON object')
  }
  // Distinguish a kind mismatch from a schema failure for clearer repair prompts.
  if (obj.kind !== expectedKind) {
    throw new DecisionParseError('kind', `expected kind '${expectedKind}', got '${obj.kind ?? '(absent)'}'`)
  }
  const parsed = schema.safeParse(obj)
  if (!parsed.success) {
    throw new DecisionParseError('schema', zodErrorSummary(parsed.error))
  }
  return { decision: parsed.data, warnings }
}

const EXAMPLES = {
  epic_plan: '{ "kind": "epic_plan", "subtasks": [ { "title": "...", "goal": "...", "role": "audit" } ] }',
  plan_of_attack: '{ "kind": "plan_of_attack", "plan": "...", "summary": "..." }',
  poa_review: '{ "kind": "poa_review", "verdict": "approve", "feedback": "..." }',
  work_result: '{ "kind": "work_result", "summary": "..." }',
  result_review: '{ "kind": "result_review", "verdict": "approve" }',
  synthesis: '{ "kind": "synthesis", "reportMarkdown": "# ..." }',
}

/** The per-turn instruction appended to a role prompt (NOT the capped preamble). */
export function decisionInstruction(expectedKind) {
  return [
    `End your reply with exactly one fenced code block tagged \`chroxy-decision\` containing ONLY`,
    `JSON of kind "${expectedKind}", matching:`,
    '```chroxy-decision',
    EXAMPLES[expectedKind] ?? '{ "kind": "..." }',
    '```',
    'The block must be the last thing in your message. Do not wrap it in prose.',
  ].join('\n')
}

/** The corrective re-prompt sent to the same session on a parse failure. */
export function buildRepairPrompt(expectedKind, parseError) {
  const stage = parseError instanceof DecisionParseError ? parseError.stage : 'unknown'
  const detail = parseError instanceof DecisionParseError ? parseError.detail : String(parseError)
  return [
    `Your previous reply's chroxy-decision block could not be used (${stage}: ${detail}).`,
    `Reply with ONLY the corrected block — nothing else:`,
    '```chroxy-decision',
    EXAMPLES[expectedKind] ?? '{ "kind": "..." }',
    '```',
  ].join('\n')
}
