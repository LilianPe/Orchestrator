import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { PRODUCT_NAME } from '../src/product.js';

export default defineConfig({
  root: 'web',
  plugins: [react(), { name: 'product-name', transformIndexHtml: (html) => html.replaceAll('%PRODUCT_NAME%', PRODUCT_NAME) }],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4100', '/oauth': 'http://127.0.0.1:4100' } },
});
