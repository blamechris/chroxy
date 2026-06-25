/**
 * Provider-capability limitation note (#6312).
 *
 * Some providers — notably `claude-tui`, the zero-config default — report
 * `modelSwitch` / `planMode` / `streaming` as `false`. The matching affordances
 * are gated client-side, but the limitation is communicated only by the ABSENCE
 * of a UI control, so a first-time user has no explanation for why plan mode,
 * streaming, or model switching is missing. This builds a concise, human note for
 * the session-creation UI so the absence is explained rather than silent.
 */

/** The capability flags whose `false` value is worth explaining at session creation. */
export interface DegradableCapabilities {
  modelSwitch?: boolean
  planMode?: boolean
  streaming?: boolean
}

// Order here is the order the limitations are listed in the note.
const DEGRADE_LABELS: Array<[keyof DegradableCapabilities, string]> = [
  ['planMode', 'plan mode'],
  ['streaming', 'streaming'],
  ['modelSwitch', 'model switching'],
]

/**
 * Build a one-line "This provider doesn't support …" note from a provider's
 * capability flags, listing only the degradable capabilities reported as
 * `false`. Returns `null` when none are disabled (a fully-capable provider shows
 * no note) or when `caps` is missing — callers render nothing in that case.
 */
export function buildProviderLimitationNote(
  caps: DegradableCapabilities | null | undefined,
): string | null {
  if (!caps) return null
  const missing = DEGRADE_LABELS.filter(([key]) => caps[key] === false).map(([, label]) => label)
  if (missing.length === 0) return null
  const list =
    missing.length === 1
      ? missing[0]
      : missing.length === 2
        ? `${missing[0]} and ${missing[1]}`
        : // 3+ — Oxford comma before the final "and".
          `${missing.slice(0, -1).join(', ')}, and ${missing[missing.length - 1]}`
  return `This provider doesn't support ${list}.`
}
