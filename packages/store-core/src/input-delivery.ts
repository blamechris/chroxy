import {
  ServerInputAckSchema,
  type InputContextEnvelope,
} from '@chroxy/protocol/schemas'

export type InputDeliveryStatus =
  | 'uncertain'
  | 'accepted'
  | 'queued'
  | 'duplicate'
  | 'rejected'
  | 'expired'
  | 'cancelled'

export interface InputDeliveryRecord {
  clientMessageId: string
  sessionId: string | null
  status: InputDeliveryStatus
  delivery: 'dispatch_started' | 'queued' | 'evaluation_held' | 'not_dispatched' | 'unknown'
  pendingContextItemIds: string[]
  acceptedAt?: number
  retentionExpiresAt?: number
  reason?: string
  message?: string
  updatedAt: number
}

export type InputDeliveryMap = Record<string, InputDeliveryRecord>

export const MAX_INPUT_DELIVERY_RECORDS = 128

function bounded(records: InputDeliveryMap): InputDeliveryMap {
  const entries = Object.entries(records)
  if (entries.length <= MAX_INPUT_DELIVERY_RECORDS) return records
  entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt)
  return Object.fromEntries(entries.slice(entries.length - MAX_INPUT_DELIVERY_RECORDS))
}

/** A successful socket write remains uncertain until input_ack arrives. */
export function beginInputDelivery(
  current: InputDeliveryMap | undefined,
  clientMessageId: string,
  context: InputContextEnvelope,
  now = Date.now(),
  sessionId: string | null = null,
): InputDeliveryMap {
  const records = current ?? {}
  return bounded({
    ...records,
    [clientMessageId]: {
      clientMessageId,
      sessionId,
      status: 'uncertain',
      delivery: 'unknown',
      pendingContextItemIds: context.items.filter((item) => item.lifetime === 'one_turn').map((item) => item.id),
      updatedAt: now,
    },
  })
}

/** Late/duplicate acknowledgements resolve only their correlated request. */
export function applyInputAcknowledgement(current: InputDeliveryMap | undefined, value: unknown): InputDeliveryMap {
  const records = current ?? {}
  const parsed = ServerInputAckSchema.safeParse(value)
  if (!parsed.success) return records
  const ack = parsed.data
  const previous = records[ack.clientMessageId]
  const provesContextAdmission = ack.delivery === 'dispatch_started' || ack.delivery === 'queued'
  const acceptedIds = provesContextAdmission &&
    (ack.status === 'accepted' || ack.status === 'queued' || ack.status === 'duplicate')
    ? new Set(ack.context?.acceptedItemIds ?? [])
    : new Set<string>()
  return bounded({
    ...records,
    [ack.clientMessageId]: {
      clientMessageId: ack.clientMessageId,
      sessionId: ack.sessionId,
      status: ack.status,
      delivery: ack.delivery,
      pendingContextItemIds: (previous?.pendingContextItemIds ?? []).filter((id) => !acceptedIds.has(id)),
      ...(ack.acceptedAt === undefined ? {} : { acceptedAt: ack.acceptedAt }),
      ...(ack.retentionExpiresAt === undefined ? {} : { retentionExpiresAt: ack.retentionExpiresAt }),
      ...(ack.reason === undefined ? {} : { reason: ack.reason }),
      ...(ack.message === undefined ? {} : { message: ack.message }),
      updatedAt: Date.now(),
    },
  })
}

/** Cancellation/user removal consumes one-shot context without a server retry. */
export function cancelInputDelivery(current: InputDeliveryMap | undefined, clientMessageId: string): InputDeliveryMap {
  const records = current ?? {}
  const previous = records[clientMessageId]
  if (!previous) return records
  return {
    ...records,
    [clientMessageId]: {
      ...previous,
      status: 'cancelled',
      delivery: 'not_dispatched',
      pendingContextItemIds: [],
      updatedAt: Date.now(),
    },
  }
}
