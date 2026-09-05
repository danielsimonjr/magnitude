import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    port: 4777,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:4776',
    },
  },
  build: {
    outDir: 'dist',
  },
})
