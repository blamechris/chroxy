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
/** Default unified-diff context lines around each change. */
export const DEFAULT_CONTEXT_LINES = 3;
/**
 * Combined-line ceiling before the differ bails to a single whole-file-replace
 * hunk. The LCS table is O(n·m); at 4000 combined lines that is ~4M cells worst
 * case, which is fine, and beyond it a per-hunk review isn't ergonomic anyway.
 */
export const MAX_DIFF_LINES = 4000;
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
export function splitContentLines(content) {
    return content === '' ? [] : content.split('\n');
}
/**
 * LCS line diff → an ordered edit script. Each op carries the 0-indexed
 * position in the original (`oldIndex`) and proposed (`newIndex`) it sits at,
 * which the hunk builder turns into `@@` line numbers.
 */
function diffLines(a, b) {
    const n = a.length;
    const m = b.length;
    // dp[i][j] = LCS length of a[i:] and b[j:].
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            ops.push({ op: 'eq', oldIndex: i, newIndex: j, content: a[i] });
            i++;
            j++;
        }
        else if (dp[i + 1][j] >= dp[i][j + 1]) {
            ops.push({ op: 'del', oldIndex: i, newIndex: j, content: a[i] });
            i++;
        }
        else {
            ops.push({ op: 'ins', oldIndex: i, newIndex: j, content: b[j] });
            j++;
        }
    }
    while (i < n) {
        ops.push({ op: 'del', oldIndex: i, newIndex: j, content: a[i] });
        i++;
    }
    while (j < m) {
        ops.push({ op: 'ins', oldIndex: i, newIndex: j, content: b[j] });
        j++;
    }
    return ops;
}
/** A single whole-file-replace hunk — the large-input + no-common-line fallback. */
function wholeFileReplaceHunk(a, b) {
    const lines = [
        ...a.map((content) => ({ type: 'deletion', content })),
        ...b.map((content) => ({ type: 'addition', content })),
    ];
    // git convention: a 0-count side uses a 0-based start (new file `@@ -0,0 +1,N @@`,
    // deleted file `@@ -1,N +0,0 @@`); a non-empty side is 1-based. Keeps the header
    // consistent with `parseOriginalRange`'s count-0 insertion math.
    const oldStart = a.length === 0 ? 0 : 1;
    const newStart = b.length === 0 ? 0 : 1;
    return { header: `@@ -${oldStart},${a.length} +${newStart},${b.length} @@`, lines };
}
/**
 * Compute the hunks transforming `original` into `proposed`, in the canonical
 * `DiffHunk` shape (git-style `@@ -o,c +n,c @@` header + context/deletion/
 * addition lines with the +/-/space PREFIX omitted, exactly as the server's
 * parser emits). Returns `[]` when the two are identical. Hunks are ordered and
 * non-overlapping, each padded with up to `contextLines` unchanged lines and
 * merged when they would otherwise abut.
 */
export function computeHunks(original, proposed, contextLines = DEFAULT_CONTEXT_LINES) {
    if (original === proposed)
        return [];
    const a = splitContentLines(original);
    const b = splitContentLines(proposed);
    if (a.length + b.length > MAX_DIFF_LINES)
        return [wholeFileReplaceHunk(a, b)];
    const ops = diffLines(a, b);
    const changed = ops.map((o) => o.op !== 'eq');
    // Expand each changed op by `contextLines` in both directions, then merge
    // overlapping/abutting ranges into hunk op-ranges [start, end).
    const ranges = [];
    for (let k = 0; k < ops.length; k++) {
        if (!changed[k])
            continue;
        const start = Math.max(0, k - contextLines);
        const end = Math.min(ops.length, k + contextLines + 1);
        const last = ranges[ranges.length - 1];
        if (last && start <= last[1])
            last[1] = Math.max(last[1], end);
        else
            ranges.push([start, end]);
    }
    return ranges.map(([start, end]) => {
        const slice = ops.slice(start, end);
        const first = slice[0];
        const oldCount = slice.filter((o) => o.op !== 'ins').length;
        const newCount = slice.filter((o) => o.op !== 'del').length;
        // git convention: for a non-empty side the start is 1-indexed (0-indexed+1);
        // for a 0-count side it is the 0-indexed line the change sits AFTER.
        const oldStart = oldCount === 0 ? first.oldIndex : first.oldIndex + 1;
        const newStart = newCount === 0 ? first.newIndex : first.newIndex + 1;
        const lines = slice.map((o) => ({
            type: o.op === 'eq' ? 'context' : o.op === 'del' ? 'deletion' : 'addition',
            content: o.content,
        }));
        return { header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, lines };
    });
}
