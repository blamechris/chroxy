/**
 * IDE feature handlers (epic #6469).
 *
 * The opt-in IDE navigation surface — file/symbol navigation, go-to-definition,
 * search. Every handler here is GATED on the `features.ide` flag (#6481) and
 * fails closed when off: the server advertises the `ide` capability only when
 * the operator opts in, so clients won't send these messages, and the handler
 * additionally returns early as defence-in-depth. Off ⇒ zero IDE behaviour.
 *
 * Handles: list_symbols (#6471), resolve_symbol (#6475), search_content (#6474),
 * find_references (#6477).
 */
import { resolveSession } from '../handler-utils.js'
import { isIdeFeatureEnabled } from '../config.js'
import { collectWorkspaceSymbols, getWorkspaceSymbolIndex, resolveSymbol } from '../ide/symbols.js'
import { searchContent, findReferences } from '../ide/search.js'
import { createLogger } from '../logger.js'

const log = createLogger('ide')

/**
 * `list_symbols` → `symbols_snapshot`. Parses the session workspace (or an
 * optional sub-path) with the self-contained regex symbol parser and returns
 * the symbol table. Dashboard-only consumer for v1 (#6472 renders it).
 */
async function handleListSymbols(ws, client, msg, ctx) {
  // #6481 (epic #6469): fail closed when the IDE surface is not opted in.
  if (!isIdeFeatureEnabled(ctx.services?.config)) return

  const path = typeof msg.path === 'string' && msg.path ? msg.path : null
  const entry = resolveSession(ctx, msg, client)
  const cwd = entry?.cwd || null

  if (!cwd) {
    ctx.transport.send(ws, {
      type: 'symbols_snapshot',
      path,
      symbols: [],
      truncated: false,
      error: 'No workspace directory for this session',
    })
    return
  }

  try {
    // Whole-workspace list_symbols (no path) shares the TTL symbol-index cache
    // (#6499) with resolve_symbol; a scoped path re-scans that sub-tree fresh.
    const { symbols, truncated } = path
      ? await collectWorkspaceSymbols(cwd, { path })
      : await getWorkspaceSymbolIndex(cwd)
    ctx.transport.send(ws, { type: 'symbols_snapshot', path, symbols, truncated, error: null })
  } catch (err) {
    log.debug(`list_symbols failed: ${err?.message}`)
    ctx.transport.send(ws, {
      type: 'symbols_snapshot',
      path,
      symbols: [],
      truncated: false,
      error: err?.message || 'Failed to list symbols',
    })
  }
}

/**
 * `resolve_symbol` → `symbol_location`. Go-to-definition (#6475): resolves a
 * clicked symbol NAME to a single declaration over the same regex index
 * list_symbols uses. `file` (the originating file) only breaks ranking ties.
 * A hit sends `{ file, line, error: null }`; a miss sends `{ file: null,
 * line: null, error }` so the client can show a graceful 'definition not found'.
 * Dashboard-only consumer for v1.
 */
async function handleResolveSymbol(ws, client, msg, ctx) {
  // #6481 (epic #6469): fail closed when the IDE surface is not opted in.
  if (!isIdeFeatureEnabled(ctx.services?.config)) return

  const symbol = typeof msg.symbol === 'string' ? msg.symbol.trim() : ''
  // Normalize the tie-break hint to the workspace-relative POSIX form
  // collectWorkspaceSymbols emits (forward slashes), so a Windows-style path or
  // stray whitespace from any client still matches `s.file`. Pure string compare
  // — no security impact (#6498 review, cross-platform determinism).
  const fromFile = typeof msg.file === 'string' && msg.file.trim()
    ? msg.file.trim().replace(/\\/g, '/')
    : null

  if (!symbol) {
    ctx.transport.send(ws, { type: 'symbol_location', symbol: '', file: null, line: null, error: 'No symbol to resolve' })
    return
  }

  const entry = resolveSession(ctx, msg, client)
  const cwd = entry?.cwd || null
  if (!cwd) {
    ctx.transport.send(ws, {
      type: 'symbol_location',
      symbol,
      file: null,
      line: null,
      error: 'No workspace directory for this session',
    })
    return
  }

  try {
    const loc = await resolveSymbol(cwd, symbol, { fromFile })
    ctx.transport.send(ws, loc
      ? { type: 'symbol_location', symbol, file: loc.file, line: loc.line, error: null }
      : { type: 'symbol_location', symbol, file: null, line: null, error: 'Definition not found' })
  } catch (err) {
    log.debug(`resolve_symbol failed: ${err?.message}`)
    ctx.transport.send(ws, {
      type: 'symbol_location',
      symbol,
      file: null,
      line: null,
      error: err?.message || 'Failed to resolve symbol',
    })
  }
}

