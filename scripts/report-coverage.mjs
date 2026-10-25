#!/usr/bin/env node
import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isEntryPoint } from './lib/is-entry-point.mjs'

const packages = new Map([
  ['server', 'Server'],
  ['app', 'Mobile app'],
  ['dashboard', 'Dashboard'],
  ['store-core', 'Store core'],
])
const metrics = ['lines', 'branches', 'functions', 'statements']

function fail(message) {
  throw new Error(`Coverage report: ${message}`)
}

function readRequired(path) {
  let data
  try {
    data = readFileSync(path, 'utf8')
  } catch {
    fail(`missing expected report ${path}`)
  }
  if (!data.trim()) fail(`empty expected report ${path}`)
  return data
}

function validateMetric(value, label, allowZero = false) {
  if (!value || !Number.isInteger(value.total) || value.total < (allowZero ? 0 : 1) ||
      !Number.isInteger(value.covered) || value.covered < 0 || value.covered > value.total ||
      typeof value.pct !== 'number' || !Number.isFinite(value.pct) ||
      value.pct < 0 || value.pct > 100) {
    fail(`invalid or zero ${label}`)
  }
  if (value.total === 0) {
    // Istanbul reporters use either 0 or 100 for an empty per-file metric.
    if (value.pct !== 0 && value.pct !== 100) fail(`inconsistent ${label} percentage`)
  } else if (Math.abs((100 * value.covered) / value.total - value.pct) > 0.02) {
    fail(`inconsistent ${label} percentage`)
  }
}

// Istanbul's JSON summary records absolute paths from the runner checkout,
// while LCOV records package-relative paths. Compare their normalized source
// identities so downloaded artifacts remain verifiable after relocation.
function sourceIdentity(source, packageName, reporter) {
  const path = source.replaceAll('\\', '/')
  let relative
  if (reporter === 'JSON') {
    const marker = `/packages/${packageName}/`
    const markerAt = path.lastIndexOf(marker)
    if ((!path.startsWith('/') && !/^[A-Za-z]:\//.test(path)) || markerAt < 0) {
      fail(`unexpected source for ${packageName} in JSON summary: ${source}`)
    }
    relative = path.slice(markerAt + marker.length)
  } else {
    relative = path
  }
  const sourceRoots = packageName === 'server' ? ['src/', 'hooks/', 'sidecar/'] : ['src/']
  if (!sourceRoots.some((root) => relative.startsWith(root)) ||
      relative.split('/').some((part, index) => index > 0 && (part === '' || part === '.' || part === '..'))) {
    fail(`unexpected source for ${packageName} in ${reporter}: ${source}`)
  }
  return relative
}

function verifyLcov(lcov, packageName, jsonSources, lcovPath) {
  if (!lcov.trimEnd().endsWith('end_of_record')) fail(`malformed or empty LCOV report ${lcovPath}`)
  const records = lcov.split('end_of_record')
  if (records.pop().trim()) fail(`malformed or empty LCOV report ${lcovPath}`)
  const seen = new Set()
  for (const record of records) {
    const sourceLines = [...record.matchAll(/^SF:(.+)$/gm)]
    const linesFound = record.match(/^LF:(\d+)$/m)
    const linesHit = record.match(/^LH:(\d+)$/m)
    if (sourceLines.length !== 1 || !linesFound || !linesHit) fail(`malformed or empty LCOV report ${lcovPath}`)
    const source = sourceIdentity(sourceLines[0][1].trim(), packageName, 'LCOV')
    if (seen.has(source) || !jsonSources.has(source)) fail(`LCOV source mismatch for ${source} in ${lcovPath}`)
    seen.add(source)
    const total = Number(linesFound[1])
    const covered = Number(linesHit[1])
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(covered) || covered > total ||
        (total > 0 && !/^DA:\d+,\d+/m.test(record))) {
      fail(`malformed or empty LCOV report ${lcovPath}`)
    }
    const jsonLines = jsonSources.get(source).lines
    if (total !== jsonLines.total || covered !== jsonLines.covered) {
      fail(`LCOV line counts mismatch for ${source} in ${lcovPath}`)
    }
  }
  if (seen.size === 0 || seen.size !== jsonSources.size) fail(`LCOV source mismatch in ${lcovPath}`)
}

