import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'
import type { Plugin } from 'vite'

// Rewrites external ESM imports to globalThis.__ABRACA_SHARED__.* so the host's
// singletons (one vue, one yjs) are reused. `three` is NOT a host singleton, so
// it is bundled into plugin.js (it only externalizes vue + yjs). Mirrors the
// terminal plugin's shim; replaces @abraca/vite-plugin until that's published.
function abraShim(): Plugin {
  const EXTERNALS: Record<string, string> = { vue: 'vue', yjs: 'yjs' }
  return {
    name: 'abra-shim',
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue
        for (const [pkg, key] of Object.entries(EXTERNALS)) {
          const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          chunk.code = chunk.code.replace(
            new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*["']${escaped}["']`, 'g'),
            // `import { a as b }` → `const { a: b }`: object destructuring
            // renames with `:`, not the import-only `as` keyword.
            (_m: string, names: string) =>
              `const {${names.replace(/([\w$]+)\s+as\s+([\w$]+)/g, '$1: $2')}} = globalThis.__ABRACA_SHARED__["${key}"]`,
          )
        }
      }
    },
  }
}

export default defineConfig({
  // Fold component CSS into plugin.js — the host loader only fetches the JS.
  plugins: [vue(), cssInjectedByJsPlugin(), abraShim()],
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'plugin' },
    // Single self-contained plugin.js (three + loaders bundled). External
    // plugins load by URL/blob, where a separate async chunk wouldn't resolve.
    rollupOptions: { external: ['vue', 'yjs'], output: { inlineDynamicImports: true } },
    // three + GLTF/Draco/KTX2 loaders are large; keep the warning quiet.
    chunkSizeWarningLimit: 4000,
    // Inline the Draco + basis decoder binaries (largest ~516 KB) as base64
    // data URLs so the plugin decodes every model format fully OFFLINE with no
    // sidecar files. Limit must clear the basis transcoder wasm.
    assetsInlineLimit: 4_000_000,
  },
})
