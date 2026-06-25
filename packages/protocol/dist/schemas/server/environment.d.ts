/**
 * Server → Client schemas for the container/worktree environment lifecycle
 * results (#6332 batch 2b of #6314).
 *
 * Domain slice re-exported verbatim by ../server.ts (barrel). Shapes verified
 * against the emit sites in packages/server/src/handlers/feature-handlers.js and
 * the raw env objects EnvironmentManager.list()/get() return. NOTE: the wire
 * descriptor is BROADER than the dashboard's `EnvironmentInfo` TS interface
 * (which omits the compose-stack fields) — the schema follows the SERVER shape.
 *
 * All five types are dashboard-only today (the app has no environment surface).
 */
import { z } from 'zod';
export declare const ServerEnvironmentCreatedSchema: z.ZodObject<{
    type: z.ZodLiteral<"environment_created">;
    environmentId: z.ZodString;
    name: z.ZodString;
    status: z.ZodEnum<{
        error: "error";
        running: "running";
        stopped: "stopped";
    }>;
}, z.core.$strip>;
export declare const ServerEnvironmentDestroyedSchema: z.ZodObject<{
    type: z.ZodLiteral<"environment_destroyed">;
    environmentId: z.ZodString;
}, z.core.$strip>;
export declare const ServerEnvironmentErrorSchema: z.ZodObject<{
    type: z.ZodLiteral<"environment_error">;
    error: z.ZodString;
    environmentId: z.ZodOptional<z.ZodString>;
    code: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ServerEnvironmentInfoSchema: z.ZodObject<{
    type: z.ZodLiteral<"environment_info">;
    environment: z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        cwd: z.ZodString;
        image: z.ZodString;
        containerId: z.ZodString;
        containerUser: z.ZodString;
        containerCliPath: z.ZodString;
        status: z.ZodEnum<{
            error: "error";
            running: "running";
            stopped: "stopped";
        }>;
        sessions: z.ZodArray<z.ZodString>;
        createdAt: z.ZodString;
        memoryLimit: z.ZodNullable<z.ZodString>;
        cpuLimit: z.ZodNullable<z.ZodString>;
        compose: z.ZodNullable<z.ZodString>;
        composeProject: z.ZodNullable<z.ZodString>;
        primaryService: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        services: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            status: z.ZodString;
            primary: z.ZodBoolean;
        }, z.core.$strip>>>;
        snapshots: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            image: z.ZodString;
            createdAt: z.ZodString;
        }, z.core.$strip>>>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const ServerEnvironmentListSchema: z.ZodObject<{
    type: z.ZodLiteral<"environment_list">;
    environments: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        cwd: z.ZodString;
        image: z.ZodString;
        containerId: z.ZodString;
        containerUser: z.ZodString;
        containerCliPath: z.ZodString;
        status: z.ZodEnum<{
            error: "error";
            running: "running";
            stopped: "stopped";
        }>;
        sessions: z.ZodArray<z.ZodString>;
        createdAt: z.ZodString;
        memoryLimit: z.ZodNullable<z.ZodString>;
        cpuLimit: z.ZodNullable<z.ZodString>;
        compose: z.ZodNullable<z.ZodString>;
        composeProject: z.ZodNullable<z.ZodString>;
        primaryService: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        services: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            status: z.ZodString;
            primary: z.ZodBoolean;
        }, z.core.$strip>>>;
        snapshots: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            image: z.ZodString;
            createdAt: z.ZodString;
        }, z.core.$strip>>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
