// Fixture for the IDE go-to-definition dashboard smoke (#6500). The smoke opens
// this file via quick-open (Cmd/Ctrl+P) and cmd/ctrl+clicks the identifiers below
// to exercise the live resolve_symbol round-trip in a real browser. The names are
// deliberately unique so resolution is deterministic against any session cwd that
// contains this file. Never imported or executed — it is read as text only.

export function smokeGotoDefTarget() {
  return 42
}

// HIT: cmd/ctrl+click `smokeGotoDefTarget` here → the daemon resolves it to the
// exported declaration above and the viewer jumps to + highlights that line.
const smokeGotoDefHit = smokeGotoDefTarget()

// MISS: cmd/ctrl+click `smokeGotoDefMissingSymbol` → no declaration exists anywhere
// in the workspace → the viewer shows a transient "definition not found" pill.
const smokeGotoDefMiss = smokeGotoDefMissingSymbol()

export { smokeGotoDefHit, smokeGotoDefMiss }
