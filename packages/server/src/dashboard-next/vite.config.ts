import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Tauri sets TAURI_ENV_PLATFORM during dev/build — use root base for embedded app
const isTauri = !!process.env.TAURI_ENV_PLATFORM

// Read version from server package.json at build time
import { readFileSync } from 'fs'
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'))

export default defineConfig({
  plugins: [react()],
  base: isTauri ? '/' : '/dashboard/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
  },
  server: {
    proxy: {
      '/ws': {
        target: 'ws://localhost:7860',
        ws: true,
      },
    },
  },
  test: {
    root: resolve(__dirname),
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
  },
})
