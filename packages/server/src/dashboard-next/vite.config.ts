import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Tauri sets TAURI_ENV_PLATFORM during dev/build — use root base for embedded app
const isTauri = !!process.env.TAURI_ENV_PLATFORM

export default defineConfig({
  plugins: [react()],
  base: isTauri ? '/' : '/dashboard-next/',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/ws': {
        target: 'ws://localhost:7860',
        ws: true,
      },
    },
  },
})
