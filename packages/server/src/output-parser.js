import { EventEmitter } from "events";

/**
 * Parses raw Claude Code terminal output into structured messages.
 *
 * Tuned against real Claude Code v2.1.x PTY output which includes:
 * - Prompt lines starting with ❯
 * - Spinner characters: ✻✶✳✽✢⏺ and text like "Swirling…"
 * - Tool blocks: ╭─── Read(...) / ╰───
 * - Response text: ⏺ followed by content
 * - Noise: tmux status bar, divider lines, token counts
 */

const State = {
  IDLE: "idle",
  USER_INPUT: "user_input",
  THINKING: "thinking",
  RESPONSE: "response",
  TOOL_USE: "tool_use",
};

export class OutputParser extends EventEmitter {
  constructor({ assumeReady = false, suppressScrollback = false } = {}) {
    super();
    this.state = State.IDLE;
    this.buffer = "";
    this.currentMessage = null;
    this._flushTimer = null;
    this._recentEmissions = new Map(); // key -> timestamp
    // Skip initial scrollback burst — only start emitting messages after 5s
    // When assumeReady=true (e.g. attaching to an existing session), skip the grace period
    this._startTime = assumeReady ? 0 : Date.now();
    this._ready = assumeReady;
    // Track whether Claude Code is ready (has shown the ❯ prompt)
    this.claudeReady = assumeReady;
    // Pending interactive prompt being accumulated
    this._pendingPrompt = null;
    this._promptFlushTimer = null;
    // Echo suppression: lines expected from PTY echo of user input
    this._pendingEchos = [];
    // Scrollback suppression: when attaching to an existing tmux session,
    // suppress message emissions until the initial data burst finishes
    // (detected by 500ms of silence on feed()). Raw events still emit.
    this._suppressingScrollback = suppressScrollback;
    this._scrollbackQuietTimer = null;
  }

  /**
   * Register text expected to echo back from the PTY.
   * Stores as a single whitespace-normalized blob with 5s TTL.
   * tmux wraps long input at ~120 cols, so the echo arrives as
   * multiple fragments — substring containment catches them all.
   */
  expectEcho(text) {
    const normalized = text.replace(/\r/g, '').replace(/\s+/g, ' ').trim()
    if (!normalized) return
    this._pendingEchos.push({ blob: normalized, expires: Date.now() + 5000 })
  }

  /**
   * Check if a trimmed line is a substring of a pending echo blob.
   * Does NOT consume on match — let TTL expire naturally, since
   * one echo produces multiple fragments from tmux line wrapping.
   */
  _matchAndConsumeEcho(trimmed) {
    const now = Date.now()
    // Prune expired entries
    this._pendingEchos = this._pendingEchos.filter(e => e.expires > now)
    const normalized = trimmed.replace(/\s+/g, ' ')
    if (!normalized) return false
    return this._pendingEchos.some(e => e.blob.includes(normalized))
  }

