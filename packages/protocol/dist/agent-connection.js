import { z } from 'zod';
export const AGENT_CONNECTION_VERSION = 1;
const NullableBoundedString = z.string().max(512).nullable();
export const AgentConnectionSchema = z.object({
    version: z.literal(AGENT_CONNECTION_VERSION),
    id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    label: z.string().min(1).max(200),
    provider: z.string().min(1).max(128),
    runtime: z.object({
        id: z.string().min(1).max(256),
        version: NullableBoundedString,
    }),
    accountRef: NullableBoundedString,
    authentication: z.object({
        requested: z.enum(['native', 'api', 'local', 'imported', 'unknown']),
        observed: z.enum(['native', 'api-key', 'local', 'none', 'unknown']),
    }),
    entitlement: z.object({
        route: z.enum(['subscription', 'api', 'local', 'unknown']),
        status: z.enum(['available', 'unavailable', 'unknown']),
    }),
    model: z.object({
        requested: NullableBoundedString,
        resolved: NullableBoundedString,
    }),
    execution: z.object({
        host: z.enum(['daemon', 'container', 'remote', 'unknown']),
        inference: z.enum(['local', 'remote', 'unknown']),
    }),
    readiness: z.object({
        state: z.enum(['ready', 'blocked', 'unsupported', 'unknown']),
        reasonCode: NullableBoundedString,
        message: NullableBoundedString,
        recoveryAction: NullableBoundedString,
    }),
    provenance: z.object({
        source: z.enum(['configured', 'legacy']),
        observedAt: z.string().datetime(),
        expiresAt: z.string().datetime().nullable(),
    }),
}).strict();
