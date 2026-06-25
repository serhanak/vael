import { defineConfig } from 'vite'

// Vite config tuned for Tauri:
// - fixed dev port (Tauri points devUrl here)
// - don't watch the Rust side for HMR
// - expose TAURI_* env vars to the frontend
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
})
