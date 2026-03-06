/**
 * usePathAutocomplete — debounced directory path autocomplete via WS.
 *
 * Splits the input into parent dir + partial segment, requests a directory
 * listing from the server for the parent, and filters results by prefix match.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { useConnectionStore } from '../store/connection'
import type { DirectoryListing } from '../store/types'

/** Split a path into the parent directory and the partial segment being typed. */
export function splitPath(input: string): { parent: string; partial: string } {
  if (!input) return { parent: '', partial: '' }

  // Handle ~ expansion
  const normalized = input.startsWith('~/')
    ? input  // Server handles ~ expansion
    : input

  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) return { parent: '', partial: normalized }
  if (lastSlash === 0) return { parent: '/', partial: normalized.slice(1) }
  return { parent: normalized.slice(0, lastSlash), partial: normalized.slice(lastSlash + 1) }
}

const DEBOUNCE_MS = 200

export function usePathAutocomplete(input: string) {
  const [suggestions, setSuggestions] = useState<string[]>([])
  const requestDirectoryListing = useConnectionStore(s => s.requestDirectoryListing)
  const setDirectoryListingCallback = useConnectionStore(s => s.setDirectoryListingCallback)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastParentRef = useRef('')

  const handleListing = useCallback((listing: DirectoryListing) => {
    if (listing.error || !listing.entries) {
      setSuggestions([])
      return
    }

    const { partial } = splitPath(input)
    const parentPath = listing.path || listing.parentPath || ''
    const dirs = listing.entries
      .filter(e => e.isDirectory)
      .filter(e => !partial || e.name.toLowerCase().startsWith(partial.toLowerCase()))
      .map(e => {
        const sep = parentPath.endsWith('/') ? '' : '/'
        return `${parentPath}${sep}${e.name}`
      })

    setSuggestions(dirs)
  }, [input])

  useEffect(() => {
    if (!input || input.length < 2) {
      setSuggestions([])
      return
    }

    const { parent } = splitPath(input)

    // Need at least a parent directory to query
    if (!parent) {
      setSuggestions([])
      return
    }

    // If input ends with /, query the full path (user wants contents of this dir)
    const queryPath = input.endsWith('/') ? input.replace(/\/+$/, '') : parent

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
