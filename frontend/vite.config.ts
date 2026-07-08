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
        target: 'http://localhost:8901',
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
      // 이미지 AI 마이크로서비스 (port 8902) — base64 payload 가 크므로 타임아웃 5분
      '/image-ai': {
        target: 'http://localhost:8902',
        changeOrigin: true,
        timeout: 300000,
        rewrite: (path) => path.replace(/^\/image-ai/, ''),
      },
      // Django MEDIA (편집된 썸네일) — 8901 그대로 프록시
      '/media': {
        target: 'http://localhost:8901',
        changeOrigin: true,
      },
    },
  },
})
