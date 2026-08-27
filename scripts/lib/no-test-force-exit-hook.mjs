// no-test-force-exit-hook.mjs — the side-effecting form of the refusal, for
// packages whose test command has no `tests/_setup.mjs` to hang it on (#7400).
//
// `packages/server` and `packages/claude-hooks` call `assertNoTestForceExit()`
// from their own setup module. `packages/protocol` and `packages/design-tokens`
// have no setup module, so they `--import` this file instead. Same refusal,
// same measurements, same escape hatch — see `./no-test-force-exit.mjs`.
//
// This exists as a separate file because the library module must NOT fire on
// import: its own tests import it, and a module that refuses at link time
// cannot be tested.
import { assertNoTestForceExit } from './no-test-force-exit.mjs'

assertNoTestForceExit()
