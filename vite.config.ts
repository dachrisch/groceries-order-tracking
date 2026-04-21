import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    solidPlugin(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      daisyui: 'daisyui/index.js',
    },
  },
  optimizeDeps: {
    include: ['lucide-solid'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'esnext',
  },
});
