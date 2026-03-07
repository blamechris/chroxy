/**
 * DirectoryBrowser — file system browser for directory selection.
 *
 * Shows a breadcrumb path + directory listing fetched from the server.
 * Only directories are displayed. Clicking a directory navigates into it.
 * Used in the New Session modal for picking a working directory.
 */
import type { DirectoryEntry } from '../store/types'

export interface DirectoryBrowserProps {
  initialPath: string
  entries: DirectoryEntry[]
  currentPath: string
  loading: boolean
  onNavigate: (path: string) => void
  onSelect: (path: string) => void
  onCancel: () => void
}

function parseBreadcrumbs(path: string): { label: string; path: string }[] {
  const segments = path.split('/').filter(Boolean)
  const crumbs: { label: string; path: string }[] = [
    { label: '/', path: '/' },
  ]
  for (let i = 0; i < segments.length; i++) {
    crumbs.push({
      label: segments[i]!,
      path: '/' + segments.slice(0, i + 1).join('/'),
    })
  }
  return crumbs
}

export function DirectoryBrowser({
  entries,
  currentPath,
  loading,
  onNavigate,
  onSelect,
  onCancel,
}: DirectoryBrowserProps) {
  const crumbs = parseBreadcrumbs(currentPath)
  const dirs = entries.filter(e => e.isDirectory)

  return (
    <div className="directory-browser">
      <nav className="directory-browser-breadcrumb" role="navigation" aria-label="Breadcrumb">
        {crumbs.map((crumb, i) => (
          <span key={crumb.path}>
            {i > 1 && <span className="directory-browser-sep">/</span>}
            {i < crumbs.length - 1 ? (
              <button
                type="button"
                className="directory-browser-crumb"
                onClick={() => onNavigate(crumb.path)}
              >
                {crumb.label}
              </button>
            ) : (
              <span className="directory-browser-crumb directory-browser-crumb--current" aria-current="location">
                {crumb.label}
              </span>
            )}
          </span>
        ))}
      </nav>

      <div className="directory-browser-list-container">
        {loading && (
          <div className="directory-browser-loading">Loading...</div>
        )}
        {!loading && dirs.length === 0 && (
          <div className="directory-browser-empty">No subdirectories</div>
        )}
        {!loading && dirs.length > 0 && (
          <ul className="directory-browser-list" role="list">
            {dirs.map(entry => (
              <li key={entry.name}>
                <button
                  type="button"
                  className="directory-browser-entry"
                  onClick={() => onNavigate(
                    currentPath.endsWith('/')
                      ? `${currentPath}${entry.name}`
                      : `${currentPath}/${entry.name}`
                  )}
                >
                  <span className="directory-browser-icon" aria-hidden="true">&#128193;</span>
                  {entry.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="directory-browser-actions">
        <button
          type="button"
          className="btn-modal-cancel"
          aria-label="Cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn-modal-create"
          aria-label="Select"
          onClick={() => onSelect(currentPath)}
        >
          Select
        </button>
      </div>
    </div>
  )
}
