import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'

// Builds only the public calendar page for the standalone container
// (calendar-share/). A separate build rather than a second input on the main
// config, so the output holds the calendar's code and nothing else — the
// dashboard's pages never end up on the internet-facing server, not even as
// unreachable static files.
export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: '../dist-share',
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./client/share.html', import.meta.url)),
    },
  },
})
