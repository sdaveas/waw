import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GitHub Pages serves project sites from /<repo>/, so the production build
// needs a base path. `npm run dev` stays at the root.
export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? '/waw/' : '/',
  plugins: [react(), tailwindcss()],
}))
