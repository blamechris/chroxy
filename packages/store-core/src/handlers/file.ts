/**
 * Shared stateless handlers for file-operation result messages
 * (directory_listing / file_listing / file_content / write_file_result).
 *
 * Extracted from the handlers barrel (audit P2-3) — pure move, no logic
 * change. Re-exported from ./index so the public surface is unchanged. These
 * handlers normalize the wire payload then hand it to a platform callback;
 * concrete entry types live downstream in the app/dashboard. See the
 * module-level doc in ./index.ts for the stateless-handler contract.
 */

// ---------------------------------------------------------------------------
// File operations: directory_listing / file_listing / file_content /
// write_file_result
//
// These cases all extract a normalized payload then forward to a platform
// callback. The payload normalisation is the duplication; the callback
// dispatch (`get()._fooCallback` vs `getCallback('foo')`) stays at the call
// site.
//
// Concrete entry types (`DirectoryEntry`, `FileEntry`) live downstream in
// dashboard/app — the shared payloads keep arrays as `unknown[]`. Each call
// site casts to its own concrete type when forwarding to the callback.
// ---------------------------------------------------------------------------

/**
 * Internal helper that extracts the `(path, parentPath, entries, error)`
 * quadruple shared by `directory_listing` and `file_listing` messages
 * (#3131). Per-element shape of `entries` is NOT validated — callers cast
 * to their own concrete entry type when invoking the callback.
 */
function extractEntriesPayload(
  msg: Record<string, unknown>,
): {
  path: string | null
  parentPath: string | null
  entries: unknown[]
  error: string | null
} {
  return {
    path: typeof msg.path === 'string' ? msg.path : null,
    parentPath: typeof msg.parentPath === 'string' ? msg.parentPath : null,
    entries: Array.isArray(msg.entries) ? (msg.entries as unknown[]) : [],
    error: typeof msg.error === 'string' ? msg.error : null,
  }
}

/** Parsed payload for a `directory_listing` message. */
export interface DirectoryListingPayload {
  /** Directory path that was listed (raw string, not trimmed). Null if missing/non-string. */
  path: string | null
  /** Parent directory path (raw string). Null if missing/non-string. */
  parentPath: string | null
  /** Listing entries — forwarded verbatim. Empty array when missing/non-array. */
  entries: unknown[]
  /** Error string from the server, if any. Null when missing/non-string. */
  error: string | null
}

/**
 * Parse a `directory_listing` message into the fields the dashboard and app
 * forward to their `_directoryListingCallback` / `getCallback('directoryListing')`.
 *
 * Behaviour-preserving: delegates to {@link extractEntriesPayload} (#3131).
 * Per-element shape of `entries` is NOT validated — callers cast to their
 * own concrete entry type when invoking the callback.
 */
export function handleDirectoryListing(
  msg: Record<string, unknown>,
): DirectoryListingPayload {
  return extractEntriesPayload(msg)
}

/** Parsed payload for a `file_listing` message. */
export interface FileListingPayload {
  /** Listed path (raw string). Null if missing/non-string. */
  path: string | null
  /** Parent path (raw string). Null if missing/non-string. */
  parentPath: string | null
  /** File entries — forwarded verbatim. Empty array when missing/non-array. */
  entries: unknown[]
  /** Error string from the server, if any. Null when missing/non-string. */
  error: string | null
}

/**
 * Parse a `file_listing` message into a normalised payload.
 *
 * Same shape as `handleDirectoryListing` — both messages share the
 * `(path, parentPath, entries, error)` quadruple, but they target different
 * callback channels (`fileBrowser` vs `directoryListing`). The downstream
 * concrete entry types (`FileEntry` vs `DirectoryEntry`) live in the
 * dashboard/app and are applied via cast at the call site. Delegates to
 * the shared {@link extractEntriesPayload} helper (#3131).
 */
export function handleFileListing(msg: Record<string, unknown>): FileListingPayload {
  return extractEntriesPayload(msg)
}

/** Parsed payload for a `file_content` message. */
export interface FileContentPayload {
  /** File path the content corresponds to. Null if missing/non-string. */
  path: string | null
  /** File contents (raw string, not trimmed). Null if missing/non-string. */
  content: string | null
  /** Detected language (e.g. `'typescript'`). Null if missing/non-string. */
  language: string | null
  /** Reported size in bytes. Null if missing/non-number. */
  size: number | null
  /**
   * Whether the server truncated the content. Strict `=== true` check —
   * truthy strings/numbers do NOT count, matching both clients' prior
   * inline `msg.truncated === true` guard.
   */
  truncated: boolean
  /** Error string from the server, if any. Null when missing/non-string. */
  error: string | null
}

/**
 * Parse a `file_content` message into a normalised payload.
 *
 * Behaviour-preserving: per-field guards match the inline implementations
 * in both clients. Note that `truncated` requires literal `true` — `'true'`,
 * `1`, and other truthy values resolve to `false`.
 */
export function handleFileContent(msg: Record<string, unknown>): FileContentPayload {
  return {
    path: typeof msg.path === 'string' ? msg.path : null,
    content: typeof msg.content === 'string' ? msg.content : null,
    language: typeof msg.language === 'string' ? msg.language : null,
    size: typeof msg.size === 'number' ? msg.size : null,
    truncated: msg.truncated === true,
    error: typeof msg.error === 'string' ? msg.error : null,
  }
}

/** Parsed payload for a `write_file_result` message (app-only today). */
export interface WriteFileResultPayload {
  /** Path that was written. Null if missing/non-string. */
  path: string | null
  /** Error string from the server, if any. Null when missing/non-string. */
  error: string | null
}

/**
 * Parse a `write_file_result` message into a normalised payload.
 *
 * App-only handler today — the dashboard does not yet have a
 * `write_file_result` case. Extracted here so dashboard can adopt the same
 * shape without duplicating logic later.
 */
export function handleWriteFileResult(
  msg: Record<string, unknown>,
): WriteFileResultPayload {
  return {
    path: typeof msg.path === 'string' ? msg.path : null,
    error: typeof msg.error === 'string' ? msg.error : null,
  }
}
