/**
 * Pure tree-logic helpers for the collapsible file explorer (#6470, epic #6469).
 *
 * The dashboard file browser is a VSCode-style explorer: one workspace-rooted
 * tree whose directories expand/collapse in place, lazy-loading their children
 * via `browse_files` (which returns one directory's children per request). These
 * helpers are the pure core — no React, no store, no WS — so the tree's behaviour
 * is fully unit-testable without a headless-visual pass.
 */
import type { FileEntry } from '../store/types'

/** One rendered row in the flattened visible tree. */
export interface VisibleTreeItem {
  entry: FileEntry
  /** Absolute path of this entry. */
  path: string
  /** Nesting depth — 0 for the root's direct children. */
  depth: number
  /** Directory only: is it currently expanded. */
  expanded: boolean
  /** Directory only: are its children being fetched. */
  loading: boolean
  /** Directory only: number of cached children, or null until fetched. */
  childCount: number | null
}

/** Does the path look absolute (POSIX root or a Windows drive)? */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:\//.test(p)
}

/** Join a directory path and a child name with a single forward slash. Backslash
 *  separators in `dir` are normalized so the tree never mixes separators. */
export function joinPath(dir: string, name: string): string {
  const d = dir.replace(/\\/g, '/')
  return d.endsWith('/') ? `${d}${name}` : `${d}/${name}`
}

/**
 * Sort entries VSCode-style: directories first, then files, each group
 * alphabetical (case-insensitive). Pure — returns a new array.
 */
export function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    const an = a.name.toLowerCase()
    const bn = b.name.toLowerCase()
    return an < bn ? -1 : an > bn ? 1 : 0
  })
}

/**
 * Flatten the visible tree into a render list: the root's children, recursing
 * into every expanded directory whose children are cached. A directory that is
 * expanded but whose children haven't arrived yet contributes only its own row
 * (the caller shows a spinner via `loading`). `childCount` is the cached child
 * count for a directory (null until fetched) — the folder-count badge (#6470).
 */
export function computeVisibleEntries(
  rootPath: string,
  dirChildren: Map<string, FileEntry[]>,
  expandedDirs: Set<string>,
  loadingDirs: Set<string>,
): VisibleTreeItem[] {
  const out: VisibleTreeItem[] = []
  const walk = (dir: string, depth: number) => {
    const children = dirChildren.get(dir)
    if (!children) return
    for (const entry of sortEntries(children)) {
      const path = joinPath(dir, entry.name)
      const expanded = entry.isDirectory && expandedDirs.has(path)
      const cached = entry.isDirectory ? dirChildren.get(path) : undefined
      out.push({
        entry,
        path,
        depth,
        expanded,
        loading: entry.isDirectory && loadingDirs.has(path),
        childCount: entry.isDirectory ? (cached ? cached.length : null) : null,
      })
      if (expanded) walk(path, depth + 1)
    }
  }
  walk(rootPath, 0)
  return out
}

/** Toggle a directory's expanded membership. Pure — returns a new Set. */
export function toggleDir(expandedDirs: Set<string>, path: string): Set<string> {
  const next = new Set(expandedDirs)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

/**
 * The ancestor directory paths that must be expanded to reveal a file — every
 * directory between the workspace root (exclusive) and the file (exclusive).
 * Accepts an absolute path under root or a workspace-relative one (a symbol
 * jump), and tolerates Windows separators. Returns `[]` when the file isn't
 * under root (including an absolute path pointing outside the workspace).
 */
export function ancestorDirs(filePath: string, rootPath: string): string[] {
  if (!filePath || !rootPath) return []
  const root = rootPath.replace(/\\/g, '/').replace(/\/$/, '')
  const norm = filePath.replace(/\\/g, '/')
  let rel: string
  if (norm.startsWith(root + '/')) rel = norm.slice(root.length + 1)
  else if (isAbsolutePath(norm)) return [] // an absolute path outside the workspace
  else rel = norm.replace(/^\.?\//, '')
  const segs = rel.split('/').filter(Boolean)
  const dirs: string[] = []
  for (let i = 0; i < segs.length - 1; i++) {
    dirs.push(root + '/' + segs.slice(0, i + 1).join('/'))
  }
  return dirs
}

/** A breadcrumb segment: a label and the absolute path it points at. */
export interface Breadcrumb {
  label: string
  path: string
  /** The final crumb (the file itself, or the root when nothing is selected). */
  isLeaf: boolean
}

/**
 * Breadcrumbs for the selected file, VSCode-style: root → …dirs… → file. When
 * nothing is selected — or the selection is an absolute path outside the
 * workspace — a single root crumb. Directory crumbs carry the dir path (clickable
 * to reveal in the tree); the file crumb is the leaf.
 */
export function buildBreadcrumbs(selectedFile: string | null, rootPath: string): Breadcrumb[] {
  if (!rootPath) return []
  const root = rootPath.replace(/\\/g, '/').replace(/\/$/, '')
  const rootName = root.split('/').pop() || root
  if (!selectedFile) return [{ label: rootName, path: root, isLeaf: true }]
  const norm = selectedFile.replace(/\\/g, '/')
  let rel: string
  if (norm.startsWith(root + '/')) rel = norm.slice(root.length + 1)
  else if (isAbsolutePath(norm)) return [{ label: rootName, path: root, isLeaf: true }]
  else rel = norm.replace(/^\.?\//, '')
  const segs = rel.split('/').filter(Boolean)
  const crumbs: Breadcrumb[] = [{ label: rootName, path: root, isLeaf: segs.length === 0 }]
  for (let i = 0; i < segs.length; i++) {
    crumbs.push({
      label: segs[i]!,
      path: root + '/' + segs.slice(0, i + 1).join('/'),
      isLeaf: i === segs.length - 1,
    })
  }
  return crumbs
}
