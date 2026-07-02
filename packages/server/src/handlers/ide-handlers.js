/**
 * IDE feature handlers (epic #6469).
 *
 * The opt-in IDE navigation surface — file/symbol navigation, go-to-definition,
 * search. Every handler here is GATED on the `features.ide` flag (#6481) and
 * fails closed when off: the server advertises the `ide` capability only when
 * the operator opts in, so clients won't send these messages, and the handler
 * additionally returns early as defence-in-depth. Off ⇒ zero IDE behaviour.
 *
 * Handles: list_symbols (#6471), resolve_symbol (#6475).
 */
import { resolveSession } from '../handler-utils.js'
import { isIdeFeatureEnabled } from '../config.js'
import { collectWorkspaceSymbols, resolveSymbol } from '../ide/symbols.js'
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
    const { symbols, truncated } = await collectWorkspaceSymbols(cwd, { path })
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
  const fromFile = typeof msg.file === 'string' && msg.file ? msg.file : null

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

export const ideHandlers = {
  list_symbols: handleListSymbols,
  resolve_symbol: handleResolveSymbol,
}
