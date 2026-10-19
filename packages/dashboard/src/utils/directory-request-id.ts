let directoryRequestNonce = 0

/** Unique across Browse, autocomplete, probes and component remounts. */
export function nextDirectoryRequestId(): string {
  return `directory-${++directoryRequestNonce}`
}
