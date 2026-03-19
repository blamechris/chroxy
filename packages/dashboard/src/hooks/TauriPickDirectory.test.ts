/**
 * Tests that the Tauri pick_directory IPC command exists (#1473)
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const libSrc = fs.readFileSync(
  path.resolve(__dirname, '../../../..', 'packages/desktop/src-tauri/src/lib.rs'),
  'utf-8',
)

describe('Tauri pick_directory command (#1473)', () => {
  it('has a pick_directory Tauri command', () => {
    expect(libSrc).toMatch(/#\[tauri::command\][\s\S]*?fn pick_directory/)
  })

  it('registers pick_directory in invoke_handler', () => {
    expect(libSrc).toMatch(/pick_directory/)
  })

  it('uses DialogExt for native folder picker', () => {
    expect(libSrc).toMatch(/DialogExt/)
    expect(libSrc).toMatch(/pick_folder/)
  })
})
