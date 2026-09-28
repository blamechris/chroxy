// assert-match-payload-guard-hook.mjs — the side-effecting form of the guard,
// for packages whose test command has no `tests/_setup.mjs` to hang it on
// (#7413, following the `no-test-force-exit-hook.mjs` precedent from #7400).
//
// `packages/server` and `packages/claude-hooks` call
// `installAssertMatchPayloadGuard()` from their own setup module.
// `packages/protocol` and `packages/design-tokens` have no setup module, so
// they `--import` this file instead. Same guard, same measurements, same
// escape hatch — see `./assert-match-payload-guard.mjs`.
//
// This exists as a separate file for the same reason
// `no-test-force-exit-hook.mjs` does: the library module must not fire on
// import — its own tests import it and install it under a chosen limit — and
// a module that patches global state at link time cannot be tested that way.
import { installAssertMatchPayloadGuard } from './assert-match-payload-guard.mjs'

installAssertMatchPayloadGuard()