  /**
   * Feed raw terminal data into the parser.
   * Strips ANSI escape codes for pattern matching but preserves
   * them in the raw output for terminal view.
   */
  feed(rawData) {
    // Emit raw data immediately for terminal view
    this.emit("raw", rawData);

    // Scrollback suppression: reset quiet timer on each data chunk.
    // When 500ms pass with no new data, scrollback burst is over.
    if (this._suppressingScrollback) {
      if (this._scrollbackQuietTimer) clearTimeout(this._scrollbackQuietTimer);
      this._scrollbackQuietTimer = setTimeout(() => {
        this._scrollbackQuietTimer = null;
        this._suppressingScrollback = false;
        // Discard any message accumulated during the burst
        if (this._flushTimer) {
          clearTimeout(this._flushTimer);
          this._flushTimer = null;
        }
        this.currentMessage = null;
        // Don't clear _recentEmissions — entries self-expire via TTL.
        // Clearing here wipes dedup history right when "real" data starts,
        // allowing stale scrollback content to re-emit as duplicates.
        console.log("[parser] Scrollback suppression ended (500ms quiet)");
      }, 500);
    }

    // Accumulate raw data into buffer, THEN strip ANSI from the whole buffer.
    // This handles ANSI sequences that get split across PTY data chunks
    // (e.g. \x1b[38;5; in one chunk and 255m in the next).
    this.buffer += rawData;
    this.buffer = this._stripAnsi(this.buffer);

    // Process complete lines
    const lines = this.buffer.split("\n");
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      this._processLine(line);
    }
  }

  /** Check if a line is noise that should be skipped */
  _isNoise(trimmed) {
    // Server log lines — when tmux scrollback includes chroxy server output,
    // the parser would re-parse its own logs creating recursive amplification.
    // Must be checked FIRST before any other pattern to prevent feedback loops.
    if (/^\[(?:parser|ws|cli|tunnel|pty|pty-session|SIGINT)\]\s/.test(trimmed)) return true
    // Server output fragments that leak from tmux scrollback
    if (/^Press Ctrl\+C to stop/i.test(trimmed)) return true
    // CLI chrome: "Press up to edit queued messages", "Press enter to send", etc.
    if (/^Press\s+(up|enter|escape|ctrl)/i.test(trimmed) && trimmed.length < 60) return true
    if (/^Or connect manually:/i.test(trimmed)) return true
    if (/^URL:\s+wss?:\/\//i.test(trimmed)) return true
    if (/^Token:\s+\w+/i.test(trimmed)) return true
    if (/^Scan this QR code/i.test(trimmed)) return true
    // QR code block characters
    if (/^[▄▀█\s]+$/.test(trimmed) && trimmed.length > 10) return true
    // Very short non-marker lines (≤5 chars) that are just letters/digits/spaces
    // are terminal redraw artifacts (e.g. "z g", "c 9", "i n", "A u").
    // Skip this filter during RESPONSE state to preserve legitimate short content like "OK", "Yes."
    if (this.state !== State.RESPONSE &&
        trimmed.length <= 5 && !/^[❯⏺]/.test(trimmed) && /^[a-zA-Z\d\s.·…]+$/.test(trimmed)) return true;
    // CUP-split status fragments: short lines where every token is a single character.
    // These are cursor-positioning artifacts from terminal screen redraws.
    // Examples: "c a", "z g", "i n", "A u", "· c a 9"
    // State-independent — these are never legitimate content in any state.
    if (trimmed.length < 20) {
      const tokens = trimmed.split(/\s+/)
      if (tokens.length >= 2 && tokens.every(t => t.length <= 1 || /^\d{1,3}$/.test(t))) return true
    }
    // Numeric-only fragments with optional punctuation (CUP artifacts, line counters)
    // Examples: "7 0 -0", "8 187 -3", "2 9 )"
    // Skip during RESPONSE state — "42" or "100" can be legitimate response content.
    if (this.state !== State.RESPONSE &&
        /^[\d\s.()+-]+$/.test(trimmed) && trimmed.length < 20) return true
    // Divider lines (all dashes, or dashes with a few other chars)
    if (/^[━─╌]{3,}/.test(trimmed)) return true;
    // Lines that are mostly dashes with some text mixed in (require at least one dash)
    if (/[─━]/.test(trimmed) && /^[─━n\d]+$/.test(trimmed)) return true;
    // tmux status bar — any session name in brackets followed by window:pane
    if (/^\[[\w-]+\]\s*\d+:/.test(trimmed)) return true;
    if (/\[claude-co/.test(trimmed)) return true;
    // tmux status bar (non-anchored) — CUP joining may prepend content before [session]
    // Pattern: [name] N:window_name with multiple trailing spaces (tmux pads with spaces)
    if (/\[[\w-]+\]\s+\d+:[\w.-]+[*#!\-]?\s{2,}/.test(trimmed)) return true
    // Quoted pane titles from tmux status bar (braille/spinner char inside quotes)
    if (/^"[\u2800-\u28FF✻✶✳✽✢·•⏺]/.test(trimmed)) return true
    if (/^"\*?\s*Claude\s*Code"/.test(trimmed)) return true;
    if (/^"Christophers-/.test(trimmed)) return true;
    if (/^\*\s*Claude\s*Code/.test(trimmed)) return true;
    // Token/cost/version lines
    if (/^\$[\d.]+(\s*\||$)/.test(trimmed)) return true;
    if (/tokens?\s*current:/i.test(trimmed)) return true;
    if (/latest:\s*[\d.]+/i.test(trimmed) && !/^⏺/.test(trimmed)) return true;
    if (/current:\s*[\d.]+/i.test(trimmed) && !/^⏺/.test(trimmed)) return true;
    if (/til compact/i.test(trimmed)) return true;
    if (/^\d+\s*tokens?$/i.test(trimmed)) return true;
    if (/\d+tokens/i.test(trimmed)) return true;
    // Token counts with closing paren — status line fragments like "775 tokens)"
    if (/^\d+\.?\d*k?\s*tokens?\)?$/i.test(trimmed)) return true;
    // Timing/token status lines: "10s · ↓ 150 tokens · thinking)" etc.
    if (/\d+s\s*·\s*[↓↑]?\s*\d/.test(trimmed) && /tokens/i.test(trimmed)) return true;
    // "thought for Ns)" timing fragments
    if (/thought\s+for\s+\d+s\)/i.test(trimmed)) return true;
    // "(No content)" marker from Claude Code UI
    if (/^\(No content\)/i.test(trimmed)) return true;
    // Bare version numbers
    if (/^\d+\.\d+\.\d+$/.test(trimmed)) return true;
    // ctrl+g / ide hints
    if (/^ctrl\+g/i.test(trimmed)) return true;
    if (/\/ide\s+for/i.test(trimmed)) return true;
    // Empty box-drawing fragments or lines with only box chars + spaces
    if (/^[╭╮╰╯│┌┐└┘├┤┬┴┼\s]+$/.test(trimmed)) return true;
    // Welcome screen fragments (box content without ⏺ prefix)
    if (/^│.*│$/.test(trimmed)) return true;
    // Welcome banner block elements (ASCII art logo) — with or without trailing text
    if (/^[▐▛▜▌▝▘█░▒▓]/.test(trimmed)) return true;
    // Claude Code version/model lines from welcome banner
    if (/Claude\s*Code\s*v\d/i.test(trimmed) && !/^⏺/.test(trimmed)) return true;
    if (/(?:Opus|Sonnet|Haiku)\s+\d/i.test(trimmed) && !/^⏺/.test(trimmed)) return true;
    if (/Claude\s*(?:Max|Pro|Free)/i.test(trimmed) && !/^⏺/.test(trimmed)) return true;
    // Try "edit..." placeholder prompt
    if (/^Try "/.test(trimmed)) return true;
    // Percentage/compact lines
    if (/\d+\.\d+%/.test(trimmed) && !/^⏺/.test(trimmed)) return true;
    // "start of a new conversation" banner text
    if (/^start\s*of\s*a\s*new/i.test(trimmed) && !/^⏺/.test(trimmed)) return true;
    if (/^new\s*conversation/i.test(trimmed) && !/^⏺/.test(trimmed)) return true;
    // Tool block end boundaries (╰───) that leak when not in TOOL_USE state
    if (/^[╰└]─{2,}/.test(trimmed)) return true;
    // Tool status lines: "Bash(cmd)   ⎿ Running…"
    if (/⎿\s*(Running|Completed|Done|Failed)/i.test(trimmed)) return true;
    // Status bar fragments with scroll arrows
    if (/[↓↑]\s*\d*$/.test(trimmed) && trimmed.length < 25) return true;
    // Path-only lines from welcome banner (not inside a response)
    if (/^\/Users\/\w+$/.test(trimmed)) return true;
    // PTY Scrollback marker
    if (/PTY\s*Scrollback/i.test(trimmed)) return true;
    // [Pasted text #N] markers from Claude Code paste handling
    if (/^\[Pasted text #\d+/.test(trimmed)) return true
    // "Baked for Nm Ns" / completion timing lines
    if (/^Baked\s+for\s+\d/i.test(trimmed)) return true
    // "Conversation compacted" notification from Claude Code context compaction
    if (/conversation\s+compacted/i.test(trimmed)) return true
    // Tool result summaries: "⎿ Read 15 lines" / "⎿ Added 3 lines"
    if (/⎿\s*\w+\s+\d+\s*(lines?|chars?|bytes?)/i.test(trimmed)) return true
    // General ⎿ lines outside TOOL_USE/RESPONSE (tool chrome)
    // Skip if line starts with a tool name (compact tool format like "Bash(cmd) ⎿ output")
    if (this.state !== State.TOOL_USE && this.state !== State.RESPONSE &&
        /⎿/.test(trimmed) && trimmed.length < 60 &&
        !/^(Read|Write|Edit|Bash|Search|Glob|Grep|TodoRead|TodoWrite|Task|Skill|WebFetch|WebSearch|NotebookEdit)\(/.test(trimmed)) return true
    // Git diff summaries: "1 file +3 -0" / "N files changed"
    if ((/^\d+\s+files?\s+changed\b/i.test(trimmed) ||
         /^\d+\s+files?\s+\+\d+\s+-\d+\b/i.test(trimmed)) &&
        trimmed.length < 50 &&
        !/^⏺/.test(trimmed)) return true
    // Standalone "tokens" / "tokens)"
    if (/^tokens\)?$/i.test(trimmed)) return true
    // CUP-split compact status: "l compact 100653 tokens"
    if (/compact\s+\d+\s*tokens/i.test(trimmed)) return true
    // Message count: "msgs:375"
    if (/msgs?:\s*\d+/i.test(trimmed)) return true
    // tsc output leakage
    if (/tsc:\s*The\s*TypeScript/i.test(trimmed)) return true
    // Autosuggest ghost text: short imperative git commands (not in RESPONSE)
    if (this.state !== State.RESPONSE &&
        /^(merge|commit|push|pull|rebase|checkout)\s/i.test(trimmed)
        && trimmed.length < 30) return true
    return false;
  }

  /** Check if a line is a Claude Code spinner/thinking indicator */
  _isThinking(trimmed) {
    // Bare spinner characters (single or groups, with optional spaces)
    if (/^[✻✶✳✽✢·•⏺]+$/.test(trimmed)) return true;
    // Any short line starting with spinner characters — these are exclusively
    // used for Claude Code's thinking/working animation, never in response text.
    if (/^[✻✶✳✽✢]/.test(trimmed) && trimmed.length < 40) return true;
    if (/^[·•]\s*\w.*…/i.test(trimmed)) return true;
    // Middle dot/bullet followed by status indicators (numbers, ellipsis, arrows, "thinking")
    // but NOT followed by uppercase letter (which would be a bullet-point list item)
    if (/^[·•]\s*(?:\d|…|thinking|tokens|↑|↓)/i.test(trimmed) && trimmed.length < 40) return true;
    // Bare spinner with timing info
    if (/^[✻✶✳✽✢⏺·•]\s*.*\(\d+s\s*·\s*[↓↑]/.test(trimmed)) return true;
    // Mixed spinner character sequences (animation frames) — includes … (U+2026)
    if (/^[✻✶✳✽✢·•↑↓…\d\s]{3,}$/.test(trimmed)) return true;
    // Braille spinners — full braille block (U+2800–U+28FF)
    if (/^[\u2800-\u28FF]/.test(trimmed)) return true;
    // Standalone spinner verb text (from animation frames after ANSI stripping).
    // Must be JUST the verb (optionally with ellipsis) — not followed by real content.
    // Length < 20 prevents false positives on "Writing tests for the parser module" etc.
    // Skip during RESPONSE state — "Reading..." can appear as sentence fragment in responses.
    if (this.state !== State.RESPONSE &&
        /^(thinking|swirling|reasoning|pondering|processing|analyzing|considering|working|reading|writing|searching|editing|actualizing|imagining|waiting|unravelling|fetching|preparing|generating|resolving|updating|parsing|cogitating)(…|\.\.\.)?$/i.test(trimmed) && trimmed.length < 20) return true;
    // "N thinking" — thinking counter fragment (e.g. "42 thinking", "7 thinking")
    if (/^\d+\s*thinking/i.test(trimmed)) return true;
    // Lines ending with "thinking" or "thinking)" — status bar fragments like "c a thinking"
    if (/thinking\)?$/i.test(trimmed) && trimmed.length < 60) return true;
    // "thought for Ns)" — past tense thinking indicator
    if (/thought\s+for\s+\d/i.test(trimmed)) return true;
    // Known spinner verb with "…" or "..." — e.g. "Actualizing…", "Imagining… 39"
    // Skip during RESPONSE state — "Reading..." or "Writing..." can appear in response text.
    if (this.state !== State.RESPONSE &&
        /^(thinking|swirling|reasoning|pondering|processing|analyzing|considering|working|reading|writing|searching|editing|actualizing|imagining|waiting|downloading|compiling|installing|building|connecting|loading|unravelling|fetching|preparing|generating|resolving|updating|parsing|cogitating)(…|\.\.\.)/i.test(trimmed) && trimmed.length < 30) return true;
    // General: any capitalized word ending in … or ... followed by optional trailing noise
    // (numbers, arrows, spaces). Future-proofs against new creative spinner verbs.
    // Skip during RESPONSE state — "However...", "Meanwhile..." are real response content.
    if (this.state !== State.RESPONSE &&
        /^[A-Z][a-z]+(…|\.\.\.)\s*[\d↑↓\s]*$/.test(trimmed) && trimmed.length < 40) return true;
    // Multi-word spinner: "Wait Unravelling…" / "Just Thinking..."
    if (this.state !== State.RESPONSE &&
        /^[A-Z][a-z]+\s+[A-Z][a-z]+(…|\.\.\.)\s*[\d↑↓\s]*$/.test(trimmed)
        && trimmed.length < 50) return true;
    // Line ending with ellipsis + scroll indicators
    if (this.state !== State.RESPONSE &&
        /(…|\.\.\.)\s*[↑↓]\s*[\d\s]*$/.test(trimmed)
        && trimmed.length < 50) return true;
    return false;
  }

  /**
   * Extract Claude Code status bar line and emit as structured metadata.
   * Format: "$77.79 | Opus 4.6 | msgs:375 | 76.1K (38.1%) | 61.9% til compact"
   */
  _extractStatusBar(trimmed) {
    const match = trimmed.match(
      /^\$(\d+\.?\d*)\s*\|\s*(.+?)\s*\|\s*msgs?:(\d+)\s*\|\s*([\d.]+[KkMm]?)\s*\(([\d.]+)%\)(?:\s*\|\s*([\d.]+)%\s*til\s*compact)?/
    )
    if (!match) return false
    this.emit('status_update', {
      cost: parseFloat(match[1]),
      model: match[2],
      messageCount: parseInt(match[3], 10),
      contextTokens: match[4],
      contextPercent: parseFloat(match[5]),
      compactPercent: match[6] ? parseFloat(match[6]) : null,
    })
    return true
  }

  /**
   * Detect interactive prompts from Claude Code and emit them.
   * Accumulates numbered options and permission prompts, then
   * emits a 'message' with type 'prompt' and parsed options.
   */
  _detectPrompt(trimmed) {
    // Numbered option: "1. Yes, I trust this folder" / "2. No, exit"
    // Cap at 10 options — Claude Code prompts never have more than ~5.
    // Scrollback replay of numbered test output (ok 1, ok 2, ...) can
    // generate hundreds of false positives without this guard.
    const optMatch = trimmed.match(/^(\d+)\.\s*(.+)/);
    if (optMatch) {
      // Overflow sentinel — once we've seen too many options, ignore all
      // subsequent numbered lines until the prompt state resets naturally.
      if (this._pendingPrompt && this._pendingPrompt.overflow) return;
      if (!this._pendingPrompt) {
        this._pendingPrompt = { options: [], timestamp: Date.now() };
      }
      if (this._pendingPrompt.options.length >= 10) {
        // Too many options — this is scrollback noise, not a real prompt.
        // Set overflow sentinel to block further accumulation.
        this._pendingPrompt = { overflow: true };
        return;
      }
      this._pendingPrompt.options.push({
        label: optMatch[2].trim(),
        value: optMatch[1],
      });
      this._resetPromptFlush();
      return;
    }

    // Permission prompt keywords: "Allow", "Deny", "Always allow"
    if (/^(Allow|Deny|Always\s*allow|Yes|No)\b/i.test(trimmed) && trimmed.length < 40) {
      if (!this._pendingPrompt) {
        this._pendingPrompt = { options: [], timestamp: Date.now() };
      }
      // Map to key presses Claude Code expects
      const label = trimmed.trim();
      let value = label;
      if (/^allow$/i.test(label)) value = "y";
      else if (/^deny$/i.test(label)) value = "n";
      else if (/^always/i.test(label)) value = "a";
      this._pendingPrompt.options.push({ label, value });
      this._resetPromptFlush();
      return;
    }
  }

  /** Flush pending prompt after a short delay to collect all options */
  _resetPromptFlush() {
    if (this._promptFlushTimer) clearTimeout(this._promptFlushTimer);
    this._promptFlushTimer = setTimeout(() => {
      this._promptFlushTimer = null;
      if (this._pendingPrompt && this._pendingPrompt.options && this._pendingPrompt.options.length > 0) {
        // Don't emit startup prompts (trust dialog etc.) — server auto-handles those
        if (!this.claudeReady) {
          console.log(`[parser] Suppressing startup prompt (${this._pendingPrompt.options.length} options)`);
          this._pendingPrompt = null;
          return;
        }
        const content = this._pendingPrompt.options
          .map((o) => `${o.value}. ${o.label}`)
          .join("\n");
        console.log(`[parser] Emitting prompt with ${this._pendingPrompt.options.length} options`);
        this.emit("message", {
          type: "prompt",
          content,
          options: this._pendingPrompt.options,
          timestamp: this._pendingPrompt.timestamp,
        });
        this._pendingPrompt = null;
      }
    }, 500);
  }

  /** Process a single line through the state machine */
  _processLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Extract status bar (before noise filtering — status lines are also matched by noise)
    if (this._extractStatusBar(trimmed)) return;

    // Skip noise
    if (this._isNoise(trimmed)) return;

    // Skip thinking/spinner lines
    if (this._isThinking(trimmed)) {
      if (this.state !== State.THINKING && this.state !== State.TOOL_USE) {
        this._finishCurrentMessage();
        this.state = State.THINKING;
      }
      return;
    }

    // Detect interactive prompts (permission requests, selections)
    this._detectPrompt(trimmed);

    // Tool use block start: ╭─── Read(src/file.js) ───
    // Also detect compact format: Read(src/file.js) or Bash(cmd) ⎿ output
    const toolNames = 'Read|Write|Edit|Bash|Search|Glob|Grep|TodoRead|TodoWrite|Task|Skill|WebFetch|WebSearch|NotebookEdit';
    const toolBoxMatch = trimmed.match(new RegExp(`^[╭┌]─+\\s*(${toolNames})`));
    const toolCompactMatch = !toolBoxMatch && trimmed.match(new RegExp(`^(${toolNames})\\(`));
    if (toolBoxMatch || toolCompactMatch) {
      this._finishCurrentMessage();
      const tool = toolBoxMatch ? toolBoxMatch[1] : toolCompactMatch[1];
      this.state = State.TOOL_USE;
      this.currentMessage = {
        type: "tool_use",
        tool: tool || "unknown",
        // Compact format has the full invocation on one line — use it as content.
        // Box-drawing format accumulates content from subsequent lines.
        content: toolCompactMatch ? trimmed + "\n" : "",
        timestamp: Date.now(),
      };
      this._resetFlush();
      return;
    }

    // Tool use block end
    if (this.state === State.TOOL_USE && /^[╰└]─+/.test(trimmed)) {
      this._finishCurrentMessage();
      this.state = State.IDLE;
      return;
    }

    // Prompt line: ❯ (with or without text after it)
    if (/^❯/.test(trimmed)) {
      this._finishCurrentMessage();
      // Signal that Claude Code is ready for input
      // Only after grace period — the shell also shows ❯ before claude launches
      if (!this.claudeReady && this._ready) {
        this.claudeReady = true;
        console.log(`[parser] Claude Code is ready`);
        this.emit("claude_ready");
      }
      const userText = trimmed.replace(/^❯\s*/, "").trim();
      if (userText && !/^Try "/.test(userText)) {
        // User typed something — emit as user_input
        this.state = State.USER_INPUT;
        this.currentMessage = {
          type: "user_input",
          content: userText + "\n",
          timestamp: Date.now(),
        };
        this._finishCurrentMessage();
      }
      this.state = State.IDLE;
      return;
    }

    // Response marker: ⏺ followed by text
    if (/^⏺\s*/.test(trimmed)) {
      if (this.state !== State.RESPONSE) {
        this._finishCurrentMessage();
        this.state = State.RESPONSE;
        const text = trimmed.replace(/^⏺\s*/, "");
        this.currentMessage = {
          type: "response",
          content: text ? text + "\n" : "",
          timestamp: Date.now(),
        };
      } else {
        // Additional ⏺ line within a response
        const text = trimmed.replace(/^⏺\s*/, "");
        if (this.currentMessage && text) {
          this.currentMessage.content += text + "\n";
        }
      }
      this._resetFlush();
      return;
    }

    // Accumulate content into current message
    if (this.currentMessage) {
      this.currentMessage.content += trimmed + "\n";
      this._resetFlush();
    } else if (this.state === State.IDLE || this.state === State.THINKING) {
      // Suppress echoed user input from PTY
      if (this._matchAndConsumeEcho(trimmed)) return;
      // New response content
      this.state = State.RESPONSE;
      this.currentMessage = {
        type: "response",
        content: trimmed + "\n",
        timestamp: Date.now(),
      };
      this._resetFlush();
    }
  }

  /** Set a timer to flush accumulated message if no new state transition */
  _resetFlush() {
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._finishCurrentMessage();
    }, 1500);
  }

  /** Emit and reset the current accumulated message */
  _finishCurrentMessage() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this.currentMessage && this.currentMessage.content?.trim()) {
      // Scrollback suppression: discard messages during initial burst
      if (this._suppressingScrollback) {
        this.currentMessage = null;
        return;
      }
      // Skip messages from initial scrollback burst (first 5 seconds)
      if (!this._ready) {
        if (Date.now() - this._startTime < 5000) {
          this.currentMessage = null;
          return;
        }
        this._ready = true;
        this._recentEmissions.clear();
        console.log(`[parser] Ready`);
      }
      // Don't emit chat messages until Claude Code is ready (skip startup noise)
      if (!this.claudeReady) {
        this.currentMessage = null;
        return;
      }
      // Deduplicate — tmux redraws cause the same content to be re-parsed.
      // Normalize by stripping ALL whitespace so garbled redraws (lost/extra spaces)
      // still match the original emission.
      const key = `${this.currentMessage.type}:${this.currentMessage.content.replace(/\s/g, "")}`;
      const now = Date.now();
      const lastEmit = this._recentEmissions.get(key);
      if (!lastEmit || now - lastEmit > 10000) {
        this._recentEmissions.set(key, now);
        // Prune old entries
        if (this._recentEmissions.size > 200) {
          for (const [k, t] of this._recentEmissions) {
            if (now - t > 30000) this._recentEmissions.delete(k);
          }
        }
        console.log(`[parser] Emitting ${this.currentMessage.type}: "${this.currentMessage.content.trim().slice(0, 100)}"`);
        this.emit("message", { ...this.currentMessage });
      }
    }
    this.currentMessage = null;
  }

  /** Strip ANSI escape codes for clean pattern matching.
   *  Cursor-positioning sequences (\x1b[...H) are replaced with \n
   *  so that tmux screen redraws produce parseable lines instead of
   *  concatenating everything into one giant buffer line. */
  _stripAnsi(str) {
    // First pass: smart cursor positioning (CUP) replacement.
    // CUP format: \x1b[row;colH or \x1b[rowH (col defaults to 1)
    // Column 1 = start of a new screen row → insert \n
    // Column > 1 = mid-line positioning → insert space (preserves word spacing)
    str = str.replace(
      // eslint-disable-next-line no-control-regex
      /\x1b\[(\d*);?(\d*)H/g,
      (_match, _row, col) => {
        const c = col ? parseInt(col, 10) : 1;
        return c <= 1 ? "\n" : " ";
      }
    );
    // Handle cursor forward (CUF \x1b[nC) — tmux uses this for spacing between
    // styled segments during screen redraws. Without this, words run together.
    // Also handle CHA (cursor to absolute column \x1b[nG).
    // eslint-disable-next-line no-control-regex
    str = str.replace(/\x1b\[\d*C/g, " ");
    // eslint-disable-next-line no-control-regex
    str = str.replace(/\x1b\[(\d*)G/g, (_match, col) => {
      const c = col ? parseInt(col, 10) : 1;
      return c <= 1 ? "\n" : " ";
    });
    // Also treat \r as a line boundary (tmux uses \r for carriage returns)
    str = str.replace(/\r/g, "\n");
    // Second pass: strip all remaining ANSI sequences
    return str.replace(
      // eslint-disable-next-line no-control-regex
      /\x1b\[[0-9;?]*[A-Za-z~]|\x1b\][^\x07]*\x07?|\x1b[()#][A-Z0-2]|\x1b[A-Za-z]|\x9b[0-9;?]*[A-Za-z~]/g,
      ""
    );
  }
}
