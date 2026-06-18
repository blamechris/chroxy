#!/usr/bin/env node
// compile-skill-targets.mjs — model-agnostic skill compiler.
//
// The repo-customized install at `.claude/commands/<name>.md` is the
// provider-NEUTRAL source of truth (markdown instructions + $ARGUMENTS). This
// script compiles it into each coding agent's NATIVE custom-command format so
// the same skill is first-party under whichever model you drive:
//
//   claude -> .claude/skills/<name>/SKILL.md        (md + YAML frontmatter; v2.1.x "skills")
//   gemini -> .gemini/commands/<name>.toml          (TOML: prompt + description; {{args}})
//   codex  -> ~/.codex/prompts/<name>.md            (md; $ARGUMENTS; user-global, /prompts:<name>)
//
// Targets come from `.claude/skill-profile.md` (a `targets:` line) unless
// overridden with --targets. Codex is opt-in (user-global + deprecated upstream).
//
// Usage:
//   node scripts/compile-skill-targets.mjs [--name <name>] [--targets claude,gemini]
//        [--repo <root>] [--dry-run]
//
// Exit non-zero on emit failure so /skill and CI can gate on it.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const ALL_TARGETS = ['claude', 'gemini', 'codex']

function parseArgs(argv) {
  const out = { repo: process.cwd(), dryRun: false }
  // Require a value after a value-taking flag, with a clear error instead of an
  // `undefined.split` stack trace.
  const need = (i, flag) => {
    if (i + 1 >= argv.length) {
      console.error(`Missing value for ${flag}`)
      process.exit(1)
    }
    return argv[i + 1]
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--name') out.name = need(i++, a)
    else if (a === '--targets') out.targets = need(i++, a).split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--repo') out.repo = need(i++, a)
    else if (a === '--dry-run') out.dryRun = true
  }
  return out
}

// Read `targets:` from the repo's skill-profile (the profile-driven default).
function targetsFromProfile(repo) {
  const p = join(repo, '.claude/skill-profile.md')
  if (!existsSync(p)) return null
  const m = readFileSync(p, 'utf8').match(/^\s*targets:\s*(.+)$/m)
  if (!m) return null
  // Drop unfilled template placeholders (`<comma-separated agents…>`) so a profile
  // that still carries the placeholder degrades to the `claude` fallback rather than
  // erroring on an "unknown target".
  const list = m[1]
    .replace(/[[\]]/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !s.includes('<') && !s.includes('>'))
  return list.length ? list : null
}

// Strip the registry version stamp — it's install metadata, not skill content.
function stripStamp(body) {
  return body.replace(/^<!--\s*skill-templates:.*?-->\s*$/gm, '').replace(/\n{3,}$/g, '\n').trimEnd() + '\n'
}

// First sentence of the first non-heading prose PARAGRAPH -> a clean one-line
// description for menus. Accumulate the whole paragraph first (the source's first
// sentence often wraps across several physical lines) so we don't return a dangling
// half-sentence. Capped; ellipsis only when truncated.
function deriveDescription(body, name) {
  let para = ''
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('---') || line.startsWith('<!--')) {
      if (para) break // blank/heading ends the first prose paragraph
      continue
    }
    para = para ? `${para} ${line}` : line
  }
  if (!para) return `Project skill: /${name}`
  let desc = para.replace(/\s+/g, ' ').trim()
  const dot = desc.search(/\.(\s|$)/)
  if (dot !== -1 && dot < 160) desc = desc.slice(0, dot + 1)
  if (desc.length > 160) desc = desc.slice(0, 157).trimEnd() + '...'
  return desc
}

// Escape a string for a double-quoted YAML/TOML scalar.
function dqEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function yamlDq(s) {
  return '"' + dqEscape(s) + '"'
}

// ---- emitters: (name, body, description, repo) -> { path, content } ----

function emitClaude(name, body, description, repo) {
  return {
    path: join(repo, '.claude/skills', name, 'SKILL.md'),
    content: `---\ndescription: ${yamlDq(description)}\n---\n\n${body}`,
  }
}

