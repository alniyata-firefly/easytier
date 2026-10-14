import { defineConfig } from 'vite';
const target=process.env.API_BASE_URL || 'http://127.0.0.1:21811';
const proxy={ '^/api(?:/|$)': {target}, '/auth/config': {target} };
export default defineConfig({
  esbuild: {jsx: 'automatic'},
  server: {host: '0.0.0.0',port: 5188,strictPort: true,proxy},
  preview: {host: '0.0.0.0',port: 5188,strictPort: true,proxy},
});
