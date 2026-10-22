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

const stripTrailingSep = (p: string) => (p.length > 1 ? p.replace(/[/\\]+$/, '') : p)

/**
 * @param input - the path being typed
 * @param probePath - optional prefilled directory to probe (#8303): the hook asks
 *   the server to list it once and reports whether Browse can open it, through
 *   `probeBrowsable` (null = unknown / not probed, false = the server refused).
 *   It rides this hook because the store has ONE directory-listing callback slot,
 *   and a second consumer would clobber autocomplete's.
 */
export function usePathAutocomplete(input: string, probePath?: string | null) {
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [probe, setProbe] = useState<{ path: string; ok: boolean } | null>(null)
  const probePathRef = useRef<string | null>(null)
  probePathRef.current = probePath ? stripTrailingSep(probePath) : null
  const requestDirectoryListing = useConnectionStore(s => s.requestDirectoryListing)
  const setDirectoryListingCallback = useConnectionStore(s => s.setDirectoryListingCallback)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastParentRef = useRef('')

  const inputRef = useRef(input)
  inputRef.current = input

  const handleListing = useCallback((listing: DirectoryListing) => {
    const target = probePathRef.current
    const listed = listing.path ? stripTrailingSep(listing.path) : ''
    if (target && listed === target) {
      // Only a refusal counts: a missing directory is the modal's own "New directory" hint.
      setProbe({ path: target, ok: !(listing.error && listing.error.startsWith('Access denied')) })
      // A probe reply that is NOT also the parent autocomplete asked for must
      // not touch the suggestions (an error here would blank them).
      if (listed !== lastParentRef.current) return
    }
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

  // #8303: one-shot probe of the prefilled directory. Same callback slot as the
  // autocomplete listing above, so it is set here, after the modal's open reset.
  useEffect(() => {
    if (!probePath) return
    const timer = setTimeout(() => {
      setDirectoryListingCallback(handleListing)
      requestDirectoryListing(probePath)
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [probePath, handleListing, requestDirectoryListing, setDirectoryListingCallback])

  // Cleanup callback on unmount
  useEffect(() => {
    return () => setDirectoryListingCallback(null)
  }, [setDirectoryListingCallback])

  const probeBrowsable = probePath && probe && probe.path === stripTrailingSep(probePath) ? probe.ok : null
  return { suggestions, probeBrowsable }
}
