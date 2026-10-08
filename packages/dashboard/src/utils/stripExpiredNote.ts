/**
 * #7353 — the expired-permission handler appends its own
 * `\n(Expired — …)` note to the prompt's stored content (message-handler.ts,
 * `permission_expired`). The compact "dropped" record states the outcome
 * itself, so that trailing note is stripped rather than shown twice.
 */
export function stripExpiredNote(description: string): string {
  return description.replace(/\n\(Expired[^\n]*\)\s*$/, '')
}
