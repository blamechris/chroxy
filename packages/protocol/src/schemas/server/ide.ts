/**
 * Server → Client schemas for the IDE navigation surface (epic #6469).
 *
 * Domain slice of the server→client schema surface; re-exported verbatim by
 * ../server.ts (barrel). The whole surface is gated behind the opt-in
 * `features.ide` flag (#6481) — the server advertises the `ide` capability and
 * emits these messages only when the operator opts in.
 *
 * v1 is DASHBOARD_ONLY (the mobile app has no symbol surface yet); the asymmetry
 * is declared in the protocol type-coverage lint (DASHBOARD_ONLY) and the
 * handler-coverage guard (PLATFORM_SPECIFIC: 'dashboard').
 */
import { z } from 'zod'

// One parsed declaration. `kind` is an open string (function/class/const/
// variable/interface/type/enum/method) rather than a closed enum so the
// regex parser can grow new kinds without a schema bump; `line` is 1-indexed;
// `file` is the workspace-relative POSIX path; `exported` is the visibility flag.
export const SymbolEntrySchema = z.object({
  name: z.string(),
  kind: z.string(),
  file: z.string(),
  line: z.number(),
  exported: z.boolean(),
})

// `list_symbols` response (#6471). `path` echoes the requested scope (null for a
// whole-workspace scan). `truncated` is true when a scan cap (max files/symbols)
// was hit. `error` is non-null only on failure (symbols then empty).
export const ServerSymbolsSnapshotSchema = z.object({
  type: z.literal('symbols_snapshot'),
  path: z.string().nullable(),
  symbols: z.array(SymbolEntrySchema),
  truncated: z.boolean(),
  error: z.string().nullable(),
})

export type SymbolEntry = z.infer<typeof SymbolEntrySchema>
export type ServerSymbolsSnapshotMessage = z.infer<typeof ServerSymbolsSnapshotSchema>
