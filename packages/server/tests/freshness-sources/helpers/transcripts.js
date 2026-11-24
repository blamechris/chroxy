/**
 * Synthetic Claude transcript fixtures. Everything here is invented text in
 * temp directories; no real transcript is read. Registers no tests.
 */

import fs from 'node:fs'
import path from 'node:path'
import { T0, MIN, tmp } from '../../freshness-core/helpers/harness.js'

export const SRC_NAME = 'claude-transcript'
export const iso = (ms) => new Date(ms).toISOString()

/** A four-slot status block as the daemon's parser reads it. */
export function block({ done = 'did the work', blocked = 'none', decision = 'none', next = '⚪ IDLE — nothing waits on anyone' } = {}) {
  return ['**Status:**', `- ✅ ${done}`, '- 🔄 none', `- ⛔ ${blocked}`, `- 🔶 DECISION: ${decision}`, '', `**Next:** ${next}`].join('\n')
}

let n = 0
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

export const assistant = (text, at, extra = {}) =>
  ({ type: 'assistant', uuid: uid(), parentUuid: null, sessionId: 'x', cwd: '/work/dir', timestamp: iso(at), message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra })
export const user = (text, at) => ({ type: 'user', uuid: uid(), timestamp: iso(at), message: { role: 'user', content: [{ type: 'text', text }] } })
export const assistantBlocks = (content, at, extra = {}) => ({ type: 'assistant', uuid: uid(), timestamp: iso(at), message: { role: 'assistant', content }, ...extra })
export const toolResult = (text, at) => ({ type: 'user', uuid: uid(), timestamp: iso(at), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: text }] } })

export const jsonl = (entries, { terminate = true } = {}) => entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + (terminate ? '\n' : '')

/** A projects directory as Claude Code lays it out: `<encoded cwd>/<session id>.jsonl`. */
export function store() {
  const root = tmp()
  const projects = path.join(root, 'projects')
  fs.mkdirSync(projects)
  return {
    root,
    projects,
    file: (id, project = '-work-dir') => path.join(projects, project, `${id}.jsonl`),
    write(id, content, project = '-work-dir') {
      fs.mkdirSync(path.join(projects, project), { recursive: true })
      fs.writeFileSync(path.join(projects, project, `${id}.jsonl`), content)
      return path.join(projects, project, `${id}.jsonl`)
    },
  }
}

export { T0, MIN }
