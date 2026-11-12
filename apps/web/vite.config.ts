import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vite';

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
  // Dev only: the ward server runs on :3000 (start it with WDB_ORIGIN=http://localhost:5173).
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3000' } },
  build: { assetsInlineLimit: 0 }, // CSP img-src/font-src 'self': no data: URLs needed
});
