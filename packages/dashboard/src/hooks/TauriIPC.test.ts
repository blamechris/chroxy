import { describe, test, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const hookSrc = fs.readFileSync(
  path.resolve(__dirname, './useTauriIPC.ts'),
  'utf-8',
)

// Navigate from hooks/ → src/ → dashboard/ → packages/ → repo root → desktop/
const libSrc = fs.readFileSync(
  path.resolve(__dirname, '../../../..', 'packages/desktop/src-tauri/src/lib.rs'),
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

  test('hook uses shared tauri-bridge for Tauri context check', () => {
    expect(hookSrc).toMatch(/tauri-bridge/)
  })

  test('Rust has get_tunnel_mode command', () => {
    expect(libSrc).toMatch(/#\[tauri::command\][\s\S]*?fn get_tunnel_mode/)
  })

  test('Rust has set_tunnel_mode command', () => {
    expect(libSrc).toMatch(/#\[tauri::command\][\s\S]*?fn set_tunnel_mode/)
  })

  test('tunnel mode commands registered in generate_handler', () => {
    expect(libSrc).toMatch(/generate_handler!\[[\s\S]*?get_tunnel_mode/)
    expect(libSrc).toMatch(/generate_handler!\[[\s\S]*?set_tunnel_mode/)
  })

  test('TypeScript hook exports getTunnelMode', () => {
    expect(hookSrc).toMatch(/export async function getTunnelMode/)
  })

  test('TypeScript hook exports setTunnelMode', () => {
    expect(hookSrc).toMatch(/export async function setTunnelMode/)
  })

  // #5294 — summon hotkey settings command + live re-registration.
  test('Rust has get_summon_hotkey command', () => {
    expect(libSrc).toMatch(/#\[tauri::command\][\s\S]*?fn get_summon_hotkey/)
  })

  test('Rust has set_summon_hotkey command', () => {
    expect(libSrc).toMatch(/#\[tauri::command\][\s\S]*?fn set_summon_hotkey/)
  })

  test('summon hotkey commands registered in generate_handler', () => {
    expect(libSrc).toMatch(/generate_handler!\[[\s\S]*?get_summon_hotkey/)
    expect(libSrc).toMatch(/generate_handler!\[[\s\S]*?set_summon_hotkey/)
  })

  test('TypeScript hook exports getSummonHotkey', () => {
    expect(hookSrc).toMatch(/export async function getSummonHotkey/)
  })

  test('TypeScript hook exports setSummonHotkey', () => {
    expect(hookSrc).toMatch(/export async function setSummonHotkey/)
  })

  // #6787 — first-run setup wizard wiring.
  test('Rust has check_dependencies command', () => {
    expect(libSrc).toMatch(/#\[tauri::command\][\s\S]*?fn check_dependencies/)
  })

  test('Rust has get_setup_state command', () => {
    expect(libSrc).toMatch(/#\[tauri::command\][\s\S]*?fn get_setup_state/)
  })

  test('Rust has save_setup_config command', () => {
    expect(libSrc).toMatch(/#\[tauri::command\][\s\S]*?fn save_setup_config/)
  })

  test('setup wizard commands registered in generate_handler', () => {
    expect(libSrc).toMatch(/generate_handler!\[[\s\S]*?check_dependencies/)
    expect(libSrc).toMatch(/generate_handler!\[[\s\S]*?get_setup_state/)
    expect(libSrc).toMatch(/generate_handler!\[[\s\S]*?save_setup_config/)
  })

  test('TypeScript hook exports checkDependencies', () => {
    expect(hookSrc).toMatch(/export async function checkDependencies/)
  })

  test('TypeScript hook exports getSetupState', () => {
    expect(hookSrc).toMatch(/export async function getSetupState/)
  })

  test('TypeScript hook exports saveSetupConfig', () => {
    expect(hookSrc).toMatch(/export async function saveSetupConfig/)
  })
})
