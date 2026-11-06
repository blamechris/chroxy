import { z } from 'zod'

// Agent-declared intent is independent of observed provider busy/liveness.
export const DeclaredStatusInputSchema = z.object({
  state: z.enum(['running', 'idle', 'blocked', 'stalled', 'done', 'unknown']),
  summary: z.string().trim().min(1).max(280),
  next: z.string().trim().min(1).max(280).optional(),
  blockedOn: z.string().trim().min(1).max(280).optional(),
  etaMinutes: z.number().finite().nonnegative().max(525600).optional(),
  // Absence preserves a pending decision; explicit "none" clears it.
  decision: z.string().trim().min(1).max(280).optional(),
}).strict()

export const DeclaredStatusSchema = DeclaredStatusInputSchema.extend({
  updatedAt: z.number().int().nonnegative(),
  source: z.enum(['marker', 'api', 'hook']),
})

export type DeclaredStatus = z.infer<typeof DeclaredStatusSchema>
