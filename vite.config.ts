import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Everything is client-side: no proxy, no backend, no SSR.
 * The service worker only precaches the application shell; media lives in
 * IndexedDB and Telegram, never in an HTTP cache.
 */
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // `injectManifest` lets us add the Web Share Target POST handler next to
      // Workbox precaching in src/sw.ts. The manifest itself is a static file
      // (public/manifest.json) so the share_target stays reviewable.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        // mtcute ships a WASM crypto provider; it is part of the shell.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // mtcute resolves its WASM binary with `new URL('./x.wasm', import.meta.url)`.
    // Pre-bundling rewrites that URL to `.vite/deps/`, where Vite serves the HTML
    // fallback instead of the binary. Excluding the packages keeps the URL real.
    exclude: ['@mtcute/web', '@mtcute/wasm'],
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          telegram: ['@mtcute/web'],
          storage: ['dexie'],
          qr: ['qrcode'],
        },
      },
    },
  },
});
