# Minimalist's Audit: Chroxy Security Architecture

**Agent**: Minimalist -- Ruthless engineer who believes the best code is no code
**Overall Rating**: 7 / 10 (High complexity)
**Date**: 2026-02-12

## Verdict

Chroxy suffers from **aspirational over-engineering**: 3 modes doing the same thing differently, 8,187 LOC for "run Claude, proxy to WebSocket".

**Target Complexity**: 3/10 (after cuts)
**Potential Reduction**: -2,900 LOC (35% smaller)

## Section Necessity Ratings

| Feature | LOC | Rating | Keep? |
|---------|-----|--------|-------|
| Multi-session support | ~800 | 2/5 | YES (core feature) |
| PTY mode | ~1,400 | 1/5 | ❌ DELETE |
| Legacy CLI mode | ~800 | 1/5 | ❌ DELETE |
| Permission HTTP hook | ~200 | 2/5 | ❌ DELETE (SDK has native) |
| Stream delta buffering | ~100 | 3/5 | ❌ DELETE |
| Auto-discovery polling | ~100 | 2/5 | ❌ DELETE |
| Graceful restart state | ~100 | 2/5 | ❌ DELETE |
| Client primary tracking | ~80 | 2/5 | ❌ DELETE |
| Auth rate limiting | ~50 | 3/5 | ✅ KEEP |
| Constant-time compare | ~30 | 4/5 | ✅ KEEP |

## Top 10 Over-Engineering Findings

### #1: Triple Mode Duplication (2,200 LOC wasted)
**Files**: cli-session.js (788), sdk-session.js (599), pty-session.js (178), pty-manager.js (227), output-parser.js (748)

All three emit same EventEmitter interface but duplicate implementation. **DELETE PTY + Legacy CLI**, keep SDK only.

### #2: OutputParser Complexity (748 LOC)
**What it does**: Parses raw ANSI to detect tool calls, Claude responses, status bar.
**Why unnecessary**: Only for PTY mode. SDK gives structured JSON.
**Recommendation**: Delete entire file with PTY mode.

### #3: Permission Hook HTTP Pipeline (200 LOC)
**Complexity**: Mutates settings.json, HTTP long-poll, retry logic.
**Why unnecessary**: SDK has native `canUseTool` callback.
**Recommendation**: Delete permission-hook.js, use SDK.

### #4: Multi-Session Discovery Polling (150 LOC)
**What it does**: Every 45s, scans tmux sessions, emits new discoveries.
**Use case**: Niche (multi-tmux power user).
**Recommendation**: Remove auto-discovery, keep on-demand only.

### #5: Stream Delta Buffering (100 LOC)
**Benefit**: Saves ~50% WS messages during streaming.
**Cost**: 100 LOC (Map management, timers, flush logic).
**Recommendation**: Remove, forward deltas immediately.

### #6: Graceful Restart State (100 LOC)
**What it does**: Serializes sessions to JSON on drain, restores on restart.
**Limitation**: Only works for SDK. CLI/PTY lose state anyway.
**Recommendation**: Remove, SDK resume works without state file.

### #7: Primary Client Tracking (80 LOC)
**What it does**: Tracks "last writer wins" for multi-device indicator.
**Current usage**: Just a dot in the app.
**Recommendation**: Remove server tracking, client already knows if they sent last message.

### #8: Version Check from npm (70 LOC)
**What it does**: Fetches latest version from registry on startup.
**Benefit**: Nice-to-have for "Update available" message.
**Recommendation**: Remove, users check manually via `npm outdated`.

### #9: Config Validation Schema (200 LOC)
**What it does**: Schema validation + merge precedence + verbose logging for 13 keys.
**Overkill for**: 13-key config.
**Recommendation**: Simplify to basic merge, remove schema boilerplate.

### #10: Slash Commands + Agent Discovery (150 LOC)
**What it does**: Scans `.claude/commands/` and `.claude/agents/`, parses markdown.
**Recommendation**: Move to app (already has file browser logic).

## Reduction Plan

### Quick Wins (No API Changes) -600 LOC
1. Remove version check (-70 LOC)
2. Remove stream buffering (-100 LOC)
3. Remove primary tracking (-80 LOC)
4. Remove slash/agent discovery (-150 LOC)
5. Remove graceful state (-100 LOC)
6. Remove auto-discovery polling (-100 LOC)

### Major Simplifications (Breaking but Worth It) -2,300 LOC
1. Delete PTY mode (-1,400 LOC, removes tmux dependency)
2. Delete legacy CLI (-800 LOC)
3. Simplify config validation (-100 LOC)

## The Minimal Viable Chroxy

**Keep:**
- ws-server.js (simplified: no buffering, no primary, no discovery)
- sdk-session.js (sole session type)
- session-manager.js (simplified: no discovery, no state)
- tunnel.js, supervisor.js (core features)
- models.js, logger.js (utilities)

**Delete:**
- PTY mode files (1,400 LOC)
- Legacy CLI files (800 LOC)
- Config boilerplate, version check, slash scanner

**Result**: 5,287 LOC (35% reduction), 1 mode, 1 session type, 1 permission system

## Evidence of Duplication

### Model Switching: 3 Implementations
- PTY: "Not supported" (3 LOC)
- CLI: Kill + respawn (75 LOC)
- SDK: Live change (15 LOC)

**Total**: 93 LOC for a 1-line feature

### Permission Handling: 2 Pipelines
- HTTP hook (385 LOC)
- SDK canUseTool (100 LOC)

**Duplication**: 285 LOC

## Final Verdict

**Current**: 8,187 LOC, 3 modes, 3 session types, 2 permission systems
**Minimal**: 5,287 LOC, 1 mode, 1 session type, 1 permission system

Delete ruthlessly. Ship minimal version. Add back only what users actually need.
