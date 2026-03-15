import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_ORIGIN ?? 'http://localhost:3848',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist/ui/app',
    emptyOutDir: true,
  },
})
