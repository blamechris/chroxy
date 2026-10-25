/**
 * matchSlashCommands tests (#8699)
 */
import { describe, it, expect } from 'vitest'
import { matchSlashCommands } from './slash-command-match'

const commands = [
  { name: 'prime-directive', description: 'Unattended work toward an outcome', source: 'project' as const },
  { name: 'commit', description: 'Create a git commit', source: 'project' as const },
  { name: 'review-pr', description: 'Review a pull request', source: 'user' as const },
]

const names = (input: string) => matchSlashCommands(commands, input).commands.map(c => c.name)

describe('matchSlashCommands (#8699)', () => {
  it('lists every command for a bare "/"', () => {
    expect(matchSlashCommands(commands, '')).toEqual({ commands, tokenComplete: false })
  })

  it('substring-matches a bare partial token on name or description', () => {
    expect(names('prime')).toEqual(['prime-directive'])
    expect(names('PULL')).toEqual(['review-pr'])
    expect(matchSlashCommands(commands, 'prime').tokenComplete).toBe(false)
  })

  it('matches the command token when arguments follow it', () => {
    expect(names('prime-directive "a b"')).toEqual(['prime-directive'])
    expect(matchSlashCommands(commands, 'prime-directive "a b"').tokenComplete).toBe(true)
  })

  it('ignores a quoted argument containing spaces and a slash', () => {
    expect(names('prime-directive "Some task: follow docs/reports/PLAN.md exactly"')).toEqual(['prime-directive'])
  })

  it('treats a trailing space or a newline as the end of the token', () => {
    expect(matchSlashCommands(commands, 'commit ')).toEqual({ commands: [commands[1]], tokenComplete: true })
    expect(names('commit\nfix the build')).toEqual(['commit'])
  })

  it('matches nothing for an unknown token followed by arguments', () => {
    expect(matchSlashCommands(commands, 'notacommand "a b"')).toEqual({ commands: [], tokenComplete: true })
  })

  it('matches a finished token exactly, as the server dispatches it', () => {
    // A partial or differently-cased token names no command once it is finished.
    expect(names('prime "a b"')).toEqual([])
    expect(names('Prime-Directive "a b"')).toEqual([])
    // An argument that happens to contain a command name matches nothing.
    expect(names('notacommand commit')).toEqual([])
  })
})
