/// <reference types="vite/client" />

// Tauri API types — available at runtime in Tauri webview, stub for non-Tauri builds
declare module '@tauri-apps/api/core' {
  export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>
}
