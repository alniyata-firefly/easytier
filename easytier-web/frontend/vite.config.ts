import { defineConfig } from 'vite';
import { reactBundleAudit } from '../frontend-lib/src/build/reactBundleAudit';
const target=process.env.API_BASE_URL || 'http://127.0.0.1:21811';
const proxy={ '^/api(?:/|$)': {target}, '/auth/config': {target} };
export default defineConfig({
  plugins: [reactBundleAudit()],
  esbuild: {jsx: 'automatic'},
  build: {assetsInlineLimit: 0},
  server: {host: '0.0.0.0',port: 5188,strictPort: true,proxy},
  preview: {host: '0.0.0.0',port: 5188,strictPort: true,proxy},
});
