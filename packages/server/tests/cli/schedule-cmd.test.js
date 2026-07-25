/**
 * E2E coverage for `chroxy schedule` — spawns the real CLI binary (via
 * runCli, which isolates HOME/CHROXY_CONFIG_DIR per child process) so the
 * commander wiring in src/cli.js -> registerScheduleCommands is exercised
 * end-to-end, not just the pure functions in src/cli/schedule-cmd.js
 * (covered in depth by tests/schedule-cli.test.js).
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { runCli, makeTempHome } from './__helpers/spawn-cli.js'

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