function emitGemini(name, body, description, repo) {
  // Always report the path (even on skip) so the caller can clean up a stale
  // artifact from a previous compile.
  const path = join(repo, '.gemini/commands', `${name}.toml`)
  // $ARGUMENTS is the neutral arg token; Gemini uses {{args}}.
  const prompt = body.replace(/\$ARGUMENTS\b/g, '{{args}}')
  // Gemini's prompt engine is active: it interprets {{...}}, !{...} (shell), and
  // @{...} (file injection). A body that contains those sequences literally (e.g.
  // an HTML template's {{TITLE}}, or {{CUSTOMIZE}} docs) would be corrupted. Gemini
  // has no documented brace-escape, so refuse to emit a broken command — skip this
  // skill for Gemini and let the caller log the drop (no silent corruption).
  const otherMustache = prompt.replace(/\{\{args\}\}/g, '').match(/\{\{|!\{|@\{/)
  if (otherMustache) {
    return { path, skip: `gemini: body contains an active template sequence ("${otherMustache[0]}…") that Gemini would interpret; not Gemini-safe` }
  }
  // TOML literal triple-string ('''…''') needs no escaping; bail to a basic
  // string only if the body itself contains ''' (vanishingly rare).
  let promptBlock
  if (!prompt.includes("'''")) {
    promptBlock = `prompt = '''\n${prompt}'''`
  } else {
    const esc = prompt.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')
    promptBlock = `prompt = """\n${esc}"""`
  }
  const descToml = description.includes("'") ? `"${dqEscape(description)}"` : `'${description}'`
  // Warn on positional $N args only when they appear OUTSIDE fenced code blocks —
  // a bash `${1:-…}` inside a ```code``` block is a shell positional, not a Gemini
  // arg-mapping concern, and would be a noisy false positive.
  const prose = prompt.replace(/```[\s\S]*?```/g, '')
  return {
    path,
    content: `description = ${descToml}\n${promptBlock}\n`,
    warn: /\$[1-9]\b/.test(prose) ? `gemini: positional $N args have no Gemini equivalent (only {{args}})` : null,
  }
}

function emitCodex(name, body, description) {
  // Codex custom prompts: ~/.codex/prompts (user-global, no project scope).
  // $ARGUMENTS is natively supported, so the body passes through. Invoked as
  // /prompts:<name>, not /<name>.
  return {
    path: join(homedir(), '.codex/prompts', `${name}.md`),
    content: `---\ndescription: ${yamlDq(description)}\n---\n\n${body}`,
    note: `codex: invoke as /prompts:${name} (user-global; OpenAI marks custom prompts deprecated)`,
  }
}

const EMITTERS = { claude: emitClaude, gemini: emitGemini, codex: emitCodex }

function compileOne(name, srcPath, targets, repo, dryRun) {
  const raw = readFileSync(srcPath, 'utf8')
  const body = stripStamp(raw)
  const description = deriveDescription(body, name)
  const results = []
  for (const t of targets) {
    const emit = EMITTERS[t]
    if (!emit) {
      results.push({ target: t, error: `unknown target "${t}"` })
      continue
    }
    const { path, content, warn, note, skip } = emit(name, body, description, repo)
    if (skip) {
      // Remove any artifact left by a previous compile so a now-unsafe skill
      // can't keep loading a stale/broken native command.
      let removedStale = false
      if (!dryRun && path && existsSync(path)) {
        rmSync(path)
        removedStale = true
      }
      results.push({ target: t, skip, removedStale })
      continue
    }
    if (!dryRun) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
    results.push({ target: t, path, warn, note })
  }
  return { name, description, results }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const repo = args.repo
  const cmdDir = join(repo, '.claude/commands')
  if (!existsSync(cmdDir)) {
    console.error(`No .claude/commands/ in ${repo}`)
    process.exit(1)
  }
  let targets = args.targets || targetsFromProfile(repo) || ['claude']
  const bad = targets.filter((t) => !ALL_TARGETS.includes(t))
  if (bad.length) {
    console.error(`Unknown target(s): ${bad.join(', ')}. Known: ${ALL_TARGETS.join(', ')}`)
    process.exit(1)
  }

  const names = args.name ? [args.name] : readdirSync(cmdDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
  // `--name` is user-facing; a name with a path separator or `..` would let the
  // emitters write outside the intended dirs (incl. ~/.codex). Reject up front.
  const unsafe = names.filter((n) => /[/\\]/.test(n) || n.split(/[/\\]/).includes('..') || n.includes('..'))
  if (unsafe.length) {
    console.error(`Unsafe skill name(s): ${unsafe.join(', ')} — names must not contain "/", "\\", or "..".`)
    process.exit(1)
  }
  let failed = 0
  let skipped = 0
  console.log(`Compiling ${names.length} skill(s) -> [${targets.join(', ')}]${args.dryRun ? ' (dry-run)' : ''}\n`)
  for (const name of names) {
    const srcPath = join(cmdDir, `${name}.md`)
    if (!existsSync(srcPath)) {
      console.error(`  ${name}: SOURCE MISSING (${srcPath})`)
      failed++
      continue
    }
    const { description, results } = compileOne(name, srcPath, targets, repo, args.dryRun)
    console.log(`  /${name} — ${description.slice(0, 70)}${description.length > 70 ? '…' : ''}`)
    for (const r of results) {
      if (r.error) {
        console.error(`      [${r.target}] ERROR: ${r.error}`)
        failed++
      } else if (r.skip) {
        console.log(`      [${r.target}] SKIPPED — ${r.skip}${r.removedStale ? ' (removed stale artifact)' : ''}`)
        skipped++
      } else {
        const rel = r.path.replace(homedir(), '~').replace(repo + '/', '')
        console.log(`      [${r.target}] ${rel}`)
        if (r.warn) console.log(`         ! ${r.warn}`)
        if (r.note) console.log(`         · ${r.note}`)
      }
    }
  }
  if (failed) {
    console.error(`\n${failed} emit(s) failed.`)
    process.exit(1)
  }
  console.log(`\nDone.${skipped ? ` ${skipped} target(s) skipped (logged above — not emitted).` : ''}`)
}

main()
