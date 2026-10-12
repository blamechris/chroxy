import { createHash } from 'node:crypto'

export const INSTRUCTION_COMPILER_VERSION = '1'
export const INSTRUCTION_SEPARATOR = '\n\n--- project-doc ---\n\n'
export const REQUIRED_RULE_START = '<!-- chroxy-required-rule:start '
export const REQUIRED_RULE_END = '<!-- chroxy-required-rule:end '
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const MAX_SOURCES = 32
const MAX_TARGETS = 32
const MAX_RULES = 128

function fail(message) { throw new Error(`Instruction policy: ${message}`) }

/**
 * Build a schema-safe, deterministic identity from a portable relative path.
 * Existing safe identities remain readable; paths whose characters or length
 * cannot cross the protocol boundary use an opaque full SHA-256 identity.
 */
export function boundedInstructionIdentity(namespace, relativePath) {
  if (typeof namespace !== 'string' || !ID.test(namespace)) fail(`invalid identity namespace '${namespace || ''}'`)
  if (typeof relativePath !== 'string' || relativePath.length === 0) fail('instruction identity path must be non-empty text')
  const candidate = `${namespace}:${relativePath}`
  if (ID.test(candidate)) return candidate
  return `${namespace}:sha256-${createHash('sha256').update(relativePath, 'utf8').digest('hex')}`
}

function validText(text, label) {
  if (typeof text !== 'string' || text.length === 0) fail(`${label} must be non-empty text`)
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) {
        fail(`${label} contains invalid UTF-16 and cannot be encoded as UTF-8`)
      }
      index++
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      fail(`${label} contains invalid UTF-16 and cannot be encoded as UTF-8`)
    }
  }
}

function byteOffset(text, characterOffset) {
  return Buffer.byteLength(text.slice(0, characterOffset), 'utf8')
}

export function inspectInstructionSource(source) {
  if (!source || !ID.test(source.id || '')) fail(`invalid source id '${source?.id || ''}'`)
  validText(source.text, `source '${source.id}'`)
  const rules = []
  const seen = new Set()
  let explicit = null
  let standalone = null
  let lineNumber = 1
  let cursor = 0

  const closeStandalone = (endCharacter) => {
    if (!standalone) return
    standalone.endByte = byteOffset(source.text, endCharacter)
    rules.push(standalone)
    standalone = null
  }
  const addRuleId = (id) => {
    if (seen.has(id)) fail(`source '${source.id}' duplicates required rule '${id}'`)
    seen.add(id)
  }

  while (cursor < source.text.length) {
    const newline = source.text.indexOf('\n', cursor)
    const contentEnd = newline === -1 ? source.text.length : newline
    const lineEnd = newline === -1 ? source.text.length : newline + 1
    const rawLine = source.text.slice(cursor, contentEnd).replace(/\r$/, '')
    // TextDecoder is configured to preserve a UTF-8 BOM. Ignore it only while
    // classifying the first line; source bytes, hashes, offsets, and delivery
    // remain byte-for-byte unchanged.
    const line = lineNumber === 1 && rawLine.startsWith('\uFEFF') ? rawLine.slice(1) : rawLine
    const explicitStart = line.match(/^<!-- chroxy-required-rule:start ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127}) -->$/)
    const explicitEnd = line.match(/^<!-- chroxy-required-rule:end ([A-Za-z0-9][A-Za-z0-9._:/-]{0,127}) -->$/)
    const classified = line.match(/^<!--(?:floor|default):([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})-->$/)

    if (explicitStart) {
      if (explicit) fail(`source '${source.id}' starts rule '${explicitStart[1]}' inside '${explicit.id}'`)
      closeStandalone(cursor)
      addRuleId(explicitStart[1])
      explicit = { id: explicitStart[1], line: lineNumber, startByte: byteOffset(source.text, cursor) }
    } else if (explicitEnd) {
      if (!explicit) fail(`source '${source.id}' ends rule '${explicitEnd[1]}' without a start`)
      if (explicit.id !== explicitEnd[1]) fail(`source '${source.id}' ends '${explicitEnd[1]}' while '${explicit.id}' is open`)
      rules.push({ id: explicit.id, startByte: explicit.startByte, endByte: byteOffset(source.text, lineEnd) })
      explicit = null
    } else if (classified) {
      if (explicit) fail(`source '${source.id}' starts classified rule '${classified[1]}' inside '${explicit.id}'`)
      closeStandalone(cursor)
      addRuleId(classified[1])
      standalone = { id: classified[1], startByte: byteOffset(source.text, cursor) }
    } else if (line.startsWith('<!-- chroxy-required-rule:') || line.startsWith('<!--floor:') || line.startsWith('<!--default:')) {
      fail(`source '${source.id}' has malformed rule marker on line ${lineNumber}`)
    }

    cursor = lineEnd
    lineNumber++
  }
  if (explicit) fail(`source '${source.id}' rule '${explicit.id}' is incomplete (started on line ${explicit.line})`)
  closeStandalone(source.text.length)
  if (rules.length === 0) {
    rules.push({ id: source.id, startByte: 0, endByte: Buffer.byteLength(source.text, 'utf8') })
  }
  if (rules.length > MAX_RULES) fail(`source '${source.id}' rule count exceeds ${MAX_RULES}`)
  return { ...source, rules, requiredRuleIds: rules.map(rule => rule.id) }
}

