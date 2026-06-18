// Paste-heuristic PTY stub (#4271).
//
// Mimics the user-visible side of claude TUI's paste detector for
// integration-level testing of `ClaudeTuiSession._writePtyTextThrottled`
// (#4269 fix, #4273 throttle hardening). Unit tests already pin the exact
// bytes chroxy emits — what they cannot pin is "those bytes survive
// claude's heuristic and arrive as typed input, not as a paste
// placeholder." This stub closes that loop.
//
// Documented assumptions (so the stub can be tuned when claude TUI's
// real heuristic shifts):
//
// 1. Byte-arrival rate is the trigger, NOT total byte count alone.
//    A long prompt typed by a human (10s of seconds) is fine; the same
//    prompt arriving as one bulk write is not. The stub keeps a sliding
//    window of write timestamps + char counts and flags "paste" when N
//    chars land inside T ms.
//
// 2. DEC mode 2004 (`ESC[?2004l` / `ESC[?2004h`) is honored as
//    defense-in-depth — when bracketed-paste-disable is active, the
//    stub will NOT flag a paste regardless of arrival rate. This
//    mirrors a claude version that honors the mode toggle. Real claude
//    TUI (as of #4269) ignores the toggle, which is why throttling is
//    the actual fix — but we still want the stub to model both
//    failure modes so a regression that breaks ONLY the throttle (and
//    relies on the toggle) is detectable.
//
// 3. Multi-byte characters (e.g. emoji) count as one "char" per
//    JS string iterator step (matches `for (const ch of text)` in the
//    production code). The heuristic is about visible characters
//    arriving at human-typing speed, not raw UTF-8 byte count.
//
// 4. Control bytes (the bracketed-paste mode prefix/suffix and the
//    final `\r`) are excluded from the heuristic counter. Real claude
//    does not classify mode toggles as "input chars". A write that
//    begins with `ESC[` is treated as a control sequence and not
//    counted toward the burst-detection window.

export class PasteHeuristicPtyStub {
  constructor() {
    // Each entry: { t: timestamp ms, count: visible chars in this write }
    this._writes = []
    // True between ESC[?2004l (disable) and ESC[?2004h (enable).
    // Initial state matches a freshly-spawned PTY: bracketed-paste
    // mode is enabled by default (it's claude TUI's startup state).
    this._bracketedPasteEnabled = true
  }

  write(data) {
    if (typeof data !== 'string') {
      throw new TypeError('PasteHeuristicPtyStub.write expects a string')
    }
    const t = performance.now()

    // Mode toggles update internal state and don't count as input.
    // Match the exact byte sequences chroxy emits; partial / split
    // writes aren't a concern because production code emits each
    // toggle as a single write.
    if (data === '\x1b[?2004l') {
      this._bracketedPasteEnabled = false
      this._writes.push({ t, count: 0, control: true, raw: data })
      return
    }
    if (data === '\x1b[?2004h') {
      this._bracketedPasteEnabled = true
      this._writes.push({ t, count: 0, control: true, raw: data })
      return
    }

    // Any other write that starts with an ESC byte is treated as a
    // control sequence (cursor moves, color, etc.) — don't feed it to
    // the heuristic. Real claude differentiates with a CSI parser; we
    // only need a coarse "not an input char" classification.
    if (data.length > 0 && data.charCodeAt(0) === 0x1b) {
      this._writes.push({ t, count: 0, control: true, raw: data })
      return
    }

    // Submit char (\r alone) is not "input" for the heuristic — it's
    // the Enter keypress. Don't count it.
    if (data === '\r') {
      this._writes.push({ t, count: 0, control: true, raw: data })
      return
    }

    // Visible characters. Use the string iterator so a JS surrogate
    // pair (one emoji) counts as one, matching `for (const ch of text)`
    // in the production throttle loop.
    const count = [...data].length
    this._writes.push({ t, count, control: false, raw: data })
  }

  // Required IPty surface beyond `write` — production code touches
  // these in cleanup paths.
  kill() {}
  get pid() { return 99999 }

  // ---- inspection helpers (tests call these) ----

  /**
   * Returns true if any rolling window of `thresholdMs` contains at
   * least `thresholdChars` visible characters. This is the
   * burst-detection rule.
   *
   * If bracketed-paste mode was ever disabled (ESC[?2004l), this
   * returns false regardless of arrival rate — modeling a claude
   * version that honors the toggle. To test the throttle in
   * isolation (the actual #4269 / #4273 fix path), use
   * `simulatePasteHeuristicIgnoringMode` below.
   */
  simulatePasteHeuristic(thresholdMs, thresholdChars) {
    if (this._sawBracketedPasteDisable()) return false
    return this._burstDetected(thresholdMs, thresholdChars)
  }

  /**
   * Same as above but ignores the mode-2004 state. This models the
   * real-world claude TUI behavior (#4269): the toggle is a no-op,
   * only the byte-arrival rate matters. The throttle MUST defeat the
   * heuristic under this stricter rule for the fix to be valid.
   */
  simulatePasteHeuristicIgnoringMode(thresholdMs, thresholdChars) {
    return this._burstDetected(thresholdMs, thresholdChars)
  }

  _sawBracketedPasteDisable() {
    return this._writes.some((w) => w.raw === '\x1b[?2004l')
  }

  _burstDetected(thresholdMs, thresholdChars) {
    const visible = this._writes.filter((w) => !w.control)
    if (visible.length === 0) return false
    // Sliding window: for each write, sum char counts of all visible
    // writes whose timestamp is within [t, t + thresholdMs]. If any
    // such sum >= thresholdChars, flag a paste.
    for (let i = 0; i < visible.length; i++) {
      const windowStart = visible[i].t
      let total = 0
      for (let j = i; j < visible.length; j++) {
        if (visible[j].t - windowStart > thresholdMs) break
        total += visible[j].count
        if (total >= thresholdChars) return true
      }
    }
    return false
  }

  // Total visible chars seen (sanity helper for tests).
  visibleCharCount() {
    return this._writes
      .filter((w) => !w.control)
      .reduce((s, w) => s + w.count, 0)
  }

  // Concatenated visible body — proves throttled write reproduces
  // the original prompt verbatim. Surrogates round-trip because we
  // concatenate the raw write strings.
  visibleBody() {
    return this._writes
      .filter((w) => !w.control)
      .map((w) => w.raw)
      .join('')
  }

  // All raw writes in order, including control sequences. Lets a
  // test inspect the full byte stream if it needs to.
  allWrites() {
    return this._writes.map((w) => w.raw)
  }
}
