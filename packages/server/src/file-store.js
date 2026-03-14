/**
 * FileStore — consistent JSON file I/O utilities.
 *
 * Consolidates the read/write/mkdir patterns used across 16+ server files
 * into a single module with predictable error handling:
 *
 * - readJsonFile: returns defaultValue for ENOENT, throws on corrupt JSON
 * - writeJsonFile: ensures parent dirs exist, writes pretty-printed JSON
 * - ensureDir: recursive mkdir
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Read and parse a JSON file.
 *
 * @param {string} path - Absolute path to JSON file
 * @param {*} [defaultValue=null] - Value to return if file does not exist
 * @returns {*} Parsed JSON data, or defaultValue if file is missing
 * @throws {SyntaxError} If file exists but contains invalid JSON
 * @throws {Error} For I/O errors other than ENOENT
 */
export function readJsonFile(path, defaultValue = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    if (err.code === 'ENOENT') return defaultValue
    throw err
  }
}

/**
 * Write data as pretty-printed JSON to a file.
 * Creates parent directories if they don't exist.
 *
 * @param {string} path - Absolute path to write
 * @param {*} data - Data to serialize as JSON
 */
export function writeJsonFile(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

/**
 * Ensure a directory exists, creating parent directories as needed.
 *
 * @param {string} path - Directory path to create
 */
export function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}
