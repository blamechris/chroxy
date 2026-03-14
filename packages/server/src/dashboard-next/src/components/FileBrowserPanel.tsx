/**
 * FileBrowserPanel — file tree + read-only file viewer with syntax highlighting.
 *
 * Shows the active session's CWD as a navigable directory tree.
 * Clicking a file loads its content with syntax highlighting.
 * Displays git status decorations on modified/untracked files.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useConnectionStore } from '../store/connection'
import { tokenize } from '../lib/syntax'
import type { FileEntry, FileListing, FileContent, GitStatusResult } from '../store/types'

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

interface FileTreeItemProps {
  entry: FileEntry
  currentPath: string
  rootPath: string
  gitStatusMap: Map<string, string>
  onNavigate: (path: string) => void
  onFileClick: (path: string) => void
}

function FileTreeItem({ entry, currentPath, rootPath, gitStatusMap, onNavigate, onFileClick }: FileTreeItemProps) {
  const entryPath = currentPath.endsWith('/')
    ? `${currentPath}${entry.name}`
    : `${currentPath}/${entry.name}`
  const relPath = relativePath(entryPath, rootPath)
  const status = gitStatusMap.get(relPath) || gitStatusMap.get(entry.name)
  const statusInfo = status ? gitStatusChar(status) : null

  return (
    <li className="file-tree-item">
      <button
        type="button"
        className={`file-tree-btn${entry.isDirectory ? ' is-directory' : ''}`}
        onClick={() => entry.isDirectory ? onNavigate(entryPath) : onFileClick(entryPath)}
        title={entry.isDirectory ? `Open ${entry.name}` : `${entry.name}${entry.size !== null ? ` (${formatSize(entry.size)})` : ''}`}
      >
        <span className="file-tree-icon" aria-hidden="true">{fileIcon(entry.name, entry.isDirectory)}</span>
        <span className="file-tree-name">{entry.name}</span>
        {statusInfo && (
          <span className={`file-tree-git ${statusInfo.className}`} aria-label={`git ${status}`}>
            {statusInfo.char}
          </span>
        )}
        {!entry.isDirectory && entry.size !== null && (
          <span className="file-tree-size">{formatSize(entry.size)}</span>
        )}
      </button>
    </li>
  )
}

export function FileBrowserPanel() {
  const requestFileListing = useConnectionStore(s => s.requestFileListing)
  const requestFileContent = useConnectionStore(s => s.requestFileContent)
  const requestGitStatus = useConnectionStore(s => s.requestGitStatus)
  const setFileBrowserCallback = useConnectionStore(s => s.setFileBrowserCallback)
  const setFileContentCallback = useConnectionStore(s => s.setFileContentCallback)
  const setGitStatusCallback = useConnectionStore(s => s.setGitStatusCallback)
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [fileLanguage, setFileLanguage] = useState<string | null>(null)
  const [fileSize, setFileSize] = useState<number | null>(null)
  const [fileTruncated, setFileTruncated] = useState(false)
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)

  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null)
  const rootPath = useRef<string | null>(null)

  // Register callbacks
  useEffect(() => {
    const handleListing = (listing: FileListing) => {
      setEntries(listing.entries)
      setCurrentPath(listing.path)
      setParentPath(listing.parentPath)
      setError(listing.error)
      setLoading(false)
      if (!rootPath.current && listing.path) {
        rootPath.current = listing.path
      }
    }
    setFileBrowserCallback(handleListing)
    return () => setFileBrowserCallback(null)
  }, [setFileBrowserCallback])

  useEffect(() => {
    const handleContent = (content: FileContent) => {
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

  // Load initial directory listing
  useEffect(() => {
    setLoading(true)
    rootPath.current = null
    requestFileListing()
    requestGitStatus()
  }, [requestFileListing, requestGitStatus])

  const gitStatusMap = useMemo(
    () => buildGitStatusMap(gitStatus, rootPath.current),
    [gitStatus],
  )

  const handleNavigate = useCallback((path: string) => {
    setLoading(true)
    setError(null)
    requestFileListing(path)
  }, [requestFileListing])

  const handleFileClick = useCallback((path: string) => {
    setSelectedFile(path)
    setFileLoading(true)
    setFileError(null)
    setFileContent(null)
    requestFileContent(path)
  }, [requestFileContent])

  const handleBack = useCallback(() => {
    if (parentPath) {
      setLoading(true)
      requestFileListing(parentPath)
    }
  }, [parentPath, requestFileListing])

  const handleCloseFile = useCallback(() => {
    setSelectedFile(null)
    setFileContent(null)
    setFileError(null)
  }, [])

  // Breadcrumbs from currentPath relative to root
  const breadcrumbs = useMemo(() => {
    if (!currentPath || !rootPath.current) return []
    const root = rootPath.current
    const rootName = root.split('/').pop() || root
    if (currentPath === root) return [{ label: rootName, path: root }]

    const rel = currentPath.slice(root.length + 1)
    const segments = rel.split('/').filter(Boolean)
    const crumbs = [{ label: rootName, path: root }]
    for (let i = 0; i < segments.length; i++) {
      crumbs.push({
        label: segments[i]!,
        path: root + '/' + segments.slice(0, i + 1).join('/'),
      })
    }
    return crumbs
  }, [currentPath])

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
              {i < breadcrumbs.length - 1 ? (
                <button
                  type="button"
                  className="file-browser-crumb"
                  onClick={() => handleNavigate(crumb.path)}
                >
                  {crumb.label}
                </button>
              ) : (
                <span className="file-browser-crumb file-browser-crumb--current">
                  {crumb.label}
                </span>
              )}
            </span>
          ))}
          {gitStatus?.branch && (
            <span className="file-browser-branch" title={`Branch: ${gitStatus.branch}`}>
              {gitStatus.branch}
            </span>
          )}
        </nav>

        {/* Entries */}
        <div className="file-browser-entries">
          {loading && <div className="file-browser-loading">Loading...</div>}
          {!loading && error && <div className="file-browser-error">{error}</div>}
          {!loading && !error && entries.length === 0 && (
            <div className="file-browser-empty">Empty directory</div>
          )}
          {!loading && entries.length > 0 && (
            <ul className="file-tree-list" role="list">
              {parentPath && (
                <li className="file-tree-item">
                  <button type="button" className="file-tree-btn is-directory" onClick={handleBack}>
                    <span className="file-tree-icon" aria-hidden="true">{'\u{2B06}'}</span>
                    <span className="file-tree-name">..</span>
                  </button>
                </li>
              )}
              {entries.map(entry => (
                <FileTreeItem
                  key={entry.name}
                  entry={entry}
                  currentPath={currentPath || ''}
                  rootPath={rootPath.current || ''}
                  gitStatusMap={gitStatusMap}
                  onNavigate={handleNavigate}
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
          <div className="file-viewer-content">
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
              <pre className="file-viewer-code">
                <code>
                  {highlightedLines
                    ? highlightedLines.map((tokens, lineIdx) => (
                        <span key={lineIdx} className="file-viewer-line">
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
