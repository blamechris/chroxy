/**
 * FileBrowserPanel — file tree + read-only file viewer with syntax highlighting.
 *
 * Shows the active session's CWD as a navigable directory tree.
 * Clicking a file loads its content with syntax highlighting.
 * Displays git status decorations on modified/untracked files.
 */
import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react'
import { useConnectionStore } from '../store/connection'
import { tokenize } from '@chroxy/store-core'
import type { FileEntry, FileListing, FileContent, GitStatusResult } from '../store/types'
import type { SymbolEntry } from '@chroxy/protocol'
import {
  computeVisibleEntries, toggleDir, ancestorDirs, buildBreadcrumbs, joinPath,
} from './fileTreeLogic'
import type { VisibleTreeItem } from './fileTreeLogic'
import { ViewerPreWriteReview } from './ViewerPreWriteReview'

/** File icon by extension */
function fileIcon(name: string, isDirectory: boolean): string {
  if (isDirectory) return '\u{1F4C1}'
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() : ''
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': return '\u{1F7E8}'
    case 'ts': case 'tsx': return '\u{1F535}'
    case 'jsx': return '\u{1F7E1}'
    case 'json': return '\u{1F4CB}'
    case 'md': case 'mdx': return '\u{1F4DD}'
    case 'css': case 'scss': case 'less': return '\u{1F3A8}'
    case 'html': case 'htm': return '\u{1F310}'
    case 'py': return '\u{1F40D}'
    case 'rs': return '\u{2699}'
    case 'go': return '\u{1F439}'
    case 'rb': return '\u{1F48E}'
    case 'sh': case 'bash': case 'zsh': return '\u{1F4DF}'
    case 'yml': case 'yaml': return '\u{2699}'
    case 'toml': return '\u{2699}'
    case 'lock': return '\u{1F512}'
    case 'svg': case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': return '\u{1F5BC}'
    default: return '\u{1F4C4}'
  }
}

