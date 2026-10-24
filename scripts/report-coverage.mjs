#!/usr/bin/env node
import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  for (const file of sourceFiles) {
    if (!file.replaceAll('\\', '/').includes('/src/')) {
      fail(`unexpected non-source entry ${file} in ${summaryPath}`)
    }
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
  if (!lcov.split('end_of_record').slice(0, -1).some((record) =>
    /^SF:.+$/m.test(record) && /^DA:\d+,\d+/m.test(record))) {
    fail(`malformed or empty LCOV report ${lcovPath}`)
  }
  const htmlPath = resolve(directory, 'index.html')
  readRequired(htmlPath)
  if (!statSync(htmlPath).isFile()) fail(`HTML report is not a file ${htmlPath}`)
  const row = `| ${packages.get(packageName)} | ${sourceFiles.length} | ${metrics.map((metric) => `${summary.total[metric].pct.toFixed(2)}%`).join(' | ')} |`
  return row
}

function main() {
  const [packageName, rootFlag, rootValue] = process.argv.slice(2)
  if (!packageName || (rootFlag && rootFlag !== '--root') || (rootFlag && !rootValue)) {
    fail('usage: node scripts/report-coverage.mjs <server|app|dashboard|store-core> [--root <repo-root>]')
  }
  const repoRoot = rootValue ?? resolve(fileURLToPath(import.meta.url), '../..')
  const row = summarizeCoverage(packageName, repoRoot)
  const markdown = '| Package | Source files | Lines | Branches | Functions | Statements |\n| --- | ---: | ---: | ---: | ---: | ---: |\n' + row + '\n'
  process.stdout.write(markdown)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${packages.get(packageName)} coverage\n\n${markdown}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`::error::${error.message}`)
    process.exitCode = 1
  }
}