function verifyHtml(html, htmlPath) {
  // All four configured reporters use Istanbul's index layout. Check its
  // complete document and coverage table, not merely a nonempty index file.
  const content = html.toLowerCase()
  const markers = [
    '<!doctype html>', '<html', '<head',
    '<title>code coverage report for all files</title>', '</head>',
    '<body', '<table class="coverage-summary">', '</table>', '</body>', '</html>',
  ]
  let cursor = 0
  for (const marker of markers) {
    const position = content.indexOf(marker, cursor)
    if (position < 0) fail(`malformed HTML report ${htmlPath}: missing ${marker}`)
    cursor = position + marker.length
  }
  if (!content.trimEnd().endsWith('</html>')) fail(`malformed HTML report ${htmlPath}: truncated document`)
  const tableStart = content.indexOf('<table class="coverage-summary">')
  const tableEnd = content.indexOf('</table>', tableStart)
  const bodyStart = content.indexOf('<tbody>', tableStart)
  const bodyEnd = content.indexOf('</tbody>', bodyStart)
  const body = content.slice(bodyStart + '<tbody>'.length, bodyEnd)
  if (bodyStart < 0 || bodyStart >= tableEnd || bodyEnd < 0 || bodyEnd >= tableEnd ||
      !/<tr\b[^>]*>\s*<td class="file[^"]*"[^>]*>\s*<a href="[^"]+\.html">[^<]+<\/a>/.test(body)) {
    fail(`malformed HTML report ${htmlPath}: coverage table has no source row and file link`)
  }
}

export function summarizeCoverage(packageName, repoRoot) {
  if (!packages.has(packageName)) fail(`unknown package ${packageName}`)
  const directory = resolve(repoRoot, 'packages', packageName, 'coverage')
  const summaryPath = resolve(directory, 'coverage-summary.json')
  let summary
  try {
    summary = JSON.parse(readRequired(summaryPath))
  } catch (error) {
    if (error instanceof SyntaxError) fail(`malformed JSON in ${summaryPath}: ${error.message}`)
    throw error
  }
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    fail(`malformed JSON summary in ${summaryPath}`)
  }
  const sourceFiles = Object.keys(summary).filter((key) => key !== 'total')
  if (sourceFiles.length === 0) fail(`zero instrumented source files in ${summaryPath}`)
  const jsonSources = new Map()
  for (const file of sourceFiles) {
    const source = sourceIdentity(file, packageName, 'JSON')
    if (jsonSources.has(source)) fail(`duplicate source ${source} in ${summaryPath}`)
    jsonSources.set(source, summary[file])
  }
  for (const metric of metrics) {
    const value = summary.total?.[metric]
    validateMetric(value, `${metric} total in ${summaryPath}`)
    let total = 0
    let covered = 0
    for (const file of sourceFiles) {
      const fileValue = summary[file]?.[metric]
      validateMetric(fileValue, `${metric} for ${file} in ${summaryPath}`, true)
      total += fileValue.total
      covered += fileValue.covered
    }
    if (value.total !== total || value.covered !== covered) fail(`inconsistent ${metric} source totals in ${summaryPath}`)
  }
  const lcovPath = resolve(directory, 'lcov.info')
  const lcov = readRequired(lcovPath)
  verifyLcov(lcov, packageName, jsonSources, lcovPath)
  const htmlPath = resolve(directory, 'index.html')
  const html = readRequired(htmlPath)
  if (!statSync(htmlPath).isFile()) fail(`HTML report is not a file ${htmlPath}`)
  verifyHtml(html, htmlPath)
  const row = `| ${packages.get(packageName)} | ${sourceFiles.length} | ${metrics.map((metric) => `${summary.total[metric].pct.toFixed(2)}%`).join(' | ')} |`
  return row
}

function main() {
  const args = process.argv.slice(2)
  const packageName = args[0]
  const rootFlag = args[1]
  const rootValue = args[2]
  if (!packageName || (rootFlag && rootFlag !== '--root') || (rootFlag && !rootValue)) {
    fail('usage: node scripts/report-coverage.mjs <server|app|dashboard|store-core> [--root <repo-root>]')
  }
  const repoRoot = rootValue ?? resolve(fileURLToPath(import.meta.url), '../..')
  const row = summarizeCoverage(packageName, repoRoot)
  const markdown = '| Package | Source files | Lines | Branches | Functions | Statements |\n| --- | ---: | ---: | ---: | ---: | ---: |\n' + row + '\n'
  process.stdout.write(markdown)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${packages.get(packageName)} coverage\n\n${markdown}`)
}

if (isEntryPoint(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`::error::${error.message}`)
    process.exitCode = 1
  }
}
