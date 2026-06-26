import { describe, it, expect } from 'vitest'
import {
  getToolKind,
  getToolPresentation,
  TOOL_KIND_META,
  type ToolKind,
} from './tool-presentation'
import { formatToolName } from './group-messages'

describe('getToolKind', () => {
  const cases: Array<[string, ToolKind]> = [
    ['Read', 'read'],
    ['read_file', 'read'],
    ['NotebookRead', 'read'],
    ['LS', 'read'],
    ['Edit', 'edit'],
    ['MultiEdit', 'edit'],
    ['NotebookEdit', 'edit'],
    ['Write', 'write'],
    ['write_file', 'write'],
    ['Bash', 'exec'],
    ['BashOutput', 'exec'],
    ['Grep', 'search'],
    ['Glob', 'search'],
    ['WebFetch', 'web'],
    ['WebSearch', 'web'],
    ['Task', 'task'],
    ['TodoWrite', 'todo'],
    ['AskUserQuestion', 'question'],
  ]
  it.each(cases)('classifies %s as %s', (name, kind) => {
    expect(getToolKind(name)).toBe(kind)
  })

  it('is case- and separator-insensitive', () => {
    expect(getToolKind('read-file')).toBe('read')
    expect(getToolKind('BASH')).toBe('exec')
    expect(getToolKind('todo_write')).toBe('todo')
  })

  it('classifies MCP tools as other (intent is not inferable)', () => {
    expect(getToolKind('mcp__github__list_repos')).toBe('other')
    expect(getToolKind('mcp__repo-memory__search_by_purpose')).toBe('other')
  })

  it('falls back to other for unknown / empty names', () => {
    expect(getToolKind('SomeFutureTool')).toBe('other')
    expect(getToolKind('')).toBe('other')
    expect(getToolKind(undefined)).toBe('other')
    expect(getToolKind(null)).toBe('other')
  })
})

describe('getToolPresentation', () => {
  it('returns kind + icon + colorToken + label for a core tool', () => {
    expect(getToolPresentation('Read')).toEqual({
      kind: 'read',
      icon: TOOL_KIND_META.read.icon,
      colorToken: TOOL_KIND_META.read.colorToken,
      label: 'Read',
    })
  })

  it('label matches formatToolName (single source of truth)', () => {
    expect(getToolPresentation('read_file').label).toBe(formatToolName('read_file'))
    expect(getToolPresentation('mcp__github__list_repos').label).toBe(
      formatToolName('mcp__github__list_repos'),
    )
  })

  it('forwards serverName to the label', () => {
    expect(getToolPresentation('Read', 'gh').label).toBe(formatToolName('Read', 'gh'))
  })

  it('uses the other-kind meta for unknown tools', () => {
    const p = getToolPresentation('SomeFutureTool')
    expect(p.kind).toBe('other')
    expect(p.icon).toBe(TOOL_KIND_META.other.icon)
    expect(p.colorToken).toBe(TOOL_KIND_META.other.colorToken)
  })

  it('never throws on empty / nullish names', () => {
    expect(() => getToolPresentation('')).not.toThrow()
    expect(getToolPresentation(undefined).kind).toBe('other')
  })
})

describe('TOOL_KIND_META', () => {
  it('has an entry for every ToolKind the classifier can return', () => {
    const kinds: ToolKind[] = [
      'read', 'edit', 'write', 'exec', 'search', 'web', 'task', 'todo', 'question', 'other',
    ]
    for (const kind of kinds) {
      expect(TOOL_KIND_META[kind]).toBeDefined()
      expect(TOOL_KIND_META[kind].icon).toBeTruthy()
      expect(TOOL_KIND_META[kind].colorToken).toBeTruthy()
    }
  })
})
