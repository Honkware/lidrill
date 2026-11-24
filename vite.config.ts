import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

// The production CSP lives in public/_headers. The same policy goes into a
// <meta> tag in built pages so `vite preview` runs under it too (dev can't:
// Vite's client is an inline script). frame-ancestors only works as a header.
function cspMeta(): Plugin {
  const csp = readFileSync('public/_headers', 'utf8').match(/Content-Security-Policy: (.*)/)![1].replace(/; frame-ancestors [^;]*/, '')
  return {
    name: 'csp-meta',
    apply: 'build',
    transformIndexHtml: html => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`),
  }
}

export default defineConfig({
  plugins: [tailwindcss(), cspMeta()],
  // The Worker that `bun run dev` starts beside Vite (scripts/dev.ts)
  server: { proxy: { '/api': 'http://localhost:8787' } },
  test: {
    environment: 'jsdom',
    setupFiles: ['fake-indexeddb/auto'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
