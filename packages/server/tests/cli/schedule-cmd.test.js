/**
 * E2E coverage for `chroxy schedule` — spawns the real CLI binary (via
 * runCli, which isolates HOME/CHROXY_CONFIG_DIR per child process) so the
 * commander wiring in src/cli.js -> registerScheduleCommands is exercised
 * end-to-end, not just the pure functions in src/cli/schedule-cmd.js
 * (covered in depth by tests/schedule-cli.test.js).
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli, makeTempHome } from './__helpers/spawn-cli.js'

/** Write `~/.chroxy/config.json` with the given `provider` into a temp HOME. */
function writeConfig(home, config) {
  const dir = join(home, '.chroxy')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2))
}

// The store logs an INFO line ("Loaded N scheduled task(s)") to stdout ahead
// of --json output on any non-empty load — strip to the first `{` so this
// suite doesn't couple to that logger's exact format.
function parseJsonStdout(stdout) {
  return JSON.parse(stdout.slice(stdout.indexOf('{')))
}

describe('chroxy schedule — CLI wiring (#6868)', () => {
  it('registers the schedule command group with all subcommands', async () => {
    const r = await runCli(['schedule', '--help'])
    assert.equal(r.code, 0, `stderr: ${r.stderr}`)
    assert.match(r.stdout, /Manage scheduled tasks/)
    for (const cmd of ['create', 'list', 'edit', 'pause', 'resume', 'delete', 'last-run']) {
      assert.match(r.stdout, new RegExp(cmd), `missing "${cmd}" in --help output`)
    }
  })

  it('schedule create --help lists the cadence and target flags', async () => {
    const r = await runCli(['schedule', 'create', '--help'])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /--prompt/)
    assert.match(r.stdout, /--at/)
    assert.match(r.stdout, /--cron/)
    assert.match(r.stdout, /--provider/)
    assert.match(r.stdout, /--permission-mode/)
  })

  describe('create -> list -> last-run -> delete round trip', () => {
    const { home, cleanup } = makeTempHome()
    after(cleanup)

    it('create persists a task and reports the default-off scheduler + provider-refusal warnings', async () => {
      const r = await runCli(
        ['schedule', 'create', '--prompt', 'say hi', '--cron', '0 9 * * *', '--name', 'Morning'],
        { home },
      )
      assert.equal(r.code, 0, `stderr: ${r.stderr}`)
      assert.match(r.stdout, /Created scheduled task/)
      // No config.json / CHROXY_ENABLE_SCHEDULER in this temp HOME -> gate closed.
      assert.match(r.stdout, /WARNING:.*DISABLED/)
      // No target.provider given -> falls back to the daemon default
      // (claude-tui), which the engine refuses (no in-process permissions).
      assert.match(r.stdout, /WARNING:.*will be REFUSED/)
    })

    it('list shows the task as [NEVER RUN], never healthy-looking', async () => {
      const r = await runCli(['schedule', 'list'], { home })
      assert.equal(r.code, 0, `stderr: ${r.stderr}`)
      assert.match(r.stdout, /Scheduled execution: DISABLED/)
      assert.match(r.stdout, /\[NEVER RUN\] Morning/)
    })

    it('last-run reports "never run" honestly for the fresh task', async () => {
      const listRes = await runCli(['schedule', 'list', '--json'], { home })
      const { tasks } = parseJsonStdout(listRes.stdout)
      const id = tasks[0].id

      const r = await runCli(['schedule', 'last-run', id], { home })
      assert.equal(r.code, 0, `stderr: ${r.stderr}`)
      assert.match(r.stdout, /\[NEVER RUN\] never run/)
      assert.match(r.stdout, /This task has never fired/)
    })

    it('delete without --yes explains and removes nothing; with --yes removes it', async () => {
      const listRes = await runCli(['schedule', 'list', '--json'], { home })
      const { tasks } = parseJsonStdout(listRes.stdout)
      const id = tasks[0].id

      const dry = await runCli(['schedule', 'delete', id], { home })
      assert.equal(dry.code, 0)
      assert.match(dry.stdout, /re-run with --yes/)

      const stillThere = await runCli(['schedule', 'list', '--json'], { home })
      assert.equal(parseJsonStdout(stillThere.stdout).tasks.length, 1, 'not deleted without --yes')

      const confirmed = await runCli(['schedule', 'delete', id, '--yes'], { home })
      assert.equal(confirmed.code, 0)
      assert.match(confirmed.stdout, /Deleted scheduled task/)

      const gone = await runCli(['schedule', 'list', '--json'], { home })
      assert.equal(parseJsonStdout(gone.stdout).tasks.length, 0)
    })
  })

  it('create rejects an invalid cron expression and exits non-zero', async () => {
    const r = await runCli(['schedule', 'create', '--prompt', 'x', '--cron', 'garbage'])
    assert.notEqual(r.code, 0)
    assert.match(r.stdout, /Invalid schedule/)
  })

  // #7014 — the provider-refusal warning must follow the daemon's OWN
  // resolution of "the effective default provider" (config.provider ||
  // DEFAULT_PROVIDER, mirroring server-cli.js), not a hardcoded
  // DEFAULT_PROVIDER constant. These two cases prove the warning tracks
  // config.json rather than the constant: a configured provider that IS
  // schedulable (in-process permissions) must NOT warn even though
  // DEFAULT_PROVIDER (claude-tui) would; a configured provider that is
  // hook-routed must warn even without any --provider flag.
  describe('provider-refusal warning follows config.provider, not the DEFAULT_PROVIDER constant (#7014)', () => {
    it('does not warn when config.provider is a schedulable (in-process-permissions) provider', async () => {
      const { home, cleanup } = makeTempHome()
      try {
        writeConfig(home, { provider: 'claude-sdk' })
        const r = await runCli(
          ['schedule', 'create', '--prompt', 'x', '--cron', '0 9 * * *'],
          { home },
        )
        assert.equal(r.code, 0, `stderr: ${r.stderr}`)
        assert.doesNotMatch(r.stdout, /will be REFUSED/)
      } finally {
        cleanup()
      }
    })

    it('warns when config.provider is a hook-routed provider, with no --provider flag given', async () => {
      const { home, cleanup } = makeTempHome()
      try {
        writeConfig(home, { provider: 'claude-tui' })
        const r = await runCli(
          ['schedule', 'create', '--prompt', 'x', '--cron', '0 9 * * *'],
          { home },
        )
        assert.equal(r.code, 0, `stderr: ${r.stderr}`)
        assert.match(r.stdout, /WARNING:.*will be REFUSED/)
      } finally {
        cleanup()
      }
    })
  })

  // #7015 / #7052 — `chroxy schedule` must read/write the registry the RUNNING
  // daemon reads. The invariant is that the CLI and the daemon agree; if they
  // ever diverge, `create` reports "Created scheduled task" into a file the
  // scheduler never opens and `list` comes back empty — a task that silently
  // never fires.
  //
  // Until #7052 they agreed on a home-rooted path, because neither hop consulted
  // CHROXY_CONFIG_DIR, and this test pinned that by proving the registry stayed
  // under $HOME even when the env var pointed elsewhere. #7052 moved the
  // WRITERS: SessionManager's default state file is now configPath(...), so both
  // hops follow the env var and the agreement holds at the relocated root
  // instead. Same invariant, other side of the migration.
  it('puts the registry under CHROXY_CONFIG_DIR, and create/list agree there', async () => {
    const { home, cleanup } = makeTempHome()
    const elsewhere = mkdtempSync(join(tmpdir(), 'chroxy-cfgdir-'))
    try {
      const created = await runCli(
        ['schedule', 'create', '--prompt', 'x', '--cron', '0 9 * * *', '--name', 'EnvProbe'],
        { home, env: { CHROXY_CONFIG_DIR: elsewhere } },
      )
      assert.equal(created.code, 0, `stderr: ${created.stderr}`)

      assert.ok(
        existsSync(join(elsewhere, 'scheduled-tasks.json')),
        'registry must follow CHROXY_CONFIG_DIR — that is where the daemon now loads session-state from',
      )
      assert.ok(
        !existsSync(join(home, '.chroxy', 'scheduled-tasks.json')),
        'registry must not stay home-rooted once CHROXY_CONFIG_DIR relocates the daemon state',
      )

      // Same resolution on the read side, so create and list can't disagree.
      const listed = await runCli(
        ['schedule', 'list', '--json'],
        { home, env: { CHROXY_CONFIG_DIR: elsewhere } },
      )
      assert.equal(listed.code, 0, `stderr: ${listed.stderr}`)
      const { tasks } = parseJsonStdout(listed.stdout)
      assert.equal(tasks.length, 1, 'list must find the task create just wrote')
      assert.equal(tasks[0].name, 'EnvProbe')
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
      cleanup()
    }
  })

  // The positive control for the case above: with CHROXY_CONFIG_DIR unset the
  // registry must fall back to $HOME/.chroxy. Without this, "it landed in the
  // relocated dir" would also be satisfied by a CLI that had simply stopped
  // writing under $HOME for some unrelated reason.
  it('falls back to $HOME/.chroxy when CHROXY_CONFIG_DIR is unset', async () => {
    const { home, cleanup } = makeTempHome()
    try {
      const created = await runCli(
        ['schedule', 'create', '--prompt', 'x', '--cron', '0 9 * * *', '--name', 'HomeProbe'],
        { home },
      )
      assert.equal(created.code, 0, `stderr: ${created.stderr}`)
      assert.ok(
        existsSync(join(home, '.chroxy', 'scheduled-tasks.json')),
        'registry must be home-rooted when nothing relocates it',
      )
    } finally {
      cleanup()
    }
  })

  it('pause/resume/edit/delete on an unknown id exit non-zero with a clear message', async () => {
    const { home, cleanup } = makeTempHome()
    try {
      const pause = await runCli(['schedule', 'pause', 'does-not-exist'], { home })
      assert.notEqual(pause.code, 0)
      assert.match(pause.stdout, /No scheduled task matches/)

      const del = await runCli(['schedule', 'delete', 'does-not-exist', '--yes'], { home })
      assert.notEqual(del.code, 0)
    } finally {
      cleanup()
    }
  })
})