/**
 * `search_content` → `code_search_results`. Find-in-project (#6474):
 * case-insensitive substring grep over the session workspace (or an optional
 * sub-path), returning file/line/column + the matched line for preview. The
 * response type is `code_search_results` (NOT `search_results`, owned by the
 * cross-session conversation search). Dashboard-only consumer (Cmd+Shift+F).
 */
async function handleSearchContent(ws, client, msg, ctx) {
  // #6481 (epic #6469): fail closed when the IDE surface is not opted in.
  if (!isIdeFeatureEnabled(ctx.services?.config)) return

  // #6506 — single-flight per connection: a newer search_content supersedes any
  // in-flight walk. Stamp a monotonic token; the walk polls isCancelled() and
  // aborts once the token moves, and we skip emitting a superseded reply — so the
  // daemon runs at most one workspace walk per client at a time under fast typing.
  // Stamped before the empty-query branch so clearing the box also cancels a walk.
  const token = (client._ideSearchToken || 0) + 1
  client._ideSearchToken = token
  const superseded = () => client._ideSearchToken !== token

  const query = typeof msg.query === 'string' ? msg.query.trim() : ''
  const path = typeof msg.path === 'string' && msg.path ? msg.path : null

  if (!query) {
    ctx.transport.send(ws, { type: 'code_search_results', query: '', results: [], truncated: false, error: null })
    return
  }

  const entry = resolveSession(ctx, msg, client)
  const cwd = entry?.cwd || null
  if (!cwd) {
    ctx.transport.send(ws, {
      type: 'code_search_results',
      query,
      results: [],
      truncated: false,
      error: 'No workspace directory for this session',
    })
    return
  }

  try {
    const { results, truncated } = await searchContent(cwd, query, { path, isCancelled: superseded })
    // A newer search landed while this walk ran — it emits its own results; stay
    // silent so a stale reply can't clobber the fresher one.
    if (superseded()) return
    ctx.transport.send(ws, { type: 'code_search_results', query, results, truncated, error: null })
  } catch (err) {
    if (superseded()) return
    log.debug(`search_content failed: ${err?.message}`)
    ctx.transport.send(ws, {
      type: 'code_search_results',
      query,
      results: [],
      truncated: false,
      error: err?.message || 'Failed to search',
    })
  }
}

/**
 * `find_references` → `references_result`. Find-all-references (#6477): a
 * word-boundary, case-sensitive grep for a symbol NAME over the same confined
 * walk search_content uses, returning every referencing site. `file` (the
 * originating file) ranks that file's references first (#6516), mirroring how
 * resolveSymbol uses it as a tie-break. Dashboard-only consumer for v1 (the
 * references palette).
 */
async function handleFindReferences(ws, client, msg, ctx) {
  // #6481 (epic #6469): fail closed when the IDE surface is not opted in.
  if (!isIdeFeatureEnabled(ctx.services?.config)) return

  const symbol = typeof msg.symbol === 'string' ? msg.symbol.trim() : ''
  // The originating file (the symbol was alt+clicked in) — normalized to the
  // workspace-relative POSIX form findReferences ranks against (#6516), same as
  // handleResolveSymbol does for its tie-break.
  const fromFile = typeof msg.file === 'string' && msg.file.trim()
    ? msg.file.trim().replace(/\\/g, '/')
    : null

  if (!symbol) {
    ctx.transport.send(ws, { type: 'references_result', symbol: '', results: [], truncated: false, error: null })
    return
  }

  const entry = resolveSession(ctx, msg, client)
  const cwd = entry?.cwd || null
  if (!cwd) {
    ctx.transport.send(ws, {
      type: 'references_result',
      symbol,
      results: [],
      truncated: false,
      error: 'No workspace directory for this session',
    })
    return
  }

  try {
    const { results, truncated } = await findReferences(cwd, symbol, { fromFile })
    ctx.transport.send(ws, { type: 'references_result', symbol, results, truncated, error: null })
  } catch (err) {
    log.debug(`find_references failed: ${err?.message}`)
    ctx.transport.send(ws, {
      type: 'references_result',
      symbol,
      results: [],
      truncated: false,
      error: err?.message || 'Failed to find references',
    })
  }
}

export const ideHandlers = {
  list_symbols: handleListSymbols,
  resolve_symbol: handleResolveSymbol,
  search_content: handleSearchContent,
  find_references: handleFindReferences,
}
