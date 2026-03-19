/**
 * usePathAutocomplete — debounced directory path autocomplete via WS.
 *
 * Splits the input into parent dir + partial segment, requests a directory
 * listing from the server for the parent, and filters results by prefix match.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
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

export function usePathAutocomplete(input: string) {
  const [suggestions, setSuggestions] = useState<string[]>([])
  const requestDirectoryListing = useConnectionStore(s => s.requestDirectoryListing)
  const setDirectoryListingCallback = useConnectionStore(s => s.setDirectoryListingCallback)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastParentRef = useRef('')

  const inputRef = useRef(input)
  inputRef.current = input

  const handleListing = useCallback((listing: DirectoryListing) => {
    if (listing.error || !listing.entries) {
      setSuggestions([])
      return
    }

    // Guard against out-of-order responses — only accept listings matching the last request
    const responsePath = listing.path || listing.parentPath || ''
    if (responsePath && lastParentRef.current && responsePath !== lastParentRef.current) {
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
  }, [])

  useEffect(() => {
    if (!input || input.length < 2) {
      setSuggestions([])
      setDirectoryListingCallback(null)
      return
    }

    const { parent } = splitPath(input)

    // Need at least a parent directory to query
    if (!parent) {
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
      requestDirectoryListing(queryPath)
    }, DEBOUNCE_MS)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [input, handleListing, requestDirectoryListing, setDirectoryListingCallback])

  // Cleanup callback on unmount
  useEffect(() => {
    return () => setDirectoryListingCallback(null)
  }, [setDirectoryListingCallback])

  return { suggestions }
}
