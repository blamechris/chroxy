/** Model presentation for one provider's roster. Never changes selection IDs. */
import type { ModelInfo } from './types'
import { isClaudeBackedProvider } from './context-window'

/** Exact IDs win over full-ID aliases. Display fallback must never select a row. */
export function findModelEntry(models: readonly ModelInfo[], model: string | null | undefined): ModelInfo | undefined {
  if (!model) return undefined
  return models.find(m => m.id === model) ?? models.find(m => m.fullId === model)
}

function baseLabel(model: ModelInfo): string {
  const unresolved = (model.fullId || model.id) === 'default'
    && (!model.label || /^(?:default(?:\s*\(default\))?|recommended)$/i.test(model.label))
  return unresolved ? 'Provider default' : model.label || model.id
}

/** Collapse identical provider targets, retaining the first accepted selection ID.
 * Aliases such as haiku, claude-haiku-4-5 and dated pins are distinct targets.
 */
export function modelChoices(models: readonly ModelInfo[]): ModelInfo[] {
  const targets = new Set<string>()
  const unique = models.filter(m => {
    const target = m.fullId || m.id
    if (targets.has(target)) return false
    targets.add(target)
    return true
  })
  const choices = unique.map(m => {
    const label = baseLabel(m)
    if (unique.filter(other => baseLabel(other) === label).length < 2) return { ...m, label }
    const target = m.fullId || m.id
    const date = target.match(/-(\d{8})(\[1m\])?$/)?.[1]
    const version = target.match(/^(?:claude-)?[a-z]+-(\d+)-(\d+)(?:-\d{8})?(?:\[1m\])?$/)
    const descriptor = date ? `pinned ${date}${target.endsWith('[1m]') ? ', 1M' : ''}`
      : version ? `pinned ${version[1]}.${version[2]}${target.endsWith('[1m]') ? ', 1M' : ''}`
        : /^(?:claude-)?(?:haiku|sonnet|opus|fable)(?:\[1m\])?$/.test(target)
          ? `provider alias${target.endsWith('[1m]') ? ', 1M' : ''}` : target
    const candidate = `${label} (${descriptor})`
    // Different provider aliases/custom targets may still share a descriptor.
    const ambiguous = unique.some(other => other !== m && baseLabel(other) === label
      && (other.fullId || other.id).replace(/^claude-/, '') === target.replace(/^claude-/, ''))
    return { ...m, label: ambiguous ? `${label} (${target})` : candidate }
  })
  return choices.map(m => choices.filter(other => other.label === m.label).length > 1
    ? { ...m, label: `${baseLabel(m)} (${m.fullId || m.id})` } : m)
}

/** Shared header/status label. The family fallback is display-only, Claude-only,
 * and date-only: it cannot confuse a pinned version, a 1M target or a provider.
 */
export function formatActiveModelLabel(
  models: readonly ModelInfo[],
  model: string | null | undefined,
  defaultModelId?: string | null,
  provider?: string | null,
): string {
  const selected = model || defaultModelId
  if (!selected) return 'Provider default'
  const entry = findModelEntry(models, selected)
  if (entry) {
    const label = modelChoices(models).find(m => (m.fullId || m.id) === (entry.fullId || entry.id))?.label ?? baseLabel(entry)
    const defaultEntry = findModelEntry(models, defaultModelId)
    return defaultEntry === entry && label !== 'Provider default' ? `Default (${label})` : label
  }
  if (selected === 'default') return 'Provider default'
  if (isClaudeBackedProvider(provider)) {
    const dated = selected.match(/^(claude-(?:haiku|sonnet|opus|fable)-\d+(?:-\d+)?)-(\d{8})(\[1m\])?$/)
    if (dated) {
      const familyId = `${dated[1]}${dated[3] ?? ''}`
      const family = models.find(m => m.fullId === familyId)
      const label = family ? baseLabel(family) : dated[1]!.slice(7).split('-').map((part, i) => i === 0 ? part[0]!.toUpperCase() + part.slice(1) : part).join(' ').replace(/(\d+) (\d+)$/, '$1.$2')
      return `${label} (pinned ${dated[2]}${dated[3] ? ', 1M' : ''})`
    }
  }
  return selected
}
