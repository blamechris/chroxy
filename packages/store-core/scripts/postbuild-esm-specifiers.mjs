#!/usr/bin/env node
// Make tsc's bundler-style relative specifiers runnable under Node ESM.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

function listJsFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      files.push(...listJsFiles(fullPath))
    } else if (entry.endsWith('.js')) {
      files.push(fullPath)
    }
  }
  return files
}

function hasExplicitExtension(specifier) {
  const lastSegment = specifier.split('/').at(-1) ?? ''
  return extname(lastSegment) !== ''
}

function resolveSpecifier(filePath, specifier) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return specifier
  }
  if (hasExplicitExtension(specifier)) {
    return specifier
  }

  const absoluteBase = resolve(dirname(filePath), specifier)
  if (existsSync(`${absoluteBase}.js`)) {
    return `${specifier}.js`
  }
  if (existsSync(join(absoluteBase, 'index.js'))) {
    return `${specifier.replace(/\/$/, '')}/index.js`
  }

  throw new Error(`Cannot resolve relative ESM specifier "${specifier}" in ${filePath}`)
}

function rewriteStaticSpecifiers(filePath, source) {
  return source.split('\n').map((line) => {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      return line
    }
    return line.replace(/\bfrom\s+(['"])(\.{1,2}\/[^'"]+)\1/g, (match, quote, specifier) => {
      const rewritten = resolveSpecifier(filePath, specifier)
      return `from ${quote}${rewritten}${quote}`
    })
  }).join('\n')
}

function rewriteDynamicSpecifiers(filePath, source) {
  return source.split('\n').map((line) => {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      return line
    }
    return line.replace(/\bimport\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g, (match, quote, specifier) => {
      const rewritten = resolveSpecifier(filePath, specifier)
      return `import(${quote}${rewritten}${quote})`
    })
  }).join('\n')
}

for (const filePath of listJsFiles(distDir)) {
  const original = readFileSync(filePath, 'utf8')
  const rewritten = rewriteDynamicSpecifiers(filePath, rewriteStaticSpecifiers(filePath, original))
  if (rewritten !== original) {
    writeFileSync(filePath, rewritten, 'utf8')
  }
}
