// Fixture for the IDE go-to-definition dashboard smoke (#6500). The smoke opens
// this file via quick-open (Cmd/Ctrl+P) and cmd/ctrl+clicks the identifiers below
// to exercise the live resolve_symbol round-trip in a real browser. The names are
// deliberately unique so resolution is deterministic against any session cwd that
// contains this file. Read as text only — never imported or executed.

export function smokeGotoDefTarget() {
  return 42
}

// HIT: cmd/ctrl+click the smokeGotoDefTarget reference below → the daemon resolves
// it to the exported declaration above and the viewer jumps to + paints that line.
// smokeGotoDefTarget is declared, so the reference is inert either way.
const smokeGotoDefHit = smokeGotoDefTarget()

// MISS: cmd/ctrl+click the smokeGotoDefMissingSymbol reference below → no
// declaration exists anywhere in the workspace → a transient "definition not
// found" pill. Wrapped in a never-called function so the undeclared reference is
// inert (no ReferenceError) if this file is ever evaluated, while still rendering
// as a clickable identifier token.
function smokeGotoDefMissRef() {
  return smokeGotoDefMissingSymbol()
}

export { smokeGotoDefHit, smokeGotoDefMissRef }
