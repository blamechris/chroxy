# Empirical TUI recordings

Curated extracts of `scripts/tui-form-recorder.mjs` runs against a live `claude`
TUI (v2.1.168), captured to validate the AskUserQuestion form drivers in
`packages/server/src/claude-tui-session.js`.

Each file is JSONL, one event per line:

- `{"kind":"meta", ...}` — provenance note (first line).
- `{"t":<ms>,"kind":"in","data":<bytes>}` — keystrokes the human typed,
  **verbatim** (the empirically meaningful part: the pasted prompt, the digit
  picks, Ctrl+D).
- `{"t":<ms>,"kind":"out","text":<str>}` — selected terminal output events
  proving the outcome, **ANSI-stripped** for readability and with home paths /
  usernames scrubbed. Status-line and box-drawing noise is trimmed.

The full raw PTY captures (~60–70 KB of ANSI per run) are **not** committed —
they carry no additional empirical signal and embedded environment paths / PII.

| File | Issue | Finding |
|------|-------|---------|
| `4882-all-single-select-2q.jsonl` | #4882 | A pure 2-question all-single-select form submits on `2`,`2`,`1` — the Submit screen accepts `1` alone, no trailing Enter. |
| `4880-twelve-option-cap.jsonl` | #4880 | AskUserQuestion hard-caps each question at 4 options (`InputValidationError: too_big, maximum: 4`); a ≥10-option form is unproducible. |
