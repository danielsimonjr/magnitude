import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const apiPort = Number(process.env.ACN_DASH_API_PORT ?? 4886)
const uiPort = Number(process.env.ACN_DASH_UI_PORT ?? 4887)

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    port: uiPort,
    strictPort: true,
    proxy: {
      '/api': `http://localhost:${apiPort}`,
    },
  },
  build: {
    outDir: 'dist',
  },
})
