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
// One staged/unstaged entry in a git_status_result. `untracked` is a flat array
// of path strings (NOT objects). The status enum is the server STATUS_MAP set.
const GitStatusEntrySchema = z.object({
    path: z.string(),
    status: z.enum(['modified', 'added', 'deleted', 'renamed', 'copied', 'unknown']),
});
// `git_status` response. `branch` is null in detached-HEAD / not-a-repo; the
// four data fields are always present (defaulted to [] / null on every error
// path). Handled by both clients (dashboard case + shared store-core dispatch).
export const ServerGitStatusResultSchema = z.object({
    type: z.literal('git_status_result'),
    branch: z.string().nullable(),
    staged: z.array(GitStatusEntrySchema),
    unstaged: z.array(GitStatusEntrySchema),
    untracked: z.array(z.string()),
    error: z.string().nullable(),
});
// `git_branches` response. NOTE the wire field is `currentBranch` (the
// ws-server.js doc comment's `current` is stale). App-only today (the dashboard
// has no git_branches_result handler).
export const ServerGitBranchesResultSchema = z.object({
    type: z.literal('git_branches_result'),
    branches: z.array(z.object({
        name: z.string(),
        isCurrent: z.boolean(),
        isRemote: z.boolean(),
    })),
    currentBranch: z.string().nullable(),
    error: z.string().nullable(),
});
// `get_diff` response — 3-level nesting (files → hunks → lines). The DiffFile
// status enum carries `untracked` (and no `copied`/`unknown`), distinct from the
// git_status entry enum. line.type is exactly context/addition/deletion.
export const ServerDiffResultSchema = z.object({
    type: z.literal('diff_result'),
    files: z.array(z.object({
        path: z.string(),
        status: z.enum(['modified', 'added', 'deleted', 'renamed', 'untracked']),
        additions: z.number(),
        deletions: z.number(),
        hunks: z.array(z.object({
            header: z.string(),
            lines: z.array(z.object({
                type: z.enum(['context', 'addition', 'deletion']),
                content: z.string(),
            })),
        })),
    })),
    error: z.string().nullable(),
});
// `read_file` response. The 7 core keys are always present (present-and-nullable,
// not optional); `requestId` (#6502) is the one optional field — echoed back only
// when the originating `read_file` carried a nonce, so the dashboard can drop a
// superseded reply. For images, `content` is a base64 data URL and `language` is
// the literal 'image'; `content` is sliced to 100KB with `truncated` true past that.
export const ServerFileContentSchema = z.object({
    type: z.literal('file_content'),
    path: z.string().nullable(),
    content: z.string().nullable(),
    language: z.string().nullable(),
    size: z.number().nullable(),
    truncated: z.boolean(),
    error: z.string().nullable(),
    // #6502 — echoes the `read_file` request nonce when the client supplied one,
    // so the dashboard can drop replies from superseded requests without relying
    // on echoed-path matching. Absent when the request carried no nonce.
    requestId: z.string().max(200).optional(),
});
// `browse_files` response (HOME-dir restricted). `entries` are directories only
// ({ name, isDirectory: true }); `parentPath` is legitimately null at the root
// (not just on error). Distinct from the `file_listing` family (CWD-restricted,
// entries carry size).
export const ServerDirectoryListingSchema = z.object({
    type: z.literal('directory_listing'),
    path: z.string().nullable(),
    parentPath: z.string().nullable(),
    entries: z.array(z.object({
        name: z.string(),
        isDirectory: z.boolean(),
    })),
    error: z.string().nullable(),
});
// #6876 — `git_create_pr` response. The server pushes the current branch and
// runs `gh pr create`; on success `url` is the created PR's URL and `number`
// its integer number (best-effort — parsed from the URL). `branch`/`base` echo
// the head/base used. On failure `url`/`number` are always null and `error`
// carries a clear, operator-actionable message (gh not installed / not
// authenticated / no origin remote / PR already exists / detached HEAD). The
// identifying fields `branch`/`base` MAY still be populated on some error paths
// (e.g. base === head, or a push failure) to help the UI show which branch it
// tried — so only `url`/`number` are guaranteed null on failure, not every data
// field. Handled by the dashboard only for v1 (mobile PR-creation UI is a
// tracked follow-up).
// #6938 — `existingUrl` is populated (non-null) ONLY on the "a pull request
// already exists for this branch" error path — the pre-existing PR's URL as a
// structured field, so the dashboard can render a real link (instead of the
// URL only ever appearing embedded inside the `error` string). Every other
// path (success or any other error) leaves it null.
export const ServerGitCreatePrResultSchema = z.object({
    type: z.literal('git_create_pr_result'),
    url: z.string().nullable(),
    number: z.number().nullable(),
    branch: z.string().nullable(),
    base: z.string().nullable(),
    error: z.string().nullable(),
    existingUrl: z.string().nullable().optional(),
});
// `write_file` response — the wire type is `write_file_result` (NOT
// file_write_result). Only path + error beyond type. App-only today (the
// dashboard has no write_file handling).
export const ServerWriteFileResultSchema = z.object({
    type: z.literal('write_file_result'),
    path: z.string().nullable(),
    error: z.string().nullable(),
});
// #6861 (epic #6760): ack for the `#`-prefix composer quick-append. `path` is
// the absolute project `CLAUDE.md` the note landed in (null on error); `created`
// distinguishes "created the file" from "appended to an existing one" so the
// confirmation can name the outcome. Handled by BOTH clients — each appends a
// system confirmation (or the error) to the active session transcript.
export const ServerAppendMemoryResultSchema = z.object({
    type: z.literal('append_memory_result'),
    path: z.string().nullable(),
    created: z.boolean(),
    error: z.string().nullable(),
});
// #6864 (epic #6760): `memory_read` reply — the effective merged CLAUDE.md
// memory stack with per-file provenance, plus the project's auto-generated
// MEMORY.md descriptor. `entries` is ordered global -> project -> local
// (Claude Code's own load order — https://code.claude.com/docs/en/memory:
// "content is ordered from the filesystem root down to your working
// directory"), with each root's own @import references inlined depth-first
// immediately after it (`importedFrom` names the file that referenced them).
// An import whose target resolves outside the session cwd or the user's
// ~/.claude home is reported with `skipped: true` / `content: null` — the
// read-only path-confinement guard; it is never opened, so its existence is
// never disclosed either. `memoryFile` is null only when the request-level
// `error` fires (memory unavailable in this mode / session cwd unresolvable);
// otherwise it always carries the resolved MEMORY.md descriptor
// (`exists: false` when the project has no auto-memory yet).
const MemoryFileDescriptorSchema = z.object({
    path: z.string().nullable(),
    exists: z.boolean(),
    content: z.string().nullable(),
    truncated: z.boolean(),
    skipped: z.boolean(),
    error: z.string().nullable(),
});
const MemoryStackEntrySchema = MemoryFileDescriptorSchema.extend({
    scope: z.enum(['global', 'project', 'local', 'import']),
    importedFrom: z.string().nullable(),
});
export const ServerMemoryStackResultSchema = z.object({
    type: z.literal('memory_stack_result'),
    entries: z.array(MemoryStackEntrySchema),
    memoryFile: MemoryFileDescriptorSchema.nullable(),
    error: z.string().nullable(),
    // Echoes the `memory_read` request nonce when the client supplied one, so a
    // rapid session switch can drop a superseded reply (mirrors read_file's
    // #6502 `requestId` pattern).
    requestId: z.string().max(200).optional(),
});
