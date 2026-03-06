import { describe, test, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const hookSrc = fs.readFileSync(
  path.resolve(__dirname, './useTauriIPC.ts'),
  'utf-8',
)

// Navigate from hooks/ → src/ → dashboard-next/ → src/ → server/ → packages/ → desktop/
const libSrc = fs.readFileSync(
  path.resolve(__dirname, '../../../../../', 'desktop/src-tauri/src/lib.rs'),
  'utf-8',
)

describe('Tauri IPC commands (#1108)', () => {
  test('Rust has get_server_info command', () => {
    expect(libSrc).toMatch(/#\[tauri::command\][\s\S]*?fn get_server_info/)
  })

  test('Rust has start_server command', () => {
    expect(libSrc).toMatch(/#\[tauri::command\][\s\S]*?fn start_server/)
  })

  test('Rust has stop_server command', () => {
    expect(libSrc).toMatch(/#\[tauri::command\][\s\S]*?fn stop_server/)
  })

  test('Rust has restart_server command', () => {
    expect(libSrc).toMatch(/#\[tauri::command\][\s\S]*?fn restart_server/)
  })

  test('commands registered in generate_handler', () => {
    expect(libSrc).toMatch(/generate_handler!\[[\s\S]*?get_server_info/)
    expect(libSrc).toMatch(/generate_handler!\[[\s\S]*?start_server/)
    expect(libSrc).toMatch(/generate_handler!\[[\s\S]*?stop_server/)
    expect(libSrc).toMatch(/generate_handler!\[[\s\S]*?restart_server/)
  })

  test('TypeScript hook exports getServerInfo', () => {
    expect(hookSrc).toMatch(/export async function getServerInfo/)
  })

  test('TypeScript hook exports startServer', () => {
    expect(hookSrc).toMatch(/export async function startServer/)
  })

  test('TypeScript hook exports stopServer', () => {
    expect(hookSrc).toMatch(/export async function stopServer/)
  })

  test('hook checks for Tauri context before invoking', () => {
    expect(hookSrc).toMatch(/__TAURI_INTERNALS__|isTauri/)
  })
})
