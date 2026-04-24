/**
 * Skills loader — reads ~/.chroxy/skills/*.md files and formats them for
 * injection into provider system prompts / first user messages.
 *
 * MVP design (issue #2957):
 *   - Location: ~/.chroxy/skills/ (one file per skill)
 *   - No frontmatter — the file body IS the skill content
 *   - Active = every *.md that does NOT end in .disabled.md
 *   - Disable a skill by renaming foo.md → foo.disabled.md
 *
 * v2 (frontmatter, trust model, UI toggle) is tracked in #2958 / #2959.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export const DEFAULT_SKILLS_DIR = join(homedir(), '.chroxy', 'skills')

/**
 * Scan `dir` for active skills and return them as an array sorted by name.
 * A skill is any regular `*.md` file whose name does NOT end in `.disabled.md`.
 *
 * Returns `[]` if the directory does not exist or contains no active skills —
 * skills are optional, so a missing dir is not an error.
 *
 * @param {string} dir - Directory to scan (e.g. ~/.chroxy/skills)
 * @returns {Array<{ name: string, body: string, description: string }>}
 */
export function loadActiveSkills(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  const skills = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    if (entry.endsWith('.disabled.md')) continue

    const fullPath = join(dir, entry)
    let st
    try {
      st = statSync(fullPath)
    } catch {
      continue
    }
    if (!st.isFile()) continue

    let body
    try {
      body = readFileSync(fullPath, 'utf8')
    } catch {
      continue
    }

    const name = entry.slice(0, -'.md'.length)
    const description = _firstNonEmptyLine(body) || name
    skills.push({ name, body, description })
  }

  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return skills
}

/**
 * Format a list of skills as a single string suitable for appending to a
 * system prompt or prepending to a user message.
 *
 * Returns an empty string for empty/missing input so callers can branch on
 * truthiness without null-checking.
 *
 * @param {Array<{ name: string, body: string }>|null|undefined} skills
 * @returns {string}
 */
export function formatSkillsForPrompt(skills) {
  if (!Array.isArray(skills) || skills.length === 0) return ''

  const sections = skills.map((s) => {
    const body = typeof s.body === 'string' ? s.body.trim() : ''
    return `## Skill: ${s.name}\n\n${body}`
  })

  return [
    '# User skills',
    '',
    'The following skills have been shared from the user\'s ~/.chroxy/skills directory. Apply them when relevant to the task at hand.',
    '',
    sections.join('\n\n---\n\n'),
  ].join('\n')
}

function _firstNonEmptyLine(s) {
  if (typeof s !== 'string') return ''
  for (const line of s.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}
