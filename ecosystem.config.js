module.exports = {
  apps: [
    {
      name: 'ai-fund-webhook',
      script: 'dist/webhook-entry.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'ai-fund-server',
      script: 'uv',
      args: 'run uvicorn main:app --host 0.0.0.0 --port 8080',
      cwd: './server',
      interpreter: 'none',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
