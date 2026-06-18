// The claude CLI version chroxy's claude-tui form-driving was last validated
// against (audit P1-3 / #5821 backstop).
//
// ClaudeTuiSession drives the real `claude` interactive TUI by screen-scraping
// and emitting empirically-pinned keystroke sequences (see pty-driver.js /
// form-driver.js) — there is NO programmatic answer channel. A claude CLI UI
// change (hotkey scheme, prompt layout, bracketed-paste handling) can therefore
// mis-drive AskUserQuestion forms SILENTLY: a wrong key lands, claude resolves
// *some* option, and the user's choice is quietly mis-applied.
//
// This pin lets `chroxy doctor` turn that silent class into a MEASURED, surfaced
// signal: it warns when the installed claude differs (by major.minor) from the
// version the byte sequences were validated against. It is the only real
// backstop against the silent-mis-drive class until a structured answer channel
// exists.
//
// MAINTENANCE: when you re-validate the form-driving against a newer claude CLI
// (running the AskUserQuestion flows and confirming the keystrokes still resolve
// the intended option — e.g. via scripts/tui-form-recorder.mjs), bump this to
// the version you tested. Keep it next to the driving code so the bump is an
// obvious part of that re-validation.
export const TESTED_CLAUDE_TUI_CLI_VERSION = '2.1.177'
