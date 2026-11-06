import { z } from 'zod';
export declare const DeclaredStatusInputSchema: z.ZodObject<{
    state: z.ZodEnum<{
        unknown: "unknown";
        blocked: "blocked";
        running: "running";
        done: "done";
        idle: "idle";
        stalled: "stalled";
    }>;
    summary: z.ZodString;
    next: z.ZodOptional<z.ZodString>;
    blockedOn: z.ZodOptional<z.ZodString>;
    etaMinutes: z.ZodOptional<z.ZodNumber>;
    decision: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const DeclaredStatusSchema: z.ZodObject<{
    state: z.ZodEnum<{
        unknown: "unknown";
        blocked: "blocked";
        running: "running";
        done: "done";
        idle: "idle";
        stalled: "stalled";
    }>;
    summary: z.ZodString;
    next: z.ZodOptional<z.ZodString>;
    blockedOn: z.ZodOptional<z.ZodString>;
    etaMinutes: z.ZodOptional<z.ZodNumber>;
    decision: z.ZodOptional<z.ZodString>;
    updatedAt: z.ZodNumber;
    source: z.ZodEnum<{
        api: "api";
        marker: "marker";
        hook: "hook";
    }>;
}, z.core.$strict>;
export type DeclaredStatus = z.infer<typeof DeclaredStatusSchema>;
