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
  ],
};
