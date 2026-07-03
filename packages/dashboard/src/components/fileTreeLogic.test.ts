import { describe, it, expect } from 'vitest'
import {
  joinPath, sortEntries, computeVisibleEntries, toggleDir, ancestorDirs, buildBreadcrumbs,
} from './fileTreeLogic'
import type { FileEntry } from '../store/types'

const dir = (name: string): FileEntry => ({ name, isDirectory: true, size: null })
const file = (name: string, size: number | null = 10): FileEntry => ({ name, isDirectory: false, size })

describe('joinPath', () => {
  it('joins with a single separator', () => {
    expect(joinPath('/root', 'a.ts')).toBe('/root/a.ts')
    expect(joinPath('/root/', 'a.ts')).toBe('/root/a.ts')
  })
  it('normalizes backslash separators so the result never mixes', () => {
    expect(joinPath('C:\\root\\src', 'x.ts')).toBe('C:/root/src/x.ts')
  })
})

describe('sortEntries', () => {
  it('directories first, then files, each alphabetical (case-insensitive)', () => {
    const out = sortEntries([file('Zeta.ts'), dir('src'), file('alpha.ts'), dir('App')])
    expect(out.map(e => e.name)).toEqual(['App', 'src', 'alpha.ts', 'Zeta.ts'])
  })
  it('is pure (does not mutate the input)', () => {
    const input = [file('b'), file('a')]
    sortEntries(input)
    expect(input.map(e => e.name)).toEqual(['b', 'a'])
  })
})

describe('computeVisibleEntries', () => {
  const root = '/root'
  const children = new Map<string, FileEntry[]>([
    ['/root', [dir('src'), file('readme.md')]],
    ['/root/src', [dir('lib'), file('index.ts')]],
    ['/root/src/lib', [file('util.ts')]],
  ])

  it('shows only the root children when nothing is expanded', () => {
    const out = computeVisibleEntries(root, children, new Set(), new Set())
    expect(out.map(i => `${i.depth}:${i.entry.name}`)).toEqual(['0:src', '0:readme.md'])
  })

  it('recurses into an expanded directory whose children are cached', () => {
    const out = computeVisibleEntries(root, children, new Set(['/root/src']), new Set())
    expect(out.map(i => `${i.depth}:${i.entry.name}`)).toEqual([
      '0:src', '1:lib', '1:index.ts', '0:readme.md',
    ])
  })

  it('recurses through nested expanded directories', () => {
    const out = computeVisibleEntries(root, children, new Set(['/root/src', '/root/src/lib']), new Set())
    expect(out.map(i => `${i.depth}:${i.entry.name}`)).toEqual([
      '0:src', '1:lib', '2:util.ts', '1:index.ts', '0:readme.md',
    ])
  })

  it('marks an expanded dir loading and skips its (not-yet-cached) children', () => {
    const partial = new Map<string, FileEntry[]>([['/root', [dir('src')]]])
    const out = computeVisibleEntries(root, partial, new Set(['/root/src']), new Set(['/root/src']))
    expect(out).toHaveLength(1)
    expect(out[0]!.entry.name).toBe('src')
    expect(out[0]!.expanded).toBe(true)
    expect(out[0]!.loading).toBe(true)
  })

  it('returns empty when the root has no cached children', () => {
    expect(computeVisibleEntries(root, new Map(), new Set(), new Set())).toEqual([])
  })

  it('#6470 — reports the cached child count on directories (null until fetched)', () => {
    const out = computeVisibleEntries(root, children, new Set(), new Set())
    const src = out.find(i => i.entry.name === 'src')!
    const readme = out.find(i => i.entry.name === 'readme.md')!
    expect(src.childCount).toBe(2) // /root/src has [lib, index.ts]
    expect(readme.childCount).toBe(null) // files never carry a count
    // A directory whose children aren't cached yet reports null.
    const partial = new Map<string, FileEntry[]>([['/root', [dir('unfetched')]]])
    const [row] = computeVisibleEntries(root, partial, new Set(), new Set())
    expect(row!.childCount).toBe(null)
  })
})

describe('toggleDir', () => {
  it('adds then removes a path; is pure', () => {
    const a = toggleDir(new Set(), '/root/src')
    expect([...a]).toEqual(['/root/src'])
    const b = toggleDir(a, '/root/src')
    expect([...b]).toEqual([])
    expect([...a]).toEqual(['/root/src']) // original untouched
  })
})

describe('ancestorDirs', () => {
  it('returns the dir chain between root and an absolute file (exclusive of both)', () => {
    expect(ancestorDirs('/root/src/lib/util.ts', '/root')).toEqual(['/root/src', '/root/src/lib'])
  })
  it('handles a workspace-relative path (symbol jump)', () => {
    expect(ancestorDirs('src/lib/util.ts', '/root')).toEqual(['/root/src', '/root/src/lib'])
  })
  it('a root-level file has no ancestors', () => {
    expect(ancestorDirs('/root/readme.md', '/root')).toEqual([])
  })
  it('normalizes Windows separators + trailing root slash', () => {
    expect(ancestorDirs('C:\\root\\a\\b.ts', 'C:\\root\\')).toEqual(['C:/root/a'])
  })
  it('returns [] for an absolute path outside the workspace root', () => {
    expect(ancestorDirs('/etc/passwd', '/root')).toEqual([])
  })
})

describe('buildBreadcrumbs', () => {
  it('a single root crumb when nothing is selected', () => {
    expect(buildBreadcrumbs(null, '/home/me/proj')).toEqual([
      { label: 'proj', path: '/home/me/proj', isLeaf: true },
    ])
  })
  it('root → dirs → file for a selected file', () => {
    const out = buildBreadcrumbs('/root/src/index.ts', '/root')
    expect(out.map(c => `${c.label}${c.isLeaf ? '*' : ''}`)).toEqual(['root', 'src', 'index.ts*'])
    expect(out[1]!.path).toBe('/root/src')
    expect(out[2]!.path).toBe('/root/src/index.ts')
  })
  it('handles a workspace-relative selection', () => {
    const out = buildBreadcrumbs('src/index.ts', '/root')
    expect(out.map(c => c.label)).toEqual(['root', 'src', 'index.ts'])
  })
  it('returns [] with no root', () => {
    expect(buildBreadcrumbs('/root/a.ts', '')).toEqual([])
  })
  it('a single root crumb for an absolute selection outside the workspace', () => {
    expect(buildBreadcrumbs('/etc/passwd', '/root')).toEqual([
      { label: 'root', path: '/root', isLeaf: true },
    ])
  })
})
