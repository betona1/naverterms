module.exports = {
  apps: [
    {
      name: 'naverterms-backend',
      cwd: '/home/joacham/projects/naverterms/backend',
      script: 'python3',
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
      cwd: '/home/joacham/projects/naverterms/frontend',
      script: 'npx',
      args: 'vite --host 0.0.0.0 --port 5174',
      interpreter: 'none',
      autorestart: true,
      watch: false,
      max_restarts: 10,
    },
  ],
};
