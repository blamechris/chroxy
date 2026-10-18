/**
 * usePathAutocomplete — debounced directory path autocomplete via WS.
 *
 * Splits the input into parent dir + partial segment, requests a directory
 * listing from the server for the parent, and filters results by prefix match.
 */
import { useState, useEffect, useRef, useCallback, useId } from 'react'
import { useConnectionStore } from '../store/connection'
import type { DirectoryListing } from '../store/types'

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

export function usePathAutocomplete(input: string, checkedPath = '', enabled = true) {
  const [pathCheck, setPathCheck] = useState<{ path: string; error: string | null } | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const requestDirectoryListing = useConnectionStore(s => s.requestDirectoryListing)
  const setDirectoryListingCallback = useConnectionStore(s => s.setDirectoryListingCallback)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastParentRef = useRef('')
  const checkPrefix = useId()
  const checkSequenceRef = useRef(0)
  const checkRequestRef = useRef<string | null>(null)

  const inputRef = useRef(input)
  inputRef.current = input

  const handleListing = useCallback((listing: DirectoryListing) => {
    const responsePath = listing.path || listing.parentPath || ''
    // The server can expand/normalize the requested path. A nonce correlates
    // that reply without guessing its canonical spelling or accepting a stale
    // parent/check reply. Older daemons retain exact-path matching.
    const matchesCheck = listing.requestId
      ? listing.requestId === checkRequestRef.current
      : responsePath.replace(/\/+$/, '') === checkedPath.replace(/\/+$/, '')
    if (checkedPath && checkRequestRef.current && matchesCheck) {
      setPathCheck({ path: checkedPath, error: listing.error || null })
    }
    // The exact prefill check and autocomplete share the existing response
    // callback. A check reply must never replace parent-directory suggestions.
    if (responsePath && lastParentRef.current && responsePath !== lastParentRef.current) return
    if (listing.error || !listing.entries) {
      setSuggestions([])
      return
    }

    const { partial } = splitPath(inputRef.current)
    const parentPath = responsePath
    const dirs = listing.entries
      .filter(e => e.isDirectory)
      .filter(e => !partial || e.name.toLowerCase().startsWith(partial.toLowerCase()))
      .map(e => {
        const sep = parentPath.endsWith('/') || parentPath.endsWith('\\') ? '' : '/'
        return `${parentPath}${sep}${e.name}`
      })

    setSuggestions(dirs)
  }, [checkedPath])

  useEffect(() => {
    setPathCheck(null)
    checkRequestRef.current = null
    if (!enabled) return
    const { parent } = splitPath(input)
    if ((!input || input.length < 2 || !parent) && !checkedPath) {
      setSuggestions([])
      setDirectoryListingCallback(null)
      return
    }

    // If input ends with a separator, query the full path (user wants contents of this dir)
    const endsWithSep = input.endsWith('/') || input.endsWith('\\')
    const queryPath = endsWithSep ? input.replace(/[/\\]+$/, '') : parent

    if (debounceRef.current) clearTimeout(debounceRef.current)

    debounceRef.current = setTimeout(() => {
      lastParentRef.current = queryPath
      setDirectoryListingCallback(handleListing)
      if (checkedPath) {
        const requestId = `${checkPrefix}-${++checkSequenceRef.current}`
        checkRequestRef.current = requestId
        requestDirectoryListing(checkedPath, requestId)
      }
      if (queryPath && queryPath !== checkedPath) requestDirectoryListing(queryPath)
    }, DEBOUNCE_MS)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      checkRequestRef.current = null
    }
  }, [input, checkedPath, enabled, checkPrefix, handleListing, requestDirectoryListing, setDirectoryListingCallback])

  // Cleanup callback on unmount
  useEffect(() => {
    return () => setDirectoryListingCallback(null)
  }, [setDirectoryListingCallback])

  return { suggestions, pathCheck }
}
