// daemon-entry-modules.mjs — the daemon's lazily-imported entry points.
//
// `chroxy start` / `chroxy dev` only `import()` these at the moment a user
// actually runs the command (packages/server/src/cli/server-cmd.js) — never
// eagerly, and never merely by `chroxy --version` or `chroxy doctor` running.
// That is exactly why verify-publish-artifacts.mjs has to import() them
// itself out of the installed package (#8165/#8166): nothing else in the
// verify pipeline ever exercises this part of the module graph, so a packed
// install silently missing a real runtime dependency (e.g. `ws`) passed
// every other check and only failed on a user's first `chroxy start`.
//
// Exported from this one file, rather than duplicated as a literal array in
// both scripts/verify-publish-artifacts.mjs and the test that cross-checks
// it against server-cmd.js's real imports
// (packages/server/tests/release-verify-artifacts-gate.test.js), so the two
// can never silently drift apart — "a hardcoded list next to a set that
// grows" is the first recurring cause docs/false-safety-guards.md
// catalogues, and a list with exactly one writer and one independent reader
// is what turns that into a loud failure instead of a silent one.
//
// Paths are relative to the installed @chroxy/server package root — i.e.
// what they look like under <prefix>/lib/node_modules/@chroxy/server/.
export const DAEMON_ENTRY_MODULES = ['src/server-cli.js', 'src/supervisor.js']
