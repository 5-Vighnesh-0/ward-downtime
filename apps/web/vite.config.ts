import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const api = process.env.WDB_API ?? 'http://127.0.0.1:3000';
// E2E serves the build over HTTPS (e2e/tls.sh), so Secure cookies behave as in production on every browser.
const tls = process.env.WDB_TLS_DIR;
const https = tls ? { key: readFileSync(`${tls}/key.pem`), cert: readFileSync(`${tls}/cert.pem`) } : undefined;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt', // never skipWaiting on its own (design.md §8.6)
      injectRegister: false,
      manifest: {
        name: 'Ward Downtime Board',
        short_name: 'Ward Board',
        display: 'standalone',
        start_url: '/',
        background_color: '#ffffff',
        theme_color: '#0e7490',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg}'],
        navigateFallbackDenylist: [/^\/api\//], // API is network only; data lives in IndexedDB
        runtimeCaching: [],
      },
    }),
  ],
  // Dev and E2E only (production sits behind Caddy): the ward server runs on WDB_API, default :3000.
  // Start it with WDB_ORIGIN set to this page's origin, e.g. http://localhost:5173.
  server: { port: 5173, strictPort: true, proxy: { '/api': api } },
  preview: { port: 4173, strictPort: true, proxy: { '/api': api }, ...(https ? { https } : {}) },
  build: { assetsInlineLimit: 0 }, // CSP img-src/font-src 'self': no data: URLs needed
});
