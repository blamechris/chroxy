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
const EnvironmentStatusSchema = z.enum(['running', 'stopped', 'error']);
// One environment descriptor — the raw env object EnvironmentManager returns
// (round-tripped through JSON persist). The compose-* fields are present only on
// compose-stack envs; memoryLimit/cpuLimit/compose/composeProject are always
// present but null on the side that doesn't apply (standard vs compose).
const EnvironmentDescriptorSchema = z.object({
    id: z.string(),
    name: z.string(),
    cwd: z.string(),
    image: z.string(),
    containerId: z.string(),
    containerUser: z.string(),
    containerCliPath: z.string(),
    status: EnvironmentStatusSchema,
    sessions: z.array(z.string()),
    createdAt: z.string(),
    memoryLimit: z.string().nullable(),
    cpuLimit: z.string().nullable(),
    compose: z.string().nullable(),
    composeProject: z.string().nullable(),
    // compose-stack only:
    primaryService: z.string().nullable().optional(),
    services: z.array(z.object({
        name: z.string(),
        status: z.string(),
        primary: z.boolean(),
    })).optional(),
    snapshots: z.array(z.object({
        id: z.string(),
        name: z.string(),
        image: z.string(),
        createdAt: z.string(),
    })).optional(),
});
export const ServerEnvironmentCreatedSchema = z.object({
    type: z.literal('environment_created'),
    environmentId: z.string(),
    name: z.string(),
    status: EnvironmentStatusSchema,
});
export const ServerEnvironmentDestroyedSchema = z.object({
    type: z.literal('environment_destroyed'),
    environmentId: z.string(),
});
// `error` is present at every emit site; `environmentId` only when an id is in
// scope (destroy/get failures, not the validation early-returns); `code` only
// for the Docker image-allowlist rejection (currently the literal
// 'DOCKER_IMAGE_NOT_ALLOWED' — typed loosely so a new code can't make this stale).
export const ServerEnvironmentErrorSchema = z.object({
    type: z.literal('environment_error'),
    error: z.string(),
    environmentId: z.string().optional(),
    code: z.string().optional(),
});
export const ServerEnvironmentInfoSchema = z.object({
    type: z.literal('environment_info'),
    environment: EnvironmentDescriptorSchema,
});
export const ServerEnvironmentListSchema = z.object({
    type: z.literal('environment_list'),
    environments: z.array(EnvironmentDescriptorSchema),
});
