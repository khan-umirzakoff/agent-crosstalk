import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vite'

// Built into ../ui, which the crosstalk daemon serves; dev proxies the API to a running daemon.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  build: { outDir: '../ui', emptyOutDir: true },
  server: { proxy: { '/api': { target: 'http://127.0.0.1:4477', changeOrigin: true }, '/events': { target: 'http://127.0.0.1:4477', changeOrigin: true } } },
})
