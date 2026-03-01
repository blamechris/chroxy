/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  base: '/dashboard-next/',
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  build: { outDir: resolve(__dirname, 'dist'), emptyOutDir: true },
  test: {
    root: resolve(__dirname),
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
  },
})
