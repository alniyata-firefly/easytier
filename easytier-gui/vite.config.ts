import { defineConfig } from 'vite'
import path from 'node:path'
export default defineConfig({
 resolve: { alias: { '~/': `${path.resolve(__dirname, 'src')}/` } },
 esbuild: { jsx: 'automatic' }, clearScreen: false,
 server: { port: 1420, host: process.env.TAURI_DEV_HOST || '127.0.0.1', strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
 build: { assetsInlineLimit: 0, target: 'es2022', rollupOptions: { output: { manualChunks(id) { if (id.includes('/frontend-lib/src/generated/')) return 'protocol'; if (id.includes('/qrcode/') || id.includes('/dijkstrajs/')) return 'portal-vendor'; if (id.includes('/node_modules/')) return 'vendor'; } } } },
})
