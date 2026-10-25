/**
 * Slash-palette matching (#8699) — shared by `SlashCommandPicker` (what it
 * lists) and `InputBar` (what Enter/Tab/arrows act on), so the two can never
 * disagree about the matches.
 *
 * The palette matches on the command token, the first word after the leading
 * "/", never on the whole input. Matching the whole input turned a known
 * command into "No commands found" as soon as arguments followed it
 * (`/prime-directive "a b"` matched nothing).
 */
import type { SlashCommand } from '../store/types'

export interface SlashCommandMatch {
  /** The commands the palette lists. */
  commands: SlashCommand[]
  /** Whitespace follows the token, so the command name is finished. */
  tokenComplete: boolean
}

/** `input` is the composer text after its leading "/". */
export function matchSlashCommands(commands: SlashCommand[], input: string): SlashCommandMatch {
  const wsIdx = input.search(/\s/)
  if (wsIdx === -1) {
    // A bare, possibly partial token: substring match on name or description.
    if (!input) return { commands, tokenComplete: false }
    const lower = input.toLowerCase()
    return {
      commands: commands.filter(
        c => c.name.toLowerCase().includes(lower) || c.description.toLowerCase().includes(lower)
      ),
      tokenComplete: false,
    }
  }
  // A finished token matches only the command it names, by its exact listed
  // name. That is how the BYOK session dispatches an MCP prompt (split at the
  // first whitespace, compared with ===); other providers hand the text to
  // their own CLI or SDK, whose case handling Chroxy does not decide.
  const token = input.slice(0, wsIdx)
  return { commands: commands.filter(c => c.name === token), tokenComplete: true }
}
