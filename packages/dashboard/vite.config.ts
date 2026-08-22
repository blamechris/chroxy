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
    // #7300. Every failure that issue catalogues is `Test timed out in 5000ms`
    // and never an assertion, on a different random subset each run — so the
    // premise that is wrong is the clock, not any test's behaviour. The
    // self-hosted pool runs several jobs per physical box (chroxy-linux-winbox-01
    // shares hardware with chroxy-win-01), and a spec that takes 200ms locally
    // has been measured at 10.6s there.
    //
    // Two changes, because the default is unstated on both axes: give the clock
    // headroom, and stop vitest opening one worker per core on a box it does not
    // have to itself.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: '50%',
  },
})
