import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Standalone dev harness config — mounts SpatialRenderer.vue against a mock host
// (see dev/harness.ts) so the renderer can be exercised in a browser without
// cou-sh or the plugin registry. `vue`/`three` resolve normally from node_modules
// in serve mode (the lib build's abra-shim only runs on `build`).
export default defineConfig({
  plugins: [vue()],
  server: { port: 5189 },
})
