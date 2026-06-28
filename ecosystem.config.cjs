module.exports = {
  apps: [
    {
      name: 'naverterms-backend',
      cwd: '/home/joacham/projects/naverterms/backend',
      script: 'python3',
      // --noreload: autoreloader 가 .py 변경 감지 시 reload 하면서 진행 중 요청을 끊어
      // 11st 측 ai_keyword_worker 의 ReadTimeout 76건 발생. PM2 autorestart 만으로 충분.
      args: 'manage.py runserver 0.0.0.0:8901 --noreload',
      interpreter: 'none',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      env: {
        DJANGO_SETTINGS_MODULE: 'config.settings',
      },
    },
    {
      name: 'naverterms-frontend',
      cwd: '/home/mueres/naver/frontend',
      script: '/home/mueres/naver/start-frontend.sh',
      args: '',
      interpreter: '/bin/bash',
      autorestart: true,
      watch: false,
      max_restarts: 10,
    },
    {
      // 워커 자동 복구 데몬 — 5분마다 11대 점검, dead 발견 시 WoL/SSH restart 자동 시도, 회복/실패 텔레그램 알림.
      name: 'naverterms-worker-doctor',
      cwd: '/home/joacham/projects/naverterms/backend',
      script: 'python3',
      args: '-u naver_worker_doctor.py',
      interpreter: 'none',
      env: {
        DJANGO_SETTINGS_MODULE: 'config.settings',
        PYTHONUNBUFFERED: '1',
        DOCTOR_INTERVAL: '300',
      },
      autorestart: true,
      watch: false,
    },
    {
      // 이미지 AI 마이크로서비스 (port 8902) — rembg + EasyOCR/LaMa + Real-ESRGAN/Lanczos.
      // 시작 전 1회: cd backend/image_ai_service && ./setup.sh
      // 시작: pm2 start ecosystem.config.cjs --only naverterms-image-ai
      name: 'naverterms-image-ai',
      cwd: '/home/joacham/projects/naverterms/backend/image_ai_service',
      script: './start.sh',
      interpreter: 'bash',
      autorestart: true,
      watch: false,
      max_restarts: 5,
      env: {
        PYTHONUNBUFFERED: '1',
      },
    },
    {
      // 매시 정각에 큐 진척 텔레그램 보고. .tg_reporter_enabled 플래그 파일 있을 때만 전송.
      name: 'naverterms-queue-reporter',
      cwd: '/home/joacham/projects/naverterms/backend',
      script: 'python3',
      args: '-u naver_queue_reporter.py',
      interpreter: 'none',
      env: {
        DJANGO_SETTINGS_MODULE: 'config.settings',
        PYTHONUNBUFFERED: '1',
      },
      cron_restart: '0 * * * *',
      autorestart: false,
      watch: false,
    },
    {
      // 218 의 ~/upscaled_thumbs 를 backend/media/upscaled_thumbs 에 sshfs 마운트.
      // 업스케일 결과물이 218에 primary 저장됨. -f (foreground) 로 PM2 가 직접 관리.
      // 추가: 2026-05-27 (저장공간 100→218 이전).
      name: 'naverterms-sshfs-218',
      script: '/home/joacham/.local/bin/sshfs',
      args: [
        'joacham@192.168.219.218:/home/joacham/upscaled_thumbs',
        '/home/joacham/projects/naverterms/backend/media/upscaled_thumbs',
        '-f',
        '-o', 'reconnect,ServerAliveInterval=15,ServerAliveCountMax=3,cache_timeout=120,attr_timeout=60,ConnectTimeout=10,kernel_cache',
      ].join(' '),
      interpreter: 'none',
      autorestart: true,
      watch: false,
      max_restarts: 20,
      restart_delay: 5000,
    },
    {
      name: 'competitor-crawl-morning',
      cwd: '/home/joacham/projects/naverterms/backend',
      script: 'python3',
      args: 'manage.py crawl_competitors',
      interpreter: 'none',
      autorestart: false,
      cron_restart: '0 11 * * *',
      watch: false,
      env: {
        DJANGO_SETTINGS_MODULE: 'config.settings',
      },
    },
    {
      name: 'competitor-crawl-night',
      cwd: '/home/joacham/projects/naverterms/backend',
      script: 'python3',
      args: 'manage.py crawl_competitors',
      interpreter: 'none',
      autorestart: false,
      cron_restart: '50 23 * * *',
      watch: false,
      env: {
        DJANGO_SETTINGS_MODULE: 'config.settings',
      },
    },
  ],
};
