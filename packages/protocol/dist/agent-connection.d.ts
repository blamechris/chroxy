import { z } from 'zod';
export declare const AGENT_CONNECTION_VERSION: 1;
export declare const AgentConnectionSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    id: z.ZodString;
    label: z.ZodString;
    provider: z.ZodString;
    runtime: z.ZodObject<{
        id: z.ZodString;
        version: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
    accountRef: z.ZodNullable<z.ZodString>;
    authentication: z.ZodObject<{
        requested: z.ZodEnum<{
            native: "native";
            api: "api";
            local: "local";
            imported: "imported";
            unknown: "unknown";
        }>;
        observed: z.ZodEnum<{
            native: "native";
            local: "local";
            unknown: "unknown";
            "api-key": "api-key";
            none: "none";
        }>;
    }, z.core.$strip>;
    entitlement: z.ZodObject<{
        route: z.ZodEnum<{
            api: "api";
            local: "local";
            unknown: "unknown";
            subscription: "subscription";
        }>;
        status: z.ZodEnum<{
            unknown: "unknown";
            available: "available";
            unavailable: "unavailable";
        }>;
    }, z.core.$strip>;
    model: z.ZodObject<{
        requested: z.ZodNullable<z.ZodString>;
        resolved: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
    execution: z.ZodObject<{
        host: z.ZodEnum<{
            unknown: "unknown";
            daemon: "daemon";
            container: "container";
            remote: "remote";
        }>;
        inference: z.ZodEnum<{
            local: "local";
            unknown: "unknown";
            remote: "remote";
        }>;
    }, z.core.$strip>;
    readiness: z.ZodObject<{
        state: z.ZodEnum<{
            unknown: "unknown";
            ready: "ready";
            blocked: "blocked";
            unsupported: "unsupported";
        }>;
        reasonCode: z.ZodNullable<z.ZodString>;
        message: z.ZodNullable<z.ZodString>;
        recoveryAction: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
    provenance: z.ZodObject<{
        source: z.ZodEnum<{
            configured: "configured";
            legacy: "legacy";
        }>;
        observedAt: z.ZodString;
        expiresAt: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strict>;
export type AgentConnection = z.infer<typeof AgentConnectionSchema>;
export type AgentConnectionAuthRoute = AgentConnection['authentication']['requested'];
