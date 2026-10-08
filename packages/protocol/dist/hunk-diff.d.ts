/**
 * Line hunk diff, ONE implementation shared by every side of the pre-write review
 * (#6542, #8446): the clients (via @chroxy/store-core) draw the diff the operator
 * reviews, and the server (permission-manager) recomputes it over the same redacted
 * copy to check that the hunks a client names are exactly the real ones. Two copies
 * of a differ drift; this is the only one, and it lives here (not in store-core)
 * because the server is plain JavaScript and imports this package's built output.
 *
 * The differ is a straightforward LCS line diff (correct + easy to reason about)
 * with a size guard: past `MAX_DIFF_LINES` combined lines it falls back to a
 * single whole-file-replace hunk rather than allocate an O(n·m) table.
 *
 * Headers follow git's unified-diff convention, INCLUDING the empty-side cases —
 * a new file is `@@ -0,0 +1,N @@` (pure additions, no phantom deletion) and a
 * deleted file is `@@ -1,N +0,0 @@`.
 */
export interface DiffHunkLine {
    type: 'context' | 'addition' | 'deletion';
    content: string;
}
export interface DiffHunk {
    header: string;
    lines: DiffHunkLine[];
}
/** Default unified-diff context lines around each change. */
export declare const DEFAULT_CONTEXT_LINES = 3;
/**
 * Combined-line ceiling before the differ bails to a single whole-file-replace
 * hunk. The LCS table is O(n·m); at 4000 combined lines that is ~4M cells worst
 * case, which is fine, and beyond it a per-hunk review isn't ergonomic anyway.
 */
export declare const MAX_DIFF_LINES = 4000;
/**
 * Split file content into lines such that `lines.join('\n') === content`, so the
 * round-trip is lossless — a trailing newline becomes a trailing empty element
 * the diff treats like any other line.
 *
 * The one special case is the **empty file**: `''` maps to `[]` (0 lines), NOT
 * `['']`. This matches git's unified-diff model — a `'' → 'x'` diff is then a
 * pure addition (`@@ -0,0 +1,1 @@`, one addition line) rather than a phantom
 * deletion of an empty line — so `computeHunks` output stays consistent with the
 * server's git diff. `[].join('\n') === ''`, so the round-trip is still lossless.
 * (A single newline `'\n'` is `['', '']`, distinct from the empty file.)
 */
export declare function splitContentLines(content: string): string[];
/**
 * Compute the hunks transforming `original` into `proposed`, in the canonical
 * `DiffHunk` shape (git-style `@@ -o,c +n,c @@` header + context/deletion/
 * addition lines with the +/-/space PREFIX omitted, exactly as the server's
 * parser emits). Returns `[]` when the two are identical. Hunks are ordered and
 * non-overlapping, each padded with up to `contextLines` unchanged lines and
 * merged when they would otherwise abut.
 */
export declare function computeHunks(original: string, proposed: string, contextLines?: number): DiffHunk[];
