// entry-point-guard-copies.mjs — the three files allowed to answer "was this
// module run directly?" by hand.
//
// There are exactly two gates on that guard, and before #7235 each carried its
// own copy of this list:
//
//   - the DRIFT gate (scripts/__tests__/is-entry-point.test.mjs) says
//     "the three agree" — it extracts the guard body from each and fails on
//     divergence (#7222).
//   - the WALK (packages/server/scripts/lint-entry-point-guard.mjs) says
//     "there are only three" — it walks the repo and fails on any entry-point
//     determination outside this set (#7235).
//
// Two lists of the same three files is the defect #7235 is about, one level up:
// add a fourth copy to the walk's allowlist and forget the drift gate, and the
// new copy is exempt from BOTH — nothing compares it to anything, and nothing
// objects. So there is one list, here, imported by both.
//
// Adding an entry is a real decision, not bookkeeping. It says a file cannot
// import either existing copy, and it opts that file into the drift gate, which
// will then require its guard body to match the others character for character
// (comments excepted). Today's three are:
//
//   scripts/lib/is-entry-point.mjs             — `scripts/` sits outside every
//     workspace package and imports nothing from `packages/*​/src` (#7217).
//   packages/server/src/utils/is-entry-point.js — the server's copy, the one
//     ordinary server modules import.
//   packages/server/sidecar/agent.js           — ships as a standalone in-pod
//     bundle. Its Dockerfile copies in only `package.json package-lock.json`
//     and `agent.js`; neither packages/server/src nor scripts/lib is ever in
//     the image, so it can import neither of the others.
//
// If you are here because you want a fourth: check first whether the file can
// import one of the three. That has been the answer every time so far.
//
// Paths are repo-relative and POSIX-separated. Both consumers join them onto
// their own root.

export const GUARD_COPIES = [
  'scripts/lib/is-entry-point.mjs',
  'packages/server/src/utils/is-entry-point.js',
  'packages/server/sidecar/agent.js',
]
