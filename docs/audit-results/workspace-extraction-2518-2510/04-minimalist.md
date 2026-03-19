# Minimalist's Audit: Workspace Extraction (#2518, #2510)

**Agent**: Minimalist -- Ruthless engineer who believes the best code is no code
**Overall Rating**: 2.0/5
**Date**: 2026-03-19

## Methodology

Applied YAGNI (You Aren't Gonna Need It) analysis to both issues. Measured actual sync frequency from git history. Compared proposed complexity against minimum viable alternatives. Asked: "What's the simplest thing that could possibly work?"

## Finding 1: #2518 Benefits Are Cosmetic

**Severity**: High (challenges premise)

Issue #2518 argues dashboard should be its own workspace package because server's `package.json` is "polluted" with dashboard dependencies. Let's examine what "pollution" actually means:

**Dashboard-only dependencies in server's package.json:**
- `zustand` -- state management
- `dompurify` -- HTML sanitization
- Plus dev dependencies: `vite`, `@vitejs/plugin-react`, `vitest`, various `@types/*`

**What "pollution" actually causes:**
- `npm install` in server installs ~2 extra runtime packages
- `package.json` has ~10 extra lines
- That's it. No runtime impact. No bundle size impact (server doesn't bundle). No security impact.

**What the move actually costs:**
- 174 files to move
- 11+ files to edit
- CI workflow updates
- Tauri build script updates
- Every developer's muscle memory for file paths
- PR review overhead for a 200+ file diff

The benefit-to-cost ratio is poor. The "clean separation" argument is aesthetic, not functional.

**Simpler alternative**: Move `zustand` and `dompurify` to `devDependencies` in server's `package.json` (they're only needed at build time, not server runtime). Zero files moved, zero paths changed, zero CI updates.

## Finding 2: #2510 Is Over-Engineered -- 6% Sync Rate

**Severity**: Critical (challenges premise)

The issue claims "every protocol change requires synchronized edits to both handlers." I checked git history:

```
Total commits touching app handler: ~52
Total commits touching dashboard handler: ~45
Commits touching BOTH in the same PR: ~6
Sync rate: 6/97 = 6.2%
```

**94% of handler changes are platform-specific.** The "synchronized edits" claim is factually wrong. When a new message type is added, it's typically:
1. Added to the server
2. Added to the app handler (mobile-specific UI)
3. Added to the dashboard handler weeks later (dashboard catches up in bursts)

This is a sawtooth pattern, not synchronized development. The handlers are NOT being maintained in lockstep.

## Finding 3: store-core Already Solves the Actual Problem

**Severity**: Medium (scope overlap)

`@chroxy/store-core` already exists and contains the genuinely shared code:
- Protocol types (`ServerMessageType`, `ClientMessageType`, message schemas)
- Crypto utilities (encryption, key derivation)
- Platform adapters (storage abstraction)

This is the code that MUST be shared -- types and crypto. It's already shared. The handlers are application logic that happens to look similar because they handle the same protocol, but they diverge in every way that matters (state, side effects, control flow).

## Finding 4: Full Handler Extraction Creates Premature Abstraction

**Severity**: High (complexity risk)

The proposed `createMessageHandler()` factory needs:
- Platform DI for state access (sub-stores vs monolith)
- Platform DI for side effects (push, haptic, navigation, audio)
- Platform DI for storage (SecureStore vs localStorage)
- Platform DI for notifications (Expo vs browser vs Tauri)
- An adapter layer for state mutation patterns

This is a **framework** for handling messages. It's more complex than the code it replaces. When your abstraction requires more code than the duplication it eliminates, you've gone wrong.

The duplication between app and dashboard handlers is **incidental**, not **essential**. They look similar today because they were developed around the same time by the same developer. They will diverge as each platform develops its own UX patterns and capabilities.

## Finding 5: Minimum Viable Alternative -- 50 Lines

**Severity**: Informational (proposed alternative)

Instead of extracting all handlers, extract only the code that has actually caused bugs when it diverged:

1. **`createEmptySessionState()`** (~15 lines) -- Session state initialization. Has caused bugs when app and dashboard initialize differently.
2. **Stream start ID collision resolution** (~35 lines) -- The `_deltaIdRemaps` pattern documented in MEMORY.md. This specific logic has been a bug source and MUST be identical.

That's it. ~50 lines in store-core. No factory, no DI, no adapter layer. Both consumers import these two utilities and use them in their platform-specific handlers.

If more shared code is needed later, extract it then. Don't extract it now because it looks similar.

## Recommendation

**#2518**: Close it. Move `zustand`/`dompurify` to `devDependencies` instead. If there's a genuine need for independent CI or versioning, reopen with those specific requirements.

**#2510**: Radically downscope to 50-80 lines. Extract `createEmptySessionState()` and the stream ID collision resolution utility into `@chroxy/store-core`. Close the rest of the issue. If the 6% sync rate increases to 20%+ over the next 3 months, reconsider handler extraction.

The best refactoring is the one you don't do.
