import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { modelsPlugin } from './vite-plugin-models'

export default defineConfig({
  plugins: [react(), modelsPlugin()],
  server: {
    port: 5173,
  },
})