function normalize(sources, targets) {
  if (!Array.isArray(sources) || sources.length === 0) fail('at least one source is required')
  if (sources.length > MAX_SOURCES) fail(`source count exceeds ${MAX_SOURCES}`)
  if (!Array.isArray(targets) || targets.length === 0) fail('at least one target is required')
  if (targets.length > MAX_TARGETS) fail(`target count exceeds ${MAX_TARGETS}`)
  const sourceIds = new Set()
  const inspected = sources.map(source => {
    const item = inspectInstructionSource(source)
    if (sourceIds.has(item.id)) fail(`duplicate source id '${item.id}'`)
    sourceIds.add(item.id)
    return item
  })
  const allRules = new Map()
  for (const source of inspected) for (const rule of source.requiredRuleIds) {
    if (allRules.has(rule)) fail(`required rule '${rule}' is duplicated by sources '${allRules.get(rule)}' and '${source.id}'`)
    allRules.set(rule, source.id)
    if (allRules.size > MAX_RULES) fail(`required rule count exceeds ${MAX_RULES}`)
  }
  const targetIds = new Set()
  return { sources: inspected, targets: targets.map(target => {
    if (!target || !ID.test(target.id || '')) fail(`invalid target id '${target?.id || ''}'`)
    if (targetIds.has(target.id)) fail(`duplicate target id '${target.id}'`)
    targetIds.add(target.id)
    if (!Number.isSafeInteger(target.budgetBytes) || target.budgetBytes <= 0) fail(`target '${target.id}' has invalid byte budget`)
    const reservedBytes = target.reservedBytes ?? 0
    if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0) fail(`target '${target.id}' has invalid reserved byte count`)
    if (!Array.isArray(target.requiredRuleIds) || target.requiredRuleIds.length === 0) fail(`target '${target.id}' must require at least one rule id`)
    const required = new Set()
    for (const rule of target.requiredRuleIds) {
      if (!ID.test(rule || '')) fail(`target '${target.id}' has invalid required rule id '${rule || ''}'`)
      if (required.has(rule)) fail(`target '${target.id}' duplicates required rule id '${rule}'`)
      if (!allRules.has(rule)) fail(`target '${target.id}' is missing required rule '${rule}'`)
      required.add(rule)
    }
    return { ...target, requiredRuleIds: [...required], reservedBytes }
  }) }
}

function render(sources, target) {
  const sourceMetadata = sources.map(source => ({
    id: source.id,
    sha256: createHash('sha256').update(source.text, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(source.text),
    startByte: 0,
    endByte: 0,
  }))
  const ruleMetadata = sources.flatMap(source => source.rules.map(rule => ({
    id: rule.id,
    sourceId: source.id,
    relativeStartByte: rule.startByte,
    relativeEndByte: rule.endByte,
    startByte: 0,
    endByte: 0,
  })))
  let text = ''
  let stable = false
  for (let pass = 0; pass < 16; pass++) {
    const header = [
      `<!-- chroxy-instruction-policy compiler=${INSTRUCTION_COMPILER_VERSION} target=${target.id} budget=${target.budgetBytes} -->`,
      ...sourceMetadata.map(source => `<!-- source id=${source.id} sha256=${source.sha256} bytes=${source.bytes} endByte=${source.endByte} -->`),
      ...ruleMetadata.map(rule => `<!-- rule id=${rule.id} source=${rule.sourceId} endByte=${rule.endByte} -->`),
      `<!-- required ${target.requiredRuleIds.join(',')} -->`,
    ].join('\n')
    let next = header
    const nextSources = []
    const nextRules = []
    for (let index = 0; index < sources.length; index++) {
      next += INSTRUCTION_SEPARATOR
      const startByte = Buffer.byteLength(next)
      next += sources[index].text
      const endByte = Buffer.byteLength(next)
      nextSources.push({ startByte, endByte })
      for (const rule of sources[index].rules) {
        nextRules.push({ startByte: startByte + rule.startByte, endByte: startByte + rule.endByte })
      }
    }
    stable = next === text
      && nextSources.every((item, index) => item.startByte === sourceMetadata[index].startByte && item.endByte === sourceMetadata[index].endByte)
      && nextRules.every((item, index) => item.startByte === ruleMetadata[index].startByte && item.endByte === ruleMetadata[index].endByte)
    text = next
    nextSources.forEach((item, index) => Object.assign(sourceMetadata[index], item))
    nextRules.forEach((item, index) => Object.assign(ruleMetadata[index], item))
    if (stable) break
  }
  if (!stable) fail(`target '${target.id}' metadata offsets did not converge`)

  const totalBytes = Buffer.byteLength(text)
  const contentLimit = target.budgetBytes - target.reservedBytes
  if (totalBytes > contentLimit) {
    const source = sourceMetadata.find(item => item.endByte > contentLimit) || sourceMetadata.at(-1)
    const rule = ruleMetadata.find(item => item.sourceId === source.id && item.endByte > contentLimit)
    fail(`target '${target.id}' exceeds ${target.budgetBytes} bytes at source '${source.id}'${rule ? ` required rule '${rule.id}'` : ''} (${target.reservedBytes + totalBytes} bytes)`)
  }
  return {
    text,
    enforcement: 'instructional',
    compilerVersion: INSTRUCTION_COMPILER_VERSION,
    budgetBytes: target.budgetBytes,
    totalBytes,
    sources: sourceMetadata.map(source => ({
      id: source.id, sha256: source.sha256, bytes: source.bytes, endByte: source.endByte,
    })),
    rules: ruleMetadata.map(rule => ({
      id: rule.id, sourceId: rule.sourceId, endByte: rule.endByte,
    })),
    includedRequiredRuleIds: target.requiredRuleIds,
  }
}

export function compileInstructionPolicy({ sources, targets }) {
  const normalized = normalize(sources, targets)
  return Object.fromEntries(normalized.targets.map(target => [target.id, render(normalized.sources, target)]))
}
