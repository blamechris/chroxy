/**
 * Shared source of truth for the provider ids whose `cost` field is
 * computed client-side from token usage rather than reported by the
 * server.
 *
 * #4206: pre-fix this list lived twice — once in `status-tooltips.ts`
 * (to gate the "estimated client-side" wording in `costTooltip`) and
 * implicitly in `message-handler.ts` (where the only providers that
 * emit `cost: null` + a usage payload happened to be Codex and Gemini,
 * so the two sites agreed by accident). The moment a NEW provider
 * lands that emits `cost: null` + non-null `contextUsage` —
 * a Gemini fork, a future BYOK variant, an MCP provider — the
 * message-handler fallback would silently run the client-side
 * estimation and the cost-tooltip would call it server-authoritative.
 *
 * Both sites now import this set. Adding a provider here is the single
 * edit that keeps the fallback and the tooltip wording in lockstep.
 *
 * Keep this list narrow: a provider belongs here ONLY if its server
 * really cannot return a cost number. `claude-byok` does NOT belong
 * here — it computes cost server-side via the byok-session pricing
 * table — even though the value is table-priced rather than
 * API-billed-authoritative. (Refining the byok wording is a separate
 * concern; see #4206 issue body.)
 */
export const CLIENT_ESTIMATED_COST_PROVIDERS: ReadonlySet<string> = new Set([
  'codex',
  'gemini',
])
