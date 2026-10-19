/**
 * usePathAutocomplete — debounced directory path autocomplete via WS.
 *
 * Splits the input into parent dir + partial segment, requests a directory
 * listing from the server for the parent, and filters results by prefix match.
 */
import { useState, useEffect } from 'react'
import { useConnectionStore } from '../store/connection'
import type { DirectoryListing } from '../store/types'
import { nextDirectoryRequestId } from '../utils/directory-request-id'

/** Split a path into the parent directory and the partial segment being typed.
 *  Handles both POSIX (/) and Windows (\) separators. */
export function splitPath(input: string): { parent: string; partial: string } {
  if (!input) return { parent: '', partial: '' }

  // Find the last separator (either / or \)
  const lastFwd = input.lastIndexOf('/')
  const lastBack = input.lastIndexOf('\\')
  const lastSep = Math.max(lastFwd, lastBack)

  if (lastSep === -1) return { parent: '', partial: input }

  // Handle root paths: "/" or "C:\"
  const parent = input.slice(0, lastSep)
  const partial = input.slice(lastSep + 1)

  if (!parent) return { parent: input[lastSep]!, partial }
  // Windows drive root: "C:" → "C:\"
  if (parent.length === 2 && parent[1] === ':') return { parent: parent + '\\', partial }

  return { parent, partial }
}

const DEBOUNCE_MS = 200

type DirectoryAccess = {
  path: string
  status: 'pending' | 'allowed' | 'denied' | 'unknown'
  error: string | null
}

const normalizeListingPath = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '') || '/'

export function usePathAutocomplete(input: string, { enabled = true, checkDirectory = false } = {}) {
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [directoryAccess, setDirectoryAccess] = useState<DirectoryAccess | null>(null)
  const requestDirectoryListing = useConnectionStore(s => s.requestDirectoryListing)
  const setDirectoryListingCallback = useConnectionStore(s => s.setDirectoryListingCallback)

  useEffect(() => {
    // Browse installs its callback synchronously before this effect runs.
    // Suspending must leave that callback in place.
    if (!enabled) {
      setDirectoryAccess(null)
      return
    }
    const target = input.trim()
    setDirectoryAccess(checkDirectory && target ? { path: target, status: 'pending', error: null } : null)
    if (!target || (!checkDirectory && target.length < 2)) {
      setSuggestions([])
      setDirectoryListingCallback(null)
      return
    }
    const { parent, partial } = splitPath(target)
    if (!parent && !checkDirectory) {
      setSuggestions([])
      setDirectoryListingCallback(null)
      return
    }
    const queryPath = /[/\\]$/.test(target) ? target.replace(/[/\\]+$/, '') || target : parent
    const parentRequestId = checkDirectory && queryPath ? nextDirectoryRequestId() : null
    const exactRequestId = checkDirectory
      ? (queryPath === target ? parentRequestId : nextDirectoryRequestId()) : null
    let active = true
    let checkTimer: ReturnType<typeof setTimeout> | undefined
    const debounce = setTimeout(() => {
      if (checkDirectory) {
        checkTimer = setTimeout(() => {
          if (active) setDirectoryAccess(current => current?.status === 'pending'
            ? { path: target, status: 'unknown', error: null } : current)
        }, 2000)
      }
      setDirectoryListingCallback((listing: DirectoryListing) => {
        if (!active) return
        const responsePath = listing.path || listing.parentPath || ''
        const hasRequestId = typeof listing.requestId === 'string'
        const exactMatch = hasRequestId
          ? listing.requestId === exactRequestId
          : Boolean(responsePath) && normalizeListingPath(responsePath) === normalizeListingPath(target)
        if (checkDirectory && exactMatch) {
          clearTimeout(checkTimer)
          setDirectoryAccess({ path: target, status: listing.error ? 'denied' : 'allowed', error: listing.error || null })
        }
        // Correlate failures too: an old error must not clear fresh suggestions,
        // and an exact-cwd probe must not replace its parent's useful entries.
        const parentMatch = queryPath && (hasRequestId
          ? listing.requestId === parentRequestId
          : (responsePath ? normalizeListingPath(responsePath) === normalizeListingPath(queryPath) : !checkDirectory))
        if (!parentMatch) return
        if (listing.error || !listing.entries) {
          setSuggestions([])
          return
        }
        const dirs = listing.entries
          .filter(entry => entry.isDirectory)
          .filter(entry => !partial || entry.name.toLowerCase().startsWith(partial.toLowerCase()))
          .map(entry => `${responsePath}${/[/\\]$/.test(responsePath) ? '' : '/'}${entry.name}`)
        setSuggestions(dirs)
      })
      if (queryPath) {
        if (parentRequestId) requestDirectoryListing(queryPath, parentRequestId)
        else requestDirectoryListing(queryPath)
      }
      if (exactRequestId && exactRequestId !== parentRequestId) requestDirectoryListing(target, exactRequestId)
    }, DEBOUNCE_MS)
    return () => {
      active = false
      clearTimeout(debounce)
      clearTimeout(checkTimer)
    }
  }, [input, enabled, checkDirectory, requestDirectoryListing, setDirectoryListingCallback])

  useEffect(() => () => setDirectoryListingCallback(null), [setDirectoryListingCallback])
  return { suggestions, directoryAccess }
}
