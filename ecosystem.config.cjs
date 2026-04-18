module.exports = {
  apps: [
    {
      name: 'naverterms-backend',
      cwd: '/home/mueres/naver/backend',
      script: '/home/mueres/naver/venv/bin/python',
      args: 'manage.py runserver 0.0.0.0:8900',
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
      name: 'competitor-crawl-morning',
      cwd: '/home/mueres/naver/backend',
      script: '/home/mueres/naver/venv/bin/python',
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
      cwd: '/home/mueres/naver/backend',
      script: '/home/mueres/naver/venv/bin/python',
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
