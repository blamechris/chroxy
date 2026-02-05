import { EventEmitter } from "events";

/**
 * Parses raw Claude Code terminal output into structured messages.
 *
 * Claude Code output follows recognizable patterns:
 * - User prompts appear after the "❯" or ">" prompt character
 * - Claude responses appear as formatted text blocks
 * - Tool use blocks show file operations, bash commands, etc.
 * - Diffs show with +/- prefixed lines
 *
 * This parser is intentionally heuristic-based and will need
 * tuning as you use it with real Claude Code output.
 */

// States for the parser state machine
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
    this.lineBuffer = "";

    // Patterns that signal state transitions
    // These will need refinement with real Claude Code output
    this.patterns = {
      // Claude Code prompt indicators
      prompt: /^[❯>]\s*$/m,
      // Thinking indicator (the spinner or "Thinking..." text)
      thinking: /(?:⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|Thinking)/,
      // Tool use block start (Read, Write, Bash, etc.)
      toolStart: /^[╭┌]─+\s*(Read|Write|Edit|Bash|Search|Glob|Grep|TodoRead|TodoWrite)/m,
      // Tool use block end
      toolEnd: /^[╰└]─+/m,
      // Horizontal rule / section divider
      divider: /^[━─]{3,}/m,
      // Diff markers
      diffAdd: /^\+(?!\+\+)/m,
      diffRemove: /^-(?!--)/m,
      // Cost/token summary line
      costLine: /tokens|cost|\$/i,
    };
  }

  /**
   * Feed raw terminal data into the parser.
   * Strips ANSI escape codes for pattern matching but preserves
   * them in the raw output for terminal view.
   */
  feed(rawData) {
    // Emit raw data immediately for terminal view
    this.emit("raw", rawData);

    // Strip ANSI codes for pattern matching
    const clean = this._stripAnsi(rawData);
    this.buffer += clean;

    // Process complete lines
    const lines = this.buffer.split("\n");
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      this._processLine(line);
    }
  }

  /** Process a single line through the state machine */
  _processLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Check for tool use blocks (highest priority)
    if (this.patterns.toolStart.test(trimmed)) {
      this._finishCurrentMessage();
      const match = trimmed.match(this.patterns.toolStart);
      this.state = State.TOOL_USE;
      this.currentMessage = {
        type: "tool_use",
        tool: match ? match[1] : "unknown",
        content: "",
        timestamp: Date.now(),
      };
      return;
    }

    if (this.state === State.TOOL_USE && this.patterns.toolEnd.test(trimmed)) {
      this._finishCurrentMessage();
      this.state = State.RESPONSE;
      return;
    }

    // Check for prompt (user input mode)
    if (this.patterns.prompt.test(trimmed)) {
      this._finishCurrentMessage();
      this.state = State.USER_INPUT;
      this.currentMessage = {
        type: "user_input",
        content: "",
        timestamp: Date.now(),
      };
      return;
    }

    // Check for thinking indicator
    if (this.patterns.thinking.test(trimmed) && this.state !== State.TOOL_USE) {
      if (this.state !== State.THINKING) {
        this._finishCurrentMessage();
        this.state = State.THINKING;
        this.emit("message", { type: "thinking", timestamp: Date.now() });
      }
      return;
    }

    // Accumulate content based on current state
    if (this.currentMessage) {
      this.currentMessage.content += trimmed + "\n";
    } else if (this.state === State.IDLE || this.state === State.THINKING) {
      // New response content from Claude
      this.state = State.RESPONSE;
      this.currentMessage = {
        type: "response",
        content: trimmed + "\n",
        timestamp: Date.now(),
      };
    }
  }

  /** Emit and reset the current accumulated message */
  _finishCurrentMessage() {
    if (this.currentMessage && this.currentMessage.content?.trim()) {
      this.emit("message", { ...this.currentMessage });
    }
    this.currentMessage = null;
  }

  /** Strip ANSI escape codes for clean pattern matching */
  _stripAnsi(str) {
    // Covers: CSI sequences, OSC sequences, simple escapes
    return str.replace(
      // eslint-disable-next-line no-control-regex
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
      ""
    );
  }
}
