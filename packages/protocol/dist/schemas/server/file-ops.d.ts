/**
 * Server → Client schemas for the git + file-operation result families
 * (#6324 batch 2a of #6314).
 *
 * Domain slice of the server→client schema surface; re-exported verbatim by
 * ../server.ts (barrel). Shapes verified against the emit sites in
 * packages/server/src/ws-file-ops/* (reader/browser/git). Element shapes are
 * INLINED rather than imported from @chroxy/store-core — the protocol package is
 * the source of truth and must not depend on store-core (which depends on it).
 */
import { z } from 'zod';
export declare const ServerGitStatusResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"git_status_result">;
    branch: z.ZodNullable<z.ZodString>;
    staged: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        status: z.ZodEnum<{
            unknown: "unknown";
            modified: "modified";
            added: "added";
            deleted: "deleted";
            renamed: "renamed";
            copied: "copied";
        }>;
    }, z.core.$strip>>;
    unstaged: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        status: z.ZodEnum<{
            unknown: "unknown";
            modified: "modified";
            added: "added";
            deleted: "deleted";
            renamed: "renamed";
            copied: "copied";
        }>;
    }, z.core.$strip>>;
    untracked: z.ZodArray<z.ZodString>;
    error: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const ServerGitBranchesResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"git_branches_result">;
    branches: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        isCurrent: z.ZodBoolean;
        isRemote: z.ZodBoolean;
    }, z.core.$strip>>;
    currentBranch: z.ZodNullable<z.ZodString>;
    error: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const ServerDiffResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"diff_result">;
    files: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        status: z.ZodEnum<{
            untracked: "untracked";
            modified: "modified";
            added: "added";
            deleted: "deleted";
            renamed: "renamed";
        }>;
        additions: z.ZodNumber;
        deletions: z.ZodNumber;
        hunks: z.ZodArray<z.ZodObject<{
            header: z.ZodString;
            lines: z.ZodArray<z.ZodObject<{
                type: z.ZodEnum<{
                    context: "context";
                    addition: "addition";
                    deletion: "deletion";
                }>;
                content: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    error: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const ServerFileContentSchema: z.ZodObject<{
    type: z.ZodLiteral<"file_content">;
    path: z.ZodNullable<z.ZodString>;
    content: z.ZodNullable<z.ZodString>;
    language: z.ZodNullable<z.ZodString>;
    size: z.ZodNullable<z.ZodNumber>;
    truncated: z.ZodBoolean;
    error: z.ZodNullable<z.ZodString>;
    requestId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ServerDirectoryListingSchema: z.ZodObject<{
    type: z.ZodLiteral<"directory_listing">;
    path: z.ZodNullable<z.ZodString>;
    parentPath: z.ZodNullable<z.ZodString>;
    entries: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        isDirectory: z.ZodBoolean;
    }, z.core.$strip>>;
    error: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const ServerWriteFileResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"write_file_result">;
    path: z.ZodNullable<z.ZodString>;
    error: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const ServerAppendMemoryResultSchema: z.ZodObject<{
    type: z.ZodLiteral<"append_memory_result">;
    path: z.ZodNullable<z.ZodString>;
    created: z.ZodBoolean;
    error: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
