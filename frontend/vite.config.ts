import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:8900',
        changeOrigin: true,
        timeout: 300000,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
            const ip = typeof clientIp === 'string' ? clientIp : clientIp[0];
            const clean = ip.replace('::ffff:', '');
            proxyReq.setHeader('X-Forwarded-For', clean);
            proxyReq.setHeader('X-Real-IP', clean);
          });
        },
      },
    },
  },
})
