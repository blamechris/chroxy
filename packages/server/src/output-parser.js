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
  constructor() {
    super();
    this.state = State.IDLE;
    this.buffer = "";
    this.currentMessage = null;
    this._flushTimer = null;
    this._recentEmissions = new Map(); // key -> timestamp
    // Skip initial scrollback burst — only start emitting messages after 5s
    this._startTime = Date.now();
    this._ready = false;
    // Track whether Claude Code is ready (has shown the ❯ prompt)
    this.claudeReady = false;
    // Pending interactive prompt being accumulated
    this._pendingPrompt = null;
    this._promptFlushTimer = null;
  }

  /**
   * Feed raw terminal data into the parser.
   * Strips ANSI escape codes for pattern matching but preserves
   * them in the raw output for terminal view.
   */
  feed(rawData) {
    // Emit raw data immediately for terminal view
    this.emit("raw", rawData);

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
    // Very short non-marker lines (1-2 chars) are usually fragments
    if (trimmed.length <= 2 && !/^[❯⏺]/.test(trimmed)) return true;
    // Divider lines (all dashes, or dashes with a few other chars)
    if (/^[━─╌]{3,}/.test(trimmed)) return true;
    // Lines that are mostly dashes with some text mixed in
    if (/^[─━n\d]+$/.test(trimmed)) return true;
    // tmux status bar
    if (/\[claude-co/.test(trimmed)) return true;
    if (/^"\*?\s*Claude\s*Code"/.test(trimmed)) return true;
    if (/^"Christophers-/.test(trimmed)) return true;
    if (/^\*\s*Claude\s*Code/.test(trimmed)) return true;
    // Token/cost/version lines
    if (/^\$[\d.]+\s*\|/.test(trimmed)) return true;
    if (/tokens?\s*current:/i.test(trimmed)) return true;
    if (/latest:\s*[\d.]+/i.test(trimmed) && !/^⏺/.test(trimmed)) return true;
    if (/current:\s*[\d.]+/i.test(trimmed) && !/^⏺/.test(trimmed)) return true;
    if (/til compact/i.test(trimmed)) return true;
    if (/^\d+\s*tokens?$/i.test(trimmed)) return true;
    if (/\d+tokens/i.test(trimmed)) return true;
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
    if (/[↓↑]\s*$/.test(trimmed) && trimmed.length < 20) return true;
    // Path-only lines from welcome banner (not inside a response)
    if (/^\/Users\/\w+$/.test(trimmed)) return true;
    return false;
  }

  /** Check if a line is a Claude Code spinner/thinking indicator */
  _isThinking(trimmed) {
    // Bare spinner characters (single or groups, with optional spaces)
    if (/^[✻✶✳✽✢·•⏺]+$/.test(trimmed)) return true;
    // Spinner characters followed by ANY word (Claude uses creative verbs)
    if (/^[✻✶✳✽✢]\s*\w/i.test(trimmed)) return true;
    if (/^[·•]\s*\w.*…/i.test(trimmed)) return true;
    // Bare spinner with timing info
    if (/^[✻✶✳✽✢⏺·•]\s*.*\(\d+s\s*·\s*[↓↑]/.test(trimmed)) return true;
    // Mixed spinner character sequences (animation frames)
    if (/^[✻✶✳✽✢·•↑↓\d\s]{3,}$/.test(trimmed)) return true;
    // Braille spinners
    if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(trimmed)) return true;
    // Standalone spinner verb text (from animation frames after ANSI stripping)
    if (/^(thinking|swirling|reasoning|pondering|processing|analyzing|considering|working|reading|writing|searching|editing)/i.test(trimmed) && trimmed.length < 30) return true;
    return false;
  }

  /**
   * Detect interactive prompts from Claude Code and emit them.
   * Accumulates numbered options and permission prompts, then
   * emits a 'message' with type 'prompt' and parsed options.
   */
  _detectPrompt(trimmed) {
    // Numbered option: "1. Yes, I trust this folder" / "2. No, exit"
    const optMatch = trimmed.match(/^(\d+)\.\s*(.+)/);
    if (optMatch) {
      if (!this._pendingPrompt) {
        this._pendingPrompt = { options: [], timestamp: Date.now() };
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
      if (this._pendingPrompt && this._pendingPrompt.options.length > 0) {
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
    if (/^[╭┌]─+\s*(Read|Write|Edit|Bash|Search|Glob|Grep|TodoRead|TodoWrite|Task|Skill|WebFetch|WebSearch)/m.test(trimmed)) {
      this._finishCurrentMessage();
      const match = trimmed.match(/^[╭┌]─+\s*(\w+)/);
      this.state = State.TOOL_USE;
      this.currentMessage = {
        type: "tool_use",
        tool: match ? match[1] : "unknown",
        content: "",
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