/** Git status indicator */
function gitStatusChar(status: string): { char: string; className: string } | null {
  switch (status) {
    case 'modified': return { char: 'M', className: 'git-modified' }
    case 'added': return { char: 'A', className: 'git-added' }
    case 'deleted': return { char: 'D', className: 'git-deleted' }
    case 'renamed': return { char: 'R', className: 'git-renamed' }
    case 'untracked': return { char: 'U', className: 'git-untracked' }
    default: return null
  }
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * #6497 — does a `file_content` reply belong to the currently-selected file?
 * The server echoes the resolved ABSOLUTE path (ws-file-ops/reader.js), while the
 * selection may be absolute (a file-tree click) OR workspace-relative (a #6475/
 * #6476 symbol jump). Compare tolerantly: an exact match, or the reply's absolute
 * path ending on the selected (relative) path. It NEVER drops a correct reply —
 * for the selected file the reply's abs path always equals or tail-matches it —
 * so a late/out-of-order reply for a *different* file is discarded instead of
 * flashing into the current viewer or stealing its jump-to-line target. A reply
 * with no path (an empty/invalid request) can't be correlated, so it's kept.
 */
export function contentReplyMatchesSelection(replyPath: string | null, selected: string | null): boolean {
  if (!replyPath || !selected) return true
  const rp = replyPath.replace(/\\/g, '/')
  const sel = selected.replace(/\\/g, '/')
  if (rp === sel) return true
  // An ABSOLUTE selection (file-tree click) must match exactly — never tail-match,
  // or an unrelated abs reply that happens to end with the same string would slip
  // through. Only a workspace-relative selection (a #6475/#6476 symbol jump) is
  // tail-matched against the server's resolved absolute reply path.
  if (sel.startsWith('/') || /^[A-Za-z]:\//.test(sel)) return false
  return rp.endsWith('/' + sel.replace(/^\.?\//, ''))
}

/** Build a lookup of relative paths to their git status */
function buildGitStatusMap(
  gitStatus: GitStatusResult | null,
  rootPath: string | null,
): Map<string, string> {
  const map = new Map<string, string>()
  if (!gitStatus || !rootPath) return map
  for (const entry of gitStatus.unstaged) {
    map.set(entry.path, entry.status)
  }
  for (const entry of gitStatus.staged) {
    if (!map.has(entry.path)) map.set(entry.path, entry.status)
  }
  for (const path of gitStatus.untracked) {
    if (!map.has(path)) map.set(path, 'untracked')
  }
  return map
}

/** Get relative path from root for git status matching */
function relativePath(fullPath: string, rootPath: string): string {
  if (fullPath.startsWith(rootPath + '/')) {
    return fullPath.slice(rootPath.length + 1)
  }
  return fullPath
}

interface FileTreeRowProps {
  item: VisibleTreeItem
  rootPath: string
  gitStatusMap: Map<string, string>
  selected: boolean
  onToggle: (path: string) => void
  onFileClick: (path: string) => void
}

/** One row in the collapsible tree (#6470): a chevron for dirs, icon, name,
 *  optional git badge / size — indented by nesting depth. */
function FileTreeRow({ item, rootPath, gitStatusMap, selected, onToggle, onFileClick }: FileTreeRowProps) {
  const { entry, path, depth, expanded, loading, childCount } = item
  // Look up git status by the entry's workspace-relative path only. A bare-name
  // fallback would mis-tag same-named files in different dirs of a multi-level
  // tree, so it's dropped (relPath already equals the name for root-level files).
  const relPath = relativePath(path, rootPath)
  const status = gitStatusMap.get(relPath)
  const statusInfo = status ? gitStatusChar(status) : null
  const chevron = entry.isDirectory ? (loading ? '⋯' : expanded ? '▾' : '▸') : ''

  return (
    <li className="file-tree-item" role="none">
      <button
        type="button"
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={entry.isDirectory ? expanded : undefined}
        aria-selected={selected || undefined}
        className={`file-tree-btn${entry.isDirectory ? ' is-directory' : ''}${selected ? ' is-selected' : ''}`}
        style={{ paddingLeft: `${6 + depth * 14}px` }}
        onClick={() => entry.isDirectory ? onToggle(path) : onFileClick(path)}
        title={entry.isDirectory ? entry.name : `${entry.name}${entry.size !== null ? ` (${formatSize(entry.size)})` : ''}`}
      >
        <span className={`file-tree-chevron${entry.isDirectory ? '' : ' file-tree-chevron--leaf'}`} aria-hidden="true">{chevron}</span>
        <span className="file-tree-icon" aria-hidden="true">{fileIcon(entry.name, entry.isDirectory)}</span>
        <span className="file-tree-name">{entry.name}</span>
        {statusInfo && (
          <span className={`file-tree-git ${statusInfo.className}`} aria-label={`git ${status}`}>
            {statusInfo.char}
          </span>
        )}
        {/* #6470 — folder child-count badge (known once the dir has been fetched). */}
        {entry.isDirectory && childCount !== null && (
          <span className="file-tree-count" aria-label={`${childCount} item${childCount === 1 ? '' : 's'}`}>{childCount}</span>
        )}
        {!entry.isDirectory && entry.size !== null && (
          <span className="file-tree-size">{formatSize(entry.size)}</span>
        )}
      </button>
    </li>
  )
}

/** Single-glyph badge per symbol kind (open string — falls back to a dot). */
const SYMBOL_KIND_ICON: Record<string, string> = {
  function: 'ƒ', method: 'ƒ', class: 'C', interface: 'I',
  type: 'T', enum: 'E', const: 'k', variable: 'v',
}

interface SymbolsListProps {
  groups: [string, SymbolEntry[]][]
  loading: boolean
  onPick: (line: number) => void
}

/**
 * #6472 — read-only symbol list for the open file, grouped by kind. Clicking a
 * symbol scrolls the viewer to its (1-indexed) line via `onPick`. No per-symbol
 * backend call — renders the cached `symbols_snapshot` from the store.
 */
function SymbolsList({ groups, loading, onPick }: SymbolsListProps) {
  if (loading && groups.length === 0) {
    return <div className="symbol-panel-status" data-testid="symbol-panel-loading">Loading symbols…</div>
  }
  if (groups.length === 0) {
    return <div className="symbol-panel-status" data-testid="symbol-panel-empty">No symbols</div>
  }
  return (
    <div className="symbol-panel" data-testid="symbol-panel">
      {groups.map(([kind, syms]) => (
        <div key={kind} className="symbol-group">
          <div className="symbol-group-kind" data-testid={`symbol-group-${kind}`}>
            {kind}<span className="symbol-group-count">{syms.length}</span>
          </div>
          <ul className="symbol-list" role="list">
            {syms.map((s, i) => (
              <li key={`${s.name}-${s.line}-${i}`}>
                <button
                  type="button"
                  className="symbol-item"
                  data-testid={`symbol-item-${s.name}`}
                  onClick={() => onPick(s.line)}
                  title={`${s.kind} · line ${s.line}`}
                >
                  <span className="symbol-item-icon" aria-hidden="true">{SYMBOL_KIND_ICON[s.kind] ?? '•'}</span>
                  <span className="symbol-item-name">{s.name}</span>
                  {s.exported && <span className="symbol-item-exported" title="exported">↗</span>}
                  <span className="symbol-item-line">{s.line}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

export function FileBrowserPanel() {
  const requestFileListing = useConnectionStore(s => s.requestFileListing)
  const requestFileContent = useConnectionStore(s => s.requestFileContent)
  const requestGitStatus = useConnectionStore(s => s.requestGitStatus)
  const setFileBrowserCallback = useConnectionStore(s => s.setFileBrowserCallback)
  const setFileContentCallback = useConnectionStore(s => s.setFileContentCallback)
  const setGitStatusCallback = useConnectionStore(s => s.setGitStatusCallback)
  // #6472 — opt-in IDE symbol panel (gated on the server's `ide` capability).
  const requestSymbols = useConnectionStore(s => s.requestSymbols)
  const symbolsSnapshot = useConnectionStore(s => s.symbols)
  const symbolsLoading = useConnectionStore(s => s.symbolsLoading)
  const ideEnabled = useConnectionStore(s => s.serverCapabilities.ide === true)
  const fileBrowserPendingOpen = useConnectionStore(s => s.fileBrowserPendingOpen)
  // #6475 — go-to-definition: cmd/ctrl+click a token → resolve → jump.
  const requestResolveSymbol = useConnectionStore(s => s.requestResolveSymbol)
  // #6477 — find-all-references: alt/option+click a token → references palette.
  const requestFindReferences = useConnectionStore(s => s.requestFindReferences)
  const symbolLocation = useConnectionStore(s => s.symbolLocation)
  const openFileInBrowser = useConnectionStore(s => s.openFileInBrowser)
  // #6470 — VSCode-style collapsible tree state: children cached per directory
  // (the root + each expanded subdir), the set of expanded dirs, and dirs with an
  // in-flight browse_files. rootPath (state, below) bounds the tree.
  const [dirChildren, setDirChildren] = useState<Map<string, FileEntry[]>>(new Map())
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Restore selected file from session state (persists across tab switches)
  const activeSessionId = useConnectionStore(s => s.activeSessionId)
  const savedFilePath = useConnectionStore(s =>
    activeSessionId ? s.sessionStates[activeSessionId]?.selectedFilePath ?? null : null
  )
  const [selectedFile, _setSelectedFile] = useState<string | null>(savedFilePath)
  // #6497 — the file-content callback is registered once, so it can't close over
  // the live `selectedFile` state. Mirror it into a ref (updated synchronously at
  // every selection site + a layout-effect backstop) so the callback can drop
  // replies that belong to a since-deselected file.
  const selectedFileRef = useRef<string | null>(savedFilePath)
  const setSelectedFile = useCallback((path: string | null) => {
    // #6497 — update the guard ref synchronously at the primary selection site so
    // no reply can slip through before the sync effect runs.
    selectedFileRef.current = path
    _setSelectedFile(path)
    // Persist to session state
    const sid = useConnectionStore.getState().activeSessionId
    if (sid) {
      const { sessionStates } = useConnectionStore.getState()
      const ss = sessionStates[sid]
      if (ss) {
        useConnectionStore.setState({
          sessionStates: { ...sessionStates, [sid]: { ...ss, selectedFilePath: path } }
        })
      }
    }
  }, [])
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [fileLanguage, setFileLanguage] = useState<string | null>(null)
  const [fileSize, setFileSize] = useState<number | null>(null)
  const [fileTruncated, setFileTruncated] = useState(false)
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)

  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null)
  // #6532 — rootPath is state (not a ref) so the memos/effects that read it list
  // it as an explicit dep, and git decorations recompute regardless of whether
  // the listing or the git_status reply lands first.
  const [rootPath, setRootPath] = useState<string | null>(null)
  const viewerRef = useRef<HTMLDivElement>(null)
  // #6476 — a 1-indexed line to scroll to once the externally-opened file's
  // content has rendered (symbol-search "jump to definition").
  const pendingScrollLine = useRef<number | null>(null)
  // #6475 — the last go-to-definition nonce we acted on, so a persisted
  // `symbolLocation` doesn't re-fire a jump on remount / tab-switch.
  const lastDefNonce = useRef<number | null>(null)
  // #6475 — transient "Definition not found for X" pill (cleared after a beat).
  const [defNotFound, setDefNotFound] = useState<string | null>(null)
  // The workspace-relative path we last asked symbols for; matched against the
  // snapshot's echoed `path` so we only render symbols for the open file.
  const [symbolScope, setSymbolScope] = useState<string | null>(null)
  // Dedup guard so the request effect fires once per open file (not on every
  // directory navigation), while still covering the restore-on-mount case.
  const lastSymbolReq = useRef<string | null>(null)

  // Register callbacks
  useEffect(() => {
    const handleListing = (listing: FileListing) => {
      setLoading(false)
      setError(listing.error)
      if (!listing.path) return
      // Set the tree root only from the ROOT listing — the server marks it with
      // parentPath null (the CWD caps navigation), so a subdir reply that somehow
      // arrived first can't be mistaken for the root.
      if (listing.parentPath === null) setRootPath(listing.path)
      // Route the children under the directory they belong to (the root, or a
      // subdir being expanded) — never replace the whole tree. #6470.
      setDirChildren(prev => {
        const next = new Map(prev)
        next.set(listing.path!, listing.entries)
        return next
      })
      setLoadingDirs(prev => {
        if (!prev.has(listing.path!)) return prev
        const next = new Set(prev)
        next.delete(listing.path!)
        return next
      })
    }
    setFileBrowserCallback(handleListing)
    return () => setFileBrowserCallback(null)
  }, [setFileBrowserCallback])

  // #6497 — backstop: keep the ref in sync for selection changes that bypass
  // setSelectedFile (session-switch restore, StrictMode). A layout effect runs
  // synchronously after commit — before the browser yields to the next macrotask
  // (a file_content WS message) — so the ref can't be briefly stale.
  useLayoutEffect(() => {
    selectedFileRef.current = selectedFile
  }, [selectedFile])

  useEffect(() => {
    const handleContent = (content: FileContent) => {
      // #6502 — nonce correlation is authoritative: drop any reply whose echoed
      // requestId isn't the latest read_file we issued (a superseded request).
      // This subsumes the #6497 case (a since-deselected file's reply carries an
      // older nonce) without depending on echoed-path shape. The path-match
      // (#6497) stays as the fallback for replies from an older server that
      // doesn't echo a requestId at all.
      if (content.requestId != null) {
        const latest = useConnectionStore.getState().lastFileContentRequestId
        if (latest != null && content.requestId !== latest) return
      } else if (!contentReplyMatchesSelection(content.path, selectedFileRef.current)) {
        return
      }
      setFileContent(content.content)
      setFileLanguage(content.language)
      setFileSize(content.size)
      setFileTruncated(content.truncated)
      setFileError(content.error)
      setFileLoading(false)
    }
    setFileContentCallback(handleContent)
    return () => setFileContentCallback(null)
  }, [setFileContentCallback])

  useEffect(() => {
    const handleGitStatus = (result: GitStatusResult) => {
      setGitStatus(result)
    }
    setGitStatusCallback(handleGitStatus)
    return () => setGitStatusCallback(null)
  }, [setGitStatusCallback])

  // Load directory listing when session changes (including follow mode switches)
  useEffect(() => {
    // Reset local state for the new session
    setDirChildren(new Map())
    setExpandedDirs(new Set())
    setLoadingDirs(new Set())
    setError(null)
    setFileContent(null)
    setFileLanguage(null)
    setFileSize(null)
    setFileTruncated(false)
    setFileError(null)
    setGitStatus(null)
    setSymbolScope(null)
    lastSymbolReq.current = null
    setRootPath(null)

    // Restore selected file from session state
    const state = useConnectionStore.getState()
    const sid = state.activeSessionId
    const restoredPath = sid ? state.sessionStates[sid]?.selectedFilePath ?? null : null
    _setSelectedFile(restoredPath)

    // Request fresh listing
    setLoading(true)
    requestFileListing()
    requestGitStatus()

    // Restore previously selected file content
    if (restoredPath) {
      setFileLoading(true)
      requestFileContent(restoredPath)
    }
  }, [activeSessionId, requestFileListing, requestGitStatus, requestFileContent])

  const gitStatusMap = useMemo(
    () => buildGitStatusMap(gitStatus, rootPath),
    [gitStatus, rootPath],
  )

  // #6470 — expand/collapse a directory in place; lazy-load its children on the
  // first expand (browse_files returns one level), cached thereafter.
  const handleToggleDir = useCallback((path: string) => {
    const willExpand = !expandedDirs.has(path)
    if (willExpand && !dirChildren.has(path) && !loadingDirs.has(path)) {
      setLoadingDirs(l => new Set(l).add(path))
      requestFileListing(path)
    }
    setExpandedDirs(prev => toggleDir(prev, path))
  }, [expandedDirs, dirChildren, loadingDirs, requestFileListing])

  // #6470 — reveal a directory (breadcrumb click): expand it and every ancestor,
  // lazy-loading any whose children aren't cached yet.
  const handleRevealDir = useCallback((path: string) => {
    const chain = ancestorDirs(joinPath(path, 'x'), rootPath || '')
    for (const d of chain) {
      if (!dirChildren.has(d) && !loadingDirs.has(d)) {
        setLoadingDirs(l => new Set(l).add(d))
        requestFileListing(d)
      }
    }
    setExpandedDirs(prev => {
      const next = new Set(prev)
      chain.forEach(d => next.add(d))
      return next
    })
  }, [dirChildren, loadingDirs, requestFileListing, rootPath])

  const handleFileClick = useCallback((path: string) => {
    setSelectedFile(path)
    setFileLoading(true)
    setFileError(null)
    setFileContent(null)
    requestFileContent(path)
  }, [requestFileContent])

  // #6475 / #6477 — modifier+click a token in the viewer: cmd/ctrl+click jumps to
  // its definition (go-to-definition); alt/option+click finds all references.
  // Event-delegated on the <pre>: read the clicked token's text; only act on an
  // identifier-ish token (not a keyword/string/comment/punctuation). Opt-in.
  const handleCodeClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (!ideEnabled) return
    const goToDef = e.metaKey || e.ctrlKey
    const findRefs = e.altKey
    if (!goToDef && !findRefs) return
    const target = e.target as HTMLElement
    const cls = typeof target.className === 'string' ? target.className : ''
    const m = cls.match(/(?:^|\s)syn-(\w+)/)
    if (!m || !['plain', 'function', 'type', 'property'].includes(m[1]!)) return
    const text = (target.textContent || '').trim()
    if (!/^[A-Za-z_$][\w$]*$/.test(text)) return
    e.preventDefault()
    const fromFile = selectedFile && rootPath
      ? relativePath(selectedFile, rootPath)
      : undefined
    // cmd/ctrl wins if both modifiers are held (definition is the primary gesture).
    if (goToDef) requestResolveSymbol(text, fromFile)
    else requestFindReferences(text, fromFile)
  }, [ideEnabled, selectedFile, rootPath, requestResolveSymbol, requestFindReferences])

  // #6473 — open a file requested externally (Cmd+P quick-open); reuse the click
  // path so it persists the selection, loads content, and triggers the symbols
  // request. Keyed on the nonce object so repeated opens of the same path fire.
  useEffect(() => {
    if (!fileBrowserPendingOpen) return
    handleFileClick(fileBrowserPendingOpen.path)
    // #6476 — remember the jump-to line; the scroll fires once content renders.
    pendingScrollLine.current = fileBrowserPendingOpen.line ?? null
  }, [fileBrowserPendingOpen, handleFileClick])

  const handleCloseFile = useCallback(() => {
    setSelectedFile(null)
    setFileContent(null)
    setFileError(null)
    setSymbolScope(null)
    lastSymbolReq.current = null
  }, [])

  // #6472 — request the open file's symbols once the workspace root is known.
  // Single request site: fires when a file is selected AND when the listing lands
  // (`currentPath`), so a file restored from session state on mount/tab-switch —
  // where root isn't known at select time — also gets its symbols. Opt-in: the
  // server fail-closes when features.ide is off, so we gate on ideEnabled.
  useEffect(() => {
    if (!selectedFile || !ideEnabled || !rootPath) return
    const rel = relativePath(selectedFile, rootPath)
    if (lastSymbolReq.current === rel) return
    lastSymbolReq.current = rel
    setSymbolScope(rel)
    requestSymbols(rel)
    // rootPath is a dep so a file restored on mount (root not yet known at select
    // time) still requests its symbols once the root listing lands.
  }, [selectedFile, rootPath, ideEnabled, requestSymbols])

  // #6472 — group the open file's symbols by kind for the read-only panel. Only
  // render when the snapshot's echoed `path` matches the file we asked about.
  const groupedSymbols = useMemo<[string, SymbolEntry[]][]>(() => {
    if (!symbolsSnapshot || !symbolScope || symbolsSnapshot.path !== symbolScope) return []
    const byKind = new Map<string, SymbolEntry[]>()
    for (const sym of symbolsSnapshot.symbols) {
      const arr = byKind.get(sym.kind)
      if (arr) arr.push(sym)
      else byKind.set(sym.kind, [sym])
    }
    return [...byKind.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  }, [symbolsSnapshot, symbolScope])

  // Scroll the viewer to a 1-indexed line and briefly highlight it.
  const scrollToLine = useCallback((line: number) => {
    const el = viewerRef.current?.querySelector<HTMLElement>(`[data-line="${line}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.add('file-viewer-line--active')
    window.setTimeout(() => el.classList.remove('file-viewer-line--active'), 1400)
  }, [])

  // #6476 — once an externally-opened file's content has rendered, scroll to the
  // requested jump-to line (symbol-search "jump to definition"). Deferred a tick
  // so the freshly-rendered `data-line` rows are in the DOM.
  useEffect(() => {
    if (pendingScrollLine.current == null || fileContent == null) return
    const line = pendingScrollLine.current
    pendingScrollLine.current = null
    const id = window.setTimeout(() => scrollToLine(line), 0)
    return () => window.clearTimeout(id)
  }, [fileContent, scrollToLine])

  // #6475 — react to a go-to-definition result: on a hit, open the target file
  // at the declaration line (reusing the Cmd+P open plumbing); on a miss, flash a
  // transient "not found" pill. Deduped by nonce so a persisted result doesn't
  // re-jump on remount / tab-switch.
  useEffect(() => {
    if (!symbolLocation) return
    if (lastDefNonce.current === symbolLocation.nonce) return
    lastDefNonce.current = symbolLocation.nonce
    if (symbolLocation.file && symbolLocation.line != null) {
      openFileInBrowser(symbolLocation.file, symbolLocation.line)
      setDefNotFound(null)
      return
    }
    setDefNotFound(symbolLocation.symbol || 'symbol')
    const id = window.setTimeout(() => setDefNotFound(null), 2200)
    return () => window.clearTimeout(id)
  }, [symbolLocation, openFileInBrowser])

  // #6470 — breadcrumbs for the selected file (VSCode-style: root → dirs → file).
  const breadcrumbs = useMemo(
    () => buildBreadcrumbs(selectedFile, rootPath || ''),
    [selectedFile, rootPath],
  )

  // #6470 — the flattened visible tree: root children + expanded subtrees.
  const visibleEntries = useMemo(
    () => rootPath ? computeVisibleEntries(rootPath, dirChildren, expandedDirs, loadingDirs) : [],
    [rootPath, dirChildren, expandedDirs, loadingDirs],
  )

  // Syntax-highlighted lines for the file viewer
  const highlightedLines = useMemo(() => {
    if (!fileContent || !fileLanguage || fileLanguage === 'image') return null
    const lines = fileContent.split('\n')
    return lines.map(line => tokenize(line, fileLanguage))
  }, [fileContent, fileLanguage])

  return (
    <div className="file-browser-panel" data-testid="file-browser-panel">
      {/* File tree */}
      <div className={`file-browser-tree${selectedFile ? ' with-viewer' : ''}`}>
        {/* Breadcrumbs */}
        <nav className="file-browser-breadcrumb" aria-label="File browser breadcrumb">
          {breadcrumbs.map((crumb, i) => (
            <span key={crumb.path}>
              {i > 0 && <span className="file-browser-sep">/</span>}
              {crumb.isLeaf ? (
                <span className="file-browser-crumb file-browser-crumb--current">
                  {crumb.label}
                </span>
              ) : (
                <button
                  type="button"
                  className="file-browser-crumb"
                  onClick={() => handleRevealDir(crumb.path)}
                >
                  {crumb.label}
                </button>
              )}
            </span>
          ))}
          {gitStatus?.branch && (
            <span className="file-browser-branch" title={`Branch: ${gitStatus.branch}`}>
              {gitStatus.branch}
            </span>
          )}
        </nav>

        {/* Collapsible tree (#6470) */}
        <div className="file-browser-entries">
          {loading && dirChildren.size === 0 && <div className="file-browser-loading">Loading...</div>}
          {!loading && error && <div className="file-browser-error">{error}</div>}
          {!error && dirChildren.size > 0 && visibleEntries.length === 0 && (
            <div className="file-browser-empty">Empty directory</div>
          )}
          {visibleEntries.length > 0 && (
            <ul className="file-tree-list" role="tree">
              {visibleEntries.map(item => (
                <FileTreeRow
                  key={item.path}
                  item={item}
                  rootPath={rootPath || ''}
                  gitStatusMap={gitStatusMap}
                  selected={selectedFile === item.path}
                  onToggle={handleToggleDir}
                  onFileClick={handleFileClick}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* File viewer */}
      {selectedFile && (
        <div className="file-browser-viewer">
          <div className="file-viewer-header">
            <span className="file-viewer-path" title={selectedFile}>
              {selectedFile.split('/').pop()}
            </span>
            {fileSize !== null && (
              <span className="file-viewer-size">{formatSize(fileSize)}</span>
            )}
            {fileTruncated && (
              <span className="file-viewer-truncated">Truncated</span>
            )}
            <button
              type="button"
              className="file-viewer-close"
              onClick={handleCloseFile}
              aria-label="Close file"
            >
              &times;
            </button>
          </div>
          {/* #6544 (IDE P3.3 feature A): when a Write/Edit permission is pending
              for THIS file, surface the #6543 per-hunk pre-write diff here on the
              viewer — the operator narrows/approves it in the file's own context.
              Self-gates on features.ide + a matching live write (renders nothing
              otherwise). Approve/Deny route through the same editedInput seam. */}
          <ViewerPreWriteReview filePath={selectedFile} />
          {ideEnabled && fileContent !== null && fileLanguage !== 'image' && (
            <SymbolsList groups={groupedSymbols} loading={symbolsLoading} onPick={scrollToLine} />
          )}
          <div className="file-viewer-content" ref={viewerRef}>
            {/* #6475 — transient go-to-definition "not found" feedback. */}
            {defNotFound && (
              <div className="file-viewer-def-notfound" data-testid="def-not-found" role="status">
                Definition not found for <code>{defNotFound}</code>
              </div>
            )}
            {fileLoading && <div className="file-viewer-loading">Loading file...</div>}
            {!fileLoading && fileError && <div className="file-viewer-error">{fileError}</div>}
            {!fileLoading && !fileError && fileContent !== null && fileLanguage === 'image' && (
              <div className="file-viewer-image">
                <img
                  src={fileContent}
                  alt={selectedFile.split('/').pop() || 'Image preview'}
                  style={{ maxWidth: '100%', maxHeight: '80vh', objectFit: 'contain' }}
                />
              </div>
            )}
            {!fileLoading && !fileError && fileContent !== null && fileLanguage !== 'image' && (
              <pre
                className={ideEnabled ? 'file-viewer-code file-viewer-code--ide' : 'file-viewer-code'}
                onClick={handleCodeClick}
                title={ideEnabled ? 'Cmd/Ctrl+click a symbol to jump to its definition' : undefined}
              >
                <code>
                  {highlightedLines
                    ? highlightedLines.map((tokens, lineIdx) => (
                        <span key={lineIdx} className="file-viewer-line" data-line={lineIdx + 1}>
                          <span className="file-viewer-line-num">{lineIdx + 1}</span>
                          {tokens.map((tok, tokIdx) => (
                            <span key={tokIdx} className={`syn-${tok.type}`}>{tok.text}</span>
                          ))}
                          {'\n'}
                        </span>
                      ))
                    : fileContent
                  }
                </code>
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
